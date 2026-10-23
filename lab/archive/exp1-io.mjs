/**
 * Experiment: does per-process IO accounting actually track a download?
 *
 * Runs the same transfer two ways and samples `ReadTransferCount` for the
 * powershell process at 1 Hz:
 *
 *   iwr  — Invoke-WebRequest: the bytes are written by powershell itself.
 *   curl — a curl.exe CHILD does the transfer; powershell only waits.
 *
 * The second case is the one that decides whether this approach is worth
 * building: if a child's bytes are not attributed to the parent, then a `-File`
 * script that shells out to curl can never be measured this way.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { statSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LAB = 'D:/AIworks/dsh-download-progress/lab'
const WORK = path.join(LAB, 'work')
const HELPER = path.join(LAB, 'io-helper.ps1')
const PORT = 45777
const MB = 12

mkdirSync(WORK, { recursive: true })

/* ---------------- resident IO helper ---------------- */

function startHelper() {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  const rl = createInterface({ input: child.stdout })
  let pending = null
  let done = null
  let readyResolve = null
  const ready = new Promise((r) => {
    readyResolve = r
  })
  rl.on('line', (line) => {
    if (line === 'READY') {
      if (readyResolve) {
        readyResolve()
        readyResolve = null
      }
      return
    }
    if (line.startsWith('P\t')) {
      if (!pending) return
      const [, pid, r, w, o, name] = line.split('\t')
      pending.push({ pid: Number(pid), read: Number(r), write: Number(w), other: Number(o), name })
      return
    }
    if (line.startsWith('END\t') && pending) {
      const out = pending
      pending = null
      if (done) {
        done(out)
        done = null
      }
    }
  })
  return {
    ready,
    query(ids) {
      return new Promise((res) => {
        pending = []
        done = res
        child.stdin.write(ids.join(',') + '\n')
      })
    },
    close() {
      try {
        child.stdin.write('QUIT\n')
      } catch {}
      child.kill()
    },
  }
}

/* ---------------- one measured run ---------------- */

async function runHelper(helper, script, label) {
  const out = path.join(WORK, `${label}.bin`)
  if (existsSync(out)) unlinkSync(out)

  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(LAB, script), '-Url', `http://127.0.0.1:${PORT}/file?mb=${MB}`, '-Out', out],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  const err = []
  ps.stderr.on('data', (d) => err.push(String(d)))

  const samples = []
  const t0 = Date.now()
  const timer = setInterval(async () => {
    const rows = await helper.query([ps.pid])
    const row = rows[0]
    let disk = -1
    try {
      disk = statSync(out).size
    } catch {}
    samples.push({ t: Date.now() - t0, read: row ? row.read : null, write: row ? row.write : null, disk })
  }, 1000)

  const code = await new Promise((res) => ps.on('exit', res))
  clearInterval(timer)
  let finalDisk = -1
  try {
    finalDisk = statSync(out).size
  } catch {}

  return { label, exitCode: code, stderr: err.join('').slice(0, 400), samples, finalDisk, elapsedMs: Date.now() - t0 }
}

/* ---------------- report ---------------- */

function report(r) {
  console.log(`\n=== ${r.label} (exit=${r.exitCode}, ${r.elapsedMs}ms) ===`)
  if (r.stderr) console.log('stderr:', r.stderr.trim())
  console.log('  t(s)   readBytes        deltaRead      diskBytes      read/disk')
  let prev = null
  for (const s of r.samples) {
    const delta = prev === null || s.read === null ? '' : String(s.read - prev)
    const ratio = s.read && s.disk > 0 ? (s.read / s.disk).toFixed(3) : '-'
    console.log(`  ${String((s.t / 1000).toFixed(0)).padStart(4)}   ${String(s.read).padStart(13)}  ${delta.padStart(13)}  ${String(s.disk).padStart(12)}  ${ratio.padStart(8)}`)
    prev = s.read
  }
  console.log(`  finalDisk=${r.finalDisk} bytes (${(r.finalDisk / 1048576).toFixed(2)} MiB)`)
  const last = r.samples[r.samples.length - 1]
  if (last && last.read !== null) {
    console.log(`  final read=${last.read}  read/disk=${(last.read / r.finalDisk).toFixed(3)}`)
  }
}

/* ---------------- main ---------------- */

const server = spawn(process.execPath, [path.join(LAB, 'http-slow.mjs')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, LAB_PORT: String(PORT), LAB_RATE: String(4 * 1024 * 1024) },
})
await new Promise((res) => {
  const rl = createInterface({ input: server.stdout })
  rl.on('line', (line) => {
    const info = JSON.parse(line)
    console.log('server ready:', JSON.stringify(info))
    res()
  })
})

const helper = startHelper()
await helper.ready
console.log('io helper ready')

const results = []
for (const [script, label] of [
  ['dl-iwr.ps1', 'iwr'],
  ['dl-curl.ps1', 'curl-child'],
]) {
  results.push(await runHelper(helper, script, label))
}

helper.close()
server.kill()

for (const r of results) report(r)
writeFileSync(path.join(WORK, 'result.json'), JSON.stringify(results, null, 2))
console.log('\nwrote', path.join(WORK, 'result.json'))
