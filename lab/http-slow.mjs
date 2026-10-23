/**
 * Deterministic slow HTTP server for the IO-counter feasibility experiment.
 *
 * Serves `/file?mb=N` as N MiB of zeros at a fixed rate, so a test can compare
 * "bytes the OS says this process transferred" against "bytes that really
 * arrived" without depending on the internet or a particular mirror's speed.
 *
 * Throttling note: the writer is an async loop that waits out the delay
 * *before each chunk*, and it also awaits a drain when the socket pushes back.
 * The earlier callback version forgot the delay on the backpressure path, so a
 * fast reader (node's fetch) drained the socket and the whole file went out in
 * one burst — a 12 MiB transfer completed in 61 ms at "4 MiB/s".
 */
import http from 'node:http'

const PORT = Number(process.env.LAB_PORT || 45777)
const CHUNK = 64 * 1024
/** Bytes per second. */
const RATE = Number(process.env.LAB_RATE || 4 * 1024 * 1024)
const CHUNK_MS = Math.max(1, Math.round((CHUNK / RATE) * 1000))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/file') {
    res.writeHead(404).end('no')
    return
  }
  const mb = Math.min(200, Math.max(1, Number(url.searchParams.get('mb') || 20)))
  const total = mb * 1024 * 1024
  // HEAD must answer immediately with the size only. Node suppresses the body of
  // a HEAD response, so the throttled loop below would still run — and block on a
  // `drain` that never arrives, because nothing is being written. That made a
  // HEAD take as long as the download (4.8 s for 4 MiB), which is longer than the
  // plugin's 6 s probe timeout on a bigger file, and the card then had no
  // denominator for reasons that had nothing to do with the plugin.
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(total),
      'cache-control': 'no-store',
    })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(total),
    'cache-control': 'no-store',
  })
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
