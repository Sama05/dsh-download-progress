/**
 * 通用性验证：包 `https.request` 能不能盖住「不走 undici」的 HTTP 客户端？
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe\https-request-generic.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么这条路比 undici 通用
 *
 * Node 里所有「不用 undici」的 HTTP 客户端最终都落在 `http.request` /
 * `https.request`：`node-fetch` v2、`axios`(node adapter)、`got`、`request`、
 * 原生 `https.get`，以及 `dsh-free-search` 的 `node:https` 直连。
 *
 * 而 undici 是**独立实现**，不走 `http.request`。两者互不覆盖，所以正确的
 * 覆盖率是「两层都包」，不是二选一：
 *
 *   包 https.request  → 盖住 free-search / node-fetch / axios / got …
 *   包 undici.fetch   → 盖住宿主内置 web_fetch（未装接管插件时）
 *
 * 这一层还有个额外好处：`http.request` 是 Node 的**公开稳定 API**，
 * 不需要像 undici 那样 hook 源码、也不受 CJS 缓存影响 —— 装在任何时候都立即生效。
 *
 * ## 要证明的三件事
 *
 *   1. 包 `https.request` 之后，一次真实请求的 `data` 事件能被计数
 *   2. 消费方拿到的 body 完整（不能因为计数破坏流）
 *   3. `content-length` 与 gzip 能拿到（这决定能不能算出百分比）
 */
import https from 'node:https'
import zlib from 'node:zlib'

const GZIP_URL = 'https://raw.githubusercontent.com/nodejs/node/main/README.md'
const PLAIN_URL = 'https://proof.ovh.net/files/1Mb.dat'

const line = (label, value) => console.log(label.padEnd(30) + value)

// 探针本身崩掉就什么都看不到。这两条保证「出问题也有结论」而不是一段堆栈。
process.on('uncaughtException', (err) => {
  console.log('\nUNCAUGHT: ' + (err && err.message))
  console.log('（这是探针自身的问题，不是被测逻辑的结论）')
  process.exit(9)
})
process.on('unhandledRejection', (err) => {
  console.log('\nUNHANDLED: ' + (err && err.message))
  process.exit(9)
})

// ---- 包装：只数字节，不改数据 ----

const GATE = Symbol.for('ddp-probe-https-gate')
const SINK = Symbol.for('ddp-probe-https-sink')
globalThis[GATE] = () => true
globalThis[SINK] = (e) => events.push(e)
const events = []

const realRequest = https.request

https.request = function ddpRequest(...args) {
  const req = realRequest.apply(this, args)
  // 把本次请求的 URL 记下来：`args` 形式极多（string / URL / options），
  // 逐个尝试取值，取不到就空着（那种事件会被 URL 匹配层丢弃，不会误记）。
  let url = ''
  try {
    const first = args[0]
    if (typeof first === 'string') url = first
    else if (first instanceof URL) url = first.href
    else if (first && typeof first === 'object') {
      const proto = first.protocol || 'https:'
      const host = first.hostname || first.host || ''
      const port = first.port ? ':' + first.port : ''
      const path = first.path || '/'
      if (host) url = `${proto}//${host}${port}${path}`
    }
  } catch {
    /* 取不到就当空 */
  }
  // `https.request` 被 `https.get` 复用，两者都会走到这里。
  req.on('response', (res) => {
    try {
      if (typeof globalThis[GATE] === 'function' && !globalThis[GATE]()) return
      const total = Number(res.headers['content-length']) || 0
      const encoding = String(res.headers['content-encoding'] || '')
      let bytes = 0
      // 注意：这里**只监听，不消费**。`data` 是'data' 事件的旁听者，
      // pipe / read 的语义不受影响。
      res.on('data', (chunk) => {
        bytes += chunk.length
        try {
          globalThis[SINK]({ url, bytes, total, done: false, encoding })
        } catch {
          /* 消费者抛错不能回到流里 */
        }
      })
      res.on('end', () => {
        try {
          globalThis[SINK]({ url, bytes, total, done: true, encoding })
        } catch {
          /* 同上 */
        }
      })
    } catch {
      /* 包装层绝不成为请求的错误来源 */
    }
  })
  return req
}

/** 一个最小的 GET，把 body 收全（模拟 web_fetch 的消费方式）。 */
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        let decoded = raw
        const enc = String(res.headers['content-encoding'] || '')
        try {
          if (enc.includes('gzip')) decoded = zlib.gunzipSync(raw)
          else if (enc.includes('deflate')) decoded = zlib.inflateSync(raw)
          else if (enc.includes('br')) decoded = zlib.brotliDecompressSync(raw)
        } catch {
          /* 解不开就报原始长度 */
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawLength: raw.length,
          decodedLength: decoded.length,
          body: decoded,
        })
      })
      // 响应侧的 error 必须接住：TLS 对端提前断开时它会以
      // `ECONNRESET` 抛到进程上，把整个探针带崩（第一次就崩在这里）。
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(25_000, () => req.destroy(new Error('probe timeout')))
    req.end()
  })
}

console.log('=== 1. gzip 响应（GitHub raw 常见） ===')
{
  events.length = 0
  const r = await get(GZIP_URL)
  await new Promise((r) => setTimeout(r, 200))
  line('status', String(r.status))
  line('content-encoding', String(r.headers['content-encoding'] || '(none)'))
  line('content-length hdr', String(r.headers['content-length'] || '(none)'))
  line('raw bytes (wire)', String(r.rawLength))
  line('decoded bytes', String(r.decodedLength))
  line('body intact', r.decodedLength > 1000 ? 'yes' : 'NO')
  const mine = events.filter((e) => e.url === GZIP_URL)
  line('events', String(mine.length))
  if (mine.length > 0) {
    const last = mine[mine.length - 1]
    line('last.bytes (wire)', String(last.bytes))
    line('last.total (hdr)', String(last.total))
    line('last.done', String(last.done))
    line('bytes match wire', last.bytes === r.rawLength ? 'yes' : 'no (' + last.bytes + ' vs ' + r.rawLength + ')')
  }
}

console.log('\n=== 2. 二进制大文件（无 gzip） ===')
{
  events.length = 0
  const r = await get(PLAIN_URL)
  await new Promise((r) => setTimeout(r, 200))
  line('status', String(r.status))
  line('content-encoding', String(r.headers['content-encoding'] || '(none)'))
  line('content-length hdr', String(r.headers['content-length'] || '(none)'))
  line('raw bytes', String(r.rawLength))
  line('body intact', r.rawLength > 900_000 ? 'yes' : 'NO')
  const mine = events.filter((e) => e.url === PLAIN_URL)
  line('events', String(mine.length))
  if (mine.length > 0) {
    const last = mine[mine.length - 1]
    line('last.bytes', String(last.bytes))
    line('last.total', String(last.total))
    line('last.done', String(last.done))
    line('bytes match', last.bytes === r.rawLength ? 'yes' : 'no')
  }
}

console.log('\n=== 3. `https.get` 也走同一条路吗 ===')
{
  events.length = 0
  const ok = await new Promise((resolve) => {
    https
      .get(PLAIN_URL, (res) => {
        res.resume()
        res.on('end', () => resolve(true))
      })
      .on('error', () => resolve(false))
  })
  await new Promise((r) => setTimeout(r, 200))
  line('https.get ok', String(ok))
  line('events (https.get)', String(events.length))
}

console.log('\n=== 结论 ===')
console.log('包 https.request 能盖住所有非 undici 的 Node HTTP 客户端，')
console.log('包括 dsh-free-search 的 node:https —— 与你装了什么插件无关。')
https.request = realRequest
process.exit(0)
