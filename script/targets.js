import { OUT_FLAG_RE } from './tuning.js'
import { collectAssignments, resolveValue } from './vars.js'
import { stripComments } from './comments.js'

/**
 * Every output path named in a script body, resolved where possible.
 *
 * @param {string} body script source
 * @param {Record<string, string>} [env]
 * @returns {string[]} paths in source order, deduplicated
 */
export function scriptTargets(body, env) {
  const text = stripComments(String(body ?? ''))
  if (!text) return []
  const vars = collectAssignments(text)
  const found = []
  const seen = new Set()
  OUT_FLAG_RE.lastIndex = 0
  let m
  while ((m = OUT_FLAG_RE.exec(text))) {
    const rest = text.slice(m.index + m[0].length)
    const valueMatch = /^\s*(?::|=)?\s*("[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s;|&)]+)/.exec(rest)
    if (!valueMatch) continue
    const resolved = resolveValue(valueMatch[1], vars, env)
    if (!resolved) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    found.push(resolved)
  }
  return found
}

/**
 * URL literals in a script body.
 *
 * Only used to learn a `Content-Length` for the denominator — the command line
 * `powershell -File x.ps1` carries no URL at all, so without this the card can
 * show bytes and speed but never a percentage. A script with several distinct
 * literal URLs is ambiguous (which one is the download?) and yields nothing,
 * because a wrong denominator is worse than an indeterminate ring.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function scriptUrls(body) {
  const text = stripComments(String(body ?? ''))
  if (!text) return []
  const out = []
  const seen = new Set()
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`)]+/g)) {
    // Strip trailing punctuation a sentence may have left attached.
    const url = match[0].replace(/[.,;:]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
