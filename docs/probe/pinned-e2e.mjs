/**
 * 真机复现：完全照 `web-fetch-http` 的 `requestPinned` 走一遍，验证传感器接得到字节。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/pinned-e2e.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么这条路才是真机的路
 *
 * `requestPinned` 的写法是（app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js:153-154）：
 *
 *     async function requestPinned(url, addresses, headers, signal) {
 *       const { Agent, fetch } = await import("undici")
 *       ...
 *     }
 *
 * 两个关键点：
 *   1. 解析基准是**那个文件**，不是我探针的目录 —— 所以要 createRequire 到它
 *   2. 它自带 `Agent`（私有 dispatcher），全局 fetch 的钩子抓不到 —— 只有
 *      `import("undici")` 回来的那个 `fetch` 被包住才有效
 *
 * 这个探针把这两点都照做：从那个文件解析 undici，用它的 `Agent` 建 dispatcher，
 * 用它的 `fetch` 发请求，然后看传感器收到几个字节事件。
 *
 * ## 前提：必须先装传感器再 import
 *
 * 已实测：CJS 缓存命中时 `load` 钩子不触发。所以这里先装、后 import —— 这也正是
 * 插件该有的顺序（启动即装钩子，不等用户开开关）。
 */
import http from 'node:http'
import { createRequire } from 'node:module'

import { installStreamSensor, streamInstalled } from '../../sensor/stream.js'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)

const line = (label, value) => console.log(label.padEnd(24) + value)

// 本地慢速服务（4 MiB，每 chunk 停 4ms ⇒ 约 0.5-1s，足够产生多次事件）。
const CHUNK = 64 * 1024
const TOTAL = 4 * 1024 * 1024
const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'content-length': String(TOTAL), 'content-type': 'application/octet-stream' })
  const buf = Buffer.alloc(CHUNK, 3)
  for (let sent = 0; sent < TOTAL; sent += CHUNK) {
    if (!res.write(buf)) await new Promise((r) => res.once('drain', r))
    await new Promise((r) => setTimeout(r, 4))
  }
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/payload.bin`
line('target', url)

// 1) 先装传感器（模拟插件启动即装）
const events = []
const dispose = installStreamSensor({
  onBytes: (e) => {
    if (e.url === url) events.push(e)
  },
})
line('install returned', typeof dispose === 'function' ? 'function' : String(dispose))
line('streamInstalled()', String(streamInstalled()))
if (typeof dispose !== 'function') {
  console.log('\n尚装不上（宿主已加载 undici 且未注入）—— 这正是待修的场景')
  server.close()
  process.exit(3)
}

// 2) 完全照 requestPinned：从宿主那个文件解析，用它的 Agent + fetch
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = new URL('file:///' + undiciPath.replace(/^\/+/, '').replace(/\\/g, '/')).href
const undici = await import(undiciUrl)
line('undici.fetch.name', undici.fetch && undici.fetch.name)

const agent = new undici.Agent({ connections: 1 })
const res = await undici.fetch(url, { dispatcher: agent, redirect: 'manual' })
line('status', String(res.status))
line('content-length', String(res.headers.get('content-length')))

// 消费完整响应体（模拟 web_fetch 拿到正文）
const body = Buffer.from(await res.arrayBuffer())
line('bytes received', String(body.length))
line('bytes intact', body.length === TOTAL && body.every((b) => b === 3) ? 'yes' : 'NO')

await new Promise((r) => setTimeout(r, 400))
const last = events[events.length - 1]
line('byte events', String(events.length))
line('last.bytes', last ? String(last.bytes) : '(none)')
line('last.total', last ? String(last.total) : '(none)')
line('last.done', last ? String(last.done) : '(none)')

const monotonic = events.every((e, i) => i === 0 || e.bytes >= events[i - 1].bytes)
line('monotonic', monotonic ? 'yes' : 'NO')

await agent.close?.()
dispose()
line('after dispose', String(streamInstalled()))

const ok =
  body.length === TOTAL &&
  body.every((b) => b === 3) &&
  events.length >= 2 &&
  monotonic &&
  last &&
  last.bytes === TOTAL &&
  last.total === TOTAL &&
  last.done === true

console.log(
  ok
    ? '\nPINNED E2E OK — 照 requestPinned 的调用形态，逐字节进度可用，body 完好'
    : '\nPINNED E2E FAILED',
)
server.close()
process.exit(ok ? 0 : 1)
