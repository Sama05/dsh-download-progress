/**
 * contract.mjs — the guard that keeps the UI layer and the wire layer apart.
 *
 * The plugin has two halves with one narrow seam between them:
 *
 *   Host  detect.js → state.js → snapshot() → HTTP JSON
 *   Client                          taskStore.adopt() → adapter → views
 *
 * "Decoupled" is easy to claim and easy to lose: one `task.bytes` typed inside
 * `Overlay` is all it takes for a rename in `state.js` to break a view. This
 * file makes that failure loud instead of silent, and it also catches the other
 * direction — a wire field that exists in code but not in the documented
 * contract, or a documented field that the host stopped sending.
 *
 * Run with: node contract.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(HERE, name), 'utf8')

const STATE = read('state.js')
const CLIENT = read('client.js')
const INDEX = read('index.js')
const CONTRACT = read('CONTRACT.md')

let failures = 0
const fail = (message) => {
  failures++
  console.error('FAIL  ' + message)
}
const pass = (message) => console.log('ok    ' + message)

/* ------------------------------------------------------------------ *
 * 1. The wire field set, extracted from the one place that defines it.
 * ------------------------------------------------------------------ */

/**
 * Pull the field names out of `snapshot()`'s returned object literal.
 *
 * Deliberately textual: importing state.js would execute the sampler, and the
 * point is to read the SHAPE the host promises, not to run it.
 */
function wireFields() {
  const start = STATE.indexOf('export function snapshot()')
  if (start < 0) throw new Error('state.js: snapshot() not found')
  const body = STATE.slice(start)
  const open = body.indexOf('return {')
  if (open < 0) throw new Error('state.js: snapshot() has no object literal')
  const close = body.indexOf('\n  })', open)
  if (close < 0) throw new Error('state.js: snapshot() literal is not terminated')
  const literal = body.slice(open, close)

  const fields = []
  // Top-level `key: value,` lines only: the literal is indented six spaces.
  for (const line of literal.split('\n')) {
    const m = /^\s{6}([A-Za-z_$][\w$]*):/.exec(line)
    if (m) fields.push(m[1])
  }
  return fields
}

const WIRE = wireFields()
if (WIRE.length === 0) fail('state.js: snapshot() exposes no fields')

/* ------------------------------------------------------------------ *
 * 2. Documented contract must match the code, field for field.
 * ------------------------------------------------------------------ */

const documented = new Set()
for (const line of CONTRACT.split('\n')) {
  // Contract rows look like: `| `bytes` | number | ... |`
  const m = /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|/.exec(line)
  if (m) documented.add(m[1])
}

for (const field of WIRE) {
  if (!documented.has(field)) {
    fail('CONTRACT.md does not document wire field `' + field + '` (added in state.js)')
  }
}
for (const field of documented) {
  if (!WIRE.includes(field)) {
    fail('CONTRACT.md documents `' + field + '` but snapshot() no longer sends it')
  }
}
if (failures === 0) {
  pass('wire contract matches CONTRACT.md (' + WIRE.length + ' fields)')
}

/* ------------------------------------------------------------------ *
 * 3. Views must not read wire fields directly.
 *
 * Every view reads a view-model produced by an adapter. The adapters are the
 * only legal place to touch a wire name, because a rename has to land in
 * exactly one function per surface instead of in every JSX expression.
 * ------------------------------------------------------------------ */

/** Functions allowed to read the wire shape. Everything else must not. */
const ADAPTERS = new Set([
  'logOf',
  'describe',
  'fallbackView',
  'sessionKeyOf',
  'sessionNameOf',
  'briefOf',
  'const:VIEWS',
])

/**
 * Slice `client.js` into top-level function bodies.
 *
 * Client-half functions are declared with four spaces of indentation inside the
 * module factory, so a line starting with exactly `    function name(` begins a
 * body and the next such line (or EOF) ends it.
 */
function functionBodies(source) {
  const lines = source.split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    // A function declaration...
    const fn = /^ {4}function ([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i])
    if (fn) {
      starts.push({ name: fn[1], line: i })
      continue
    }
    // ...or a top-level constant object literal (`const VIEWS = {`), which is
    // where the per-kind builders live. Without this the preceding function's
    // body would swallow them and every wire read inside would be blamed on it.
    const obj = /^ {4}const ([A-Z][A-Z0-9_]*)\s*=\s*\{/.exec(lines[i])
    if (obj) starts.push({ name: 'const:' + obj[1], line: i })
  }
  const bodies = []
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k].line
    const to = k + 1 < starts.length ? starts[k + 1].line : lines.length
    bodies.push({ name: starts[k].name, text: lines.slice(from, to).join('\n') })
  }
  return bodies
}

const WIRE_NAME = WIRE.filter((f) => f !== 'id')
  .map((f) => f.replace(/\$/g, '\\$'))
  .join('|')
// `task.bytes`, `t.total`, `props.task.speed` — a wire field read off a record.
// `id` is excluded on purpose: it is a stable identity used as a React key, not
// a presentation field, so a view reading it is neither coupling nor fragile.
const WIRE_READ = new RegExp(
  '\\b(?:task|t|props\\.task)\\.(?:' + WIRE_NAME + ')\\b',
)

/**
 * Strip comment-only lines before scanning.
 *
 * The docs inside this file quote the very patterns the guard forbids
 * (`` `log: String(task.log || '')` ``), and a guard that cannot describe
 * itself is a guard nobody can maintain.
 */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')
}

const bodies = functionBodies(CLIENT)
const views = bodies.filter((b) => !ADAPTERS.has(b.name))
let leaked = 0
for (const view of views) {
  const code = codeOnly(view.text)
  const m = WIRE_READ.exec(code)
  if (m) {
    leaked++
    const line = code.slice(0, m.index).split('\n').length
    fail(
      'view `' +
        view.name +
        '` reads wire field directly: ' +
        m[0] +
        ' (offset line ' +
        line +
        '). Read it through an adapter instead.',
    )
  }
}
if (leaked === 0) {
  pass('no view reads a wire field directly (' + views.length + ' view functions scanned)')
}

/* ------------------------------------------------------------------ *
 * 4. The route must advertise the version it is speaking.
 * ------------------------------------------------------------------ */

if (!/SCHEMA_VERSION/.test(INDEX)) {
  fail('index.js: the snapshot route does not send a schemaVersion')
} else if (!/schemaVersion:\s*SCHEMA_VERSION/.test(INDEX)) {
  fail('index.js: SCHEMA_VERSION exists but is not put on the wire')
} else {
  pass('index.js sends schemaVersion on the snapshot route')
}

/* ------------------------------------------------------------------ *
 * 5. The client must tolerate both body shapes.
 * ------------------------------------------------------------------ */

if (!/adopt\(data\)/.test(CLIENT)) {
  fail('client.js: taskStore.tick() does not run the body through adopt()')
} else if (!/Array\.isArray\(data\)/.test(CLIENT)) {
  fail('client.js: adopt() does not accept a bare array body (older host)')
} else {
  pass('client.js accepts both { schemaVersion, tasks } and a bare array')
}

/* ------------------------------------------------------------------ */

if (failures > 0) {
  console.error('\nCONTRACT FAILED — ' + failures + ' problem(s)')
  process.exit(1)
}
console.log('\nCONTRACT OK — wire shape, adapters and versioning agree')
