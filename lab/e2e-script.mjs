/**
 * End-to-end: does the card actually move for a `-File` script download?
 *
 * Everything else in the suite tests a function. This one tests the *claim*: a
 * real `powershell -NoProfile -ExecutionPolicy Bypass -File <script>` run against
 * a throttled server, observed only through the plugin's own `beginTask()` and
 * `sweep()`, must produce a climbing byte count.
 *
 * Two script shapes are covered because they exercise different byte paths:
 *   iwr   — powershell itself writes the file
 *   curl  — a child curl.exe writes the file, i.e. the bytes never touch
 *           powershell's own IO counters (this is the case that killed the
 *           per-process-counter approach)
 *
 *   node lab/e2e-script.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify } from '../detect.js'
import { beginTask, sweep, snapshot } from '../state.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = 45891
const MB = 24

const dir = mkdtempSync(path.join(tmpdir(), 'ddp-e2e-'))
const script = path.join(dir, 'get-file.ps1')

/** Start the throttled server as a child so its own timing is not ours. */
function startServer() {
  const child = spawn(process.execPath, [path.join(HERE, 'http-slow.mjs')], {
    env: { ...process.env, LAB_PORT: String(PORT), LAB_RATE: String(1536 * 1024) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000)
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('"ready"')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('exit', (code) => reject(new Error('server exited ' + code)))
  })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Run one shape and return its sample series.
 *
 * Each shape gets its own output path so the card from the previous shape cannot
 * be mistaken for this one when `snapshot()` is read.
 */
async function runShape(name, out, scriptBody, command) {
  writeFileSync(script, scriptBody)
  try {
    rmSync(out, { force: true })
  } catch {
    /* nothing to remove */
  }

  const exec = { callId: 'e2e-' + name, name: 'pwsh', agent: { id: 's-e2e' } }
  const plan = classify({ name: 'pwsh', arguments: { command } })
  assert.ok(plan, `${name}: classify must recognise the dispatch`)
  assert.equal(plan.script, true, `${name}: the destination lives in the script`)

  const task = beginTask(exec, plan, dir)
  assert.ok(task, `${name}: beginTask must produce a card`)
  assert.deepEqual(task.targets, [out], `${name}: the card watches the script's own destination`)

  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  const exited = new Promise((done) => child.on('exit', done))

  const samples = []
  const startedAt = Date.now()
  while (child.exitCode === null && Date.now() - startedAt < 120_000) {
    await sleep(1000)
    sweep(Date.now())
    const row = snapshot().find((r) => r.id === task.id)
    if (!row) break
    samples.push({
      bytes: row.bytes,
      total: row.total,
      speed: row.speed,
      pct: row.total ? row.bytes / row.total : null,
    })
  }
  const code = await exited

  console.log(`\n=== ${name} (exit=${code}) ===`)
  console.log('  t(s)        bytes      total      speed B/s    pct')
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    console.log(
      `  ${String(i + 1).padStart(4)}  ${String(s.bytes).padStart(10)}  ${String(s.total ?? '-').padStart(10)}  ` +
        `${String(Math.round(s.speed)).padStart(10)}  ${s.pct === null ? '     -' : (s.pct * 100).toFixed(1) + '%'}`,
    )
  }
  if (stderr.trim()) console.log('  stderr: ' + stderr.trim().split('\n').slice(0, 3).join(' | '))

  const finalDisk = statSync(out).size
  assert.equal(code, 0, `${name}: the script must succeed`)
  assert.equal(finalDisk, MB * 1024 * 1024, `${name}: the file must be complete`)
  assert.ok(samples.length >= 2, `${name}: the transfer must last long enough to sample`)

  // The claim under test: the byte count climbed. One tick would be a rounding
  // accident; a rising series is what a progress bar needs.
  const climbed = samples.some((s, i) => i > 0 && s.bytes > samples[i - 1].bytes)
  assert.ok(climbed, `${name}: the byte count must climb between samples`)
  const last = samples[samples.length - 1]
  assert.ok(last.bytes > 0, `${name}: a non-zero byte count reaches the card`)
  console.log(
    `  → bytes climbed ${samples[0].bytes} → ${last.bytes}, total=${last.total ?? 'unknown'}` +
      `, peak speed ${Math.round(Math.max(...samples.map((s) => s.speed)))} B/s`,
  )

  // Retire this card so the next shape's snapshot is unambiguous.
  task.done = true
  sweep(Date.now() + 25 * 60 * 60 * 1000)
  return samples
}

const server = await startServer()
try {
  const BASE = `http://127.0.0.1:${PORT}/file?mb=${MB}`
  const command = () => `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`

  // Shape 1: powershell writes the file itself.
  await runShape(
    'iwr',
    path.join(dir, 'iwr.bin'),
    [
      'param($Url)',
      "$ProgressPreference = 'SilentlyContinue'",
      `$iso = "${path.join(dir, 'iwr.bin')}"`,
      `Invoke-WebRequest -Uri "${BASE}" -OutFile $iso -UseBasicParsing`,
      '',
    ].join('\n'),
    command(),
  )

  // Shape 2: a child curl.exe writes it. This is the case the per-process IO
  // counters could not see at all: powershell's own counters stay flat while
  // curl moves the bytes, and the card must still follow the file.
  await runShape(
    'curl-child',
    path.join(dir, 'curl.bin'),
    [
      'param($Url)',
      `$iso = "${path.join(dir, 'curl.bin')}"`,
      `& curl.exe -s -L --fail -o $iso "${BASE}"`,
      'if ($LASTEXITCODE -ne 0) { throw "curl failed: $LASTEXITCODE" }',
      '',
    ].join('\n'),
    command(),
  )

  console.log('\nE2E OK — a `-File` script download produces a climbing card, for both byte paths')
} finally {
  server.kill()
  rmSync(dir, { recursive: true, force: true })
}

