import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  MAX_SCRIPT_BYTES,
  FILE_FLAG_RE,
} from './tuning.js'

/**
 * Decode a script buffer the way PowerShell itself would.
 *
 * PowerShell writes BOM'd UTF-16LE when asked to, and plenty of scripts in the
 * wild are UTF-8 with or without a BOM. A binary file must come back `null`
 * rather than as mojibake, because mojibake could accidentally match a flag.
 *
 * @param {Buffer} buf
 * @returns {string | null}
 */
export function decodeScript(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  // No BOM. NUL bytes near the start mean UTF-16LE written by an older tool.
  if (buf.subarray(0, 64).includes(0)) return buf.toString('utf16le')
  const text = buf.toString('utf8')
  // U+FFFD means the bytes were not valid UTF-8: do not guess an ANSI codepage.
  if (text.includes('\uFFFD')) return null
  return text
}

/**
 * The script path named by a `-File` command, resolved against the agent's cwd.
 *
 * Pure: it resolves a path, and never reads the file.
 *
 * @param {string} command
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function scriptPathOf(command, cwd) {
  const m = FILE_FLAG_RE.exec(String(command ?? ''))
  if (!m) return null
  const raw = m[2] || m[3] || m[4]
  if (!raw) return null
  // A path PowerShell would expand at run time is not something to guess at.
  if (/[$%`]/.test(raw)) return null
  return path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw)
}

/**
 * Read the script a command names.
 *
 * @param {string} command
 * @param {string} [cwd]
 * @returns {{ path: string, body: string } | null}
 */
export function readScript(command, cwd) {
  const scriptPath = scriptPathOf(command, cwd)
  if (!scriptPath) return null
  const st = statSync(scriptPath)
  // A directory is a legitimate `-File` argument used to provoke an error
  // message; a script is a small text file.
  if (!st.isFile() || st.size === 0 || st.size > MAX_SCRIPT_BYTES) return null
  const body = decodeScript(readFileSync(scriptPath))
  return body === null ? null : { path: scriptPath, body }
}
