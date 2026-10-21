/**
 * Pure helpers shared by the Host half.
 *
 * Nothing in here touches the DSH runtime, the filesystem or module state: every
 * export is a plain function over strings and arrays. That keeps the "what does
 * this text say" logic testable on its own and stops the same three-line string
 * dance from being copy-pasted into every module.
 */

/**
 * Collapse runs of whitespace and hard-cut to `max` characters.
 * Used for every single-line label that ends up in a card (`log`, `label`), so
 * a multi-line command or pnpm block never turns into a tall wall of text.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clip(text, max = 50) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
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
  return String(raw ?? '')
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
  const match = String(command).match(/https?:\/\/[^\s"'<>]+/)
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
  return String(token).replace(/^["']|["']$/g, '')
}
