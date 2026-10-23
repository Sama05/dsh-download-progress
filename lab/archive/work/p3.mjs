import { readScript, scriptPathOf } from '../../script/read.js'
import { scriptTargets, scriptUrls } from '../../script/targets.js'
const cmd = 'Remove-Item -LiteralPath D:\\AIworks\\dsh-download-progress\\lab\\work\\slow-real.bin -ErrorAction SilentlyContinue; powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\\AIworks\\dsh-download-progress\\lab\\work\\get-artifact-slow.ps1; "exit=$LASTEXITCODE size=$((Get-Item D:\\AIworks\\dsh-download-progress\\lab\\work\\slow-real.bin).Length)"'
console.log('path =', scriptPathOf(cmd, 'D:\\AIworks'))
const s = readScript(cmd, 'D:\\AIworks')
console.log('readScript =', s ? { path: s.path, len: s.body.length } : null)
if (s) {
  console.log('targets =', JSON.stringify(scriptTargets(s.body, process.env)))
  console.log('urls =', JSON.stringify(scriptUrls(s.body)))
}
