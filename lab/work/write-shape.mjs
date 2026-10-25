// How does a downloader write its destination file?
//
// A card watches a path with stat().size. A tool that buffers in memory or
// stages a temp file and renames at the end leaves that path absent for the whole
// transfer, so a card on it sits at 0 % -- worse than no card at all. This probe
// answers the question per tool, empirically.
//
// Needs lab/work/payload-server.mjs already listening (default :18080, 40 MB,
// ~6 MB/s), so the transfer is long enough to sample.
//
//   node lab/work/write-shape.mjs certutil
//   node lab/work/write-shape.mjs bits
//   node lab/work/write-shape.mjs curl        (control: known to grow in place)

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const tool = process.argv[2] || 'certutil'
const url = process.argv[3] || 'http://127.0.0.1:18080/payload.bin'
const DIR = join(process.cwd(), 'lab', 'work', 'probe-out')
const DEST = join(DIR, `${tool}.bin`)

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const COMMANDS = {
  certutil: ['certutil.exe', ['-urlcache', '-split', '-f', url, DEST]],
  bits: ['pwsh.exe', ['-NoProfile', '-Command', `Start-BitsTransfer -Source '${url}' -Destination '${DEST}'`]],
  curl: ['curl.exe', ['-sSL', '-o', DEST, url]],
}

const spec = COMMANDS[tool]
if (!spec) throw new Error(`unknown tool: ${tool}`)

const sizeOf = () => {
  try {
    return statSync(DEST).size
  } catch {
    return null
  }
}
const dirOf = () => {
  try {
    return readdirSync(DIR).map((name) => `${name}=${sizeOf.call(null) ?? ''}`).length
      ? readdirSync(DIR)
          .map((name) => {
            try {
              return `${name}=${statSync(join(DIR, name)).size}`
            } catch {
              return `${name}=?`
            }
          })
          .join(',')
      : ''
  } catch {
    return ''
  }
}

const started = Date.now()
// stdio must be inherited: a piped child is refused in this environment.
const child = spawn(spec[0], spec[1], { stdio: 'inherit', windowsHide: true })

const rows = []
let firstSeen = null
const timer = setInterval(() => {
  const size = sizeOf()
  if (size !== null && firstSeen === null) firstSeen = Date.now() - started
  rows.push(`${Date.now() - started}ms ${size ?? 'absent'} [${dirOf()}]`)
}, 200)

const code = await new Promise((resolve) => child.on('exit', resolve))
clearInterval(timer)

const finalSize = sizeOf()
console.log(`\n${tool}: exit=${code} elapsed=${Date.now() - started}ms`)
console.log(`first sighting: ${firstSeen === null ? 'never' : `${firstSeen}ms`}`)
console.log(`final: ${finalSize ?? 'absent'}  dir=[${dirOf()}]`)
console.log('samples every 1s:')
for (let i = 0; i < rows.length; i += 5) console.log('  ' + rows[i])
rmSync(DIR, { recursive: true, force: true })
