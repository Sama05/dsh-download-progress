// A throttled 40 MB HTTP payload, for probing how a downloader writes its target.
//
// Run as a background job while a probe samples the destination file. Kept dumb
// on purpose: one route, one size, one rate, no framework.
//
//   node lab/work/payload-server.mjs 18080 [mb] [msPerChunk]

import { createServer } from 'node:http'

const port = Number(process.argv[2] || 18080)
const total = Number(process.argv[3] || 40) * 1024 * 1024
const pause = Number(process.argv[4] || 40)
const chunk = 256 * 1024

const server = createServer((req, res) => {
  if (req.url !== '/payload.bin') {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(total),
    'accept-ranges': 'bytes',
  })
  // A HEAD carries the same headers and no body: answering it with the pump
  // below would stream 40 MB into a socket nobody reads, so the plugin's
  // denominator probe would time out and the card would stay indeterminate.
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const buf = Buffer.alloc(chunk, 0x41)
  let sent = 0
  let closed = false
  res.on('close', () => {
    closed = true
  })
  const pump = () => {
    if (closed) return
    if (sent >= total) {
      res.end()
      console.log('done')
      return
    }
    sent += buf.length
    res.write(buf)
    setTimeout(pump, pause)
  }
  pump()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/payload.bin  ${total / 1024 / 1024} MB`)
})
