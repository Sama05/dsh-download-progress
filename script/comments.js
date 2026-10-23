/**
 * Remove PowerShell comments: `#` to end of line, and `<# … #>` blocks.
 *
 * Both are prose. A comment that names a flag is documentation, not a parameter,
 * and scanning it produced real damage: this very module's own test script had a
 * header comment reading “用 Invoke-WebRequest -OutFile 落盘”, which yielded the
 * target `落盘（字节由` and titled the card with it. Worse, a script that merely
 * *documents* `-OutFile` while writing nothing would have produced a card that
 * could never move.
 *
 * Quote-aware, because `#` is an ordinary character inside a string: a URL
 * fragment (`…/file#part`) and a password can both contain one. A `#` also needs
 * a token boundary in front of it, otherwise `Set-Location D:\a#b` loses its path.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = ''
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      out += ch
      if (ch === '`' && quote === '"') {
        if (i + 1 < source.length) {
          out += source[i + 1]
          i += 1
        }
        continue
      }
      if (ch === quote) {
        // `''` inside a single-quoted string is a literal quote, not the end.
        if (source[i + 1] === quote) {
          out += quote
          i += 1
          continue
        }
        quote = ''
      }
      continue
    }
    if (ch === '<' && source[i + 1] === '#') {
      const end = source.indexOf('#>', i + 2)
      // An unterminated block comment swallows the rest, as PowerShell's does.
      i = end === -1 ? source.length : end + 1
      out += ' '
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === '#') {
      const prev = out[out.length - 1]
      if (prev === undefined || /[\s;({]/.test(prev)) {
        while (i + 1 < source.length && source[i + 1] !== '\n') i += 1
        continue
      }
    }
    out += ch
  }
  return out
}
