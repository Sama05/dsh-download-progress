/**
 * The decision: does this dispatch deserve a card, and which shape does it take?
 *
 * Kept last in the dependency order on purpose — it is the only module that reads
 * every other rule at once, so policy changes have exactly one place to land.
 */

import { clip, text } from '../utils.js'
import { FETCH_TOOLS, SEARCH_TOOLS, SHELL_TOOLS } from './tools.js'
import {
  MAX_SCAN_CHARS,
  PKG_RE,
  isGitClone,
  runsScriptFile,
} from './patterns.js'
import { commandSegments } from './segments.js'
import { transferOf, transferUploads } from './spec.js'

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/**
 * The human-readable subject of a search call.
 *
 * Every search tool in this Harness declares `queries: string[]` — one string
 * per query, usually just one. The singular spellings (`query`, `question`, `q`)
 * are kept because `research`, `domain_search` and `platform_search` still accept
 * a lone string, and because they cost nothing to look at first: an array is only
 * consulted when the singular forms are absent, so a tool that declares both is
 * read through its scalar.
 *
 * @param {Record<string, unknown>} args
 * @returns {string} '' when the call carries no query at all
 */
export function searchQuery(args) {
  const single = text(args?.query) || text(args?.question) || text(args?.q)
  if (single) return single
  const many = args?.queries
  if (Array.isArray(many)) {
    // Several queries in one call: join them so the card still names all of the
    // work, and let `clip()` cut it. An array of one is the normal case and reads
    // exactly like a scalar.
    return many.map(text).filter(Boolean).join(' · ')
  }
  return text(many)
}

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
    // `queries` is the only argument the real search tools declare — it is an
    // array, and every one of them takes several queries per call. Reading only
    // `query`/`question`/`q` therefore left the label empty on every genuine
    // call, and the card rendered as 正在搜索「…」中 with no subject at all.
    const query = searchQuery(args)
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
  // file to sample, so it must not be mistaken for a download. That rule, like
  // every other one about a specific program, lives in `spec.js`.
  //
  // Every test below runs on a *segment head*, never on the raw command line: a
  // downloader only counts when it is the thing being run. Testing the whole
  // line is what used to raise a card for `Get-Process curl`, for `# curl …` in
  // a comment, and for `Write-Host "use curl -o f u"` — none of which transfer
  // a byte, so each one left a card that could never move.
  const segments = commandSegments(scan)
  // Everything below tests the *segment text*, not the raw command line. String
  // literals and here-string payloads have been excluded by then, so a script
  // that merely contains `pip install …` or `Invoke-WebRequest -OutFile …` is
  // not mistaken for one that runs it.
  const code = segments.join('\n')
  // One table decides what counts as a transfer (`spec.js`). An upload is
  // excluded per *segment*, so a command that both uploads and downloads still
  // gets its download card: a card for the upload could only lie, since no file
  // grows on this end.
  const runsTransfer = segments.some(
    (segment) => transferOf(segment) !== null && !transferUploads(segment),
  )
  const runsClone = segments.some(isGitClone)
  const runsScript = segments.some(runsScriptFile)
  if (runsTransfer || runsClone || runsScript) {
    // `script` says "the destination is inside a file, not on this command line".
    // `beginTask()` then reads the script and drops the task outright when it
    // names no output path, so a `-File` that merely prints something never
    // leaves an empty card behind.
    return { kind: 'download', command, script: runsScript && !runsTransfer && !runsClone }
  }
  if (PKG_RE.test(code)) return { kind: 'pkg', command }

  return null
}
