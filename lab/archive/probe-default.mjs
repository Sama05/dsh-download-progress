/**
 * The decisive question for the `-File` capability: a script that declares
 * `param([string]$Url, [string]$Out = 'D:\x.iso')` and is launched with **no
 * arguments at all** — exactly the shape the other user's command has
 * (`powershell -File E:\win22h2\get-iso.ps1`). Does that resolve?
 */
import { writeFileSync } from 'node:fs'
import { classify } from '../detect.js'
import { scriptPlan, scriptTargets } from '../script.js'

const dir = 'D:\\AIworks\\dsh-download-progress\\lab\\tmp'
const bodies = {
  'param-with-default.ps1': [
    'param([string]$Url = "http://127.0.0.1:45801/file?mb=10", [string]$Out = "D:\\lab\\default.bin")',
    '$ProgressPreference = "SilentlyContinue"',
    'Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing',
  ].join('\n'),
  'param-no-default.ps1': [
    'param([string]$Url, [string]$Out)',
    '$ProgressPreference = "SilentlyContinue"',
    'Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing',
  ].join('\n'),
}

for (const [name, body] of Object.entries(bodies)) {
  const path = `${dir}\\${name}`
  writeFileSync(path, body, 'utf8')
  // No arguments, exactly like `powershell -File E:\win22h2\get-iso.ps1`.
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File ${path}`
  const plan = classify({ name: 'pwsh', arguments: { command } })
  console.log(`=== ${name}  (launched with no arguments)`)
  console.log(`  classify     -> ${plan ? plan.kind : 'null'}`)
  console.log(`  scriptTargets-> ${JSON.stringify(scriptTargets(body, {}))}`)
  console.log(`  scriptPlan   -> ${JSON.stringify(scriptPlan(command, 'D:\\AIworks'))}`)
}
