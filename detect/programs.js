/**
 * "Which program is this segment running?" — the tests that answer it.
 *
 * Every predicate here is a head test: a downloader only counts when it is the
 * thing being invoked, never when it is mentioned inside a string, a comment or
 * another command's argument.
 */

import { CURL_UPLOAD_RE, PS_SCRIPT_FILE_RE } from './patterns.js'

/**
 * The program a segment invokes, as a bare lower-case name.
 *
 * Downloaders are usually not on PATH, so the call arrives as a full path:
 * `& 'D:\tools\aria2\aria2c.exe' …`, `C:\Windows\System32\curl.exe …`. Matching
 * the head against `/^curl/` misses every one of those, and the card silently
 * never appears. Taking the basename of the first token keeps the "is this the
 * thing being run" test intact — `Get-Process "D:\x\aria2c.exe"` heads with
 * `Get-Process` and stays rejected.
 *
 * @param {string} segment a segment from commandSegments()
 * @returns {string} e.g. `aria2c`, or '' when the segment is empty
 */
export function headProgram(segment) {
  const s = segment.trim()
  if (!s) return ''
  let token
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1)
    token = end > 0 ? s.slice(1, end) : s.slice(1)
  } else {
    token = s.split(/[\s,;&|)]/, 1)[0]
  }
  const base = token.split(/[\\/]/).pop() || ''
  return base.replace(/\.exe$/i, '').toLowerCase()
}

/** Programs that transfer bytes to a file; the head of a segment must be one. */
export const DOWNLOADER_NAMES = new Set(['curl', 'wget', 'aria2c'])

/** Treats a segment as a downloader invocation, honouring a full path. */
export function runsDownloader(segment) {
  return DOWNLOADER_NAMES.has(headProgram(segment))
}

/**
 * Whether a segment is curl *sending* bytes instead of receiving them.
 *
 * The head test is what keeps `wget -T 60 -O out.bin <url>` — where `-T` is
 * `--timeout` — from being mistaken for an upload.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function runsCurlUpload(segment) {
  return headProgram(segment) === 'curl' && CURL_UPLOAD_RE.test(segment)
}

/** `Invoke-WebRequest` (or `iwr`) at the head of its segment. */
export function runsInvokeWebRequest(segment) {
  const name = headProgram(segment)
  return name === 'invoke-webrequest' || name === 'iwr'
}

/**
 * `git clone`, allowing flags between the two words (`git -C dir clone …`).
 *
 * The `clone` word must follow whitespace, so `git log --grep=clone` stays a
 * log command instead of being mistaken for a download.
 *
 * @param {string} segment
 */
export function isGitClone(segment) {
  return /^(?:git|git\.exe)(?=$|[\s])/i.test(segment) && /(?:^|\s)clone(?=\s|$)/i.test(segment)
}

/** Shells that take `-File` to mean "run this script". */
export const SCRIPT_HOSTS = new Set(['powershell', 'pwsh'])

/**
 * Whether a segment runs a script file through a PowerShell host.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function runsScriptFile(segment) {
  return SCRIPT_HOSTS.has(headProgram(segment)) && PS_SCRIPT_FILE_RE.test(segment)
}
