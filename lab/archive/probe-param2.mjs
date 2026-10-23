/**
 * Follow-up: use the *real* script path that exists on disk, so `scriptPlan`
 * actually reads a file instead of returning null for a missing one.
 */
import { classify } from '../detect.js'
import { scriptPlan, scriptPathOf } from '../script.js'

const cwd = 'D:\\AIworks\\dsh-download-progress\\lab'
const real = 'D:\\AIworks\\dsh-download-progress\\lab\\tmp\\t21-comment.ps1'
const commands = {
  'real script, -Out on the command line': `powershell -NoProfile -ExecutionPolicy Bypass -File "${real}" -Url "http://127.0.0.1:45811/file?mb=16" -Out "${cwd}\\tmp\\t21-out.bin"`,
  'real script, no -Out': `powershell -NoProfile -ExecutionPolicy Bypass -File "${real}"`,
}

for (const [name, command] of Object.entries(commands)) {
  const plan = classify({ name: 'pwsh', arguments: { command } })
  console.log(name)
  console.log(`  classify   -> ${plan ? plan.kind + ' script=' + plan.script : 'null (no card)'}`)
  console.log(`  scriptPath -> ${scriptPathOf(command, cwd)}`)
  console.log(`  scriptPlan -> ${JSON.stringify(scriptPlan(command, cwd))}`)
}
