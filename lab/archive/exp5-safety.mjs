/**
 * Experiment 5: cost and safety of reading the script from inside the plugin.
 *
 * Experiment 4 proved the approach works. This one is about whether it is SAFE
 * to run on every `-File` dispatch, in the host process, inside a hook that must
 * never disturb the tool call it observes:
 *
 *  - how long does reading + parsing a realistic script take? (budget: it runs
 *    on the hot path of `tools/execute`)
 *  - what happens with a script that is missing, huge, binary, or unreadable?
 *    Every one of those must yield "no plan", never an exception.
 *  - does a UTF-16 script (PowerShell writes BOM'd UTF-16LE when told to) parse?
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const LAB = 'D:/AIworks/dsh-download-progress/lab'
const WORK = path.join(LAB, 'work')
mkdirSync(WORK, { recursive: true })

/* ---------------- the parser, same rules as exp4 ---------------- */

const OUT_FLAGS = /(?:^|[\s;|&({])(?:-OutFile|-Destination|-Path|-o|--output)(?=[\s=:]|$)/gi

function collectAssignments(body) {
  const out = new Map()
  const re = /^\s*\$([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/gm
  let m
  while ((m = re.exec(body))) {
    let value = m[2]
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '')
    out.set(m[1], value.trim())
  }
  // `param($Out = 'default')` and typed declarations `[string]$Dest = 'D:\ISO'`
  // are both assignments, but neither starts a line with `$`, so the anchored
  // pattern above misses them. A script that pins its destination in a param
  // default has no other source for the path, and the default IS what runs when
  // the caller omits the switch.
  const paramRe = /(?:^|[\s(,;\]])\$([A-Za-z_][\w]*)\s*=\s*("[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s,;)]+)/g
  let pm
  while ((pm = paramRe.exec(body))) {
    if (out.has(pm[1])) continue
    out.set(pm[1], pm[2].trim())
  }
  return out
}

function expandAuto(text, env) {
  return text.replace(/\$env:([A-Za-z_][\w]*)/gi, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : whole
  })
}

/**
 * Resolve one side of an assignment to a literal string, or null.
 *
 * Handles quotes, `$var` interpolation over already-resolved variables, `$env:X`,
 * and `Join-Path`. Returns null for anything else — an honest "unresolved" beats
 * a wrong path that makes the card sample a file that never exists.
 *
 * The three shapes chain rather than being exclusive: `$out = Join-Path $Dest
 * "$Edition.iso"` is a cmdlet call whose arguments are a variable and an
 * interpolated string, so unwrapping quotes, interpolating, and then evaluating
 * the cmdlet all have to happen in the same pass. Handling quotes with an early
 * return silently produced the literal text `Join-Path D:\ISO "x.iso"`.
 */
function resolveValue(raw, vars, env, depth = 0) {
  if (depth > 6) return null
  let text = String(raw || '').trim()
  if (!text) return null

  // 1) Unwrap one layer of quotes, interpolating only for double quotes.
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text)
  if (quoted) {
    let inner = expandAuto(quoted[2], env)
    if (quoted[1] === '"') {
      let ok = true
      inner = inner.replace(/\$([A-Za-z_][\w]*)/g, (whole, name) => {
        const v = vars.has(name) ? resolveValue(vars.get(name), vars, env, depth + 1) : null
        if (v === null) ok = false
        return v === null ? whole : v
      })
      if (!ok) return null
    }
    text = inner.trim()
  }

  // 2) A cmdlet call that produces a path.
  const join = /^Join-Path\s+(.+)$/i.exec(text)
  if (join) {
    const parts = join[1].match(/"[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s]+/g) || []
    const resolved = parts.map((p) => resolveValue(p, vars, env, depth + 1))
    if (resolved.some((p) => p === null)) return null
    return resolved.join('\\').replace(/\\{2,}/g, '\\')
  }

  // 3) A bare variable, or a literal token.
  const bare = /^\$([A-Za-z_][\w]*)$/.exec(text)
  if (bare) return vars.has(bare[1]) ? resolveValue(vars.get(bare[1]), vars, env, depth + 1) : null
  if (!text) return null
  if (!/[\s$(){}]/.test(text)) return text
  return null
}

function scriptTargets(body, env) {
  const vars = collectAssignments(body)
  const found = []
  OUT_FLAGS.lastIndex = 0
  let m
  while ((m = OUT_FLAGS.exec(body))) {
    const rest = body.slice(m.index + m[0].length)
    const valueMatch = /^\s*(?::|=)?\s*("[^"]*"|'[^']*'|\$[A-Za-z_][\w]*|[^\s;|&)]+)/.exec(rest)
    if (!valueMatch) continue
    const resolved = resolveValue(valueMatch[1], vars, env)
    if (resolved) found.push({ raw: valueMatch[1], resolved })
  }
  return found
}

/**
 * The shape the plugin would actually call: give it a command, get targets or
 * nothing. Every failure mode collapses to `[]`, because a hook that throws
 * would take down the tool call it is observing.
 */
function planFromScriptFile(scriptPath, env) {
  try {
    const st = statSync(scriptPath)
    // A download script is a text file of a few KB. Anything wildly outside that
    // range is not something we should be slurping into memory on a hot path.
    if (!st.isFile() || st.size === 0 || st.size > 512 * 1024) return []
    const buf = readFileSync(scriptPath)
    const body = decodeScript(buf)
    if (body === null) return []
    return scriptTargets(body, env)
  } catch {
    return []
  }
}

/** PowerShell scripts come as UTF-8, UTF-16LE with BOM, or legacy ANSI. */
function decodeScript(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').slice(1)
  // Heuristic: NUL bytes in the first 64 bytes mean UTF-16LE without a BOM.
  const head = buf.subarray(0, 64)
  if (head.includes(0)) return buf.toString('utf16le')
  const text = buf.toString('utf8')
  if (text.includes('\uFFFD')) return null // binary or an encoding we cannot trust
  return text
}

/* ---------------- fixtures ---------------- */

const ENV = { USERPROFILE: 'C:\\Users\\Sama05', TEMP: 'C:\\Users\\Sama05\\AppData\\Local\\Temp' }

const REALISTIC = `#Requires -RunAsAdministrator
<#
  Downloads a Windows ISO.
#>
param(
  [string]$Edition = 'Win11_22H2',
  [string]$Dest = 'D:\\ISO'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$url  = "https://software-download.microsoft.com/$Edition.iso"
$out  = Join-Path $Dest "$Edition.iso"
$log  = "$Dest\\download.log"
Write-Host "Downloading to $out"
Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
`

const big = REALISTIC + '\n' + Array.from({ length: 4000 }, (_, i) => `# filler comment line ${i} to grow the file`).join('\n')

const fixtures = {
  'realistic.ps1': Buffer.from(REALISTIC, 'utf8'),
  'realistic-bom.ps1': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(REALISTIC, 'utf8')]),
  'utf16.ps1': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(REALISTIC, 'utf16le')]),
  'big.ps1': Buffer.from(big, 'utf8'),
  'binary.ps1': Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)),
  'empty.ps1': Buffer.alloc(0),
  'huge.ps1': Buffer.alloc(1024 * 1024, 0x23),
}

for (const [name, buf] of Object.entries(fixtures)) writeFileSync(path.join(WORK, name), buf)

/* ---------------- correctness over encodings ---------------- */

console.log('=== 编码与异常输入 ===\n')
const expect = ['D:\\ISO\\Win11_22H2.iso']
for (const name of ['realistic.ps1', 'realistic-bom.ps1', 'utf16.ps1']) {
  const got = planFromScriptFile(path.join(WORK, name), ENV).map((x) => x.resolved)
  const ok = JSON.stringify(got) === JSON.stringify(expect)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} -> ${JSON.stringify(got)}`)
  if (!ok) console.log(`      want ${JSON.stringify(expect)}`)
}

console.log('\n异常输入必须安静返回 [] 而不是抛异常:')
const weird = [
  'does-not-exist.ps1',
  'empty.ps1',
  'binary.ps1',
  'huge.ps1',
  'big.ps1',
]
for (const name of weird) {
  const t0 = performance.now()
  let out
  let threw = null
  try {
    out = planFromScriptFile(path.join(WORK, name), ENV)
  } catch (e) {
    threw = e
  }
  const ms = performance.now() - t0
  console.log(`  ${threw ? 'THREW' : 'quiet'}  ${name.padEnd(20)} ${ms.toFixed(2)}ms  -> ${out ? out.length + ' target(s)' : '-'}`)
}
// A directory as the -File argument is a real possibility: `-File C:\tmp`.
{
  let threw = null
  try {
    planFromScriptFile(WORK, ENV)
  } catch (e) {
    threw = e
  }
  console.log(`  ${threw ? 'THREW' : 'quiet'}  (directory as -File)`)
}

/* ---------------- timing on the hot path ---------------- */

console.log('\n=== 开销（100 次重复）===\n')
const target = path.join(WORK, 'realistic.ps1')
// warm up
for (let i = 0; i < 20; i++) planFromScriptFile(target, ENV)
const t0 = performance.now()
for (let i = 0; i < 100; i++) planFromScriptFile(target, ENV)
const per = (performance.now() - t0) / 100
console.log(`  单次 read+decode+parse: ${per.toFixed(3)} ms  (${statSync(target).size} bytes 脚本)`)
console.log(`  对照：一次 stat 约 0.01 ms，一次 CIM 全表快照约 100–1400 ms`)
console.log(`\n结论：${per < 5 ? '热路径开销可忽略' : '偏慢，需要缓存或延迟到首次采样'}；该钩子只在 -File 分支触发一次，不是每秒执行`)
