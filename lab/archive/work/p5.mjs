import { classify } from '../../detect.js'
import { beginTask } from '../../state.js'

const cmds = [
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\\AIworks\\dsh-download-progress\\lab\\work\\get-artifact-slow.ps1',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\lab\\work\\get-artifact-slow.ps1',
]
for (const cwd of ['D:\\AIworks\\dsh-download-progress', 'D:\\AIworks', '']) {
  for (const cmd of cmds) {
    const exec = { name: 'pwsh', callId: 'c-' + Math.random(), agent: { id: 's1' }, arguments: { command: cmd } }
    const plan = classify(exec)
    let r = null
    try { r = beginTask(exec, plan, cwd) } catch (e) { r = 'THREW ' + e.message }
    console.log('cwd=' + JSON.stringify(cwd), '| cmd=' + (cmd.includes('D:\\AIworks\\d') ? 'ABS' : 'REL'), '| plan=' + (plan ? plan.kind + '/script=' + plan.script : 'null'), '| task=' + (r ? (r.id ? 'ok targets=' + JSON.stringify(r.targets) : r) : 'NULL'))
  }
}
