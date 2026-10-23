/**
 * Chunked, length-less slow server: for eyeballing the inline RING body.
 *
 * The ring is what the chip paints when work is in flight but there is no
 * fraction to draw, so a server that never sends `content-length` is the exact
 * fixture for it: the card keeps `total = null` for the whole transfer, and the
 * ring spins (with a live rate) until the last byte lands.
 *
 *   LAB_PORT=45790 LAB_RATE=120000 node lab/chunkless-slow.mjs
 *   curl.exe -s -o lab\work\ring.bin http://127.0.0.1:45790/file?mb=8
 */
import http from 'node:http'

const PORT = Number(process.env.LAB_PORT || 45790)
const RATE = Number(process.env.LAB_RATE || 120 * 1024)
const CHUNK = 32 * 1024
const CHUNK_MS = Math.max(1, Math.round((CHUNK / RATE) * 1000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/file') {
    res.writeHead(404).end('no')
    return
  }
  const mb = Math.min(64, Math.max(1, Number(url.searchParams.get('mb') || 8)))
  const total = mb * 1024 * 1024
  // HEAD must answer at once, with no content-length — the plugin's probe then
  // finds no denominator and leaves `total` null, which is the ring state.
  // Without this branch the throttled body loop runs for HEAD too and blocks on
  // a `drain` that never comes, so the probe times out instead of returning.
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
    res.end()
    return
  }
  // Deliberately no content-length: that is the whole point. Node then uses
  // chunked transfer-encoding and the plugin's HEAD probe finds no size.
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
  const buf = Buffer.alloc(CHUNK)
  let sent = 0
  while (sent < total) {
    if (res.destroyed || req.destroyed) return
    const size = Math.min(CHUNK, total - sent)
    const ok = res.write(size === CHUNK ? buf : buf.subarray(0, size))
    sent += size
    if (!ok) await new Promise((r) => res.once('drain', r))
    await sleep(CHUNK_MS)
  }
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: PORT, rate: RATE, chunkMs: CHUNK_MS }))
})
