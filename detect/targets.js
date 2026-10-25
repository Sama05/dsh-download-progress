/**
 * Filesystem paths a shell command is going to write to.
 *
 * The one path-shaped question in `detect/`, and still a pure function of the
 * command string plus a cwd: it resolves, it never stats. Anything it cannot
 * resolve is dropped rather than guessed — a card on a path that never exists
 * stays at 0 % and reads as a broken plugin.
 */

import { basename, isAbsolute, resolve } from 'node:path'
import { extractUrl, text, uniq, unquote } from '../utils.js'
import { commandSegments } from './segments.js'
import { collectAssignments, effectiveCwd, resolveVar } from './vars.js'
import {
  ARG_LIST_RE,
  ARIA_DIR_RE,
  ARIA_OUTFILE_RE,
  GIT_CLONE_RE,
  OUTFILE_FLAGS,
  flagValues,
  psArrayTokens,
} from './patterns.js'
import { lastPositional, transferOf } from './spec.js'
import { decodeUrlName, remoteFileName } from './remote.js'

/** Anything that names a remote resource rather than a path on this disk. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Output paths named inside a PowerShell `-ArgumentList`.
 *
 * Only the flag-then-value shape is recovered; anything else stays unresolved,
 * for the same reason a `$variable` target does.
 *
 * @param {string} command
 * @returns {string[]} raw, still-quoted tokens
 */
export function argListTargets(command) {
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
 * A literal path is used as-is. A path that was assigned to a plain variable
 * earlier on the same command line (`$o = 'D:\x.iso'` … `-o $o`) is resolved
 * through that assignment, because that spelling is the normal way to write a
 * download in PowerShell and refusing it left the card watching
 * `D:\cwd\$o` — a file that never exists. Anything more computed than a single
 * literal assignment (`-o "$dir/$name"`) stays unresolved: guessing would put a
 * confident bar on a file we cannot actually watch.
 *
 * A `cd` earlier on the line moves the base directory for every relative path,
 * including the name aria2c derives from its URL.
 *
 * @param {string} command shell command line
 * @param {string} cwd resolved working directory of the agent
 * @returns {string[]} absolute paths, de-duplicated
 */
export function extractTargets(command, cwd) {
  const out = []
  // Tolerate a missing command line rather than throwing inside a tool dispatch:
  // this runs from a waterfall listener, where a throw would fail the very tool
  // call the plugin is only observing.
  const raw = text(command)
  // Scan the *code* only: a here-string that happens to carry `-OutFile x` is
  // file contents being written, not a path this command writes.
  const segments = commandSegments(raw)
  const source = segments.join('\n')
  const vars = collectAssignments(source)
  const base = effectiveCwd(segments, cwd || process.cwd())

  /** Accept only something that looks like a path, then make it absolute. */
  const push = (raw) => {
    const clean = unquote(resolveVar(raw ?? '', vars))
    // A leading `-` means the regex swallowed the next flag instead of a value.
    if (!clean || clean.startsWith('-')) return
    // Still a variable, or something interpolated we cannot evaluate: a card on a
    // guessed path is worse than no card, because it silently watches nothing.
    if (/[$%]/.test(clean)) return
    // A URL is not a path. `Start-BitsTransfer <url>` takes the source as its
    // only positional and derives the file name itself, so the `last` row would
    // otherwise produce `D:\work\https:\x\a.iso` — a path nothing will ever write.
    if (URL_SCHEME_RE.test(clean)) return
    if (isAbsolute(clean)) {
      out.push(clean)
      return
    }
    // A relative path in a command whose working directory we lost could point
    // anywhere; watching the wrong file is exactly the bug this guards against.
    if (base === null) return
    out.push(resolve(base, clean))
  }

  // Which downloader is running decides which flag table applies. Those tables
  // live in `spec.js` — one row per program — so a new downloader needs no edit
  // here at all. Applying every table to every segment is what used to put two
  // targets on one aria2c card: the cwd guess and the real one. Same head test as
  // classify(): a downloader called by full path has to select the same flag
  // table as a bare one, or the card appears and then watches the wrong file.
  //
  // Rows that own a directory flag are skipped on purpose: their `-o` is relative
  // to `-d`, not to the cwd, and resolving it here would add the wrong guess
  // alongside the right one. They are handled by their own block below.
  for (const segment of segments) {
    const entry = transferOf(segment)
    if (!entry || entry.dir) continue
    for (const value of flagValues(source, entry.out)) push(value)
    // `-O` / `--remote-name`: the name comes from the URL, which is the only way
    // to know the target before the transfer starts. Per row, because the same
    // letter means the opposite thing to curl and to wget.
    if (entry.remoteName && entry.remoteName.test(source)) {
      const remote = remoteFileName(source)
      if (remote) push(remote)
    }
    // `certutil -urlcache -split -f <url> <path>`: the destination is the last
    // positional argument, not a named flag.
    if (entry.last) push(lastPositional(segment))
  }

  // A `-ArgumentList '-OutFile','x'` is a downloader launch written as data, so
  // the row above cannot see it: the flags are string tokens, not a command line.
  for (const value of argListTargets(source)) push(value)

  // aria2c: `-o` is relative to `-d` (default: the cwd), so the directory flag
  // has to be applied before the name means anything.
  if (segments.some((segment) => transferOf(segment)?.dir)) {
    const rawDir = unquote(resolveVar(flagValues(source, ARIA_DIR_RE)[0] || '', vars))
    // A directory we cannot resolve (`-d $out`, `-d "$base/x"`, or a relative
    // `-d` under a `cd` we could not follow) leaves the target ambiguous, so
    // every name under it is skipped rather than guessed.
    const dir = /[$%]/.test(rawDir)
      ? null
      : rawDir
        ? isAbsolute(rawDir)
          ? rawDir
          : base === null
            ? null
            : resolve(base, rawDir)
        : base
    // `flagValues` is the authority on whether `-o` was given: it consumes the
    // global regex (resetting `lastIndex`) and returns the parsed values, so a
    // stray `test()` on the same pattern cannot leave it half-consumed.
    const named = flagValues(source, ARIA_OUTFILE_RE)
    let explicit = false
    for (const value of named) {
      if (dir === null) break
      const name = unquote(resolveVar(value, vars))
      if (!name || name.startsWith('-')) continue
      explicit = true
      push(isAbsolute(name) ? name : resolve(dir, name))
    }

    // Without `-o`, aria2c names the file after the last path segment of the URL
    // and writes it into `-d` (default: the cwd). That is the *most* common way to
    // call aria2c — `aria2c <url>` — and skipping it meant no card at all for a
    // perfectly ordinary download. The segment is percent-decoded first, because
    // aria2c decodes it before using it as a file name (curl -O does not, which is
    // why `remoteFileName` stays raw and the decoding happens here).
    if (!explicit && dir !== null) {
      const remote = remoteFileName(source)
      if (remote) push(resolve(dir, decodeUrlName(remote)))
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
