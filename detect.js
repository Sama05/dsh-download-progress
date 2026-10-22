/**
 * Tool-call recognition for the Host half.
 *
 * Answers one question: "is this tool call downloading, installing, fetching or
 * searching, and if it writes a file, where?" Everything here is a pure function
 * of the tool name plus its arguments — it never reads the filesystem and never
 * touches task state, which is why the rules can be reviewed in one screen.
 */
import { basename, isAbsolute, resolve } from 'node:path'
import { clip, extractUrl, text, uniq, unquote } from './utils.js'

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
 * Where one command ends and the next begins.
 *
 * Shell separators are the obvious half. Quotes are in here too, on purpose:
 * `pwsh -c "curl -o x y"` then yields a segment that begins with `curl`, while
 * `Write-Host "use curl -o f u"` yields one that begins with `use`. That is the
 * whole distinction between *running* a downloader and merely mentioning one —
 * and getting it wrong is what used to raise a progress card for
 * `Get-Process curl` or for the word `curl` inside a comment.
 */
const SEGMENT_SPLIT_RE = /[;&|\n(){}"'`]/

/** A downloader standing at the head of its segment, not mid-argument. */
const DOWNLOADER_HEAD_RE = /^(?:curl|wget)(?:\.exe)?(?=$|[\s,;&|)])/i

/** `Invoke-WebRequest` (or `iwr`) at the head of its segment. */
const IWR_HEAD_RE = /^(?:Invoke-WebRequest|iwr)(?=$|[\s,;&|)])/i

/**
 * Split a command line into the segments that could each be an invocation.
 *
 * A leading `&` (PowerShell's call operator) or `\` is dropped so `& curl …`
 * still reads as a downloader. Nothing else is rewritten: the point is only to
 * find where a command *starts*.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function commandSegments(command) {
  return text(command)
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => segment.trim().replace(/^[&\\]+/, ''))
    .filter(Boolean)
}

/**
 * `git clone`, allowing flags between the two words (`git -C dir clone …`).
 *
 * The `clone` word must follow whitespace, so `git log --grep=clone` stays a
 * log command instead of being mistaken for a download.
 *
 * @param {string} segment
 */
function isGitClone(segment) {
  return /^(?:git|git\.exe)(?=$|[\s])/i.test(segment) && /(?:^|\s)clone(?=\s|$)/i.test(segment)
}

/** `-OutFile` is what turns an Invoke-WebRequest into something sampleable. */
export const PS_OUTFILE_RE = /(?:^|\s)-OutFile(?=\s)/i

/**
 * Where `git clone` starts, for slicing out its positional arguments.
 * Deliberately looser than {@link isGitClone}: this only locates the command, it
 * never decides whether a card is raised.
 */
export const GIT_CLONE_RE = /\bgit\b[^|;&]*?\bclone\b/i

/** Package managers that stream a known amount of traffic into a cache. */
export const PKG_RE =
  /\b(pnpm\s+(?:add|i|install)|npm\s+(?:i|install|add)|yarn\s+add|pip\s+install|uv\s+(?:add|pip)|docker\s+pull|ollama\s+pull)\b/i

/**
 * How much of a command line is worth scanning.
 *
 * Agents sometimes inline whole files into `pwsh -Command "..."`. Every pattern
 * here is anchored near the start, so the tail is pure cost: a large regex pass
 * on the host main thread, once per dispatch, on data that cannot match.
 */
const MAX_SCAN_CHARS = 20000

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
 * wget's `-O` means "write to this file", which is the *opposite* of curl's `-O`.
 * Treating the two the same used to put `wget -O out.bin …` on a card watching
 * the URL's own basename — a file the transfer never touches.
 *
 * The `--output-document=path` spelling is left alone on purpose: it is rare,
 * and a half-parsed flag would be worse than the honest "unresolved".
 */
const WGET_OUTFILE_RE = /(?:^|\s)(?:-O|--output-document)\s+("([^"]+)"|'([^']+)'|(\S+))/g

/** Flags that name the file a downloader writes. */
const OUTFILE_FLAGS = new Set(['-o', '--output', '--output-document', '-outfile'])

/** `-ArgumentList …` / `-Args …`: the array form hides the flag behind commas. */
const ARG_LIST_RE = /-(?:ArgumentList|Args)\s+/i

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
 * Split a PowerShell argument list into tokens.
 *
 * `Start-Process -ArgumentList '-L','-o','out.bin','https://…'` hands the child
 * process an array; the `-o` and its value are two comma-separated items, so the
 * whitespace-anchored flag regexes cannot see them. Quoted and bare tokens are
 * both accepted.
 *
 * @param {string} value text after `-ArgumentList`
 * @returns {string[]}
 */
function psArrayTokens(value) {
  const tokens = []
  for (const match of value.matchAll(/'([^']*)'|"([^"]*)"|([^,\s]+)/g)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== undefined) tokens.push(token)
  }
  return tokens
}

/**
 * Output paths named inside a PowerShell `-ArgumentList`.
 *
 * Only the flag-then-value shape is recovered; anything else stays unresolved,
 * for the same reason a `$variable` target does.
 *
 * @param {string} command
 * @returns {string[]} raw, still-quoted tokens
 */
function argListTargets(command) {
  const out = []
  const match = ARG_LIST_RE.exec(command)
  if (!match) return out
  const tokens = psArrayTokens(command.slice(match.index + match[0].length))
  for (let i = 0; i < tokens.length; i += 1) {
    if (!OUTFILE_FLAGS.has(tokens[i].toLowerCase())) continue
    const next = tokens[i + 1]
    if (next !== undefined) out.push(next)
    i += 1
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
  // Tolerate a missing command line rather than throwing inside a tool dispatch:
  // this runs from a waterfall listener, where a throw would fail the very tool
  // call the plugin is only observing.
  const source = text(command)

  /** Accept only something that looks like a path, then make it absolute. */
  const push = (raw) => {
    const clean = unquote(raw ?? '')
    // A leading `-` means the regex swallowed the next flag instead of a value.
    if (!clean || clean.startsWith('-')) return
    out.push(isAbsolute(clean) ? clean : resolve(base, clean))
  }

  for (const value of flagValues(source, CURL_OUTFILE_RE)) push(value)
  for (const value of flagValues(source, PS_OUTFILE_ARG_RE)) push(value)
  for (const value of argListTargets(source)) push(value)

  // `-O` is read differently per downloader, so the head of the command decides
  // which flag table applies.
  const heads = commandSegments(source)
  const hasCurl = heads.some((segment) => /^curl(?:\.exe)?(?=$|[\s,;&|)])/i.test(segment))
  const hasWget = heads.some((segment) => /^wget(?:\.exe)?(?=$|[\s,;&|)])/i.test(segment))

  if (hasWget) for (const value of flagValues(source, WGET_OUTFILE_RE)) push(value)

  // `-O` takes the name from the URL, which is the only way to know the target
  // before the transfer starts. curl only: see WGET_OUTFILE_RE above.
  if (hasCurl && CURL_REMOTE_NAME_RE.test(source)) {
    const url = extractUrl(source)
    if (url) {
      try {
        push(basename(new URL(url).pathname))
      } catch {
        /* malformed URL: nothing to resolve */
      }
    }
  }

  // `git clone [flags] <repo> [dir]`: the local directory is the first positional
  // argument AFTER the repository. Taking "the last non-flag token" is wrong for
  // `--depth 1` — the flag's own value sits in the token stream and would be read
  // as the directory. Anchoring on the repository instead makes the flag order
  // irrelevant.
  if (GIT_CLONE_RE.test(source)) {
    const fromClone = source.slice(source.search(GIT_CLONE_RE))
    const tokens = fromClone.split(/\s+/).filter(Boolean).slice(2)
    const isRepo = (token) =>
      /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^[\w.-]+@[\w.-]+:/.test(token)
    const repoAt = tokens.findIndex(isRepo)
    let dir = ''
    if (repoAt >= 0) {
      dir = tokens.slice(repoAt + 1).find((token) => !token.startsWith('-')) || ''
    } else {
      // scp-style remote without a scheme: the repo is the first positional.
      const positional = tokens.filter((token) => !token.startsWith('-'))
      dir = positional[1] || ''
    }
    if (dir) push(dir)
    else {
      // No directory given: git names it after the repository.
      const url = extractUrl(fromClone)
      if (url) {
        try {
          push(basename(new URL(url).pathname).replace(/\.git$/, ''))
        } catch {
          /* malformed URL: nothing to resolve */
        }
      }
    }
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
  const name = text(exec?.name)
  const args = exec?.arguments ?? {}

  if (SEARCH_TOOLS.has(name)) {
    const query = args.query ?? args.question ?? args.q ?? ''
    return {
      kind: 'search',
      // The headline is clipped; `detail` keeps the full query for the log line.
      label: clip(query, 50),
      detail: text(query),
    }
  }

  if (FETCH_TOOLS.has(name)) {
    const url = args.url ?? ''
    return { kind: 'fetch', label: clip(url, 120), detail: text(url) }
  }

  // The tool is called `plugin_manager` (underscore); the host EVENTS it emits use
  // a hyphen (`plugin-manager/install-log`). Both spellings are accepted because
  // only the underscore one is real, and matching the hyphen form silently meant
  // install cards never appeared at all.
  if (name === 'plugin_manager' || name === 'plugin-manager') {
    const action = text(args.action)
    if (!action.includes('install')) return null
    return { kind: 'install', label: clip(args.target ?? args.name ?? '', 80) }
  }

  if (!SHELL_TOOLS.has(name)) return null

  const command = text(args.command ?? args.text)
  if (!command) return null

  // An agent can inline an entire file into `pwsh -Command "..."`. The command
  // patterns below are all anchored near the start, so scanning past this point
  // buys nothing and costs the host main thread a full regex pass per tick.
  const scan =
    command.length > MAX_SCAN_CHARS ? command.slice(0, MAX_SCAN_CHARS) : command

  // Invoke-WebRequest WITHOUT -OutFile buffers the page in memory: there is no
  // file to sample, so it must not be mistaken for a download.
  //
  // Every test below runs on a *segment head*, never on the raw command line: a
  // downloader only counts when it is the thing being run. Testing the whole
  // line is what used to raise a card for `Get-Process curl`, for `# curl …` in
  // a comment, and for `Write-Host "use curl -o f u"` — none of which transfer
  // a byte, so each one left a card that could never move.
  const segments = commandSegments(scan)
  const runsDownloader = segments.some((segment) => DOWNLOADER_HEAD_RE.test(segment))
  const runsClone = segments.some(isGitClone)
  const writesFile = segments.some((segment) => IWR_HEAD_RE.test(segment)) && PS_OUTFILE_RE.test(scan)
  if (runsDownloader || runsClone || writesFile) {
    return { kind: 'download', command }
  }
  if (PKG_RE.test(scan)) return { kind: 'pkg', command }

  return null
}

