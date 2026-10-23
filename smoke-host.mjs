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
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aria2InputSpec, classify, extractTargets } from './detect.js'
import { scriptPlan } from './script.js'
import {
  IDLE_TICKS_TO_CLOSE,
  LINGER_MS,
  aria2Completed,
  beginTask,
  noteInstallLog,
  noteInstallPhase,
  parseAria2Input,
  readAria2Bulk,
  snapshot,
  sweep,
} from './state.js'
import { clip, extractUrl, firstLine, lastLine, uniq, unquote } from './utils.js'
import {
  backgroundSnapshot,
  noteJobEvent,
  RECONCILE_AFTER_MS,
  reconcileJobs,
  noteToolEnd,
  noteToolStart,
  resetBackground,
  setTitleLookup,
} from './background.js'

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
// Every real search tool takes `queries`, an array. Reading only the scalar keys
// left the headline empty and the card read 正在搜索「…」中 with no subject.
assert.equal(
  classify({ name: 'web_search', arguments: { queries: ['dsh plugin', 'cordis'] } }).label,
  'dsh plugin · cordis',
)
assert.equal(classify({ name: 'web_search', arguments: { queries: ['solo'] } }).label, 'solo')
assert.equal(classify({ name: 'web_search', arguments: { queries: [] } }).label, '')
assert.equal(
  classify({ name: 'advanced_search', arguments: { queries: ['q'], engine: 'bing' } }).label,
  'q',
)
// A scalar still wins when both shapes are present, and a long query is clipped.
assert.equal(
  classify({ name: 'web_search', arguments: { query: 'one', queries: ['two'] } }).label,
  'one',
)
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
// An upload writes nothing here, so a card could only ever sit at 0 % forever.
// `curl -T` / `--upload-file` is the whole surface of that mistake; the response
// body `-o` writes is tiny and not what the user asked to watch.
assert.equal(shell('curl -T big.iso https://x/put'), null)
assert.equal(shell('curl --upload-file=b.bin https://x/put'), null)
assert.equal(shell('curl.exe -sS -T a.bin https://x/put -o resp.txt'), null)
// …but the exclusion is per segment: a command that also plainly downloads gets
// its card, because that transfer does grow a file on this end.
assert.equal(shell('curl -T a.bin https://x/put && curl -o out.bin https://x/y').kind, 'download')
// `-T` only counts when it is a curl flag, and only as its own argument.
assert.equal(shell('wget -O out.bin https://x/y').kind, 'download')
assert.equal(shell('curl -o out.bin https://x/y?upload-file=1').kind, 'download')
assert.equal(shell('git commit -m "add -T support"'), null)
assert.equal(shell('pwsh -c "Invoke-WebRequest -Uri u -OutFile f"').kind, 'download')
// Invoke-WebRequest without -OutFile buffers in memory: nothing to sample.
assert.equal(shell('Invoke-WebRequest -Uri https://x/y'), null)
assert.equal(shell('iwr https://x/y'), null)
assert.equal(shell('pnpm add lodash').kind, 'pkg')
assert.equal(shell('npm i -g foo').kind, 'pkg')
assert.equal(shell('docker pull nginx').kind, 'pkg')
assert.equal(shell('ls -la'), null)
assert.equal(shell(''), null)
// The word `curl` is not a download. Every one of these used to raise a card
// that could never move, because the match was anchored on whitespace instead
// of on the start of a command.
assert.equal(shell('Get-Process curl -ErrorAction SilentlyContinue | Measure-Object'), null)
assert.equal(shell('# curl is not installed here\nWrite-Host hi'), null)
assert.equal(shell('Write-Host "use curl -o file url"'), null)
assert.equal(shell('git log --grep=clone'), null)
// Wrapped invocations still count: the inline shell is unwrapped and its command
// string is parsed as code.
assert.equal(shell('pwsh -c "curl -o C:\\tmp\\c.bin https://x/c.bin"').kind, 'download')
assert.equal(shell('a && curl -o out.bin https://x/y').kind, 'download')
// …but a command that only *appears inside data* is not a command. This is the
// difference between writing a script and running one, and getting it wrong
// raises a card watching a file nobody is writing, stuck at 0 % until it ages
// out. Agents write scripts through here-strings constantly.
assert.equal(
  shell(
    "$env:TEMP/x.mjs\n@'\nimport x from 'y'\ncurl.exe -L -o D:\\Downloads\\x.iso https://e.com/x.iso\n'@ | Set-Content -LiteralPath probe.mjs",
  ),
  null,
)
assert.equal(
  shell('@"\ncurl -o D:\\Downloads\\q.iso https://e.com/q.iso\n"@ | Out-File a.ps1'),
  null,
)
// The same rule for every pattern, not just the downloader head.
assert.equal(shell("@'\npip install requests\n'@ | Set-Content notes.txt"), null)
assert.equal(
  shell("@'\nInvoke-WebRequest -Uri u -OutFile f\n'@ | Set-Content run.ps1"),
  null,
)
// A quoted string that happens to look like a transfer stays inert even when the
// rest of the line is real code.
assert.equal(shell('Write-Host "curl -o f u"; Get-Date'), null)
// A non-shell tool is never inspected for a command line.
assert.equal(classify({ name: 'read', arguments: { file_path: 'x' } }), null)
ok('detect: classify covers download / install / pkg / search / fetch / ignore')
ok('detect: commands inside here-strings and string literals are data, not transfers')

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
// A path handed over in a variable is resolved through a plain assignment — the
// normal way to write this in PowerShell, and resolving it wrong pointed the card
// at a `$o` file in the cwd that never exists.
assert.deepEqual(extractTargets("$o='D:\\out.bin'\ncurl.exe -C - -o $o https://x/y", CWD), [
  'D:\\out.bin',
])
assert.deepEqual(extractTargets('o=/tmp/out.bin; curl -o $o https://x/y', CWD), ['/tmp/out.bin'])
// A reference with nothing to resolve it stays unresolved: a bar on a guessed
// path silently watches nothing, which is worse than no bar.
assert.deepEqual(extractTargets('curl -o $dst https://x/y', CWD), [])
// The same flag twice must not double-count the same file.
assert.equal(extractTargets('curl -o a.bin --output a.bin https://x/y', CWD).length, 1)
// A target built from a variable with no assignment in the same command line
// stays unresolved. This is a documented limitation, not a bug: guessing would put
// a confident bar on a file we are not actually watching.
assert.deepEqual(extractTargets('curl -o $dst https://x/y', CWD), [])
// wget's `-O` names the output file; curl's `-O` names it after the URL. Reading
// them the same way pointed the card at a file the transfer never writes.
assert.deepEqual(extractTargets('wget -O out.bin https://x/y.bin', CWD), [
  join('D:\\work', 'out.bin'),
])
// `Start-Process -ArgumentList` hands the child an array, so `-o` and its value
// are separate comma-delimited items that the whitespace-anchored flags miss.
assert.deepEqual(
  extractTargets(
    "Start-Process -FilePath 'curl.exe' -ArgumentList '-L','-o','D:\\work\\p.bin','https://x/p.bin'",
    CWD,
  ),
  ['D:\\work\\p.bin'],
)
// aria2c: `-o` is relative to `-d`, and `-d` may itself come from a variable.
// Reading `-o` as a cwd-relative path (or skipping `-d`) points the card at a
// file aria2c never opens — the same silent 0 % as any bad guess.
assert.deepEqual(extractTargets('aria2c -x 16 -d D:\\Downloads -o w.iso https://e/x', CWD), [
  'D:\\Downloads\\w.iso',
])
assert.deepEqual(extractTargets('aria2c -x 16 -o w.iso https://e/x', CWD), [join(CWD, 'w.iso')])
assert.deepEqual(extractTargets('aria2c --out=w.iso https://e/x', CWD), [join(CWD, 'w.iso')])
assert.deepEqual(extractTargets('$d=\'D:\\d\'\naria2c -d $d -o w.iso https://e/x', CWD), ['D:\\d\\w.iso'])
// An unresolvable `-d` leaves the target ambiguous: skip it, do not guess.
assert.deepEqual(extractTargets('aria2c -d $out -o w.iso https://e/x', CWD), [])
// `aria2c <url>` with no `-o` is the *most* common way to call it: the file is
// named after the URL's last segment, inside `-d` (default: the cwd). Missing this
// produced no card at all for an ordinary download — the progress bar simply never
// appeared while the transfer ran fine.
assert.deepEqual(extractTargets('aria2c https://e/dir/w.iso', CWD), [join(CWD, 'w.iso')])
assert.deepEqual(extractTargets('aria2c -d D:\\Downloads https://e/dir/w.iso', CWD), [
  'D:\\Downloads\\w.iso',
])
assert.deepEqual(extractTargets("& 'D:\\tools\\aria2\\aria2c.exe' 'https://e/dir/w.iso'", CWD), [
  join(CWD, 'w.iso'),
])
// aria2c percent-decodes the segment before writing it; resolving the raw `%20`
// form would point the card at a file that never exists.
assert.deepEqual(extractTargets('aria2c https://e/dir/My%20File.iso', CWD), [
  join(CWD, 'My File.iso'),
])
// …but a URL with no usable basename still yields nothing rather than a guess.
assert.deepEqual(extractTargets('aria2c -d D:\\Downloads', CWD), [])

// `cd D:\Downloads` before the downloader is the ordinary way to choose the
// output folder. Ignoring it resolved the relative name against the agent cwd,
// so the card watched a file that never existed, sampled 0 bytes forever and was
// retired as "settled" three seconds in — no card at all for a running download.
assert.deepEqual(extractTargets(`cd D:\\Downloads\naria2c https://e/dir/w.iso`, CWD), [
  'D:\\Downloads\\w.iso',
])
assert.deepEqual(extractTargets(`cd D:\\Downloads\ncurl -O https://e/dir/w.iso`, CWD), [
  'D:\\Downloads\\w.iso',
])
assert.deepEqual(extractTargets(`Set-Location 'D:\\Downloads'\naria2c https://e/dir/w.iso`, CWD), [
  'D:\\Downloads\\w.iso',
])
// A relative `cd` is applied to the directory in effect at that point.
assert.deepEqual(extractTargets(`cd sub\naria2c https://e/dir/w.iso`, CWD), [
  join(CWD, 'sub', 'w.iso'),
])
assert.deepEqual(extractTargets(`cd D:\\a\ncd b\naria2c -o w.iso https://e/x`, CWD), [
  'D:\\a\\b\\w.iso',
])
// `cd` into something we cannot resolve leaves the directory unknown: the card
// must stay off rather than watch a guessed path.
assert.deepEqual(extractTargets(`cd $dst\naria2c https://e/dir/w.iso`, CWD), [])
assert.deepEqual(extractTargets(`cd ~\naria2c https://e/dir/w.iso`, CWD), [])
// Downloaders are rarely on PATH, so the call arrives as a full path:
// `& 'D:\tools\aria2\aria2c.exe' …`. Matching the head with /^curl/ missed it and
// the card never appeared at all — the most visible failure in the whole plugin.
assert.equal(classify({ name: 'pwsh', arguments: { command: "& 'D:\\tools\\aria2\\aria2c.exe' -x 16 -o w.iso https://e/x" } }).kind, 'download')
assert.equal(classify({ name: 'pwsh', arguments: { command: "'C:\\Windows\\System32\\curl.exe' -o f u" } }).kind, 'download')
assert.equal(classify({ name: 'pwsh', arguments: { command: 'D:\\bin\\wget.exe -O f u' } }).kind, 'download')
assert.equal(classify({ name: 'pwsh', arguments: { command: '/usr/bin/curl -o f u' } }).kind, 'download')
// …and `-d` still wins over the cwd for a full-path aria2c.
assert.deepEqual(extractTargets("& 'D:\\tools\\aria2\\aria2c.exe' -d D:\\Downloads -o w.iso https://e/x", CWD), ['D:\\Downloads\\w.iso'])

/* `aria2c -i list.txt` — the batch manifest. Every target lives inside the file,
 * so the command line names none of them and the card used to sit on "载入中"
 * for the whole transfer. detect.js only reports the two raw flag values; the
 * Host half resolves and reads them. */
assert.deepEqual(aria2InputSpec('aria2c -i list.txt'), { input: 'list.txt', dir: '' })
assert.deepEqual(aria2InputSpec('aria2c -i "D:\\x\\l.txt" -d D:\\Downloads'), {
  input: 'D:\\x\\l.txt',
  dir: 'D:\\Downloads',
})
assert.deepEqual(aria2InputSpec('aria2c --input-file=l.txt'), { input: 'l.txt', dir: '' })
assert.deepEqual(aria2InputSpec('& \'D:\\tools\\aria2\\aria2c.exe\' -i l.txt'), { input: 'l.txt', dir: '' })
// curl's `-i` is `--include`; it must never be read as a manifest.
assert.equal(aria2InputSpec('curl -i https://e/x -o a.bin'), null)
// No manifest at all, and a flag whose value is missing, both fall through.
assert.equal(aria2InputSpec('aria2c https://e/x'), null)
assert.equal(aria2InputSpec('aria2c -i'), null)

// The manifest format: an unindented line opens an entry, indented `key=value`
// lines are its options, `#` and blank lines are skipped.
assert.deepEqual(
  parseAria2Input('https://e/a.jpg\n  out=001.jpg\n  dir=D:\\out\n\n# c\nhttps://e/b.png\n  out=002.png,dir=D:\\o2'),
  [
    { url: 'https://e/a.jpg', out: '001.jpg', dir: 'D:\\out' },
    { url: 'https://e/b.png', out: '002.png', dir: 'D:\\o2' },
  ],
)

const bulkRoot = mkdtempSync(join(tmpdir(), 'ddp-bulk-'))
try {
  const manifest = join(bulkRoot, 'list.txt')
  writeFileSync(
    manifest,
    ['https://e/a.jpg', '  out=001.jpg', 'https://e/b.png', '  out=002.png'].join('\n'),
  )
  const bulk = readAria2Bulk(`aria2c -i "${manifest}"`, CWD)
  // `out=` is relative to aria2c's own cwd (or `-d`), never to the manifest's
  // directory — the list file is just a file it happens to read.
  assert.deepEqual(bulk.targets, [join(CWD, '001.jpg'), join(CWD, '002.png')])
  assert.deepEqual(bulk.urls, ['https://e/a.jpg', 'https://e/b.png'])

  // `-d` on the command line is the batch default for entries without `dir=`.
  const dl = join(bulkRoot, 'dl')
  const viaFlag = readAria2Bulk(`aria2c -i "${manifest}" -d "${dl}"`, CWD)
  assert.deepEqual(viaFlag.targets, [join(dl, '001.jpg'), join(dl, '002.png')])

  // An entry without `out=` falls back to the URL's own file name.
  const bare = join(bulkRoot, 'bare.txt')
  writeFileSync(bare, 'https://e/dir/name.iso\n')
  assert.deepEqual(readAria2Bulk(`aria2c -i "${bare}"`, CWD).targets, [join(CWD, 'name.iso')])

  // A `cd` earlier in the command moves the directory the outputs land in. The
  // agent's own cwd is the session directory, so ignoring it resolved every batch
  // target against the wrong folder and the card watched files that never existed.
  const cdCmd = `cd "${bulkRoot}"\naria2c -i "${manifest}"`
  assert.deepEqual(
    readAria2Bulk(cdCmd, CWD).targets,
    [join(bulkRoot, '001.jpg'), join(bulkRoot, '002.png')],
    'a cd before aria2c moves the batch outputs',
  )

  // Anything unreadable degrades to null so the caller keeps its old behaviour.
  assert.equal(readAria2Bulk(`aria2c -i "${join(bulkRoot, 'nope.txt')}"`, CWD), null)
  assert.equal(readAria2Bulk('aria2c -i list.txt', ''), null)
} finally {
  rmSync(bulkRoot, { recursive: true, force: true })
}
ok('detect: aria2c -i manifest spec, parser and batch targets')
// The basename rule must not turn an argument into a program name.
assert.equal(classify({ name: 'pwsh', arguments: { command: 'Get-Process "D:\\x\\aria2c.exe"' } }), null)
// `Start-Process -FilePath aria2c.exe -ArgumentList '-o','w.iso',url` is how most
// downloads are actually launched on Windows, and its head is `Start-Process`.
// Testing only the head meant the card never appeared for exactly the launches
// people write; the launcher is unwrapped into the command it runs.
assert.equal(classify({ name: 'pwsh', arguments: { command: "Start-Process -FilePath 'D:\\tools\\aria2c.exe' -NoNewWindow -ArgumentList '-x','16','-d','D:\\Downloads','-o','win11.iso','https://e/x'" } }).kind, 'download')
assert.deepEqual(
  extractTargets("Start-Process -FilePath 'D:\\tools\\aria2c.exe' -ArgumentList '-d','D:\\Downloads','-o','win11.iso','https://e/x'", CWD),
  ['D:\\Downloads\\win11.iso'],
)
assert.deepEqual(
  extractTargets("Start-Process -FilePath 'C:\\Windows\\System32\\curl.exe' -ArgumentList '-L','-o','D:\\Downloads\\a.iso','https://e/x'", CWD),
  ['D:\\Downloads\\a.iso'],
)
// A launcher whose program is unknown, or is not a downloader, stays no-card.
assert.equal(classify({ name: 'pwsh', arguments: { command: "Start-Process -FilePath $exe -ArgumentList '-o','w.iso'" } }), null)
assert.equal(classify({ name: 'pwsh', arguments: { command: "Start-Process -FilePath notepad.exe -ArgumentList 'x.txt'" } }), null)
// `$p = Start-Process …` is the same launch with the process object captured; the
// head reads `$p` unless the assignment is stripped first.
assert.equal(classify({ name: 'pwsh', arguments: { command: "$p = Start-Process -FilePath 'D:\\tools\\aria2c.exe' -PassThru -NoNewWindow -ArgumentList '-d','D:\\Downloads','-o','win11.iso','https://e/x'" } }).kind, 'download')
assert.deepEqual(
  extractTargets("$p = Start-Process -FilePath 'D:\\tools\\aria2c.exe' -PassThru -NoNewWindow -ArgumentList '-d','D:\\Downloads','-o','win11.iso','https://e/x'", CWD),
  ['D:\\Downloads\\win11.iso'],
)
assert.equal(classify({ name: 'pwsh', arguments: { command: "$p = Start-Process -FilePath notepad.exe -ArgumentList 'x.txt'" } }), null)
// aria2c preallocates the target, and its `.aria2` sidecar is written a moment
// later. That first stat()-only sample used to pin the high-water mark at the
// full preallocated size, holding the bar at 100 % for the whole transfer; a
// sidecar reading must be allowed to correct it.
{
  const dir = mkdtempSync(join(tmpdir(), 'ddp-prealloc-'))
  const pre = join(dir, 'pre.iso')
  const PIECE = 1024
  const PIECES = 4
  // stat() reports the full preallocated size while zero pieces are complete.
  writeFileSync(pre, Buffer.alloc(PIECE * PIECES))
  const launched = `aria2c -d "${dir}" -o pre.iso https://e/x`
  const pre_task = beginTask({ callId: 'call-pre', name: 'pwsh' }, { kind: 'download', command: launched }, dir)
  assert.deepEqual(pre_task.targets, [pre])
  // Pretend the dispatch started a while ago so the start grace is behind us.
  pre_task.startedAt = Date.now() - 10_000

  sweep(Date.now())
  // Before the sidecar exists there is no honest byte count: stat() only sees the
  // preallocation. Reporting it pinned the bar at 100 %, and taking its growth as
  // a transfer rate reported 2.8 GB/s on a 30 MB/s download. The card waits.
  assert.equal(pre_task.aria2, true, 'the command is recognised as an aria2c run')
  assert.equal(pre_task.bytes, 0, 'a stat()-only tick is not trusted for aria2c')

  // The sidecar now exists and says nothing is done yet.
  const head = Buffer.alloc(2 + 4 + 4 + 4 + 8 + 8 + 4)
  head.writeUInt16BE(1, 0)
  head.writeUInt32BE(0, 2)
  head.writeUInt32BE(0, 6)
  head.writeUInt32BE(PIECE, 10)
  head.writeBigUInt64BE(BigInt(PIECE * PIECES), 14)
  head.writeBigUInt64BE(0n, 22)
  head.writeUInt32BE(Math.ceil(PIECES / 8), 30)
  writeFileSync(pre + '.aria2', Buffer.concat([head, Buffer.alloc(Math.ceil(PIECES / 8))]))

  sweep(Date.now())
  assert.equal(pre_task.bytes, 0, 'a sidecar reading corrects the preallocated high-water mark')
  // Retire the card so it cannot show up as `snapshot()[0]` in the sections below.
  sweep(Date.now() + 25 * 60 * 60 * 1000)
  assert.equal(snapshot().length, 0, 'the preallocation fixture is retired')
  rmSync(dir, { recursive: true, force: true })
}
ok('detect: extractTargets handles quotes, cwd, -O, clone, dedupe, variables')

/* ------------------------------------------------------------------ */
/* 3b. a script named by `-File`                                       */
/* ------------------------------------------------------------------ */

{
  const dir = mkdtempSync(join(tmpdir(), 'ddp-script-'))
  try {
    const script = join(dir, 'get-iso.ps1')
    // The exact shape from the report: powershell -File, destination inside.
    writeFileSync(
      script,
      [
        'param($Url, $Out)',
        "$ProgressPreference = 'SilentlyContinue'",
        '$iso = "D:\\ISO\\win22h2.iso"',
        'Invoke-WebRequest -Uri $Url -OutFile $iso -UseBasicParsing',
        '',
      ].join('\n'),
    )
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`

    // This is the whole point: without the `-File` branch the head is a shell,
    // no downloader and no -OutFile appear, and no card is ever raised. That was
    // the reported bug — a 4-hour ISO download showed nothing.
    assert.equal(classify({ name: 'pwsh', arguments: { command } }).kind, 'download')
    assert.equal(classify({ name: 'pwsh', arguments: { command } }).script, true)

    const plan = scriptPlan(command, dir)
    assert.deepEqual(plan.targets, ['D:\\ISO\\win22h2.iso'])
    assert.equal(plan.scriptPath, script)

    // A script that downloads nothing must not leave a card behind: it would sit
    // at 0 % forever, since there is no file to sample. `beginTask` therefore
    // returns null here instead of a task, and the caller skips it.
    const quiet = join(dir, 'hello.ps1')
    writeFileSync(quiet, 'Write-Output "no download here"\n')
    assert.equal(scriptPlan(`powershell -File "${quiet}"`, dir), null)
    assert.equal(
      beginTask({ callId: 'c-quiet', name: 'pwsh' }, classify({ name: 'pwsh', arguments: { command: `powershell -File "${quiet}"` } }), dir),
      null,
      'a script with no destination produces no task at all',
    )

    // A missing script is the common case for a re-run after the agent deleted
    // it, and must degrade to no card rather than throw inside the hook.
    assert.equal(classify({ name: 'pwsh', arguments: { command: `powershell -File "${join(dir, 'gone.ps1')}"` } }).script, true)
    assert.equal(scriptPlan(`powershell -File "${join(dir, 'gone.ps1')}"`, dir), null)

    // `-File` on a non-shell head is not this shape: `curl -File x` does not
    // exist, and `Start-Process -FilePath curl.exe` is unwrapped into curl itself.
    assert.equal(classify({ name: 'pwsh', arguments: { command: 'curl --config-file x.cfg -o a.bin https://x/y' } }).script, false)
    assert.equal(
      classify({ name: 'pwsh', arguments: { command: "Start-Process -FilePath 'D:\\tools\\curl.exe' -ArgumentList '-o','a.bin','https://x/y'" } }).script,
      false,
    )
    // A here-string that writes a script is data, not a dispatch of that script.
    assert.equal(
      classify({ name: 'pwsh', arguments: { command: "@'\npowershell -File x.ps1\n'@ | Set-Content run.cmd" } }),
      null,
    )

    ok('detect: `-File` scripts are recognised and read for their destination')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}


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

  // A tool call that starts a background job returns at once, so `done` is true
  // from the first tick while the job runs for minutes. The session's running
  // job keeps the card alive; once it settles the normal linger applies.
  const bg = beginTask(
    { callId: 'call-bg', name: 'pwsh', agent: { id: 'sess-bg' } },
    { kind: 'pkg', label: 'npm install' },
    'D:\\Downloads',
  )
  bg.done = true
  sweep(t0, (sessionId) => sessionId === 'sess-bg')
  sweep(t0 + 30_000, (sessionId) => sessionId === 'sess-bg')
  assert.equal(snapshot().length, 1, 'a running job keeps its card past the linger window')
  // A different session's job must not keep this one alive.
  sweep(t0 + 31_000, (sessionId) => sessionId === 'sess-other')
  sweep(t0 + 31_000 + LINGER_MS, (sessionId) => sessionId === 'sess-other')
  assert.equal(snapshot().length, 0, 'another session being busy does not hold the card')

  // `isSessionBusy` is per session, not per job. One long download therefore
  // used to keep every finished card in that session alive forever. A download
  // that stopped growing long ago must retire even while its session is busy.
  const stale = beginTask(
    { callId: 'call-stale', name: 'pwsh', agent: { id: 'sess-stale' } },
    { kind: 'download', command: 'curl -o "D:\\\\Downloads\\\\stale.bin" http://127.0.0.1:9/x' },
    'D:\\Downloads',
  )
  stale.done = true
  stale.bytes = 241 * 1024
  stale.idleTicks = 3
  stale.lastGrowthAt = t0
  sweep(t0 + 200_000, (sessionId) => sessionId === 'sess-stale')
  sweep(t0 + 200_000 + LINGER_MS, (sessionId) => sessionId === 'sess-stale')
  assert.equal(snapshot().length, 0, 'a long-quiet download is not kept alive by a busy session')

  // …but a download that is still moving keeps its card, which is the whole
  // reason the busy grace exists.
  const moving = beginTask(
    { callId: 'call-moving', name: 'pwsh', agent: { id: 'sess-moving' } },
    { kind: 'download', command: 'curl -o "D:\\\\Downloads\\\\moving.bin" http://127.0.0.1:9/x' },
    'D:\\Downloads',
  )
  moving.done = true
  moving.bytes = 4096
  moving.lastGrowthAt = t0 + 100_000
  sweep(t0 + 120_000, (sessionId) => sessionId === 'sess-moving')
  assert.equal(snapshot().length, 1, 'a download that grew recently keeps its busy grace')

  // Settle it again so the following cases see an empty board.
  moving.idleTicks = IDLE_TICKS_TO_CLOSE
  sweep(t0 + 400_000)
  sweep(t0 + 400_000 + LINGER_MS)
  assert.equal(snapshot().length, 0, 'the moving card retires once it really stops')

  // A batch download whose HEAD probes never all answered carries no `total`.
  // A batch whose probes never all answered has no denominator, and the rate
  // projection used to extrapolate from the last measurement anyway — the card
  // climbed to several times the real byte count before snapping back.
  const batchRoot = mkdtempSync(join(tmpdir(), 'ddp-bulk-hw-'))
  const batchList = join(batchRoot, 'list.txt')
  writeFileSync(batchList, 'https://e/one.jpg\n  out=one.jpg\nhttps://e/two.jpg\n  out=two.jpg\n')
  const noDenominator = beginTask(
    { callId: 'call-bulk-null', name: 'pwsh', agent: { id: 'sess-bulk' } },
    { kind: 'download', command: `aria2c -i "${batchList}"` },
    batchRoot,
  )
  noDenominator.total = null
  noDenominator.bytes = 1000
  noDenominator.speed = 1000
  noDenominator.idleTicks = 0
  noDenominator.lastGrowthAt = Date.now() - 3000
  // A batch is marked as such: its byte count is a sum over files, and a file
  // aria2c retries truncates, so the aggregate has to hold its high-water mark.
  assert.equal(noDenominator.bulk, true, 'an input-file batch is marked as a bulk transfer')
  assert.equal(snapshot()[0].bytes, 1000, 'without a denominator the count is not projected')

  // A batch never projects, denominator or not: it is re-measured every tick, so
  // the only thing a projection adds is overshoot. Extrapolating a burst rate
  // made the card claim 100 % while a fifth of the batch was still arriving.
  noDenominator.total = 1_000_000
  assert.equal(snapshot()[0].bytes, 1000, 'a batch shows the measurement, never a projection')

  noDenominator.idleTicks = IDLE_TICKS_TO_CLOSE
  noDenominator.done = true
  sweep(Date.now() + 400_000)
  sweep(Date.now() + 400_000 + LINGER_MS)
  assert.equal(snapshot().length, 0, 'the batch card clears before the next case')

  // A download whose target could not be resolved reports `unresolved`, which the
  // client renders as an indeterminate bar.
  const blind = beginTask(
    { callId: 'call-2', name: 'pwsh' },
    { kind: 'download', command: 'curl -o $dst http://127.0.0.1:9/x' },
    'D:\\work',
  )
  blind.done = true
  ;[snap] = snapshot()
  assert.equal(snap.unresolved, true, 'a bar on an unknown file is marked unresolved')
  const blind2 = beginTask(
    { callId: 'call-3', name: 'pwsh' },
    { kind: 'download', command: 'curl -O http://127.0.0.1:9/x', },
    'D:\\work',
  )
  // `-O` derives a name from the URL, so this one IS resolved; `unresolved` needs
  // a download with no target at all, which happens when parsing yields nothing.
  assert.equal(blind2.targets.length, 1)
  blind2.done = true

  // Naming, one target: the card shows the file actually being written, even when
  // the URL's own basename is unhelpful (`/download?id=7`).
  const named = beginTask(
    { callId: 'call-name-1', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${join(dir, 'win11.iso')}" http://127.0.0.1:9/download?id=7` },
    dir,
  )
  assert.equal(named.label, 'win11.iso', 'single target names the card after the output file')
  named.done = true

  // Naming, many targets: a segmented transfer writes part1..part8 for ONE file.
  // The card must show the URL's basename, not an arbitrary fragment of it — this
  // is the `part1.bin` bug.
  const parts = join(dir, 'part1.bin')
  const segmented = beginTask(
    { callId: 'call-name-2', name: 'pwsh' },
    {
      kind: 'download',
      command:
        `curl -r 0-9 -o "${parts}" http://127.0.0.1:9/win11.iso &` +
        ` curl -r 10-19 -o "${join(dir, 'part2.bin')}" http://127.0.0.1:9/win11.iso`,
    },
    dir,
  )
  assert.equal(segmented.targets.length, 2, 'both segments are watched, so bytes sum up')
  assert.equal(segmented.label, 'win11.iso', 'segmented download is named after the remote file')
  segmented.done = true

  // `aria2c -i list.txt`: every real target is inside the manifest, so the card
  // covers the whole batch instead of watching nothing.
  const bulkManifest = join(dir, 'batch.txt')
  writeFileSync(
    bulkManifest,
    ['https://e/a.jpg', '  out=001.jpg', 'https://e/b.jpg', '  out=002.jpg'].join('\n'),
  )
  const batch = beginTask(
    { callId: 'call-bulk', name: 'pwsh' },
    { kind: 'download', command: `aria2c -i "${bulkManifest}" -j 8` },
    dir,
  )
  assert.equal(batch.targets.length, 2, 'every manifest entry is watched')
  assert.equal(batch.label, '批量下载 2 个文件', 'a batch is named after its size, not one file')
  assert.ok(batch.log.startsWith('batch.txt'), 'the batch log names the manifest')
  batch.done = true

  // A URL with no usable basename still falls back to the output path rather than
  // an empty or invented label.
  const bare = beginTask(
    { callId: 'call-name-3', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${join(dir, 'blob.bin')}" http://127.0.0.1:9/` },
    dir,
  )
  assert.equal(bare.label, 'blob.bin', 'origin-only URL falls back to the output path')
  bare.done = true

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
  // aria2c preallocates the target, so stat().size is the final size from tick one.
// The `.aria2` sidecar is the only truthful progress source; a card that trusts
// stat() sits at 100 % for the whole transfer.
{
  const dir = mkdtempSync(join(tmpdir(), 'ddp-aria-'))
  const target = join(dir, 'x.iso')
  const control = target + '.aria2'
  const PIECE = 1048576
  const PIECES = 7415
  const big = (n) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(n))
    return b
  }
  /** Header + bitmap where the first `done` pieces are marked complete. */
  const controlFile = (done) => {
    const bfLen = Math.ceil(PIECES / 8)
    const head = Buffer.alloc(2 + 4 + 4 + 4 + 8 + 8 + 4)
    head.writeUInt16BE(1, 0)
    head.writeUInt32BE(0, 2) // extLen
    head.writeUInt32BE(0, 6) // infoHashLen
    head.writeUInt32BE(PIECE, 10)
    big(PIECES * PIECE).copy(head, 14) // totalLength
    head.writeBigUInt64BE(0n, 22) // uploadLength
    head.writeUInt32BE(bfLen, 30)
    const bits = Buffer.alloc(bfLen)
    for (let i = 0; i < done; i += 1) bits[i >> 3] |= 0x80 >> (i & 7)
    return Buffer.concat([head, bits])
  }

  writeFileSync(control, controlFile(0))
  assert.equal(aria2Completed(target), 0, 'a fresh control file means no bytes yet')

  writeFileSync(control, controlFile(1000))
  assert.equal(aria2Completed(target), 1000 * PIECE, 'completed pieces are counted')

  // Bit order is the one thing a hand-built fixture can get wrong in a way that
  // still "works": MSB-first is what aria2c writes, and a reversed reader would
  // report a plausible-but-wrong byte count forever.
  writeFileSync(control, controlFile(1))
  assert.equal(aria2Completed(target), PIECE, 'the first completed piece is the MSB')

  writeFileSync(control, controlFile(PIECES))
  assert.equal(aria2Completed(target), PIECES * PIECE, 'a finished bitmap is the full size')

  writeFileSync(control, Buffer.from('not a control file'))
  assert.equal(aria2Completed(target), 0, 'an unparsable sidecar must not fall back to stat()')

  rmSync(control, { force: true })
  assert.equal(aria2Completed(target), undefined, 'no sidecar means the caller stats the file')
  rmSync(dir, { recursive: true, force: true })
  ok('state: aria2c preallocation is read from the .aria2 bitmap, not stat()')
}

// aria2c preallocates a target the moment it starts it, but only writes the
// `.aria2` control file a moment later. In that gap `stat()` already reports the
// final size, so a batch counted a file the instant it began and then dropped the
// count again when the sidecar appeared at zero — a card stepping backwards.
{
  const dir = mkdtempSync(join(tmpdir(), 'ddp-prealloc-'))
  const target = join(dir, 'a.bin')
  const control = target + '.aria2'
  const FULL = 4096
  const PIECE = 1024
  const head = Buffer.alloc(2 + 4 + 4 + 4 + 8 + 8 + 4)
  head.writeUInt16BE(1, 0)
  head.writeUInt32BE(0, 2)
  head.writeUInt32BE(0, 6)
  head.writeUInt32BE(PIECE, 10)
  head.writeBigUInt64BE(BigInt(FULL), 14)
  head.writeBigUInt64BE(0n, 22)
  head.writeUInt32BE(1, 30) // one byte of bitmap covers four pieces
  const bitmap = (done) => {
    const bits = Buffer.alloc(1)
    if (done > 0) bits[0] = 0xff << (8 - done)
    return Buffer.concat([head, bits])
  }

  const pre = beginTask(
    { callId: 'call-prealloc', name: 'pwsh' },
    { kind: 'download', command: `aria2c -d "${dir}" -o a.bin https://e/x` },
    dir,
  )
  const t0 = Date.now()
  pre.startedAt = t0 - 10_000

  // Preallocated, written just now, no sidecar: nothing has arrived yet.
  writeFileSync(target, Buffer.alloc(FULL))
  sweep(t0)
  assert.equal(pre.bytes, 0, 'a freshly preallocated target contributes no bytes')

  writeFileSync(control, bitmap(0))
  sweep(t0 + 1000)
  assert.equal(pre.bytes, 0, 'a sidecar with no completed pieces keeps the count at zero')

  writeFileSync(control, bitmap(1))
  sweep(t0 + 2000)
  assert.equal(pre.bytes, PIECE, 'real pieces are counted once the sidecar reports them')

  // aria2c deletes the sidecar when it finishes, so stat() is the truth again —
  // and because a sidecar was seen for this target, the size is believed.
  rmSync(control, { force: true })
  sweep(t0 + 3000)
  assert.equal(pre.bytes, FULL, 'a target that had a sidecar is complete once it is gone')

  // A file that finished between two samples never showed a sidecar at all. Once
  // its mtime goes quiet it counts as the whole file instead of vanishing.
  const quiet = beginTask(
    { callId: 'call-quiet', name: 'pwsh' },
    { kind: 'download', command: `aria2c -d "${dir}" -o b.bin https://e/y` },
    dir,
  )
  const t1 = Date.now()
  quiet.startedAt = t1 - 10_000
  const settled = join(dir, 'b.bin')
  writeFileSync(settled, Buffer.alloc(FULL))
  // Quiet enough to read as finished (`PREALLOC_QUIET_MS`), but still written
  // *after* this dispatch started — that ordering is what proves the bytes belong
  // to this transfer rather than to a file left behind by a previous one.
  const long = new Date(t1 - 6000)
  utimesSync(settled, long, long)
  sweep(t1)
  assert.equal(quiet.bytes, FULL, 'a quiet file with no sidecar finished between samples')

  rmSync(dir, { recursive: true, force: true })
  ok('state: a preallocated aria2c target does not count before its sidecar appears')
}

// aria2c rewrites its bitmap on an interval (60 s by default), so between two
// writes a healthy transfer reports an unchanged byte count for a whole minute.
// A speed window that reads "no growth" as "stopped" then showed `0 B/s` on a
// download running at full speed. Hold the last rate while the sidecar is fresh;
// only a stale sidecar may fall to zero.
{
  const flatDir = mkdtempSync(join(tmpdir(), 'ddp-flat-'))
  const flatTarget = join(flatDir, 'flat.iso')
  const flatSidecar = flatTarget + '.aria2'
  const PIECE = 1024
  const PIECES = 4
  /** Header + bitmap where the first `done` pieces are marked complete. */
  const controlFile = (done) => {
    const bfLen = Math.ceil(PIECES / 8)
    const head = Buffer.alloc(2 + 4 + 4 + 4 + 8 + 8 + 4)
    head.writeUInt16BE(1, 0)
    head.writeUInt32BE(0, 2)
    head.writeUInt32BE(0, 6)
    head.writeUInt32BE(PIECE, 10)
    head.writeBigUInt64BE(BigInt(PIECES * PIECE), 14)
    head.writeBigUInt64BE(0n, 22)
    head.writeUInt32BE(bfLen, 30)
    const bits = Buffer.alloc(bfLen)
    for (let i = 0; i < done; i += 1) bits[i >> 3] |= 0x80 >> (i & 7)
    return Buffer.concat([head, bits])
  }

  // Preallocated to the final size, as aria2c does before the first byte lands.
  writeFileSync(flatTarget, Buffer.alloc(PIECES * PIECE))
  writeFileSync(flatSidecar, controlFile(1))
  const flat = beginTask(
    { callId: 'call-flat', name: 'pwsh' },
    { kind: 'download', command: `aria2c -d "${flatDir}" -o flat.iso https://e/x` },
    flatDir,
  )
  const t0 = Date.now()
  flat.startedAt = t0 - 10_000

  const fresh = () => utimesSync(flatSidecar, new Date(), new Date())

  fresh()
  sweep(t0)
  assert.equal(flat.bytes, PIECE, 'one completed piece is 1024 bytes, not the preallocation')

  // Growth inside the window: a plain average over the samples.
  writeFileSync(flatSidecar, controlFile(2))
  fresh()
  sweep(t0 + 1000)
  assert.equal(flat.speed, PIECE, 'one piece in one second is one piece per second')

  // The bitmap stops changing (aria2c has not rewritten it yet) while the
  // sidecar keeps being touched: the rate must be held, not reset.
  let held = 0
  for (let i = 2; i <= 6; i += 1) {
    fresh()
    sweep(t0 + i * 1000)
    if (i === 5) held = flat.speed
  }
  assert.ok(held > 0, 'a rate was established before the window went flat, got ' + held)
  assert.equal(flat.speed, held, 'a flat window with a fresh sidecar holds the last rate')
  assert.equal(flat.idleTicks, 0, 'a fresh sidecar is proof of life, not a stall')

  // A sidecar nobody has touched for ten minutes is genuinely stale: now a flat
  // window really does mean the transfer stopped.
  const stale = new Date(Date.now() - 600_000)
  utimesSync(flatSidecar, stale, stale)
  sweep(t0 + 7000)
  assert.equal(flat.speed, 0, 'a stale sidecar lets the rate fall to zero')
  assert.ok(flat.idleTicks > 0, 'a stale sidecar counts quiet ticks toward retirement')

  rmSync(flatDir, { recursive: true, force: true })
  ok('state: a flat speed window holds the rate while the aria2c sidecar is fresh')

  // …and the rate of a staircase count is the STEP over the interval the step
  // really covers, not over the short sampling window. A 60 s save interval on a
  // 30 MB/s transfer makes one 1.8 GB step; dividing that by 5 s of samples
  // reported 360 MB/s. Same file, same bits, two very different numbers.
  const stepDir = mkdtempSync(join(tmpdir(), 'ddp-step-'))
  const stepTarget = join(stepDir, 'step.iso')
  const stepSidecar = stepTarget + '.aria2'
  writeFileSync(stepTarget, Buffer.alloc(PIECES * PIECE))
  writeFileSync(stepSidecar, controlFile(1))
  const step = beginTask(
    { callId: 'call-step', name: 'pwsh' },
    { kind: 'download', command: `aria2c -d "${stepDir}" -o step.iso https://e/x` },
    stepDir,
  )
  const s0 = Date.now()
  step.startedAt = s0 - 60_000
  utimesSync(stepSidecar, new Date(), new Date())
  sweep(s0)
  assert.equal(step.bytes, PIECE)
  // One step of three more pieces, 60 s after the previous one. The bitmap is
  // only rewritten on the save interval, so this is what the sampler really sees.
  writeFileSync(stepSidecar, controlFile(4))
  utimesSync(stepSidecar, new Date(), new Date())
  sweep(s0 + 60_000)
  const stepped = step.speed
  assert.ok(
    stepped > 0 && stepped <= (3 * PIECE) / 60 + 1,
    'a 3-piece step over 60 s is ~' + (3 * PIECE) / 60 + ' B/s, got ' + stepped,
  )
  rmSync(stepDir, { recursive: true, force: true })
  ok('state: a staircase byte count is divided by its own interval, not the sample window')
}

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

/* ------------------------------------------------------------------ */
/* 6. a clone target is a directory, so its own size is always 0       */
/* ------------------------------------------------------------------ */
// `git clone` writes a tree. `statSync(dir).size` is 0 on every Windows
// directory, so the generic branch recorded "0 bytes, no growth" for the whole
// clone and the idle counter retired the card seconds into a live transfer.
// Summing the tree underneath is the only reading that moves.
const cloneDir = mkdtempSync(join(tmpdir(), 'ddp-clone-'))
{
  const repo = join(cloneDir, 'repo')
  mkdirSync(join(repo, '.git', 'objects', 'ab'), { recursive: true })

  // Before checkout there is nothing on disk but the directory itself.
  const clone = beginTask(
    { callId: 'call-clone', name: 'pwsh' },
    { kind: 'download', command: `git clone https://github.com/a/b.git "${repo}"` },
    cloneDir,
  )
  assert.equal(clone.clone, true, 'a git clone task is flagged so the sampler walks it')
  assert.deepEqual(clone.targets, [repo])

  // Timestamps are absolute wall clock: `beginTask` stamped `startedAt` itself,
  // and the start grace is measured against it.
  const c0 = clone.startedAt
  // An empty tree is quiet: that is a real stall, not a measurement failure.
  // Sampling starts past the start grace so a "nothing yet" tick is counted.
  sweep(c0 + 6000)
  sweep(c0 + 7000)
  assert.equal(clone.idleTicks >= 1, true, 'an empty clone tree counts as quiet, not as 0 B done')

  // git populates the worktree and the pack files as it fetches.
  writeFileSync(join(repo, '.git', 'objects', 'ab', 'cdef'), Buffer.alloc(4096))
  writeFileSync(join(repo, 'README.md'), Buffer.alloc(1024))
  writeFileSync(join(repo, 'src.mjs'), Buffer.alloc(2048))
  sweep(c0 + 8000)
  const afterTree = snapshot().find((t) => t.id === 'call-clone')
  assert.equal(afterTree.bytes, 4096 + 1024 + 2048, 'the card sums the clone tree, not the directory')
  assert.equal(clone.idleTicks, 0, 'growth inside the tree refreshes the idle counter')
  assert.ok(afterTree.speed > 0, 'a growing tree reports a speed')
  ok('state: a git clone measures the tree, so the card tracks real progress')

  rmSync(cloneDir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
/* 5. a rejected HEAD must not become the file size                    */
/* ------------------------------------------------------------------ */
// Cloudflare (and plenty of other CDNs) answer HEAD with 403 and a one-byte
// error body. Reading `content-length` without looking at the status made the
// card render "0 B / 1 B" as if the download were one byte long. Only a 2xx
// response describes the resource being downloaded.
const server = createServer((req, res) => {
  res.writeHead(403, { 'content-type': 'text/plain', 'content-length': '1' })
  res.end('x')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
// The section above deletes its own temp directory, so this one needs its own.
const headDir = mkdtempSync(join(tmpdir(), 'ddp-head-'))

try {
  const probed = beginTask(
    { callId: 'call-head', name: 'pwsh' },
    { kind: 'download', command: `curl -o "${join(headDir, 'blocked.bin')}" http://127.0.0.1:${port}/blocked.bin` },
    headDir,
  )
  // probeTotal() is fire-and-forget, so let the HEAD land before asserting. A
  // fixed wait is right here: the absence of a value is what is being tested, so
  // polling for it would exit immediately.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(
    probed.total,
    null,
    'a 403 HEAD with content-length: 1 must leave total unknown, not report a one-byte file',
  )
  ok('state: a rejected HEAD probe leaves total unknown instead of trusting content-length')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(headDir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
/* background: jobs, foreground filtering, waiting                     */
/* ------------------------------------------------------------------ */

{
  setTitleLookup((sessionId) => (sessionId === 's1' ? '会话一' : ''))
  resetBackground()

  // A foreground command is registered as a job while it runs. It must NOT
  // become a background row: the transcript already shows the call, and calling
  // it "the agent is waiting on background work" would be wrong.
  const fgStart = Date.now()
  noteToolStart('s1', 'pwsh', {})
  noteJobEvent({
    type: 'registered',
    job: {
      id: 'pwsh-fg',
      kind: 'bash',
      label: 'Get-ChildItem',
      owner: 's1',
      status: 'running',
      startedAt: fgStart,
    },
  })
  let rows = backgroundSnapshot(fgStart + 500)
  assert.equal(rows.length, 0, 'a foreground shell call must not appear as background work')
  ok('background: a foreground shell call is filtered out')

  // The call returns; a genuinely detached job (started before the call) stays.
  const bgStart = fgStart - 60_000
  noteJobEvent({
    type: 'registered',
    job: {
      id: 'bash-bg',
      kind: 'bash',
      label: 'npm run build',
      owner: 's1',
      status: 'running',
      startedAt: bgStart,
    },
  })
  rows = backgroundSnapshot(fgStart + 600)
  assert.equal(rows.length, 1, 'the detached job must survive the foreground filter')
  assert.equal(rows[0].id, 'bash-bg')
  assert.equal(rows[0].sessionTitle, '会话一', 'background rows share the session-title lookup')
  assert.equal(rows[0].waiting, false, 'a running job the agent is not blocked on is not waiting')
  ok('background: a job that outlived its tool call is listed, and carries the session name')

  // The agent now blocks on it: the row must say so.
  noteToolEnd('s1')
  noteToolStart('s1', 'job_wait', {})
  rows = backgroundSnapshot(fgStart + 700)
  assert.equal(rows[0].waiting, true, 'job_wait blocks the agent on the job')
  ok('background: waiting is claimed only while the agent is blocked on it')

  // A polling readout does not block; a waiting one does.
  noteToolStart('s1', 'job_output', { wait: false })
  assert.equal(backgroundSnapshot(fgStart + 800)[0].waiting, false)
  noteToolStart('s1', 'job_output', { wait: true })
  assert.equal(backgroundSnapshot(fgStart + 900)[0].waiting, true)
  ok('background: job_output counts as blocking only with wait:true')

  // Settlement lingers briefly, then drops. The foreground call's own record is
  // removed by the shell tool when it returns, so drop it here too: without the
  // active call the filter no longer recognises it as foreground, and reality
  // is that the tool has already taken it away.
  noteToolEnd('s1')
  noteJobEvent({ type: 'removed', job: { id: 'pwsh-fg' } })
  noteJobEvent({
    type: 'settled',
    cause: 'producer',
    awaited: false,
    job: {
      id: 'bash-bg',
      kind: 'bash',
      label: 'npm run build',
      owner: 's1',
      status: 'completed',
      startedAt: bgStart,
      finishedAt: fgStart + 1000,
    },
  })
  assert.equal(backgroundSnapshot(fgStart + 1500).length, 1, 'a settled job lingers to be noticed')
  assert.equal(backgroundSnapshot(fgStart + 60_000).length, 0, 'and then it drops')
  ok('background: a settled row lingers, then leaves the payload')

  // Reset is what a disabled plugin calls; it must leave nothing behind.
  resetBackground()
  assert.equal(backgroundSnapshot(Date.now()).length, 0, 'reset clears every table')
  ok('background: reset clears every table')

  /* A subscriber that joins after the job settled is replayed the `registered`
   * view and never receives the matching `settled`. Running rows never linger
   * out, so without reconciliation such a ghost would stay on screen forever. */

  {
    const ghostAt = Date.now()
    noteJobEvent({
      type: 'registered',
      job: {
        id: 'bash-ghost',
        kind: 'bash',
        label: 'aria2c -i list.txt',
        owner: 's1',
        status: 'running',
        startedAt: ghostAt - 600_000,
      },
    })
    assert.equal(backgroundSnapshot(ghostAt + 100).length, 1, 'the replayed row starts out running')

    // Still inside the quiet window: no registry call is made yet.
    let calls = 0
    const registry = {
      get(id) {
        calls += 1
        return { id, status: 'completed', finishedAt: ghostAt - 1000 }
      },
    }
    reconcileJobs(registry, ghostAt + 1000)
    assert.equal(calls, 0, 'a fresh row is not re-read yet')

    // Past the window the registry is authoritative: it settled long ago.
    reconcileJobs(registry, ghostAt + RECONCILE_AFTER_MS + 1000)
    assert.equal(calls, 1, 'a stale running row is re-read once')
    assert.equal(backgroundSnapshot(ghostAt + RECONCILE_AFTER_MS + 2000).length, 0, 'the ghost is folded into settled and lingers out')
    ok('background: a replayed running row is reconciled against the registry')

    // A job the registry refuses (owner gone) can never become true again.
    noteJobEvent({
      type: 'registered',
      job: {
        id: 'bash-orphan',
        kind: 'bash',
        label: 'orphaned job',
        owner: 's1',
        status: 'running',
        startedAt: ghostAt - 600_000,
      },
    })
    reconcileJobs(
      {
        get() {
          throw new Error('unknown job')
        },
      },
      ghostAt + RECONCILE_AFTER_MS + 5000,
    )
    assert.equal(backgroundSnapshot(ghostAt + RECONCILE_AFTER_MS + 6000).length, 0, 'an unknown job is dropped')
    ok('background: a running row the registry refuses is dropped')

    // `force` re-reads even inside the quiet window — the reload path.
    noteJobEvent({
      type: 'registered',
      job: {
        id: 'bash-reload',
        kind: 'bash',
        label: 'replayed on reload',
        owner: 's1',
        status: 'running',
        startedAt: ghostAt - 600_000,
      },
    })
    let forced = 0
    reconcileJobs(
      {
        get(id) {
          forced += 1
          return { id, status: 'killed', finishedAt: ghostAt }
        },
      },
      ghostAt + 10,
      true,
    )
    assert.equal(forced, 1, 'force ignores the quiet window')
    assert.equal(backgroundSnapshot(ghostAt + 60_000).length, 0, 'a forced check settles the row too')
    ok('background: force re-checks rows right after a reload')

    resetBackground()
  }

  setTitleLookup(() => '')
}

console.log('\nHOST SMOKE OK — utils, detect and state behave as documented')
