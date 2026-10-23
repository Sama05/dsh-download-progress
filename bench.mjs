/**
 * bench.mjs — micro-benchmarks for the hot paths, so refactors are measurable.
 *
 * The plugin runs a 1 s sampler on the host main thread and a 1 s poller in the
 * browser, so "fast enough" is not a vibe: `classify()` runs on EVERY tool call,
 * `sample()`/`snapshot()` run on every tick, and the client re-renders on every
 * frame. This file pins those down to numbers.
 *
 * Methodology (deliberately boring, so results are comparable across runs):
 *
 *  - `hrtime.bigint()` rather than `Date.now()`: a sub-millisecond operation is
 *    invisible at wall-clock resolution.
 *  - Warm up before measuring. V8 optimises a function after it has been called
 *    a few thousand times; timing the cold calls measures the interpreter, not
 *    the code, and a refactor that changes function count changes that warm-up
 *    behaviour — which would look like a regression that is not one.
 *  - Report the MEDIAN of the rounds, not the mean: one GC pause or one
 *    descheduled timeslice otherwise dominates a 0.05 ms measurement.
 *  - Report p95 too, because the sampler's worst tick is what the user feels;
 *    an average that hides a 30 ms spike is a lie about a 1 s timer.
 *
 * Run:  node bench.mjs            human-readable table
 *       node bench.mjs --json     machine-readable, for comparing two runs
 *       node bench.mjs --save     also write bench/baseline.json
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const JSON_OUT = process.argv.includes('--json')
const SAVE = process.argv.includes('--save')

const hrtime = process.hrtime.bigint()
const msSince = (from) => Number(process.hrtime.bigint() - from) / 1e6

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const results = []

/**
 * Time `fn` and record it.
 *
 * @param {string} name    stable id, used to diff two runs
 * @param {Function} fn    the operation; may return a promise
 * @param {{rounds?: number, warmup?: number, setup?: Function}} [options]
 */
async function bench(name, fn, options = {}) {
  const rounds = options.rounds ?? 30
  const warmup = options.warmup ?? 8
  const samples = []
  for (let i = 0; i < warmup; i++) {
    const ctx = options.setup ? await options.setup() : undefined
    await fn(ctx)
  }
  for (let i = 0; i < rounds; i++) {
    const ctx = options.setup ? await options.setup() : undefined
    const t = process.hrtime.bigint()
    await fn(ctx)
    samples.push(msSince(t))
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
  const min = samples[0]
  const max = samples[samples.length - 1]
  results.push({ name, median, p95, min, max, rounds })
  return median
}

/* ------------------------------------------------------------------ *
 * Subject under test
 * ------------------------------------------------------------------ */

const detect = await import('./detect.js')
const state = await import('./state.js')
const { scriptPlan } = await import('./script.js')

/* A realistic workload mix. Weights matter more than count: most tool calls in a
 * real session are NOT downloads, and the classifier's cost on those is what the
 * user pays most often. */
const CURL = 'curl.exe -L --fail -o "D:\\Downloads\\node.zip" https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-win-x64.zip'
const IWR = 'Invoke-WebRequest -Uri https://example.com/x.iso -OutFile D:\\x\\x.iso -UseBasicParsing'
const CLONE = 'git clone --depth 1 https://github.com/lodash/lodash.git D:\\work\\lodash'
const PKG = 'pnpm add @deepseek-ai/dsh-plugin-manager'
const NOTHING = 'Get-ChildItem -LiteralPath D:\\AIworks -Recurse -Depth 2 | Select-Object Name, Length'
const SEARCH = { name: 'web_search', arguments: { queries: ['dsh plugin', 'cordis patch'] } }

const tmp = mkdtempSync(join(tmpdir(), 'ddp-bench-'))
/** A 1.6 KB script with the shapes a real installer script uses. */
const SCRIPT_BODY = [
  'param([string]$Url = "https://example.com/win.iso", [string]$Out = "D:\\iso\\win.iso")',
  '$ProgressPreference = "SilentlyContinue"',
  '$dir = Join-Path $env:USERPROFILE "Downloads"',
  '$log = "D:\\iso\\get-iso.log"',
  '@"',
  'downloading $Url',
  '"@ | Set-Content -LiteralPath $log',
  'foreach ($i in 1..3) { Write-Host "attempt $i" }',
  'Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing',
  'Write-Host "done"',
].join('\r\n')
writeFileSync(join(tmp, 'get-iso.ps1'), SCRIPT_BODY, 'utf8')
const SCRIPT_CMD = `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(tmp, 'get-iso.ps1')}"`

try {
  /* ---- classifier: the per-tool-call cost ---- */

  await bench('classify/curl', () => detect.classify({ name: 'pwsh', arguments: { command: CURL } }))
  await bench('classify/iwr', () => detect.classify({ name: 'pwsh', arguments: { command: IWR } }))
  await bench('classify/clone', () => detect.classify({ name: 'pwsh', arguments: { command: CLONE } }))
  await bench('classify/pkg', () => detect.classify({ name: 'pwsh', arguments: { command: PKG } }))
  await bench('classify/nothing', () => detect.classify({ name: 'pwsh', arguments: { command: NOTHING } }))
  await bench('classify/search', () => detect.classify(SEARCH))
  await bench('classify/-File', () => detect.classify({ name: 'pwsh', arguments: { command: SCRIPT_CMD } }))

  /* ---- script reading: only on -File, but synchronous on the host thread ---- */

  await bench('script/plan', () => scriptPlan(SCRIPT_CMD), { rounds: 40 })

  /* ---- target extraction ---- */

  await bench('targets/curl', () => detect.extractTargets(CURL, 'D:\\AIworks'))
  await bench('targets/8-flags', () =>
    detect.extractTargets(
      'curl -o a.bin https://x/a -o b.bin https://x/b -o c.bin https://x/c -o d.bin https://x/d',
      'D:\\AIworks',
    ),
  )

  /* ---- sampler: the 1 s tick, measured per card and at scale ---- */

  const sampleDir = mkdtempSync(join(tmpdir(), 'ddp-bench-files-'))
  for (let i = 0; i < 200; i++) {
    writeFileSync(join(sampleDir, `f${i}.bin`), Buffer.alloc(1024))
  }

  /** Register `n` live download tasks writing into `sampleDir`. */
  async function cards(n) {
    state.sweep(Date.now() + 31 * 60 * 1000) // retire everything from the last round
    const ids = []
    for (let i = 0; i < n; i++) {
      const t = state.beginTask(
        { callId: `bench-${i}`, name: 'pwsh' },
        { kind: 'download', command: `curl -o "${join(sampleDir, `f${i}.bin`)}" http://127.0.0.1:9/f${i}` },
        sampleDir,
      )
      if (t) ids.push(t.id)
    }
    return ids
  }

  await bench(
    'sample/1-card',
    () => {
      state.sweep(Date.now())
    },
    { setup: () => cards(1), rounds: 40, warmup: 10 },
  )
  await bench(
    'sample/30-cards',
    () => {
      state.sweep(Date.now())
    },
    { setup: () => cards(30), rounds: 20, warmup: 6 },
  )

  /* ---- snapshot: serialised once per poll, so it is the wire cost ---- */
  await bench(
    'snapshot/30-cards',
    () => {
      const rows = state.snapshot()
      return JSON.stringify(rows)
    },
    { setup: () => cards(30), rounds: 20, warmup: 6 },
  )

  /* ---- bundle load: what a page refresh pays ---- */
  const clientSrc = readFileSync(join(HERE, 'client.js'), 'utf8')
  await bench(
    'client/parse-in-vm',
    async () => {
      const { createContext, runInContext } = await import('node:vm')
      const sandbox = {
        window: {
          location: { origin: 'http://bench.invalid' },
          innerWidth: 1440,
          innerHeight: 900,
          localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
          addEventListener: () => {},
          removeEventListener: () => {},
          __ModuleLoader__: { load(definition) { this.last = definition } },
        },
        document: {
          createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
          head: { appendChild() {} },
          getElementById: () => null,
          querySelectorAll: () => [],
          addEventListener: () => {},
          removeEventListener: () => {},
        },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        setTimeout: () => 0,
        clearTimeout: () => {},
        console,
        fetch: async () => ({ ok: true, json: async () => ({ tasks: [] }) }),
      }
      sandbox.globalThis = sandbox
      createContext(sandbox)
      runInContext(clientSrc, sandbox, { filename: 'client.js' })
    },
    { rounds: 12, warmup: 4 },
  )
  await bench('client/read-bytes', () => readFileSync(join(HERE, 'client.js'), 'utf8').length, {
    rounds: 20,
  })

  /* ---- module load: host half cold start ---- */
  await bench(
    'host/import-cost',
    async () => {
      await import('./state.js?bench=' + Math.random())
    },
    { rounds: 6, warmup: 2 },
  )

  rmSync(sampleDir, { recursive: true, force: true })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const fmt = (n) => (n >= 10 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4))

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
} else {
  console.log('')
  console.log('  benchmark                          median      p95       min       max')
  console.log('  ' + '-'.repeat(72))
  for (const r of results) {
    console.log(
      '  ' +
        r.name.padEnd(34) +
        (fmt(r.median) + ' ms').padStart(10) +
        (fmt(r.p95) + ' ms').padStart(10) +
        (fmt(r.min) + ' ms').padStart(10) +
        (fmt(r.max) + ' ms').padStart(10),
    )
  }
  console.log('')
  const slowest = [...results].sort((a, b) => b.median - a.median)[0]
  console.log('  slowest (median): ' + slowest.name + ' @ ' + fmt(slowest.median) + ' ms')
  console.log('  total wall time:  ' + fmt(msSince(hrtime)) + ' ms (including warm-up)')
  console.log('')
}

if (SAVE) {
  mkdirSync(join(HERE, 'bench'), { recursive: true })
  const target = join(HERE, 'bench', process.argv.includes('--after') ? 'after.json' : 'baseline.json')
  writeFileSync(target, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  console.log('  saved → ' + target)
}

export { results }
