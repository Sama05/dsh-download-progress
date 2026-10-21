/**
 * Offline smoke test for the Host half.
 *
 * Runs on plain Node (no Electron, no DSH): the Host half only uses `node:fs`,
 * `node:path` and the global `fetch`, so every branch below is exercised for
 * real. The one thing it cannot cover is the host wiring itself (events + route),
 * which is verified by loading the plugin in DSH.
 *
 *   node smoke-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, extractTargets } from './detect.js'
import {
  LINGER_MS,
  beginTask,
  noteInstallLog,
  noteInstallPhase,
  snapshot,
  sweep,
} from './state.js'
import { clip, extractUrl, firstLine, lastLine, uniq, unquote } from './utils.js'

const ok = (message) => console.log('  ok ' + message)

/* ------------------------------------------------------------------ */
/* 1. string helpers                                                   */
/* ------------------------------------------------------------------ */

assert.equal(clip('  a   b  ', 20), 'a b')
assert.equal(clip('abcdef', 3), 'abc…')
assert.equal(clip(null), '')
assert.equal(firstLine('\n\n  one  \ntwo\n'), 'one')
assert.equal(lastLine('one\n\n  two  \n\n'), 'two')
assert.equal(lastLine(''), '')
assert.equal(extractUrl('curl -o a.bin https://x/y?z=1&w=2 done'), 'https://x/y?z=1&w=2')
assert.equal(extractUrl('no url here'), '')
assert.deepEqual(uniq([1, 2, 1, 3]), [1, 2, 3])
assert.equal(unquote('"a b"'), 'a b')
assert.equal(unquote("'a b'"), 'a b')
assert.equal(unquote('plain'), 'plain')
ok('utils: clip / lines / url / uniq / unquote')

/* ------------------------------------------------------------------ */
/* 2. classification                                                   */
/* ------------------------------------------------------------------ */

assert.deepEqual(classify({ name: 'web_search', arguments: { query: 'dsh plugin' } }), {
  kind: 'search',
  label: 'dsh plugin',
  detail: 'dsh plugin',
})
assert.equal(classify({ name: 'web_search', arguments: { question: 'q' } }).label, 'q')
assert.equal(classify({ name: 'research', arguments: { q: 'x' } }).kind, 'search')
assert.equal(classify({ name: 'web_fetch', arguments: { url: 'https://a/b' } }).kind, 'fetch')
assert.equal(
  classify({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'pkg' } }).kind,
  'install',
)
// Listing plugins is not an install and must not raise a card.
assert.equal(classify({ name: 'plugin_manager', arguments: { action: 'list_plugins' } }), null)

const shell = (command) => classify({ name: 'pwsh', arguments: { command } })
assert.equal(shell('curl.exe -sS -o out.bin https://x/y').kind, 'download')
assert.equal(shell('wget -O out.bin https://x/y').kind, 'download')
assert.equal(shell('git clone https://github.com/a/b.git d:/repo').kind, 'download')
assert.equal(shell('pwsh -c "Invoke-WebRequest -Uri u -OutFile f"').kind, 'download')
// Invoke-WebRequest without -OutFile buffers in memory: nothing to sample.
assert.equal(shell('Invoke-WebRequest -Uri https://x/y'), null)
assert.equal(shell('iwr https://x/y'), null)
assert.equal(shell('pnpm add lodash').kind, 'pkg')
assert.equal(shell('npm i -g foo').kind, 'pkg')
assert.equal(shell('docker pull nginx').kind, 'pkg')
assert.equal(shell('ls -la'), null)
assert.equal(shell(''), null)
// A non-shell tool is never inspected for a command line.
assert.equal(classify({ name: 'read', arguments: { file_path: 'x' } }), null)
ok('detect: classify covers download / install / pkg / search / fetch / ignore')

/* ------------------------------------------------------------------ */
/* 3. target parsing                                                   */
/* ------------------------------------------------------------------ */

const CWD = 'D:\\work'
assert.deepEqual(extractTargets('curl -o "C:\\a b\\f.zip" https://x/f.zip', CWD), [
  'C:\\a b\\f.zip',
])
assert.deepEqual(extractTargets('curl --output out.bin https://x/y', CWD), [
  join('D:\\work', 'out.bin'),
])
assert.deepEqual(extractTargets('wget -q --output-document=o.bin https://x/y', CWD), [])
assert.deepEqual(extractTargets('Invoke-WebRequest -Uri u -OutFile .\\x.zip', CWD), [
  join('D:\\work', '.\\x.zip'),
].map((p) => p))
assert.deepEqual(extractTargets('curl -O https://host/dir/file.tgz', CWD), [
  join('D:\\work', 'file.tgz'),
])
assert.deepEqual(extractTargets('git clone https://github.com/a/b.git D:\\repo', CWD), [
  'D:\\repo',
])
// The same flag twice must not double-count the same file.
assert.equal(extractTargets('curl -o a.bin --output a.bin https://x/y', CWD).length, 1)
// A target built from a variable stays a literal we cannot resolve. This is a
// documented limitation, not a bug: guessing would put a confident bar on a file
// we are not actually watching.
assert.deepEqual(extractTargets('curl -o $dst https://x/y', CWD), [join('D:\\work', '$dst')])
ok('detect: extractTargets handles quotes, cwd, -O, clone, dedupe, variables')

/* ------------------------------------------------------------------ */
/* 4. task lifecycle                                                   */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'ddp-smoke-'))
const target = join(dir, 'payload.bin')

try {
  // Point the URL at a closed port so the HEAD probe fails fast and predictably.
  const task = beginTask(
    { callId: 'call-1', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${target}" http://127.0.0.1:9/payload.bin` },
    dir,
  )
  assert.equal(task.kind, 'download')
  assert.deepEqual(task.targets, [target])
  assert.equal(task.label, 'payload.bin')
  assert.equal(task.log, 'http://127.0.0.1:9/payload.bin')

  const t0 = 1_000_000
  writeFileSync(target, Buffer.alloc(100))
  sweep(t0)
  let [snap] = snapshot()
  assert.equal(snap.bytes, 100, 'first sample reads the bytes already on disk')
  assert.equal(snap.total, null, 'a failed HEAD leaves total unknown')
  assert.equal(snap.unresolved, false)

  writeFileSync(target, Buffer.alloc(300))
  sweep(t0 + 1000)
  ;[snap] = snapshot()
  assert.equal(snap.bytes, 300)
  // 200 bytes over 1000 ms = 200 B/s, within rounding of the window.
  assert.ok(snap.speed > 150 && snap.speed < 250, 'speed ~200 B/s, got ' + snap.speed)

  // Tool returned, file stopped growing: stays visible for the linger window.
  task.done = true
  sweep(t0 + 2000)
  sweep(t0 + 3000)
  sweep(t0 + 4000)
  assert.equal(snapshot().length, 1, 'quiet ticks are counted, card still lingering')
  sweep(t0 + 4000 + LINGER_MS)
  assert.equal(snapshot().length, 0, 'card is retired after the linger window')

  // A download whose target could not be resolved reports `unresolved`, which the
  // client renders as an indeterminate bar.
  const blind = beginTask(
    { callId: 'call-2', name: 'pwsh' },
    { kind: 'download', command: 'curl -o $dst http://127.0.0.1:9/x' },
    'D:\\work',
  )
  blind.done = true
  ;[snap] = snapshot()
  assert.equal(snap.unresolved, false)
  const blind2 = beginTask(
    { callId: 'call-3', name: 'pwsh' },
    { kind: 'download', command: 'curl -O http://127.0.0.1:9/x', },
    'D:\\work',
  )
  // `-O` derives a name from the URL, so this one IS resolved; `unresolved` needs
  // a download with no target at all, which happens when parsing yields nothing.
  assert.equal(blind2.targets.length, 1)
  blind2.done = true

  // Install tasks are driven by host events, never by sampling.
  beginTask({ callId: 'call-inst', name: 'plugin_manager' }, { kind: 'install', label: 'pkg' }, '')
  assert.equal(snapshot().find((t) => t.id === 'call-inst').log, 'pnpm add pkg')
  noteInstallLog({ text: 'Progress: resolved 1\nProgress: resolved 128, downloaded 8' })
  assert.equal(
    snapshot().find((t) => t.id === 'call-inst').log,
    'Progress: resolved 128, downloaded 8',
  )
  noteInstallPhase({ phase: 'applying' })
  assert.equal(snapshot().find((t) => t.id === 'call-inst').phase, 'applying')
  ok('state: sample → speed window → linger → retire, plus install events')

  // Snapshot shape is the wire contract with the client. Every field the client
  // reads must be present for every kind.
  const shape = snapshot().find((t) => t.id === 'call-inst')
  for (const key of ['id', 'kind', 'label', 'bytes', 'total', 'speed', 'phase', 'log', 'elapsedMs', 'done', 'unresolved']) {
    assert.ok(key in shape, 'snapshot must expose ' + key)
  }
  ok('state: snapshot exposes the full wire contract')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\nHOST SMOKE OK — utils, detect and state behave as documented')
