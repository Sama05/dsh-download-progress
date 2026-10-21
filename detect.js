/**
 * Tool-call recognition for the Host half.
 *
 * Answers one question: "is this tool call downloading, installing, fetching or
 * searching, and if it writes a file, where?" Everything here is a pure function
 * of the tool name plus its arguments — it never reads the filesystem and never
 * touches task state, which is why the rules can be reviewed in one screen.
 */
import { basename, isAbsolute, resolve } from 'node:path'
import { clip, extractUrl, uniq, unquote } from './utils.js'

/* ------------------------------------------------------------------ */
/* Which tools mean what                                               */
/* ------------------------------------------------------------------ */

/** Search-shaped tools. None of them expose bytes, so they render as elapsed time. */
export const SEARCH_TOOLS = new Set([
  'web_search',
  'advanced_search',
  'multi_search',
  'research',
  'platform_search',
  'video_search',
  'domain_search',
  'free_search_test',
])

/** Single-page fetches: start and end only, no intermediate progress. */
export const FETCH_TOOLS = new Set(['web_fetch'])

/** Tools whose first argument is a shell command line we may be able to parse. */
export const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal_send'])

/* ------------------------------------------------------------------ */
/* Command-line patterns                                               */
/* ------------------------------------------------------------------ */

/**
 * A downloader invoked as a command.
 * `curl` gains an extension on Windows, the command may be chained with `&&`,
 * `;` or `|`, and it is often wrapped as `pwsh -c "curl -o …"` — so the match is
 * anchored on any shell separator OR an opening quote, not on whitespace alone.
 */
export const CURL_WGET_RE =
  /(?:^|[\s;&|("'\x60])(curl(?:\.exe)?|wget(?:\.exe)?)(?=[\s;&|)"'\x60]|$)/i

/** PowerShell's Invoke-WebRequest (or its alias). */
export const IWR_RE = /(?:^|[\s;&|("'\x60])(Invoke-WebRequest|iwr)(?=[\s;&|)"'\x60]|$)/i

/** `-OutFile` is what turns an Invoke-WebRequest into something sampleable. */
export const PS_OUTFILE_RE = /(?:^|\s)-OutFile(?=\s)/i

export const GIT_CLONE_RE = /\bgit\s+clone\b/i

/** Package managers that stream a known amount of traffic into a cache. */
export const PKG_RE =
  /\b(pnpm\s+(?:add|i|install)|npm\s+(?:i|install|add)|yarn\s+add|pip\s+install|uv\s+(?:add|pip)|docker\s+pull|ollama\s+pull)\b/i

/**
 * `curl -o <path>` / `--output <path>` / `--output-document <path>`.
 * Lowercase `-o` only: uppercase `-O` means "name it after the URL", which is
 * handled separately.
 */
const CURL_OUTFILE_RE = /(?:^|\s)(?:-o|--output|--output-document)\s+("([^"]+)"|'([^']+)'|(\S+))/g

/** PowerShell `-OutFile <path>`, same quoting rules. */
const PS_OUTFILE_ARG_RE = /(?:^|\s)-OutFile\s+("([^"]+)"|'([^']+)'|(\S+))/gi

/** `curl -O` / `--remote-name`: the target is `cwd/basename(url)`. */
const CURL_REMOTE_NAME_RE = /(?:^|\s)(?:-O|--remote-name)(?=\s|$)/

/**
 * Pull the path out of every match of a flag pattern.
 * Uses `matchAll` rather than a shared `.exec()` loop: a `/g` regex carries
 * `lastIndex` between calls, and a module-level constant reused across calls
 * would silently skip the first match on the second call.
 *
 * @param {string} command
 * @param {RegExp} pattern must carry the `g` flag
 * @returns {string[]} raw, still-quoted tokens
 */
function flagValues(command, pattern) {
  const out = []
  for (const match of command.matchAll(pattern)) {
    const value = match[2] || match[3] || match[4]
    if (value) out.push(value)
  }
  return out
}

/**
 * Filesystem paths a shell command is going to write to.
 *
 * Only literal paths are recoverable. A target built from a variable
 * (`-o $dst`, `-o "$OUT/x"`) stays unresolved on purpose: guessing would put a
 * confident progress bar on a file we cannot actually watch.
 *
 * @param {string} command shell command line
 * @param {string} cwd resolved working directory of the agent
 * @returns {string[]} absolute paths, de-duplicated
 */
export function extractTargets(command, cwd) {
  const out = []
  const base = cwd || process.cwd()

  /** Accept only something that looks like a path, then make it absolute. */
  const push = (raw) => {
    const clean = unquote(raw ?? '')
    // A leading `-` means the regex swallowed the next flag instead of a value.
    if (!clean || clean.startsWith('-')) return
    out.push(isAbsolute(clean) ? clean : resolve(base, clean))
  }

  for (const value of flagValues(command, CURL_OUTFILE_RE)) push(value)
  for (const value of flagValues(command, PS_OUTFILE_ARG_RE)) push(value)

  // `-O` takes the name from the URL, which is the only way to know the target
  // before the transfer starts.
  if (CURL_REMOTE_NAME_RE.test(command)) {
    const url = extractUrl(command)
    if (url) {
      try {
        push(basename(new URL(url).pathname))
      } catch {
        /* malformed URL: nothing to resolve */
      }
    }
  }

  // `git clone <url> <dir>`: the directory is the second positional argument.
  if (GIT_CLONE_RE.test(command)) {
    const fromClone = command.slice(command.search(GIT_CLONE_RE))
    const positional = fromClone.split(/\s+/).filter(Boolean).slice(2)
    const dir = positional.filter((token) => !token.startsWith('-'))[1]
    if (dir) push(dir)
  }

  return uniq(out)
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/**
 * Decide whether a dispatch deserves a card, and which shape it takes.
 *
 * @param {{name?: string, arguments?: Record<string, unknown>}} exec
 * @returns {null | {kind: 'search'|'fetch'|'install'|'download'|'pkg', label?: string, detail?: string, command?: string}}
 *   `null` means "not interesting": the caller then simply runs the tool.
 */
export function classify(exec) {
  const name = String(exec?.name ?? '')
  const args = exec?.arguments ?? {}

  if (SEARCH_TOOLS.has(name)) {
    const query = args.query ?? args.question ?? args.q ?? ''
    return {
      kind: 'search',
      // The headline is clipped; `detail` keeps the full query for the log line.
      label: clip(query, 50),
      detail: String(query ?? ''),
    }
  }

  if (FETCH_TOOLS.has(name)) {
    const url = args.url ?? ''
    return { kind: 'fetch', label: clip(url, 120), detail: String(url ?? '') }
  }

  // The tool is called `plugin_manager` (underscore); the host EVENTS it emits use
  // a hyphen (`plugin-manager/install-log`). Both spellings are accepted because
  // only the underscore one is real, and matching the hyphen form silently meant
  // install cards never appeared at all.
  if (name === 'plugin_manager' || name === 'plugin-manager') {
    const action = String(args.action ?? '')
    if (!action.includes('install')) return null
    return { kind: 'install', label: clip(args.target ?? args.name ?? '', 80) }
  }

  if (!SHELL_TOOLS.has(name)) return null

  const command = String(args.command ?? args.text ?? '')
  if (!command) return null

  // Invoke-WebRequest WITHOUT -OutFile buffers the page in memory: there is no
  // file to sample, so it must not be mistaken for a download.
  const writesFile = IWR_RE.test(command) && PS_OUTFILE_RE.test(command)
  if (CURL_WGET_RE.test(command) || GIT_CLONE_RE.test(command) || writesFile) {
    return { kind: 'download', command }
  }
  if (PKG_RE.test(command)) return { kind: 'pkg', command }

  return null
}

