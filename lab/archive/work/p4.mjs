import { FILE_FLAG_RE } from '../../script/tuning.js'
for (const c of [
  'powershell -File D:\\a\\b.ps1',
  'powershell -File D:\\a\\b.ps1;',
  'powershell -File D:\\a\\b.ps1;"x"',
  'powershell -File "D:\\a\\b.ps1"',
  'powershell -File "D:\\a\\b.ps1"; "x"',
  'powershell -File D:\\a\\b.ps1 | Out-Null',
  'powershell -File D:\\a\\b.ps1,',
]) {
  const m = FILE_FLAG_RE.exec(c)
  console.log(JSON.stringify(c), '->', m ? JSON.stringify(m[2] || m[3] || m[4]) : 'null')
  FILE_FLAG_RE.lastIndex = 0
}
