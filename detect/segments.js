/**
 * Splitting a command line into the pieces that could each be an invocation.
 *
 * This is the module the rest of `detect/` depends on, and the one that must not
 * grow a second job: it finds where a command *starts*; nothing here decides
 * whether a command is interesting.
 */

import { text } from '../utils.js'
import { ARG_LIST_RE, headProgram, psArrayTokens } from './patterns.js'

/** Where one command ends and the next begins (outside quotes). */
const SEGMENT_SPLIT_RE = /[;&|\n(){}`]/

/**
 * A here-string body: `@'` … `'@` or `@"` … `"@`, delimited by lines.
 *
 * Its contents are *data*, not commands. Agents write whole scripts this way, and
 * a script that runs `curl -o x.iso …` must not raise a card while it is still
 * just text being saved to disk — the card would watch a file that nobody is
 * writing, and stay at 0 % until it aged out.
 */
const HERESTRING_RE = /@(['"])[\r\n][\s\S]*?[\r\n]\1@/g

/** A shell that can run a command string inline (`pwsh -c "…"`, `bash -c '…'`). */
const INLINE_SHELL_RE =
  /^(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?(?=$|[\s])/i

/** The flag that introduces that inline command string. */
const INLINE_FLAG_RE = /(?:^|\s)(?:-c|-Command|--command|\/c)(?=\s|$)/i

/**
 * Drop the wrappers that sit in front of the program being invoked.
 *
 * Two forms reach the tools with a prefix that is not the program:
 *
 *   `$r = Invoke-WebRequest … -OutFile x`   PowerShell captures the response
 *   `FOO=1 curl -o x y`                     bash sets an environment variable
 *
 * Without this the head reads `$r` or `FOO=1`, no downloader is ever matched,
 * and the card silently does not appear — the most common way these commands are
 * written by an agent. Stripping is idempotent, so callers may pass either form.
 *
 * `$o = 'D:\out.bin'` on its own also becomes `'D:\out.bin'`, which is not a
 * command at all. `expandLauncher` therefore keeps the original in that case:
 * dropping it would make the assignment invisible to target resolution, and
 * `curl -o $o …` two lines later would then be watched on no path at all.
 *
 * @param {string} segment
 * @returns {string}
 */
function stripPrefixes(segment) {
  let out = segment.replace(
    /^\s*(?:\[[^\]]+\]\s*)?\$[\w:]+(?:\.\w+)?\s*=\s*/,
    '',
  )
  // `FOO=1 BAR=2 curl …` is legal, so the env prefix repeats.
  for (;;) {
    const next = out.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
    if (next === out) break
    out = next
  }
  return out.trim()
}

/**
 * Rewrite a `Start-Process` launch into the command it actually runs.
 *
 * `Start-Process -FilePath aria2c.exe -ArgumentList '-x','16','-o','w.iso',url`
 * is one of the most common ways to start a downloader on Windows, and its head
 * is `Start-Process` — not a downloader. Testing only the head therefore meant
 * the card never appeared for exactly the launches people write. Rewriting the
 * segment to `aria2c.exe -x 16 -o w.iso <url>` lets every flag rule below run
 * unchanged, instead of duplicating each one for the array form.
 *
 * A `-FilePath` that is a variable (`Start-Process $exe …`) stays as it is: the
 * program is unknown, and guessing one would put a bar on nothing.
 *
 * @param {string} segment
 * @returns {string} the effective command, or the segment unchanged
 */
export function expandLauncher(segment) {
  const body = stripPrefixes(segment)
  if (headProgram(body) !== 'start-process') {
    // Only a prefix strip that leaves a real command behind counts. Stripping
    // `$o = ` from `$o = 'D:\out.bin'` leaves a bare literal, which is a value
    // and not an invocation; keeping the original keeps the assignment visible
    // to `collectAssignments` so `-o $o` can still be resolved.
    if (body === segment || !isCommandShaped(body)) return segment
    return body
  }
  const program = /(?:^|\s)-FilePath\s+("([^"]+)"|'([^']+)'|(\S+))/i.exec(body)
  const value = program && (program[2] || program[3] || program[4])
  if (!value || /[$%]/.test(value)) return segment
  const list = ARG_LIST_RE.exec(body)
  const args = list ? psArrayTokens(body.slice(list.index + list[0].length)) : []
  // Re-quote tokens that carry whitespace: they are one path, and an unquoted
  // split would turn `C:\My Downloads` into two arguments.
  const argv = args.map((token) => (/\s/.test(token) ? `"${token}"` : token)).join(' ')
  return argv ? `${value} ${argv}` : value
}

/**
 * Whether a prefix-stripped segment still looks like `<program> <argument>…`.
 *
 * A leading quote means the remainder is a string literal (`$x = 'D:\a.bin'`),
 * and a single token leaves no argument for a program to act on.
 *
 * @param {string} body
 * @returns {boolean}
 */
function isCommandShaped(body) {
  if (!body || /^["']/.test(body)) return false
  return body.split(/\s+/).filter(Boolean).length >= 2
}

/**
 * Split a command line into the segments that could each be an invocation.
 *
 * Splitting is quote-aware. Splitting on quotes — the obvious-looking shortcut —
 * is wrong in both directions: it turns the *contents* of a string literal into
 * its own segment, so `Write-Host "curl -o f u"` and a `@'…'@` here-string
 * carrying a script both raised a card for a transfer that never happens, while
 * `pwsh -c "curl -o x y"`, which really does download, needed the opposite
 * treatment. Now quoted text stays inside its segment (so it cannot look like a
 * command on its own), here-strings are dropped as data, and an inline shell is
 * unwrapped so the command string it carries is parsed as code.
 *
 * A leading `&` (PowerShell's call operator) or `\` is dropped so `& curl …`
 * still reads as a downloader. Nothing else is rewritten: the point is only to
 * find where a command *starts*.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function commandSegments(command) {
  return expandSegments(text(command), 0)
}

/** Remove here-string bodies: they are file contents, not commands. */
export function stripHereStrings(source) {
  return source.replace(HERESTRING_RE, '\n')
}

/**
 * @param {string} source
 * @param {number} depth how many inline shells have already been unwrapped
 * @returns {string[]}
 */
function expandSegments(source, depth) {
  const out = []
  for (const raw of splitTopLevel(stripHereStrings(source))) {
    const segment = raw.trim().replace(/^[&\\]+/, '')
    if (!segment) continue
    // `Start-Process …` is unwrapped into the command it launches, so the whole
    // ladder below (head test, flag tables) applies to the real program. The
    // launcher segment itself is replaced, not kept: pushing both would put two
    // cards on one dispatch.
    const launched = expandLauncher(segment)
    if (launched !== segment) {
      out.push(launched)
      continue
    }
    // Bounded: `pwsh -c "pwsh -c \"pwsh -c …\""` must not recurse forever.
    const inner = depth < 2 ? inlineShellBody(segment) : ''
    if (inner) {
      for (const nested of expandSegments(inner, depth + 1)) out.push(nested)
      continue
    }
    out.push(segment)
  }
  return out
}

/**
 * Split on shell separators that sit outside quotes.
 *
 * Escapes are honoured to the extent that they change where a string ends: a
 * backtick-escaped quote inside `"…"` and a doubled quote inside `'…'` do not
 * close the string. That is enough to keep `'@`-style payloads from leaking out.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function splitTopLevel(source) {
  const out = []
  let buffer = ''
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      buffer += ch
      if (ch === '`' && quote === '"') {
        // Keep the escaped character inside the string instead of letting it
        // terminate the quote on the next iteration.
        if (i + 1 < source.length) {
          buffer += source[i + 1]
          i += 1
        }
        continue
      }
      if (ch === quote) {
        // `''` inside a single-quoted PowerShell string is a literal quote.
        if (source[i + 1] === quote) {
          buffer += quote
          i += 1
          continue
        }
        quote = ''
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (SEGMENT_SPLIT_RE.test(ch)) {
      out.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  out.push(buffer)
  return out
}

/**
 * The command string carried by `pwsh -c "…"` / `bash -c '…'` / `cmd /c …`.
 *
 * Only the flag-then-string shape is unwrapped; a wrapper with no `-c` is left
 * alone, so `pwsh ./run.ps1` stays a plain segment.
 *
 * @param {string} segment
 * @returns {string} the inner command, or '' when this is not an inline shell
 */
export function inlineShellBody(segment) {
  if (!INLINE_SHELL_RE.test(segment)) return ''
  const flag = segment.match(INLINE_FLAG_RE)
  if (!flag) return ''
  const rest = segment.slice(flag.index + flag[0].length).trim()
  const quoted = rest.match(/^"([\s\S]*)"$/) || rest.match(/^'([\s\S]*)'$/)
  return quoted ? quoted[1] : rest
}
