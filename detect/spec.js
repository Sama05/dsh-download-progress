/**
 * The transfer registry: one row per program that writes bytes to disk.
 *
 * Everything the plugin knows about a downloader lives here — how to recognise
 * it, which flag names its file, whether it uploads instead, whether its target
 * is measurable at all. `classify.js` and `targets.js` read this table instead of
 * carrying their own copies, so adding a downloader is one row and no logic. The
 * alternative, which this replaced, was four separate `some()` chains plus five
 * hard-coded `if (hasCurl) … if (hasWget) …` blocks that had to be kept in step
 * by hand: `--output=path` was taught to one of them and not the other, which is
 * exactly how a card ends up classified as a download with no target to watch.
 *
 * A row says:
 *   `heads`     lower-case program names, as `headProgram()` reports them
 *   `out`       flag naming the output file (read with `flagValues`)
 *   `dir`       flag naming the directory `out` is relative to
 *   `input`     flag naming a batch manifest
 *   `remoteName`flag meaning "name the file after the URL"
 *   `upload`    flag meaning "these bytes travel the other way"
 *   `needsOut`  only interesting when `out` is present (see iwr)
 *   `action`    a sub-command that must appear (see certutil)
 *   `last`      the target is the last positional token (never `out`)
 *   `staged`    the program writes somewhere else and renames on completion
 */

import {
  ARIA_DIR_RE,
  ARIA_INPUT_RE,
  ARIA_OUTFILE_RE,
  CURL_OUTFILE_RE,
  CURL_REMOTE_NAME_RE,
  CURL_UPLOAD_RE,
  PS_OUTFILE_ARG_RE,
  WGET_OUTFILE_RE,
  headProgram,
} from './patterns.js'

/**
 * `certutil` is a certificate tool with a hundred sub-commands, exactly one of
 * which (`-urlcache`) fetches a URL into a file.
 */
const CERTUTIL_URL_RE = /(?:^|\s)-urlcache(?=\s|$)/i

/**
 * `Start-BitsTransfer` writes into `BITxxxx.tmp` and renames the finished file
 * into `-Destination` at the end (measured: the destination does not exist at
 * all until the transfer completes). There is therefore nothing to sample while
 * it runs, and a bar on the destination would sit at 0 % for the whole transfer.
 * It is registered with `staged` so the wire can say so, and with `last` because
 * the destination is the last positional — the target is still known, it is the
 * *growth* that cannot be watched.
 */
export const TRANSFERS = [
  {
    id: 'curl',
    heads: new Set(['curl']),
    out: CURL_OUTFILE_RE,
    remoteName: CURL_REMOTE_NAME_RE,
    upload: CURL_UPLOAD_RE,
  },
  { id: 'wget', heads: new Set(['wget']), out: WGET_OUTFILE_RE },
  {
    id: 'aria2c',
    heads: new Set(['aria2c']),
    out: ARIA_OUTFILE_RE,
    dir: ARIA_DIR_RE,
    input: ARIA_INPUT_RE,
  },
  {
    id: 'iwr',
    heads: new Set(['invoke-webrequest', 'iwr']),
    out: PS_OUTFILE_ARG_RE,
    // Without `-OutFile` the response is buffered in memory: no file is written,
    // and a card would have nothing to watch.
    needsOut: true,
  },
  { id: 'bits', heads: new Set(['start-bitstransfer']), staged: true, last: true },
  {
    id: 'certutil',
    heads: new Set(['certutil']),
    action: CERTUTIL_URL_RE,
    // `certutil -urlcache -split -f <url> <path>`: two positionals, the second
    // one is the file. Shape assumed rather than measured — certutil cannot be
    // spawned from this machine (EPERM), so `ponytail:` if it ever turns out to
    // stage its output as well, fold it into `staged` and drop `last`.
    last: true,
  },
]

/** The registry row for a segment's program, or null. */
export function transferOf(segment) {
  const name = headProgram(segment)
  if (!name) return null
  for (const entry of TRANSFERS) {
    if (!entry.heads.has(name)) continue
    if (entry.action && segment.search(entry.action) < 0) continue
    if (entry.needsOut && (!entry.out || segment.search(entry.out) < 0)) continue
    return entry
  }
  return null
}

/**
 * Whether a segment sends bytes out instead of pulling them in.
 *
 * Only curl has an upload flag; `wget -T 60` is a *timeout*, and treating any
 * `-T` as an upload would silently drop a perfectly ordinary download.
 */
export function transferUploads(segment) {
  const entry = transferOf(segment)
  return Boolean(entry?.upload && segment.search(entry.upload) >= 0)
}

/** Whether this program finishes its file by renaming a staging copy. */
export function transferIsStaged(segment) {
  return Boolean(transferOf(segment)?.staged)
}

/** The last non-flag token of a command line, or '' when there is none. */
export function lastPositional(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  const positionals = tokens.filter((token) => !token.startsWith('-'))
  // `[head, …]`: a lone head names no output at all.
  return positionals.length > 1 ? positionals[positionals.length - 1] : ''
}
