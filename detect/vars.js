/**
 * Plain variable assignments, and the working directory a command runs in.
 *
 * Both answer "what does this path actually mean", which is why they sit between
 * the splitter and the target extractor rather than inside either. Only a single
 * quoted or bare literal is ever resolved; anything computed stays unknown on
 * purpose, because a guessed path is a card that watches nothing.
 */

import { isAbsolute, resolve } from 'node:path'
import { text, unquote } from '../utils.js'
import { commandSegments } from './segments.js'

/**
 * Plain variable assignments in a command line: `$o = 'path'`, `$o="path"`,
 * `o=/path` for bash.
 *
 * Only a single quoted or bare literal is recorded. `$a = Get-Date`, `$b = $a + '/x'`
 * and anything else computed is skipped, so a lookup miss is honest.
 *
 * @param {string} source code-only command text
 * @returns {Map<string, string>} lower-cased name (no sigil) → value
 */
export function collectAssignments(source) {
  const vars = new Map()
  const re = /(?:^|[\s;&|])\$?([A-Za-z_][\w.]*)\s*=\s*("([^"$`]*)"|'([^']*)'|([^\s;&|'"$`]+))/g
  for (const match of source.matchAll(re)) {
    const name = match[1].toLowerCase()
    const value = match[3] ?? match[4] ?? match[5]
    if (value !== undefined && value !== '') vars.set(name, value)
  }
  return vars
}

/**
 * Substitute a bare `$name` / `${name}` / `$env:NAME`-free variable reference.
 *
 * A reference embedded in a larger string (`"$dir/x"`) is deliberately left
 * alone: the caller then rejects the result rather than resolving half of it.
 *
 * @param {string} value raw token, possibly quoted
 * @param {Map<string, string>} vars
 * @returns {string}
 */
export function resolveVar(value, vars) {
  const bare = value.match(/^\$?\{?([A-Za-z_][\w.]*)\}?$/)
  if (!bare) return value
  const hit = vars.get(bare[1].toLowerCase())
  return hit === undefined ? value : hit
}

/**
 * The directory the rest of a command line runs in, after honouring `cd`.
 *
 * `cd D:\Downloads` followed by `aria2c <url>` is the ordinary way to download
 * into a chosen folder, and the relative name aria2c derives from the URL only
 * resolves against that directory. Ignoring the `cd` made the card watch
 * `<agent cwd>\<name>` — a file that never exists — so it sampled 0 bytes forever
 * and was retired as "settled" three seconds in, while the transfer ran at full
 * speed. The card was reported as missing entirely.
 *
 * @param {string[]} segments command segments, in execution order
 * @param {string} initial the agent's own working directory
 * @returns {string | null} absolute directory, or null when it cannot be known
 */
export function effectiveCwd(segments, initial) {
  let dir = initial || null
  for (const segment of segments) {
    const match = segment.match(/^\s*(?:cd|chdir|sl|set-location)\s+(?:-path\s+)?(.+)$/i)
    if (!match) continue
    let value = match[1].trim().replace(/[;&|]+\s*$/, '').trim()
    value = unquote(value)
    if (!value || value === '~') {
      // Bare `cd` goes home, which we cannot resolve portably: treat as unknown
      // rather than keeping a directory that is now wrong.
      dir = null
      continue
    }
    if (/[$%]/.test(value)) {
      dir = null
      continue
    }
    dir = isAbsolute(value) ? value : dir === null ? null : resolve(dir, value)
  }
  return dir
}

/**
 * The directory a command really runs in, once its `cd` segments are applied.
 *
 * Exported for `state.js`: an `aria2c -i list.txt` manifest names its outputs
 * relative to the directory the downloader ends up in, which is the agent's
 * working directory *after* any `cd` earlier in the same command. Ignoring that
 * resolved every batch target against the session directory instead, so the card
 * watched files that did not exist and sat at 0 B for the whole transfer.
 *
 * @param {string} command shell command line
 * @param {string} [cwd] the agent's own working directory
 * @returns {string | null}
 */
export function commandWorkingDirectory(command, cwd) {
  return effectiveCwd(commandSegments(text(command)), cwd || null)
}
