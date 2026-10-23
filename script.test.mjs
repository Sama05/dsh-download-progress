/**
 * Unit tests for `script.js`.
 *
 * Run with `node script.test.mjs` (it is part of `npm test`). Kept as plain
 * asserts with no test framework, matching the rest of this package
 * (`contract.mjs`, `smoke.mjs`), so the suite stays dependency-free.
 *
 * The tests are grouped the way the risk is:
 *   1. resolution correctness on realistic script shapes
 *   2. honest failure on shapes that cannot be resolved statically
 *   3. never throwing, on every degenerate input
 *   4. the encoding matrix
 *   5. cost on the hot path
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  collectAssignments,
  resolveValue,
  scriptTargets,
  scriptPathOf,
  scriptFileTargets,
  scriptPlan,
  scriptUrls,
} from './script.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, err })
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message.split('\n').join('\n       ')}`)
  }
}

const ENV = {
  USERPROFILE: 'C:\\Users\\Sama05',
  TEMP: 'C:\\Users\\Sama05\\AppData\\Local\\Temp',
  DOWNLOADS: 'D:\\ISO',
}

/* ------------------------------------------------------------------ *
 * 1. resolution on realistic shapes
 * ------------------------------------------------------------------ */

console.log('\nassignment collection')

test('records a plain line assignment', () => {
  const vars = collectAssignments('$iso = "D:\\ISO\\a.iso"\n')
  assert.equal(vars.get('iso'), '"D:\\ISO\\a.iso"')
})

test('records a typed param default', () => {
  const vars = collectAssignments("param(\n  [string]$Dest = 'D:\\ISO'\n)\n")
  assert.equal(vars.get('Dest'), "'D:\\ISO'")
})

test('a trailing comment is stripped from an unquoted value only', () => {
  const vars = collectAssignments('$n = 3  # count\n$s = "a # b"\n')
  assert.equal(vars.get('n'), '3')
  assert.equal(vars.get('s'), '"a # b"')
})

console.log('\nvalue resolution')

test('unwraps a double-quoted literal', () => {
  assert.equal(resolveValue('"D:\\ISO\\a.iso"', new Map(), ENV), 'D:\\ISO\\a.iso')
})

test('unwraps a single-quoted literal without interpolating', () => {
  assert.equal(resolveValue("'D:\\$literal'", new Map(), ENV), 'D:\\$literal')
})

test('interpolates a resolved variable inside double quotes', () => {
  const vars = new Map([['name', '"a.iso"']])
  assert.equal(resolveValue('"D:\\ISO\\$name"', vars, ENV), 'D:\\ISO\\a.iso')
})

test('returns null when an interpolated variable is unknown', () => {
  assert.equal(resolveValue('"D:\\ISO\\$nope"', new Map(), ENV), null)
})

test('expands $env: case-insensitively', () => {
  assert.equal(
    resolveValue('"$env:userprofile\\Downloads\\a.iso"', new Map(), ENV),
    'C:\\Users\\Sama05\\Downloads\\a.iso',
  )
})

test('leaves an unknown $env: name unresolved', () => {
  assert.equal(resolveValue('"$env:NOPE\\a.iso"', new Map(), ENV), null)
})

test('evaluates Join-Path over a variable and an interpolated string', () => {
  const vars = new Map([
    ['Dest', "'D:\\ISO'"],
    ['Edition', "'Win11_22H2'"],
  ])
  assert.equal(
    resolveValue('Join-Path $Dest "$Edition.iso"', vars, ENV),
    'D:\\ISO\\Win11_22H2.iso',
  )
})

test('Join-Path with one unresolved argument yields null, not a partial path', () => {
  const vars = new Map([['Dest', "'D:\\ISO'"]])
  assert.equal(resolveValue('Join-Path $Dest "$Unknown.iso"', vars, ENV), null)
})

test('stops a cyclic assignment chain instead of recursing forever', () => {
  const vars = new Map([
    ['a', '$b'],
    ['b', '$a'],
  ])
  assert.equal(resolveValue('$a', vars, ENV), null)
})

console.log('\ntarget extraction')

test('finds -OutFile from Invoke-WebRequest', () => {
  const body = '$out = "D:\\ISO\\a.iso"\nInvoke-WebRequest -Uri $u -OutFile $out\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\ISO\\a.iso'])
})

test('finds -Destination from Start-BitsTransfer', () => {
  const body = '$p = "D:\\ISO\\b.iso"\nStart-BitsTransfer -Source $u -Destination $p\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\ISO\\b.iso'])
})

test('finds -o from a curl shell-out', () => {
  const body = '$out = "D:\\ISO\\c.iso"\n& curl.exe -s -L -o $out $u\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\ISO\\c.iso'])
})

test('finds a literal -OutFile with no variable at all', () => {
  const body = 'Invoke-WebRequest -Uri $u -OutFile "D:\\ISO\\lit.iso"\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\ISO\\lit.iso'])
})

// A comment is prose. Scanning it produced two real bugs at once: a script whose
// header comment said "用 Invoke-WebRequest -OutFile 落盘" got the card titled
// `落盘（字节由`, and a script that merely documented a flag while writing nothing
// would have left a card stuck at 0 % forever.
test('a comment naming a flag contributes no target', () => {
  const body = '# 用 -OutFile 落盘说明\nWrite-Host "hello"\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('a comment naming a flag does not shift the real target', () => {
  const body = '# 用 -OutFile 落盘\n$p = "D:\\ISO\\real.iso"\nInvoke-WebRequest -Uri $u -OutFile $p\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\ISO\\real.iso'])
})

test('a block comment is stripped too', () => {
  const body = '<#\n  curl -o D:\\commented.bin http://h/f\n#>\nWrite-Host done\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('an unterminated block comment swallows the rest, as PowerShell does', () => {
  const body = '<# no end here\ncurl -o D:\\x.bin http://h/f\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('a # inside a quoted string is not a comment', () => {
  const body = '$u = "http://h/file#part"\nInvoke-WebRequest -Uri $u -OutFile "D:\\ISO\\hash.iso"\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\ISO\\hash.iso'])
  assert.deepEqual(scriptUrls(body), ['http://h/file#part'])
})

test('a # glued to a token is part of the token, not a comment', () => {
  const body = '$p = "D:\\a#b\\c.iso"\nInvoke-WebRequest -Uri $u -OutFile $p\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\a#b\\c.iso'])
})

test('a URL in a comment yields no denominator', () => {
  const body = '# 下载地址是 http://h/should-not-count\n$p = "D:\\ISO\\n.iso"\nInvoke-WebRequest -Uri $u -OutFile $p\n'
  assert.deepEqual(scriptUrls(body), [])
})

test('deduplicates a path named twice', () => {
  const body = 'Invoke-WebRequest -OutFile "D:\\a.iso" -OutFile "D:\\a.iso"\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\a.iso'])
})

test('keeps source order for several different targets', () => {
  const body = 'Invoke-WebRequest -OutFile "D:\\1.iso"\nInvoke-WebRequest -OutFile "D:\\2.iso"\n'
  assert.deepEqual(scriptTargets(body, ENV), ['D:\\1.iso', 'D:\\2.iso'])
})

/* ------------------------------------------------------------------ *
 * 2. honest failure — the half that keeps wrong cards off the screen
 * ------------------------------------------------------------------ */

console.log('\nunresolvable shapes must yield nothing')

test('a path built from command output yields nothing', () => {
  const body = '$cfg = Get-Content .\\c.json | ConvertFrom-Json\nInvoke-WebRequest -OutFile $cfg.path\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('the + concatenation operator yields nothing', () => {
  const body = '$d = "D:\\ISO"\nInvoke-WebRequest -OutFile ($d + "\\a.iso")\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('a here-string destination yields nothing', () => {
  const body = '$p = @"\nD:\\ISO\\a.iso\n"@\nInvoke-WebRequest -OutFile $p\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('a param with no default and no assignment yields nothing', () => {
  const body = 'param($Out)\nInvoke-WebRequest -OutFile $Out\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

test('a Get-Random name yields nothing', () => {
  const body = 'Invoke-WebRequest -OutFile "D:\\$(Get-Random).iso"\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

/* ------------------------------------------------------------------ *
 * 3. never throwing
 * ------------------------------------------------------------------ */

console.log('\ndegenerate input never throws')

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sp-'))

test('a missing script yields []', () => {
  assert.deepEqual(scriptFileTargets(`powershell -File ${path.join(dir, 'nope.ps1')}`, dir), [])
})

test('a directory passed as -File yields []', () => {
  assert.deepEqual(scriptFileTargets(`powershell -File ${dir}`, dir), [])
})

test('an empty script file yields []', () => {
  const p = path.join(dir, 'empty.ps1')
  writeFileSync(p, '')
  assert.deepEqual(scriptFileTargets(`powershell -File ${p}`, dir), [])
})

test('a binary file yields []', () => {
  const p = path.join(dir, 'bin.ps1')
  writeFileSync(p, Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)))
  assert.deepEqual(scriptFileTargets(`powershell -File ${p}`, dir), [])
})

test('a command with no -File yields []', () => {
  assert.deepEqual(scriptFileTargets('curl -o a.iso https://x/y', dir), [])
})

test('an empty command yields []', () => {
  assert.deepEqual(scriptFileTargets('', dir), [])
})

test('a null command yields []', () => {
  assert.deepEqual(scriptFileTargets(null, dir), [])
})

test('scriptTargets on a non-string yields []', () => {
  assert.deepEqual(scriptTargets(undefined, ENV), [])
})

test('a self-referential variable chain terminates', () => {
  const body = '$a = $b\n$b = $a\nInvoke-WebRequest -OutFile $a\n'
  assert.deepEqual(scriptTargets(body, ENV), [])
})

/* ------------------------------------------------------------------ *
 * 4. encoding matrix
 * ------------------------------------------------------------------ */

console.log('\nencodings')

const SCRIPT = '$out = "D:\\ISO\\enc.iso"\nInvoke-WebRequest -Uri $u -OutFile $out\n'
const WANT = ['D:\\ISO\\enc.iso']

test('utf8 without BOM', () => {
  const p = path.join(dir, 'u8.ps1')
  writeFileSync(p, Buffer.from(SCRIPT, 'utf8'))
  assert.deepEqual(scriptFileTargets(`powershell -File ${p}`, dir, ENV), WANT)
})

test('utf8 with BOM', () => {
  const p = path.join(dir, 'u8bom.ps1')
  writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SCRIPT, 'utf8')]))
  assert.deepEqual(scriptFileTargets(`powershell -File ${p}`, dir, ENV), WANT)
})

test('utf16le with BOM', () => {
  const p = path.join(dir, 'u16.ps1')
  writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SCRIPT, 'utf16le')]))
  assert.deepEqual(scriptFileTargets(`powershell -File ${p}`, dir, ENV), WANT)
})

test('utf16le without BOM is detected from NUL bytes', () => {
  const p = path.join(dir, 'u16nobom.ps1')
  writeFileSync(p, Buffer.from(SCRIPT, 'utf16le'))
  assert.deepEqual(scriptFileTargets(`powershell -File ${p}`, dir, ENV), WANT)
})

/* ------------------------------------------------------------------ *
 * 5. script path parsing
 * ------------------------------------------------------------------ */

console.log('\nscript path parsing')

test('bare -File path', () => {
  assert.equal(scriptPathOf('powershell -File C:\\a\\b.ps1', 'D:\\w'), 'C:\\a\\b.ps1')
})

test('quoted -File path', () => {
  assert.equal(scriptPathOf('powershell -File "C:\\a b\\c.ps1"', 'D:\\w'), 'C:\\a b\\c.ps1')
})

test('relative -File path resolves against cwd', () => {
  assert.equal(scriptPathOf('powershell -File sub\\x.ps1', 'D:\\w'), path.resolve('D:\\w', 'sub\\x.ps1'))
})

test('-FilePATH spelling is accepted', () => {
  assert.equal(scriptPathOf('pwsh -FilePath C:\\a.ps1', 'D:\\w'), 'C:\\a.ps1')
})

test('a $-containing path is refused rather than guessed', () => {
  assert.equal(scriptPathOf('powershell -File $env:X\\a.ps1', 'D:\\w'), null)
})

test('-File with trailing script arguments keeps only the path', () => {
  assert.equal(scriptPathOf('powershell -File C:\\a.ps1 -Url http://x -Out d.bin', 'D:\\w'), 'C:\\a.ps1')
})

test('-File followed by a statement separator does not swallow the separator', () => {
  // A real dispatch almost never ends at the path: the agent chains `; echo` to
  // read the exit code. Capturing `C:\a\b.ps1;` made statSync throw ENOENT and
  // dropped the whole card, so an otherwise identical command produced nothing.
  assert.equal(scriptPathOf('powershell -File C:\\a\\b.ps1; echo ok', 'D:\\w'), 'C:\\a\\b.ps1')
  assert.equal(scriptPathOf('powershell -File C:\\a\\b.ps1 ; echo ok', 'D:\\w'), 'C:\\a\\b.ps1')
  assert.equal(scriptPathOf('powershell -File C:\\a\\b.ps1 && echo ok', 'D:\\w'), 'C:\\a\\b.ps1')
  assert.equal(scriptPathOf('powershell -File C:\\a\\b.ps1 | Out-Null', 'D:\\w'), 'C:\\a\\b.ps1')
  assert.equal(scriptPathOf('powershell -File C:\\a\\b.ps1 2>&1', 'D:\\w'), 'C:\\a\\b.ps1')
})

test('a quoted path keeps a semicolon that is genuinely part of its name', () => {
  assert.equal(scriptPathOf('powershell -File "C:\\a;b\\c.ps1"', 'D:\\w'), 'C:\\a;b\\c.ps1')
})

/* ------------------------------------------------------------------ *
 * 6. the plan the host actually uses
 * ------------------------------------------------------------------ */

console.log('\nscript plan')

const planDir = mkdtempSync(path.join(tmpdir(), 'dsh-sp-plan-'))

test('a real-shaped script yields both its destination and its URL', () => {
  const p = path.join(planDir, 'get-iso.ps1')
  writeFileSync(
    p,
    [
      'param($Out)',
      "$ProgressPreference = 'SilentlyContinue'",
      '$iso = "D:\\ISO\\win22h2.iso"',
      '$u = "https://ms.example/win22h2.iso"',
      'Invoke-WebRequest -Uri $u -OutFile $iso',
      '',
    ].join('\n'),
  )
  const plan = scriptPlan(`powershell -File "${p}"`, planDir, ENV)
  assert.deepEqual(plan.targets, ['D:\\ISO\\win22h2.iso'])
  assert.deepEqual(plan.urls, ['https://ms.example/win22h2.iso'])
  assert.equal(plan.scriptPath, p)
})

test('a script with no destination yields no plan at all', () => {
  const p = path.join(planDir, 'hello.ps1')
  writeFileSync(p, 'Write-Output "nothing to download"\n')
  assert.equal(scriptPlan(`powershell -File "${p}"`, planDir, ENV), null)
})

test('two distinct URLs are reported as two, so no single denominator is used', () => {
  const p = path.join(planDir, 'two.ps1')
  writeFileSync(
    p,
    'Invoke-WebRequest -Uri https://a/1.iso -OutFile "D:\\1.iso"\n' +
      'Invoke-WebRequest -Uri https://b/2.iso -OutFile "D:\\2.iso"\n',
  )
  const plan = scriptPlan(`powershell -File "${p}"`, planDir, ENV)
  assert.equal(plan.urls.length, 2)
})

test('scriptUrls strips trailing sentence punctuation', () => {
  assert.deepEqual(scriptUrls('see https://a/b.iso.'), ['https://a/b.iso'])
  assert.deepEqual(scriptUrls('no urls here'), [])
  assert.deepEqual(scriptUrls(''), [])
})

rmSync(planDir, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * 7. cost
 * ------------------------------------------------------------------ */

console.log('\ncost on the hot path')

test('parsing a realistic script stays under 5 ms', () => {
  const p = path.join(dir, 'perf.ps1')
  const body =
    "param([string]$D = 'D:\\ISO')\n" +
    Array.from({ length: 60 }, (_, i) => `# comment ${i}\n$v${i} = "x${i}"\n`).join('') +
    'Invoke-WebRequest -OutFile (Join-Path $D "perf.iso")\n'
  writeFileSync(p, body)
  for (let i = 0; i < 20; i++) scriptFileTargets(`powershell -File ${p}`, dir, ENV)
  const t0 = performance.now()
  const N = 100
  for (let i = 0; i < N; i++) scriptFileTargets(`powershell -File ${p}`, dir, ENV)
  const per = (performance.now() - t0) / N
  assert.ok(per < 5, `took ${per.toFixed(2)} ms per call`)
  console.log(`       ${per.toFixed(3)} ms per call (${body.length} byte script)`)
})

rmSync(dir, { recursive: true, force: true })

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\nFAILED: ${f.name}\n${f.err.stack}`)
  process.exit(1)
}

