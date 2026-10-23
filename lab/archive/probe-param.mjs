/**
 * Does a `-File` script whose output path arrives as a *command-line argument*
 * resolve at all?
 *
 * Real scripts start with `param([string]$Url, [string]$Out)`; the caller then
 * passes `-Out D:\x.iso`. The path is on the command line, but inside the script
 * it is only ever `$Out` — so static reading has nothing to bind unless the
 * caller's own `-Out` argument is considered.
 */
import { classify } from '../detect.js'
import { scriptPlan, scriptTargets, scriptPathOf } from '../script.js'

const cwd = 'D:\\AIworks\\dsh-download-progress\\lab'
const cases = [
  [
    'param passed on the command line',
    [
      'powershell -NoProfile -ExecutionPolicy Bypass -File D:\\lab\\t21.ps1',
      "-Url 'http://127.0.0.1:45811/file?mb=16'",
      "-Out 'D:\\lab\\t21-out.bin'",
    ].join(' '),
  ],
  [
    'param with a default value',
    [
      'powershell -NoProfile -ExecutionPolicy Bypass -File D:\\lab\\t22.ps1',
      "-Url 'http://127.0.0.1:45811/file?mb=16'",
    ].join(' '),
  ],
]

for (const [name, command] of cases) {
  const plan = classify({ name: 'pwsh', arguments: { command } })
  console.log(`${name}`)
  console.log(`  classify   -> ${plan ? plan.kind : 'null (no card)'}`)
  console.log(`  scriptPath -> ${scriptPathOf(command, cwd)}`)
  const sp = scriptPlan(command, cwd)
  console.log(`  scriptPlan -> ${sp ? JSON.stringify(sp) : 'null'}`)
}

const paramScript = [
  'param([string]$Url, [string]$Out = "D:\\lab\\default.bin")',
  '$ProgressPreference = "SilentlyContinue"',
  'Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing',
].join('\n')
console.log('\nscriptTargets(param script, no values) ->', JSON.stringify(scriptTargets(paramScript, {})))
console.log('scriptTargets(param script, Out given) ->', JSON.stringify(scriptTargets(paramScript, { Out: 'D:\\lab\\given.bin' })))
