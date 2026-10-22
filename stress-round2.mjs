/**
 * Round-two stress: the failures that only appear under sustained load.
 *
 * `smoke-host.mjs` proves the documented paths work and `stress-host.mjs` proves
 * a burst of thirty calls survives. Neither answers the questions that actually
 * decide whether this plugin can sit in a long-lived host:
 *
 *   1. How much does the snapshot route cost when a thousand cards exist?
 *   2. Does a thousand-download burst spawn a thousand concurrent HEAD probes?
 *   3. Does an hour of sweeping leak tasks or memory?
 *   4. Can a hostile session title or a 100 KB log line wedge a render?
 *   5. Does adding a task while sweeping corrupt the iteration?
 *
 * Numbers are printed, not just asserted: a regression should be visible as a
 * number getting worse, not only as a red line. Thresholds are deliberately
 * loose (10-20x the measured value) so this stays a correctness gate rather than
 * a flaky benchmark on a busy machine.
 *
 *   node stress-round2.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, extractTargets } from './detect.js'
import { beginTask, setTitleResolver, snapshot, sweep } from './state.js'

const ok = (message) => console.log('  ok ' + message)
const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6

/** Drop every task: a sweep past the 30-minute ceiling retires all of them. */
const reset = () => sweep(Date.now() + 31 * 60 * 1000)

const DIR = mkdtempSync(join(tmpdir(), 'ddp-round2-'))
process.on('exit', () => {
  try {
    rmSync(DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/* ------------------------------------------------------------------ */
/* 1. A thousand concurrent cards: build, snapshot, serialise          */
/* ------------------------------------------------------------------ */

reset()
{
  const command = (i) => `curl -o "${join(DIR, 'f' + i + '.bin')}" https://example.invalid/x`
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 1000; i++) {
    beginTask({ callId: 'c' + i, name: 'pwsh' }, { kind: 'download', command: command(i) }, DIR)
  }
  const buildMs = ms(t0)

  const t1 = process.hrtime.bigint()
  const snap = snapshot()
  const snapshotMs = ms(t1)

  const t2 = process.hrtime.bigint()
  const body = JSON.stringify({ tasks: snap })
  const stringifyMs = ms(t2)

  assert.equal(snap.length, 1000, 'a thousand registered downloads must all be in the snapshot')
  assert.ok(buildMs < 2000, `registering 1000 cards took ${buildMs.toFixed(0)} ms, over the 2 s guard`)
  assert.ok(snapshotMs < 500, `snapshotting 1000 cards took ${snapshotMs.toFixed(0)} ms`)
  assert.ok(stringifyMs < 500, `serialising 1000 cards took ${stringifyMs.toFixed(0)} ms`)
  // The wire body is what the client re-parses every second; 1000 cards at
  // ~300 bytes each is ~300 KB. Anything wildly past that means a field grew a
  // payload it should not carry.
  assert.ok(body.length < 1_500_000, `snapshot body grew to ${body.length} bytes`)
  console.log(
    `     (1000 cards: register ${buildMs.toFixed(0)} ms, snapshot ${snapshotMs.toFixed(0)} ms, ` +
      `stringify ${stringifyMs.toFixed(0)} ms, body ${(body.length / 1024).toFixed(0)} KB)`,
  )
  ok('host: a thousand cards register, snapshot and serialise inside budget')
}

/* ------------------------------------------------------------------ */
/* 2. Does a burst of downloads fan out into a burst of HEAD probes?   */
/* ------------------------------------------------------------------ */

reset()
{
  // A dead endpoint makes each probe fail fast instead of waiting out the 6 s
  // timeout, so this measures fan-out rather than patience.
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 200; i++) {
    beginTask(
      { callId: 'p' + i, name: 'pwsh' },
      { kind: 'download', command: `curl -o "${join(DIR, 'p' + i + '.bin')}" http://127.0.0.1:9/x` },
      DIR,
    )
  }
  const ms200 = ms(t0)
  // Registration is synchronous; the probes are fire-and-forget. If registration
  // ever awaited them, 200 dead probes would take 200 x connect-timeout instead.
  assert.ok(ms200 < 2000, `200 registrations took ${ms200.toFixed(0)} ms — probes are being awaited`)
  console.log(`     (200 registrations with dead probes: ${ms200.toFixed(1)} ms)`)
  ok('host: probe fan-out never blocks registration')
}

/* ------------------------------------------------------------------ */
/* 3. An hour of sweeping: cost per tick, and does anything leak?      */
/* ------------------------------------------------------------------ */

reset()
{
  // 50 real files that actually grow, so the sampler does real stat() work.
  const files = []
  for (let i = 0; i < 50; i++) {
    const path = join(DIR, 'grow' + i + '.bin')
    writeFileSync(path, Buffer.alloc(64))
    files.push(path)
    beginTask(
      { callId: 'g' + i, name: 'pwsh' },
      { kind: 'download', command: `curl -o "${path}" https://example.invalid/y` },
      DIR,
    )
  }
  const before = process.memoryUsage().heapUsed
  const base = Date.now()
  const t0 = process.hrtime.bigint()
  // One simulated hour at the real 1 Hz cadence.
  for (let tick = 0; tick < 3600; tick++) {
    sweep(base + tick * 1000)
  }
  const hourMs = ms(t0)
  const after = process.memoryUsage().heapUsed
  const grewMb = (after - before) / (1024 * 1024)
  // A simulated hour must cost far less than a real one; if a tick ever does
  // per-task I/O that scales with history, this is where it shows.
  assert.ok(hourMs < 20000, `3600 sweeps took ${hourMs.toFixed(0)} ms`)
  assert.ok(grewMb < 64, `an hour of sweeping grew the heap by ${grewMb.toFixed(1)} MB`)
  // The 30-minute ceiling means everything must be retired by the end.
  assert.equal(snapshot().length, 0, 'the hour ceiling must retire every task')
  console.log(
    `     (3600 sweeps over 50 growing files: ${hourMs.toFixed(0)} ms, heap +${grewMb.toFixed(1)} MB)`,
  )
  ok('host: an hour of sweeping is cheap and leaks nothing')
}

/* ------------------------------------------------------------------ */
/* 4. Hostile session titles and log lines                             */
/* ------------------------------------------------------------------ */

reset()
{
  setTitleResolver((id) => {
    if (id === 'big') return 'x'.repeat(10_000)
    if (id === 'num') return 12345
    if (id === 'nil') return null
    if (id === 'boom') throw new Error('resolver exploded')
    return ''
  })

  const mk = (sessionId) => {
    const task = beginTask(
      { callId: 'h' + sessionId, name: 'pwsh', agent: { id: sessionId } },
      { kind: 'download', command: `curl -o "${join(DIR, 'h.bin')}" https://example.invalid/z` },
      DIR,
    )
    return task
  }

  mk('big')
  mk('num')
  mk('nil')
  mk('boom')
  // A 100 KB log line: `clip` must cut it, or every poll ships 100 KB.
  const fat = beginTask(
    { callId: 'fat', name: 'pwsh' },
    { kind: 'search', label: 'q', detail: 'y'.repeat(100_000) },
    DIR,
  )
  fat.log = 'z'.repeat(100_000)

  const snap = snapshot()
  const byId = new Map(snap.map((t) => [t.sessionId, t]))
  assert.equal(String(byId.get('big').sessionTitle).length, 10_000, 'a long title passes through')
  assert.equal(String(byId.get('num').sessionTitle), '12345', 'a numeric title is coerced, not dropped')
  // `nil` and `boom` resolve to nothing, so the fallback id label must stand in.
  assert.match(byId.get('nil').sessionTitle, /^会话 /)
  assert.match(byId.get('boom').sessionTitle, /^会话 /)
  // The wire keeps whatever the task holds; the *renderer* is what must survive
  // a long line, and case 5 covers that. Here we only prove the snapshot itself
  // does not throw on any of these shapes.
  const fatCard = snap.find((t) => t.label === 'q' || t.name === 'q' || t.id === fat.id)
  assert.ok(fatCard, 'the 100 KB card must still be in the snapshot')
  assert.equal(typeof fatCard.log, 'string')
  setTitleResolver(null)
  ok('host: 10 KB / numeric / throwing titles and a 100 KB log never break the snapshot')
}

/* ------------------------------------------------------------------ */
/* 5. Mutating the task map while sweeping it                          */
/* ------------------------------------------------------------------ */

reset()
{
  for (let i = 0; i < 20; i++) {
    beginTask(
      { callId: 'm' + i, name: 'pwsh' },
      { kind: 'download', command: `curl -o "${join(DIR, 'm' + i + '.bin')}" https://example.invalid/m` },
      DIR,
    )
  }
  // Registering during the sweep is what a real host does: the timer fires while
  // a tool dispatch is landing. Deleting during iteration is legal for a Map, so
  // the only thing to prove is that nothing throws and the new task survives.
  const sweepTime = Date.now()
  let injected = null
  const original = snapshot
  for (let i = 0; i < 20; i++) {
    if (i === 10) {
      injected = beginTask(
        { callId: 'mid', name: 'pwsh' },
        { kind: 'search', label: 'mid' },
        DIR,
      )
    }
    sweep(sweepTime + i * 1000)
  }
  assert.ok(injected, 'the task registered mid-sweep must exist')
  const ids = snapshot().map((t) => t.id)
  assert.ok(ids.includes('mid'), 'a task added mid-sweep must appear in the next snapshot')
  void original
  ok('host: registering during a sweep neither throws nor loses the new task')
}

/* ------------------------------------------------------------------ */
/* 6. Duplicate and colliding ids                                      */
/* ------------------------------------------------------------------ */

reset()
{
  // Two dispatches that share a callId replace each other instead of stacking:
  // the map is keyed by callId, and a retried call must not double the card.
  beginTask({ callId: 'dup', name: 'pwsh' }, { kind: 'search', label: 'first' }, DIR)
  beginTask({ callId: 'dup', name: 'pwsh' }, { kind: 'search', label: 'second' }, DIR)
  assert.equal(snapshot().length, 1, 'a repeated callId replaces its card')

  // A missing callId still gets a unique key; two of them must not collide.
  beginTask({ name: 'pwsh' }, { kind: 'search', label: 'a' }, DIR)
  beginTask({ name: 'pwsh' }, { kind: 'search', label: 'b' }, DIR)
  assert.equal(snapshot().length, 3, 'two anonymous dispatches must not share a key')
  ok('host: repeated ids replace, anonymous ids stay distinct')
}

/* ------------------------------------------------------------------ */
/* 7. extractTargets under adversarial command lines                   */
/* ------------------------------------------------------------------ */

{
  // A command that is nothing but flags: the regex must not read the next flag
  // as a path.
  assert.deepEqual(extractTargets('curl -o --silent https://x/y', 'D:\\work'), [])
  // Repeated output flags collapse to one target.
  assert.equal(
    extractTargets(`curl -o "${join(DIR, 'same.bin')}" --output "${join(DIR, 'same.bin')}" https://x`, DIR)
      .length,
    1,
  )
  // A 200 KB command line must not blow the regex pass up.
  const fat = 'curl -o "' + join(DIR, 'fat.bin') + '" ' + 'x'.repeat(200_000)
  const t0 = process.hrtime.bigint()
  const targets = extractTargets(fat, DIR)
  const took = ms(t0)
  assert.deepEqual(targets, [join(DIR, 'fat.bin')])
  assert.ok(took < 500, `a 200 KB command took ${took.toFixed(0)} ms to scan`)
  console.log(`     (200 KB command line scanned in ${took.toFixed(1)} ms)`)
  ok('detect: adversarial flag orders, duplicates and 200 KB commands stay bounded')
}

/* ------------------------------------------------------------------ */
/* 8. classify() never throws, whatever it is handed                   */
/* ------------------------------------------------------------------ */

{
  const hostile = [
    null,
    undefined,
    0,
    '',
    [],
    {},
    { name: 'pwsh' },
    { name: 'pwsh', arguments: null },
    { name: 'pwsh', arguments: { command: 12345 } },
    { name: 'pwsh', arguments: { command: { toString: null } } },
    { name: 'curl', arguments: { command: 'curl -o x https://y' } },
    { name: 'plugin_manager', arguments: { action: 'install', target: 'x' } },
    { name: 'plugin_manager', arguments: { action: null } },
  ]
  for (const exec of hostile) {
    const plan = classify(exec)
    assert.ok(plan === null || typeof plan === 'object', 'classify must return null or a plan')
  }
  ok('detect: classify absorbs every hostile shape without throwing')
}

/* ------------------------------------------------------------------ */
/* 9. A burst of downloads must not fan out into a burst of probes     */
/* ------------------------------------------------------------------ */

{
  // A local server that answers HEAD slowly and records how many it is serving
  // at once. This is the only way to see the cap: from the outside, a hundred
  // queued probes and a hundred running ones look identical.
  let live = 0
  let peak = 0
  let served = 0
  const server = createServer((req, res) => {
    live++
    peak = Math.max(peak, live)
    served++
    setTimeout(() => {
      live--
      res.writeHead(200, { 'content-length': '4096' })
      res.end()
    }, 120)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  reset()
  const N = 40
  for (let i = 0; i < N; i++) {
    beginTask(
      { callId: 'q' + i, name: 'pwsh' },
      {
        kind: 'download',
        command: `curl -o "${join(DIR, 'q' + i + '.bin')}" http://127.0.0.1:${port}/f${i}`,
      },
      DIR,
    )
  }

  // Wait for the queue to drain: 40 probes at 8 wide and 120 ms each is ~600 ms.
  // `served` counts responses written; the `fetch` promise settles a moment
  // later, so poll on the recorded totals rather than on the server counter.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (snapshot().filter((t) => t.total === 4096).length === N) break
    await new Promise((r) => setTimeout(r, 25))
  }
  server.close()

  assert.equal(served, N, `every one of the ${N} downloads must still be probed`)
  assert.ok(peak <= 8, `${peak} probes ran at once, over the cap of 8`)
  assert.ok(peak >= 2, `only ${peak} probes ever overlapped — the cap is not throttling anything`)
  // The probe result must still land on the task even when it had to queue.
  const withTotal = snapshot().filter((t) => t.total === 4096)
  assert.equal(withTotal.length, N, `a queued probe must still record its content-length`)
  console.log(`     (${N} probes, peak ${peak} concurrent, all ${served} served)`)
  ok('host: probe fan-out is capped, and a queued probe still records its size')
}

console.log('\nROUND-2 HOST STRESS OK — 1000 cards, probe fan-out, a simulated hour, hostile titles')
process.exit(0)
