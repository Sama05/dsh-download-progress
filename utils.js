/**
 * Pure helpers shared by the Host half.
 *
 * Nothing in here touches the DSH runtime, the filesystem or module state: every
 * export is a plain function over strings and arrays. That keeps the "what does
 * this text say" logic testable on its own and stops the same three-line string
 * dance from being copy-pasted into every module.
 */

/**
 * Coerce any value to a string without ever throwing.
 *
 * Plain `String(x)` throws for an object whose `toString`/`valueOf` are missing
 * or non-callable. That shape never comes out of JSON, but `classify()` and
 * `beginTask()` sit directly on the host's tool-dispatch path and receive
 * whatever the caller built — and a throw there does not fail one card, it
 * fails the dispatch. Everything user-supplied therefore goes through here.
 *
 * `null`/`undefined` become `''`; a bare object becomes `''` rather than the
 * useless `[object Object]`, so labels stay empty instead of showing noise.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function text(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    const out = String(value)
    return out === '[object Object]' ? '' : out
  } catch {
    return ''
  }
}

/**
 * Collapse runs of whitespace and hard-cut to `max` characters.
 * Used for every single-line label that ends up in a card (`log`, `label`), so
 * a multi-line command or pnpm block never turns into a tall wall of text.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clip(value, max = 50) {
  const flat = text(value).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * Non-empty trimmed lines, order preserved.
 * `firstLine` and `lastLine` both need exactly this, so it lives once and both
 * of them are one-liners on top of it.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function nonEmptyLines(raw) {
  return text(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** First non-empty line, or ''. */
export function firstLine(raw) {
  const lines = nonEmptyLines(raw)
  return lines.length ? lines[0] : ''
}

/**
 * Last non-empty line, or ''.
 * Cards show only the newest line of a streamed log, never a tail dump.
 */
export function lastLine(raw) {
  const lines = nonEmptyLines(raw)
  return lines.length ? lines[lines.length - 1] : ''
}

/**
 * First http(s) URL found in a command line, or ''.
 * Deliberately stops at whitespace and shell quotes: we only want the URL for a
 * HEAD probe and for the card's log line, not a full command parser.
 *
 * @param {unknown} command
 * @returns {string}
 */
export function extractUrl(command) {
  const match = text(command).match(/https?:\/\/[^\s"'<>]+/)
  return match ? match[0] : ''
}

/**
 * De-duplicate while preserving first-seen order.
 * `extractTargets` can legitimately see the same path twice (`-o x` plus
 * `--output x`), and duplicate targets would make the byte counter read the same
 * file twice.
 *
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
export function uniq(list) {
  return [...new Set(list)]
}

/**
 * Strip one layer of surrounding quotes from a shell token.
 * Handles both `"path with spaces"` and `'path with spaces'`.
 *
 * @param {string} token
 * @returns {string}
 */
export function unquote(token) {
  return text(token).replace(/^["']|["']$/g, '')
}
