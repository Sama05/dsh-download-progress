/**
 * Regression matrix, classifier level.
 *
 * Cases that would be destructive to actually run (global installs, plugin
 * installs) are pinned here instead: this asserts what the plugin *decides*,
 * without performing the side effect.
 */
import { classify } from '../detect.js'
import { scriptPlan, scriptTargets, scriptPathOf } from '../script.js'

const cases = [
  ['T1  curl.exe -o', { name: 'pwsh', arguments: { command: "& curl.exe -s -L -o 'D:\\lab\\t1.bin' 'http://h/f?mb=20'" } }],
  ['T2  curl bare -o', { name: 'pwsh', arguments: { command: "curl -s -L -o D:\\lab\\t2.bin http://h/f" } }],
  ['T3  curl -O', { name: 'pwsh', arguments: { command: 'curl.exe -O http://h/a/win.iso' } }],
  ['T4  iwr -OutFile', { name: 'pwsh', arguments: { command: "Invoke-WebRequest -Uri http://h/f -OutFile D:\\lab\\t4.bin" } }],
  ['T5  call-op abs curl', { name: 'pwsh', arguments: { command: "& 'C:\\Windows\\System32\\curl.exe' -o D:\\lab\\t5.bin http://h/f" } }],
  ['T6  Start-Process curl', { name: 'pwsh', arguments: { command: "Start-Process -FilePath 'curl.exe' -ArgumentList '-o','D:\\lab\\t6.bin','http://h/f'" } }],
  ['T7  pwsh -c inline', { name: 'pwsh', arguments: { command: 'pwsh -NoProfile -Command "curl.exe -o D:\\lab\\t7.bin http://h/f"' } }],
  ['T8  aria2c -d -o', { name: 'pwsh', arguments: { command: "aria2c -d D:\\lab\\aria1 -o t8.bin http://h/f" } }],
  ['T9  aria2c bare -o', { name: 'pwsh', arguments: { command: 'aria2c -o t9.bin http://h/f' } }],
  ['T10 aria2c -i list', { name: 'pwsh', arguments: { command: 'aria2c -i D:\\lab\\aria3\\list.txt' } }],
  ['T11 git clone', { name: 'pwsh', arguments: { command: 'git clone --depth 1 https://github.com/o/r.git D:\\lab\\t11' } }],
  ['T16 curl -T upload', { name: 'pwsh', arguments: { command: "curl.exe -T D:\\lab\\big.bin http://h/upload -o D:\\lab\\resp.txt" } }],
  ['T16b curl -T upload no -o', { name: 'pwsh', arguments: { command: 'curl.exe -T D:\\lab\\big.bin http://h/upload' } }],
  ['T14 pnpm add -g', { name: 'pwsh', arguments: { command: 'pnpm add -g typescript' } }],
  ['T14b npm i -g', { name: 'pwsh', arguments: { command: 'npm install -g typescript' } }],
  ['T15 plugin_manager install', { name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'some-bundle@1.0.0' } }],
  ['T15b plugin_manager list', { name: 'plugin_manager', arguments: { action: 'list_plugins' } }],
  ['T17 web_fetch', { name: 'web_fetch', arguments: { url: 'https://example.com' } }],
  ['T18 web_search', { name: 'web_search', arguments: { queries: ['x'] } }],
  ['T13 -File curl script', { name: 'pwsh', arguments: { command: "powershell -NoProfile -ExecutionPolicy Bypass -File D:\\lab\\t13-curl.ps1" } }],
  ['T12 -File iwr script', { name: 'pwsh', arguments: { command: "powershell -NoProfile -ExecutionPolicy Bypass -File D:\\lab\\t12-iwr.ps1" } }],
  ['T19 curl pipe (no file)', { name: 'pwsh', arguments: { command: 'curl.exe -sL http://h/f | tar -xzf -' } }],
  ['T20 curl -o with var', { name: 'pwsh', arguments: { command: '$d="D:\\lab\\v.bin"; curl.exe -o $d http://h/f' } }],
]

let bad = 0
for (const [name, exec] of cases) {
  let plan
  try {
    plan = classify(exec)
  } catch (error) {
    console.log(`${name.padEnd(28)} THREW ${error.message}`)
    bad += 1
    continue
  }
  if (!plan) {
    console.log(`${name.padEnd(28)} null (no card)`)
    continue
  }
  console.log(`${name.padEnd(28)} kind=${plan.kind} script=${plan.script ?? false} label=${plan.label ?? ''}`)
}

console.log('\n=== script.js target resolution ===')
for (const file of ['t12-iwr.ps1', 't13-curl.ps1']) {
  const p = `D:\\AIworks\\dsh-download-progress\\lab\\tmp\\${file}`
  const plan = scriptPlan(`powershell -File ${p}`, 'D:\\AIworks')
  console.log(`${file}: targets=${JSON.stringify(plan?.targets)} urls=${JSON.stringify(plan?.urls)}`)
}

console.log('\n=== scriptTargets on a body with a comment naming a flag ===')
const body = [
  '# T12: 脚本内部用 Invoke-WebRequest -OutFile 落盘（字节由 powershell 自己写）',
  "param([string]$Dest = 'D:\\real\\out.bin')",
  'Invoke-WebRequest -Uri http://h/f -OutFile $Dest -UseBasicParsing',
].join('\n')
console.log(JSON.stringify(scriptTargets(body, {})))

console.log('\n=== scriptPathOf ===')
console.log(scriptPathOf('powershell -File .\\rel.ps1', 'D:\\cwd'))
console.log(scriptPathOf('powershell -File $env:TEMP\\x.ps1', 'D:\\cwd'))
console.log(`\nfailures above are only for THREW lines: ${bad}`)
