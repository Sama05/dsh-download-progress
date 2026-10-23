/**
 * build-client.mjs — concatenates `src/client/**` into the served `client.js`.
 *
 * The client half is delivered as one bundle (`window.__ModuleLoader__.load`),
 * so it cannot use ESM imports. Splitting it therefore means splitting the
 * *source* while the artifact stays a single file. This script is that seam.
 *
 * Order is explicit (not directory-order) because the fragments are read
 * top-to-bottom by the browser and a hoisted `const` used before its line
 * would throw a TDZ error at load time — a failure mode that appears only in
 * the real UI, never in Node.
 *
 *   node scripts/build-client.mjs           # write client.js
 *   node scripts/build-client.mjs --check   # exit 1 if client.js is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SRC = join(ROOT, 'src', 'client')
const OUT = join(ROOT, 'client.js')

/**
 * The one ordered list.
 *
 * `styles` is a placeholder that expands into the CSS files, mirroring the
 * single template literal the bundle has always carried. Everything else is a
 * fragment file verbatim.
 */
const ORDER = [
  '01-prologue.js',
  'styles',
  '20-utils.js',
  '30-settings.js',
  '40-samples.js',
  '50-presence.js',
  '60-data.js',
  '70-views.js',
  '75-sessions.js',
  '78-scope.js',
  '80-drag.js',
  '85-inline.js',
  '90-overlay.js',
  '95-settings-page.js',
  '99-plugin.js',
]

const CSS_ORDER = ['overlay.css', 'inline.css', 'settings.css']

const read = (rel) => readFileSync(join(SRC, rel), 'utf8').replace(/\n$/, '')

function styles() {
  const pieces = ['styles-open.js']
  for (const css of CSS_ORDER) pieces.push('css/' + css)
  pieces.push('styles-close.js')
  return pieces.map(read).join('\n')
}

export function build() {
  const chunks = ORDER.map((entry) => (entry === 'styles' ? styles() : read(entry)))
  // No trailing newline is added: the last fragment already carries the file's
  // own ending (the source ends with `})\n\n`), and appending one here would
  // grow the bundle by a byte on every build.
  return chunks.join('\n')
}

const next = build()

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    current = ''
  }
  if (current !== next) {
    const a = current.split('\n')
    const b = next.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    console.error('client.js is STALE — run: node scripts/build-client.mjs')
    console.error('  first difference at line ' + (i + 1))
    console.error('  client.js : ' + JSON.stringify(a[i] ?? '<eof>'))
    console.error('  src/      : ' + JSON.stringify(b[i] ?? '<eof>'))
    process.exit(1)
  }
  console.log('client.js matches src/client (' + next.split('\n').length + ' lines)')
} else {
  writeFileSync(OUT, next, 'utf8')
  console.log(
    'wrote ' + relative(ROOT, OUT) + ' from src/client (' + next.split('\n').length + ' lines)',
  )
}
