/**
 * The name a URL asks to be saved as.
 *
 * Separate from `targets.js` because it answers the *label* question ("what am I
 * downloading") as well as the destination one, and because the two downloaders
 * disagree: aria2c percent-decodes the last segment before using it as a file
 * name, and curl `-O` does not.
 */

import { basename } from 'node:path'
import { extractUrl } from '../utils.js'

/**
 * The name of the thing being downloaded, taken from the URL itself.
 *
 * Why this outranks the output path: a card answers "what am I downloading",
 * not "which temporary file is growing on disk". The two differ whenever one
 * command writes several files — a segmented/parallel download writes
 * `part1.bin … part8.bin` for a single ISO, and a mirror grab writes a temp name
 * before renaming. Labelling those by `targets[0]` showed an arbitrary fragment
 * (`part1.bin`) instead of the file the user asked for.
 *
 * Returns '' when the URL has no usable basename (a bare origin, a directory, or
 * a query-only endpoint like `/download?id=5`), so the caller falls back to the
 * resolved output path.
 *
 * @param {unknown} command shell command line
 * @returns {string}
 */
export function remoteFileName(command) {
  const url = extractUrl(command)
  if (!url) return ''
  try {
    const name = basename(new URL(url).pathname)
    return name && name !== '/' && name !== '.' ? name : ''
  } catch {
    /* malformed URL: let the caller fall back to the output path */
    return ''
  }
}

/**
 * Decode the `%xx` escapes in a remote file name.
 *
 * aria2c percent-decodes the last URL segment before using it as a file name, so
 * `My%20File.iso` lands on disk as `My File.iso`. Resolving the raw form would
 * point the card at a file that never exists. curl `-O` does *not* decode, which
 * is why this is opt-in at the aria2c call site rather than folded into
 * `remoteFileName`.
 *
 * @param {string} name raw basename from the URL
 * @returns {string}
 */
export function decodeUrlName(name) {
  try {
    return decodeURIComponent(name)
  } catch {
    /* a stray `%` is not an escape sequence: keep the literal name */
    return name
  }
}
