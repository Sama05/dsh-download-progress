/**
 * Experiment 4: can the plugin get the target from the SCRIPT FILE itself?
 *
 * Experiments 1-3 established that neither process IO counters nor TCP extended
 * stats work without admin, and that a process-tree scan only helps when the
 * script shells out to curl/wget/aria2c. A Windows ISO script normally uses
 * Invoke-WebRequest, which has no child process at all.
 *
 * But the plugin runs inside the host process and `state.js` already imports
 * `readFileSync` (for aria2c manifests). So the script text itself is readable.
 * That is a completely different route: parse the script statically, resolve the
 * output path, then stat it — zero process scanning, zero per-tick overhead.
 *
 * This test asks whether a realistic `get-iso.ps1` yields its target this way,
 * and deliberately includes the hard shapes (env vars, concatenation, defaults).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'

const LAB = 'D:/AIworks/dsh-download-progress/lab'
const WORK = path.join(LAB, 'work')
const PORT = 45810
const MB = 32
mkdirSync(WORK, { recursive: true })

/* ------------------------------------------------------------------ *
 * The parser under test. This is prototype code, deliberately written
 * as pure functions so it can be unit-tested without any I/O.
 * ------------------------------------------------------------------ */

/** Flags that name an output path, in the three families we support. */
const OUT_FLAGS = /(?:^|[\s;|&({])(?:-OutFile|-Destination|-Path|-o|--output)(?=[\s=:]|$)/gi

/**
 * Collect `$name = <value>` assignments from a script body.
 *
 * Only single-level literals are recorded, matching what `detect.js` already
 * promises for command lines: a value that is itself built from other variables
 * stays unresolved rather than being guessed.
 */
function collectAssignments(body) {
  const out = new Map()
  // `$x = value` on its own line.
  const re = /^\s*\$([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/gm
  let m
  while ((m = re.exec(body))) {
    const name = m[1]
    let value = m[2]
    // Trim a trailing comment that is not inside a string.
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '')
    out.set(name, value.trim())
  }
  // `param($Out = 'default')` — a default is just an assignment whose line is
  // wrapped in the param block, so the `^\s*\$` anchor above misses it. These
  // matter: a script that pins its destination in a default has no other source
  // for the path, and the default IS what runs when the caller omits the switch.
  const paramRe = /(?:^|[\s(,;])\$([A-Za-z_][\w]*)\s*=\s*("[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s,;)]+)/g
  let pm
  while ((pm = paramRe.exec(body))) {
    // A plain assignment was already recorded with the same key; first writer wins.
    if (out.has(pm[1])) continue
    out.set(pm[1], pm[2].trim())
  }
  return out
}

/** Expand the handful of automatic variables a download script realistically uses. */
function expandAuto(text, env) {
  return text.replace(/\$env:([A-Za-z_][\w]*)/gi, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : whole
  })
}

/**
 * Resolve one side of an assignment to a literal string, or null.
 *
 * Handles `"literal"`, `'literal'`, `"$var\file.iso"` interpolation over already
 * resolved variables, and `$env:X`. Returns null for anything else — an honest
 * "unresolved" beats a wrong path that makes the card sample a file that will
 * never exist.
 */
function resolveValue(raw, vars, env, depth = 0) {
  if (depth > 6) return null
  let text = raw.trim()
  if (!text) return null
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text)
  if (quoted) {
    let inner = expandAuto(quoted[2], env)
    if (quoted[1] === "'") return inner // single quotes: no interpolation
    let ok = true
    inner = inner.replace(/\$([A-Za-z_][\w]*)/g, (whole, name) => {
      const v = vars.has(name) ? resolveValue(vars.get(name), vars, env, depth + 1) : null
      if (v === null) ok = false
      return v === null ? whole : v
    })
    return ok ? inner : null
  }
  // Bare `$var`
  const bare = /^\$([A-Za-z_][\w]*)$/.exec(text)
  if (bare) {
    const v = vars.has(bare[1]) ? resolveValue(vars.get(bare[1]), vars, env, depth + 1) : null
    return v
  }
  // Unquoted literal token (a path with no spaces).
  if (!/[\s$(){}]/.test(text)) return text
  return null
}

/** Every output path a script names, in source order, resolved where possible. */
function scriptTargets(body, env) {
  const vars = collectAssignments(body)
  const found = []
  OUT_FLAGS.lastIndex = 0
  let m
  while ((m = OUT_FLAGS.exec(body))) {
    // The value is everything up to whitespace/statement end after the flag.
    const rest = body.slice(m.index + m[0].length)
    const valueMatch = /^\s*(?::|=)?\s*("[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s;|&)]+)/.exec(rest)
    if (!valueMatch) continue
    const resolved = resolveValue(valueMatch[1], vars, env)
    if (resolved) found.push({ raw: valueMatch[1], resolved })
  }
  return found
}

/* ---------------- tests over realistic script shapes ---------------- */

const ENV = {
  USERPROFILE: 'C:\\Users\\Sama05',
  TEMP: 'C:\\Users\\Sama05\\AppData\\Local\\Temp',
}

const CASES = [
  {
    name: 'hard-coded path, no params (closest to the screenshot)',
    body: `$url = "https://example.com/win.iso"
$iso = "D:\\ISO\\Win11_22H2.iso"
Invoke-WebRequest -Uri $url -OutFile $iso -UseBasicParsing
`,
    want: ['D:\\ISO\\Win11_22H2.iso'],
  },
  {
    name: 'env-var expansion',
    body: `Invoke-WebRequest -Uri $u -OutFile "$env:USERPROFILE\\Downloads\\win11.iso"
`,
    want: ['C:\\Users\\Sama05\\Downloads\\win11.iso'],
  },
  {
    name: 'param block with defaults + single quotes',
    body: `param($Out = 'D:\\ISO\\default.iso')
Invoke-WebRequest -Uri $u -OutFile $Out
`,
    want: ['D:\\ISO\\default.iso'],
  },
  {
    name: 'concat of two resolved vars',
    body: `$dir = "D:\\ISO"
$name = "win10.iso"
$dest = "$dir\\$name"
Invoke-WebRequest -Uri $x -OutFile $dest
`,
    want: ['D:\\ISO\\win10.iso'],
  },
  {
    name: 'curl shell-out inside the script',
    body: `$out = "D:\\ISO\\tiny.iso"
& curl.exe -s -L -o $out $url
`,
    want: ['D:\\ISO\\tiny.iso'],
  },
  {
    name: 'Start-BitsTransfer',
    body: `$p = "D:\\ISO\\bits.iso"
Start-BitsTransfer -Source $u -Destination $p
`,
    want: ['D:\\ISO\\bits.iso'],
  },
  {
    name: 'NEGATIVE: path built from a command output',
    body: `$cfg = Get-Content .\\cfg.json | ConvertFrom-Json
Invoke-WebRequest -Uri $u -OutFile $cfg.path
`,
    want: [],
  },
  {
    name: 'NEGATIVE: path from string concatenation operator',
    body: `$d = "D:\\ISO"
Invoke-WebRequest -Uri $u -OutFile ($d + "\\" + $name)
`,
    want: [],
  },
]

let pass = 0
let fail = 0
console.log('=== 单元测试：脚本静态解析 ===\n')
for (const c of CASES) {
  const got = scriptTargets(c.body, ENV).map((x) => x.resolved)
  const ok = JSON.stringify(got) === JSON.stringify(c.want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) {
    console.log(`      want: ${JSON.stringify(c.want)}`)
    console.log(`      got : ${JSON.stringify(got)}`)
  }
}
console.log(`\n${pass} passed, ${fail} failed`)

/* ---------------- end-to-end: parse a real script, then sample its output ---------------- */

const REAL_SCRIPT = `param($Url, $Out)
$ProgressPreference = 'SilentlyContinue'
$iso = "D:\\AIworks\\dsh-download-progress\\lab\\work\\e2e.iso"
Invoke-WebRequest -Uri $Url -OutFile $iso -UseBasicParsing
Write-Output "done"
`
const realPath = path.join(LAB, 'get-iso-real.ps1')
writeFileSync(realPath, REAL_SCRIPT)
const isoPath = 'D:\\AIworks\\dsh-download-progress\\lab\\work\\e2e.iso'
if (existsSync(isoPath)) unlinkSync(isoPath)

console.log('\n=== 端到端：不读命令行目标，只读脚本 ===\n')

// 1) The plugin only knows the command string.
const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${realPath}" -Url http://127.0.0.1:${PORT}/file?mb=${MB} -Out ignored.bin`
const fileArg = /(?:^|\s)-File\s+("([^"]+)"|'([^']+)'|(\S+))/i.exec(command)
const scriptArg = fileArg ? fileArg[2] || fileArg[3] || fileArg[4] : null
console.log('从命令行解析出的脚本:', scriptArg)

// 2) Read the script ourselves and resolve its target.
const body = readFileSync(scriptArg, 'utf8')
const parsed = scriptTargets(body, ENV)
console.log('从脚本解析出的目标:', parsed.map((x) => x.resolved))
const target = parsed.length ? parsed[0].resolved : null

// 3) Run it and sample the file we predicted — the plugin never learns it from a process.
const server = spawn(process.execPath, [path.join(LAB, 'http-slow.mjs')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, LAB_PORT: String(PORT), LAB_RATE: String(8 * 1024 * 1024) },
})
await new Promise((res) => {
  const rl = createInterface({ input: server.stdout })
  rl.on('line', (l) => {
    console.log('server:', l)
    res()
  })
})

const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', realPath, '-Url', `http://127.0.0.1:${PORT}/file?mb=${MB}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
ps.stderr.on('data', () => {})

const t0 = Date.now()
const rows = []
const timer = setInterval(() => {
  let size = -1
  if (target) {
    try {
      size = statSync(target).size
    } catch {}
  }
  rows.push({ t: Date.now() - t0, size })
}, 1000)

const code = await new Promise((res) => ps.on('exit', res))
clearInterval(timer)
server.kill()

console.log(`\nInvoke-WebRequest 无子进程场景, exit=${code}, ${Date.now() - t0}ms`)
console.log('  t(s)      bytes            MiB')
let prev = 0
for (const r of rows) {
  const speed = r.size > prev && r.t > 0 ? ((r.size - prev) / 1048576).toFixed(1) + ' MiB/s' : ''
  prev = Math.max(prev, r.size)
  console.log(`  ${String(Math.round(r.t / 1000)).padStart(4)}  ${String(r.size).padStart(12)}     ${(r.size / 1048576).toFixed(1).padStart(6)}   ${speed}`)
}
console.log(`\n最终文件: ${target}`)
console.log(`期望 ${MB * 1048576} bytes`)
console.log(`实测可用采样: ${rows.filter((r) => r.size > 0).length}/${rows.length}`)
