import { classify } from '../../detect.js'
import { scriptPlan } from '../../script.js'
const cmd = 'Remove-Item -LiteralPath D:\\AIworks\\dsh-download-progress\\lab\\work\\slow-real.bin -ErrorAction SilentlyContinue; powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\\AIworks\\dsh-download-progress\\lab\\work\\get-artifact-slow.ps1; "exit=$LASTEXITCODE size=$((Get-Item D:\\AIworks\\dsh-download-progress\\lab\\work\\slow-real.bin).Length)"'
const ex = { name: 'pwsh', callId: 'live-1', agent: { id: 's1' }, arguments: { command: cmd } }
const plan = classify(ex)
console.log('classify =', JSON.stringify(plan))
if (plan && plan.command) console.log('scriptPlan =', JSON.stringify(scriptPlan(plan.command, 'D:\\AIworks')))
