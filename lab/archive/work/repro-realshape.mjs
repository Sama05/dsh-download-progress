// Reproduce the exact real-world command shape against the current source.
import { scriptPlan } from '../../script.js'
import { classify } from '../../detect.js'

const script = 'D:\\AIworks\\dsh-download-progress\\lab\\work\\get-artifact-slow.ps1'
const cmds = [
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${script}`,
  `Start-Sleep -Milliseconds 500; powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${script}; "EXIT=$LASTEXITCODE"`,
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${script}; "EXIT=$LASTEXITCODE"`,
  `powershell -File ${script} ; Write-Output done`,
  `powershell -File ${script} && echo ok`,
  `powershell -File ${script} | Out-Null`,
  `powershell -File ${script} 2>&1`,
  `powershell -File "${script}"`,
  `powershell -File '${script}'`,
]
for (const cmd of cmds) {
  const plan = classify({ name: 'pwsh', arguments: { command: cmd } })
  const sp = scriptPlan(cmd, 'D:\\AIworks')
  console.log(
    `${sp ? 'OK  ' : 'NULL'}  classify=${plan ? plan.kind + (plan.script ? '/script' : '') : 'null'}  targets=${sp ? sp.targets.length : 0}  cmd=${cmd.slice(-60)}`,
  )
}
