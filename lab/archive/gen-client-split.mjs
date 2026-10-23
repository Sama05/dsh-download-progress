/**
 * gen-client-split.mjs — one-shot generator: slices client.js into src/client/*.
 *
 * The client half is served to the browser as ONE bundle, so unlike the Host
 * half it cannot use `import`. The split therefore keeps the bundle shape and
 * moves the *source* into ordered fragments that `scripts/build-client.mjs`
 * concatenates back byte-for-byte. Nothing about the runtime changes; only the
 * file you edit does.
 *
 * Method is the same as the detect/state splits: cut by line range so every
 * body stays byte-identical, then let the existing suite prove the wiring.
 *
 * Run once; afterwards src/client/ is the source of truth.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const ORIGINAL = readFileSync(join(ROOT, 'client.js'), 'utf8')
const SRC = ORIGINAL.split('\n')

const at = (from, to) => SRC.slice(from - 1, to).join('\n')

/* Contiguous partition of 1..lines: every line lands in exactly one fragment,
 * so `parts.join('\n')` reproduces the file without a single byte of guesswork. */
const PARTS = [
  ['01-prologue', 1, 43],
  ['20-utils', 681, 758],
  ['30-settings', 759, 1041],
  ['40-samples', 1042, 1130],
  ['50-presence', 1131, 1156],
  ['60-data', 1157, 1332],
  ['70-views', 1333, 1491],
  ['75-sessions', 1492, 1546],
  ['78-scope', 1547, 1638],
  ['80-drag', 1639, 1729],
  ['85-inline', 1730, 2051],
  ['90-overlay', 2052, 2386],
  ['95-settings-page', 2387, 2557],
  ['99-plugin', 2558, SRC.length],
]

/* Styles live inside a template literal. Keeping them as real .css files is the
 * only way to make them editable without re-learning the string escaping, so
 * this one fragment is assembled from three pieces. */
const STYLE_OPEN = [44, 46]
const STYLE_CLOSE = [679, 680]
const CSS_PARTS = [
  ['overlay', 47, 463],
  ['inline', 464, 643],
  ['settings', 644, 678],
]

const OUT = join(ROOT, 'src', 'client')
mkdirSync(join(OUT, 'css'), { recursive: true })

const written = []
/**
 * Every fragment file ends with exactly one newline that is not part of the
 * source; the rebuild strips exactly that one and re-joins with '\n'. Trailing
 * blank lines inside a range are therefore preserved byte-for-byte (a range
 * ending on a blank line stores `\n` and rebuilds into the same two newlines).
 */
function emit(rel, text) {
  const file = join(OUT, rel)
  writeFileSync(file, text + '\n', 'utf8')
  written.push([rel, text.split('\n').length])
}

for (const [name, from, to] of PARTS) emit(name + '.js', at(from, to))
emit('styles-open.js', at(...STYLE_OPEN))
emit('styles-close.js', at(...STYLE_CLOSE))
for (const [name, from, to] of CSS_PARTS) emit(join('css', name + '.css'), at(from, to))

/* Sanity: reassemble the same way the build script will and demand equality. */
const read = (rel) => readFileSync(join(OUT, rel), 'utf8').replace(/\n$/, '')
const rebuilt = []
for (const [name] of PARTS) {
  if (name === '20-utils') {
    rebuilt.push(read('10-styles.js'.replace('10-styles.js', 'styles-open.js')))
    for (const [css] of CSS_PARTS) rebuilt.push(read(join('css', css + '.css')))
    rebuilt.push(read('styles-close.js'))
  }
  rebuilt.push(read(name + '.js'))
}
const roundTrip = rebuilt.join('\n')
if (roundTrip !== ORIGINAL) {
  const a = ORIGINAL.split('\n')
  const b = roundTrip.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  throw new Error(
    `round trip mismatch at line ${i + 1}\n  original: ${JSON.stringify(a[i])}\n  rebuilt : ${JSON.stringify(b[i])}`,
  )
}

console.log('round trip byte-identical: OK')
for (const [rel, lines] of written) console.log(String(lines).padStart(5) + '  src/client/' + rel)
