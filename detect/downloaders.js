/**
 * aria2c and git — the two downloaders that are not "one flag names one file".
 *
 * aria2c preallocates its target, writes relative to `-d`, and can keep every real
 * target inside an `-i` manifest; git clone writes a directory tree that
 * `stat().size` cannot measure. Both exceptions are answered here, once, instead
 * of being re-derived in `state.js`.
 */

import { text, unquote } from '../utils.js'
import { commandSegments } from './segments.js'
import { collectAssignments, resolveVar } from './vars.js'
import { ARIA_DIR_RE, ARIA_INPUT_RE, flagValues, headProgram, isGitClone } from './patterns.js'

/**
 * Whether a command line runs aria2c, as opposed to merely mentioning it.
 *
 * aria2c is the only downloader here that preallocates its target to the final
 * length before the first byte arrives, which makes `stat()` useless for the
 * whole transfer; it is also the only one whose `.aria2` sidecar carries the
 * truth. Both quirks in state.js are keyed off this test.
 *
 * Anchored on the head of a segment, like `classify()`: a full path
 * (`& 'D:\tools\aria2\aria2c.exe' …`) and a bare name both count, while
 * `Get-Process aria2c` does not.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function runsAria2(command) {
  return commandSegments(command).some((segment) => headProgram(segment) === 'aria2c')
}

/**
 * Whether a command line really runs `git clone`, as opposed to mentioning it.
 *
 * Exported for `state.js`: a clone target is a *directory*, and `stat().size` on
 * a directory is 0 on Windows, so the ordinary file sampler can never measure it.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function runsGitClone(command) {
  return commandSegments(command).some(isGitClone)
}

/**
 * The `-i`/`--input-file` list and `-d` directory of an aria2c call, unresolved.
 *
 * `aria2c -i list.txt` keeps every real target *inside* the list file, so the
 * command line alone names no output at all and the card had nothing to watch.
 * This returns the two raw values (still relative, still possibly a variable)
 * for the Host half to resolve and read — `detect.js` stays filesystem-free so
 * it can still be unit-tested as a pure string parser.
 *
 * @param {string} command shell command line
 * @returns {{ input: string, dir: string } | null} null when this is not a bulk run
 */
export function aria2InputSpec(command) {
  const source = commandSegments(text(command)).join('\n')
  if (!commandSegments(source).some((segment) => headProgram(segment) === 'aria2c')) return null
  const vars = collectAssignments(source)
  const input = unquote(resolveVar(flagValues(source, ARIA_INPUT_RE)[0] || '', vars))
  // A leading `-` means the regex swallowed the next flag instead of a value.
  if (!input || input.startsWith('-')) return null
  const dir = unquote(resolveVar(flagValues(source, ARIA_DIR_RE)[0] || '', vars))
  return { input, dir: dir && !dir.startsWith('-') ? dir : '' }
}
