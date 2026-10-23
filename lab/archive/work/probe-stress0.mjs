// Why does the stress case still read 0? Print the actual timestamps.
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginTask, snapshot, sweep } from '../../state.js'

const dir = mkdtempSync(join(tmpdir(), 'ddp-dbg-'))
const started = Date.now()
const file = join(dir, 'f0.bin')
const task = beginTask(
  { callId: 'bulk-0', name: 'pwsh' },
  { kind: 'download', command: `curl -o "${file}" http://127.0.0.1:1/x` },
  dir,
)
writeFileSync(file, Buffer.alloc(64))
const st = statSync(file)
console.log('startedAt     ', task.startedAt)
console.log('mtimeMs       ', st.mtimeMs)
console.log('mtime>=started', st.mtimeMs >= task.startedAt)
console.log('size          ', st.size)
sweep(started)
console.log('bytes after   ', snapshot()[0].bytes)
console.log('targets       ', task.targets)
console.log('freshTarget   ', task.freshTarget)
