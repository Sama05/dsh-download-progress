/**
 * Stress + edge-case test for the Host half.
 *
 * Where `smoke-host.mjs` proves the documented paths work, this file attacks the
 * ones that only show up in the field: 30 downloads at once, a 10 KB command line,
 * non-ASCII and UNC paths, malformed host payloads, a file that shrinks, and a
 * task that never settles.
 *
 * Runs on plain Node. The task map is module state, so every case here shares one
 * process on purpose — that is also how a long-lived plugin behaves.
 *
 *   node stress-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, extractTargets } from './detect.js'
import {
  IDLE_TICKS_TO_CLOSE,
  LINGER_MS,
  beginTask,
  noteInstallLog,
  noteInstallPhase,
  snapshot,
  sweep,
} from './state.js'

const ok = (message) => console.log('  ok ' + message)
const CWD = 'D:\\work'
const DEAD = 'http://127.0.0.1:9/x.bin'

/* ------------------------------------------------------------------ */
/* 1. git clone variants — the flag that used to eat the URL as the dir */
/* ------------------------------------------------------------------ */

assert.deepEqual(extractTargets('git clone --depth 1 https://github.com/a/b D:\\r1', CWD), ['D:\\r1'])
assert.deepEqual(extractTargets('git clone --branch main https://github.com/a/b c:/r2', CWD), [
  'c:/r2',
])
assert.deepEqual(extractTargets('git clone https://github.com/a/b.git', CWD), [join(CWD, 'b')])
assert.deepEqual(extractTargets('git clone https://github.com/a/b.git D:\\r3', CWD), ['D:\\r3'])
// A URL in a value position must never be mistaken for the directory.
assert.deepEqual(extractTargets('git clone --depth 1 https://github.com/a/b', CWD), [
  join(CWD, 'b'),
])
ok('detect: git clone survives flags, missing dir and .git suffix')

/* ------------------------------------------------------------------ */
/* 2. malformed input must never throw inside a dispatch               */
/* ------------------------------------------------------------------ */

assert.equal(classify(null), null)
assert.equal(classify(undefined), null)
assert.equal(classify({}), null)
assert.equal(classify({ name: 'pwsh', arguments: null }), null)
assert.equal(classify({ name: 'pwsh', arguments: { command: 123 } }), null)
assert.equal(classify({ name: 'web_search', arguments: {} }).kind, 'search')
assert.deepEqual(extractTargets(undefined, CWD), [])
assert.deepEqual(extractTargets(null, CWD), [])
assert.deepEqual(extractTargets(12345, CWD), [])
ok('detect: null / undefined / numeric payloads are absorbed, not thrown')

/* ------------------------------------------------------------------ */
/* 3. long and hostile command lines                                   */
/* ------------------------------------------------------------------ */

const long = 'curl -o out.bin ' + 'x'.repeat(10_000)
assert.equal(classify({ name: 'pwsh', arguments: { command: long } }).kind, 'download')
assert.deepEqual(extractTargets(long, CWD), [join(CWD, 'out.bin')])

// `-o -` means stdout: there is no file to watch, so it resolves to nothing.
assert.deepEqual(extractTargets('curl -o - ' + DEAD, CWD), [])
assert.deepEqual(extractTargets('curl -o "" ' + DEAD, CWD), [])
assert.deepEqual(extractTargets('curl -o "带 空格/文件 名.bin" ' + DEAD, CWD), [
  join(CWD, '带 空格', '文件 名.bin'),
])
assert.deepEqual(extractTargets('curl -o \\\\server\\share\\f.bin ' + DEAD, CWD), [
  '\\\\server\\share\\f.bin',
])
ok('detect: 10 KB commands, stdout, empty and non-ASCII / UNC targets')

/* ------------------------------------------------------------------ */
/* 4. thirty concurrent downloads                                      */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'ddp-stress-'))

try {
  const N = 30
  const started = Date.now()
  const batch = []
  for (let i = 0; i < N; i++) {
    const file = join(dir, 'f' + i + '.bin')
    writeFileSync(file, Buffer.alloc(64))
    batch.push(
      beginTask(
        { callId: 'bulk-' + i, name: 'pwsh' },
        { kind: 'download', command: `curl -o "${file}" ${DEAD}` },
        dir,
      ),
    )
  }
  const cost = Date.now() - started
  assert.equal(snapshot().length, N, 'all thirty cards registered')
  console.log('     (registering 30 tasks took ' + cost + ' ms)')

  sweep(started)
  for (const snap of snapshot()) {
    assert.equal(snap.bytes, 64, 'every card samples its own file')
    assert.equal(snap.unresolved, false)
  }

  // Grow them all, then let them finish and age out together.
  for (let i = 0; i < N; i++) writeFileSync(join(dir, 'f' + i + '.bin'), Buffer.alloc(1024))
  sweep(started + 1000)
  for (const snap of snapshot()) assert.equal(snap.bytes, 1024, 'grown bytes are picked up')

  for (const task of batch) task.done = true
  for (let t = 2; t <= 2 + IDLE_TICKS_TO_CLOSE; t++) sweep(started + t * 1000)
  assert.equal(snapshot().filter((s) => s.id.startsWith('bulk-')).length, N, 'still lingering')
  sweep(started + 99_999 + LINGER_MS)
  assert.equal(
    snapshot().filter((s) => s.id.startsWith('bulk-')).length,
    0,
    'thirty cards retire together',
  )
  ok('state: 30 concurrent downloads sample, linger and retire independently')

  /* ------------------------------------------------------------------ */
  /* 5. a shrinking / renamed file must not snap the bar back to zero   */
  /* ------------------------------------------------------------------ */

  const shrink = join(dir, 'shrink.bin')
  writeFileSync(shrink, Buffer.alloc(4096))
  const shrinkTask = beginTask(
    { callId: 'shrink-1', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${shrink}" ${DEAD}` },
    dir,
  )
  const t0 = Date.now()
  sweep(t0)
  assert.equal(snapshot().find((s) => s.id === 'shrink-1').bytes, 4096)

  // Rename-in-place: the sampled path disappears.
  unlinkSync(shrink)
  sweep(t0 + 1000)
  assert.equal(
    snapshot().find((s) => s.id === 'shrink-1').bytes,
    4096,
    'high-water mark is held while the file is gone',
  )
  shrinkTask.done = true
  ok('state: a vanished file keeps its last size instead of collapsing to 0 B')

  /* ------------------------------------------------------------------ */
  /* 6. a task that never settles is retired by the age ceiling         */
  /* ------------------------------------------------------------------ */

  const stuck = join(dir, 'stuck.bin')
  beginTask(
    { callId: 'stuck-1', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${stuck}" ${DEAD}` },
    dir,
  )
  // Never created, never done: only the ceiling can retire it.
  sweep(Date.now() + 29 * 60 * 1000)
  assert.equal(snapshot().some((s) => s.id === 'stuck-1'), true, 'still under the ceiling')
  sweep(Date.now() + 31 * 60 * 1000)
  assert.equal(snapshot().some((s) => s.id === 'stuck-1'), false, 'ceiling retires it')
  ok('state: an unsettled task cannot outlive the 30 minute ceiling')

  /* ------------------------------------------------------------------ */
  /* 6b. a background card survives the transfer's opening seconds      */
  /* ------------------------------------------------------------------ */

  const late = join(dir, 'late.bin')
  const lateTask = beginTask(
    { callId: 'late-1', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${late}" ${DEAD}` },
    dir,
  )
  // The tool already resolved (run_in_background returns at once) while curl is
  // still doing DNS + TLS. Counting these ticks as idle used to retire the card
  // before the first byte landed — and a retired card never comes back.
  lateTask.done = true
  const born = lateTask.startedAt
  for (let t = 1; t <= 4; t++) sweep(born + t * 1000)
  assert.equal(
    snapshot().some((s) => s.id === 'late-1'),
    true,
    'the start grace keeps the card alive',
  )
  writeFileSync(late, Buffer.alloc(1024))
  sweep(born + 5000)
  assert.equal(
    snapshot().find((s) => s.id === 'late-1').bytes,
    1024,
    'bytes are picked up once the file appears',
  )
  ok('state: a not-yet-created target gets a start grace, not instant retirement')

  /* ------------------------------------------------------------------ */
  /* 7. install events with no install card are absorbed                 */
  /* ------------------------------------------------------------------ */

  assert.doesNotThrow(() => noteInstallLog({ text: 'orphan chunk' }))
  assert.doesNotThrow(() => noteInstallLog(null))
  assert.doesNotThrow(() => noteInstallPhase({ phase: 'applying' }))
  assert.doesNotThrow(() => noteInstallPhase(undefined))
  ok('state: install events without a card are no-ops')

  /* ------------------------------------------------------------------ */
  /* 8. same callId twice replaces instead of duplicating                */
  /* ------------------------------------------------------------------ */

  beginTask({ callId: 'dup', name: 'pwsh' }, { kind: 'download', command: 'curl -o a.bin ' + DEAD }, dir)
  beginTask({ callId: 'dup', name: 'pwsh' }, { kind: 'download', command: 'curl -o b.bin ' + DEAD }, dir)
  assert.equal(snapshot().filter((s) => s.id === 'dup').length, 1, 'one card per callId')
  ok('state: a repeated callId replaces its card rather than stacking one')

  /* ------------------------------------------------------------------ */
  /* 9. wire contract types                                              */
  /* ------------------------------------------------------------------ */

  const wire = snapshot()[0]
  for (const key of ['id', 'kind', 'name', 'label', 'phase', 'log']) {
    assert.equal(typeof wire[key], 'string', key + ' must be a string')
  }
  for (const key of ['bytes', 'speed', 'startedAt', 'elapsedMs']) {
    assert.equal(typeof wire[key], 'number', key + ' must be a number')
  }
  for (const key of ['done', 'unresolved']) {
    assert.equal(typeof wire[key], 'boolean', key + ' must be a boolean')
  }
  assert.equal(wire.total, null, 'a failed probe leaves total null, never 0 or NaN')
  assert.ok(Number.isFinite(wire.elapsedMs) && wire.elapsedMs >= 0)
  ok('state: snapshot wire types are stable for every kind')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\nHOST STRESS OK — 30 concurrent cards, hostile payloads, ceilings and wire types')
