// Does NTFS advance mtime while a process is writing an existing file?
// The plugin's "is this file fresh" proof depends on the answer.
import { statSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const p = join(tmpdir(), `ddp-mtime-${Date.now()}.bin`)
writeFileSync(p, Buffer.alloc(1024))
console.log('initial mtime', statSync(p).mtimeMs)

// A handle that appends over ~6 s, the way a downloader writes.
const fd = openSync(p, 'a')
const start = Date.now()
for (let i = 0; i < 12; i += 1) {
  writeSync(fd, Buffer.alloc(1024))
  await new Promise((r) => setTimeout(r, 500))
  const st = statSync(p)
  console.log(
    `t=${String(Date.now() - start).padStart(5)}ms size=${String(st.size).padStart(6)} mtimeDelta=${st.mtimeMs - start}`,
  )
}
closeSync(fd)
console.log('after close mtimeDelta', statSync(p).mtimeMs - start)
