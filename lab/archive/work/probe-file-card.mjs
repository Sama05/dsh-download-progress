import { classify } from './detect.js'
import { beginTask, snapshot, sweep } from './state.js'

const cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\\AIworks\\dsh-download-progress\\lab\\work\\get-artifact.ps1'
const exec = { name: 'pwsh', callId: 'probe-file-1', sessionId: 's1', arguments: { command: cmd } }
const plan = classify(exec)
console.log('classify =', JSON.stringify(plan))
if (plan) {
  try {
    const t = beginTask(exec, plan, 'D:\\AIworks')
    console.log('beginTask ok, id =', t && t.id, 'targets =', JSON.stringify(t && t.targets))
  } catch (e) {
    console.log('beginTask THREW:', e && e.message)
  }
}
sweep(Date.now(), () => false)
const s = snapshot()
console.log('snapshot count =', s.length, JSON.stringify(s.map((t) => ({ k: t.kind, l: t.label, b: t.bytes, tot: t.total }))))
