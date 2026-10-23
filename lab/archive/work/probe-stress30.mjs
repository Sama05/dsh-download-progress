// Exactly the stress-host shape, instrumented.
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginTask, snapshot, sweep } from '../../state.js'

const dir = mkdtempSync(join(tmpdir(), 'ddp-dbg2-'))
const started = Date.now()
const batch = []
for (let i = 0; i < 30; i += 1) {
  const file = join(dir, 'f' + i + '.bin')
  const t = beginTask(
    { callId: 'bulk-' + i, name: 'pwsh' },
    { kind: 'download', command: `curl -o "${file}" http://127.0.0.1:1/x` },
    dir,
  )
  batch.push(t)
  writeFileSync(file, Buffer.alloc(64))
}
sweep(started)
let bad = 0
for (let i = 0; i < 30; i += 1) {
  const file = join(dir, 'f' + i + '.bin')
  const st = statSync(file)
  const t = batch[i]
  const okFresh = st.mtimeMs >= t.startedAt
  const snap = snapshot().find((s) => s.id === t.id)
  if (!snap || snap.bytes !== 64) {
    bad += 1
    if (bad <= 5) {
      console.log(
        `i=${i} bytes=${snap && snap.bytes} mtime=${st.mtimeMs} startedAt=${t.startedAt} delta=${(st.mtimeMs - t.startedAt).toFixed(3)} okFresh=${okFresh} freshTarget=${t.freshTarget} targets=${t.targets.length}`,
      )
    }
  }
}
console.log('bad =', bad, 'of 30')
