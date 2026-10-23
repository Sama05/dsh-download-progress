/**
 * Experiment 3: can we measure a `-File` script download WITHOUT admin rights
 * and WITHOUT reading the script?
 *
 * Experiment 1 killed per-process IO counters (they are file I/O only).
 * Experiment 2 killed TCP extended stats (SetPerTcpConnectionEStats returns 5 =
 * ACCESS_DENIED for a non-admin process, and the read then yields garbage).
 *
 * What is left is the process tree. A script that downloads usually shells out
 * to curl/wget/aria2c, and a child's COMMAND LINE contains the output path.
 * WMI exposes CommandLine for same-user processes with no elevation.
 *
 * This test proves, step by step, on a script that we are NOT allowed to read:
 *   1. find the powershell PID that is running `-File <script>` (CommandLine match)
 *   2. enumerate its descendants
 *   3. pull the `-o <path>` target out of a curl child's command line
 *   4. stat that path at 1 Hz and get a sane growth curve
 *
 * It also runs an inline Invoke-WebRequest variant, which must yield nothing —
 * that negative result is the honest boundary of this approach.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { statSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LAB = 'D:/AIworks/dsh-download-progress/lab'
const WORK = path.join(LAB, 'work')
const PORT = 45795
const MB = 24
mkdirSync(WORK, { recursive: true })

/* ---------- the script we pretend we cannot read ---------- */

const SCRIPT_CURL = `param($Url, $Out)
& curl.exe -s -L --fail -o $Out $Url
if ($LASTEXITCODE -ne 0) { throw "curl failed: $LASTEXITCODE" }
`
const SCRIPT_IWR = `param($Url, $Out)
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
`
writeFileSync(path.join(LAB, 'get-iso-curl.ps1'), SCRIPT_CURL)
writeFileSync(path.join(LAB, 'get-iso-iwr.ps1'), SCRIPT_IWR)

/* ---------- resident CIM helper: process tree + command lines ---------- */

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Output 'READY'
$T = [char]9
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line -eq '') { continue }
  try {
    # One snapshot of every process, so whole-tree questions cost one query.
    $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine |
             Where-Object { $_.Name -in @('powershell.exe','pwsh.exe','curl.exe','wget.exe','aria2c.exe','bitsadmin.exe') }
    foreach ($p in $all) {
      $cmd = [string]$p.CommandLine
      if ($cmd.Length -gt 900) { $cmd = $cmd.Substring(0,900) }
      $cmd = $cmd.Replace([string][char]13, ' ').Replace([string][char]10, ' ').Replace([string][char]9, ' ')
      Write-Output ('P' + $T + $p.ProcessId + $T + $p.ParentProcessId + $T + $p.Name + $T + $cmd)
    }
    Write-Output ('END' + $T + @($all).Count)
  } catch {
    Write-Output ('END' + $T + 0)
  }
}
`
const helperPath = path.join(LAB, 'proc-helper.ps1')
writeFileSync(helperPath, HELPER)

function startHelper() {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  const rl = createInterface({ input: child.stdout })
  const errs = []
  child.stderr.on('data', (d) => errs.push(String(d)))
  let buf = []
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
      const [, pid, ppid, name, cmd] = line.split('\t')
      buf.push({ pid: Number(pid), ppid: Number(ppid), name, cmd: cmd || '' })
      return
    }
    if (line.startsWith('END\t')) {
      const out = buf
      buf = []
      if (done) {
        done(out)
        done = null
      }
    }
  })
  return {
    ready,
    errors: () => errs.join('').trim(),
    snapshot() {
      return new Promise((res) => {
        buf = []
        done = res
        child.stdin.write('GO\n')
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

/* ---------- helpers over a snapshot ---------- */

function descendants(all, rootPid) {
  const byParent = new Map()
  for (const p of all) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p)
  }
  const out = []
  const queue = [rootPid]
  const seen = new Set([rootPid])
  while (queue.length) {
    const cur = queue.shift()
    for (const kid of byParent.get(cur) || []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      out.push(kid)
      queue.push(kid.pid)
    }
  }
  return out
}

/**
 * Same flag vocabulary the plugin already uses for curl, applied to a child's
 * command line instead of the tool call's command string.
 */
const CURL_OUT = /(?:^|\s)(?:-o|--output)(?:\s+|=)("([^"]+)"|'([^']+)'|(\S+))/i

function outPathOf(cmd) {
  const m = CURL_OUT.exec(cmd)
  if (!m) return null
  return m[2] || m[3] || m[4] || null
}

/* ---------- one scenario ---------- */

async function scenario(helper, scriptName, label) {
  const out = path.join(WORK, `tree-${label}.bin`)
  if (existsSync(out)) unlinkSync(out)

  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(LAB, scriptName), '-Url', `http://127.0.0.1:${PORT}/file?mb=${MB}`, '-Out', out],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  const t0 = Date.now()
  const rows = []
  let discoveredTarget = null
  let childSeen = null

  const timer = setInterval(async () => {
    const snap = await helper.snapshot()
    const kids = descendants(snap, ps.pid)
    if (!childSeen) {
      const dl = kids.find((k) => /^(curl|wget|aria2c)/i.test(k.name))
      if (dl) childSeen = { name: dl.name, pid: dl.pid, cmd: dl.cmd }
    }
    if (!discoveredTarget) {
      for (const k of kids) {
        const p = outPathOf(k.cmd)
        if (p) {
          discoveredTarget = p
          break
        }
      }
    }
    let disk = -1
    if (discoveredTarget) {
      try {
        disk = statSync(discoveredTarget).size
      } catch {}
    }
    rows.push({ t: Date.now() - t0, kids: kids.map((k) => k.name), target: discoveredTarget, disk })
  }, 1000)

  const code = await new Promise((res) => ps.on('exit', res))
  clearInterval(timer)
  let finalDisk = -1
  try {
    finalDisk = statSync(out).size
  } catch {}

  return { label, exitCode: code, elapsedMs: Date.now() - t0, rows, discoveredTarget, childSeen, finalDisk, expected: out }
}

/* ---------- main ---------- */

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

const helper = startHelper()
await helper.ready
console.log('proc helper ready')

const results = []
for (const [script, label] of [
  ['get-iso-curl.ps1', 'curl'],
  ['get-iso-iwr.ps1', 'iwr'],
]) {
  const r = await scenario(helper, script, label)
  results.push(r)
  console.log(`\n=== ${label} (exit=${r.exitCode}, ${r.elapsedMs}ms) ===`)
  console.log('  discovered target:', r.discoveredTarget || '(none)')
  console.log('  downloader child:', r.childSeen ? `${r.childSeen.name} pid=${r.childSeen.pid}` : '(none)')
  if (r.childSeen) console.log('  child cmdline   :', r.childSeen.cmd.slice(0, 220))
  console.log('  t(s)   kids                          diskBytes')
  for (const row of r.rows) {
    console.log(`  ${String(Math.round(row.t / 1000)).padStart(4)}   ${row.kids.join(',').padEnd(28)}  ${String(row.disk).padStart(10)}`)
  }
  console.log(`  finalDisk=${r.finalDisk}  expected=${MB * 1048576}`)
  const grew = r.rows.filter((x) => x.disk > 0).length
  console.log(`  samples with a usable size: ${grew}/${r.rows.length}`)
}

helper.close()
server.kill()
writeFileSync(path.join(WORK, 'result3.json'), JSON.stringify(results.map((r) => ({ ...r, rows: r.rows })), null, 2))
console.log('\nwrote', path.join(WORK, 'result3.json'))
