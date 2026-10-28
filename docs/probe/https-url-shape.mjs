/**
 * 真机定位：`web_fetch` 走 https 时，流事件的 url 到底长什么样？
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe\https-url-shape.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么需要这一条
 *
 * 真机实测：`web_fetch` 卡片出现、`progressSource: "stream"`、`capabilities.stream: "ok"`，
 * 但 `bytes` 恒为 0，30 次采样无一例外。而同一份代码在探针里对 http 本地服务
 * 拿到 66 个事件。差别只有两处：https，以及 `requestPinned` 的自定义 `Agent`。
 *
 * `state/stream.js:noteStreamBytes` 用 `task.url !== url` 精确匹配：
 *
 *     for (const task of tasks.values()) {
 *       if (task.url !== url) continue
 *       ...
 *     }
 *
 * 所以只要事件里的 `url` 与 `classify()` 记录的 `args.url` 有一个字符不同
 * （重定向改写、规范化、末尾斜杠、query 顺序），所有事件都会被丢掉，表现
 * 就是「卡片在、进度恒 0」。
 *
 * 这个探针把一个**真实 https** 请求发出去，同时打印：
 *   - 我们传进去的 input
 *   - wrapper 里看到的 url
 *   - 事件里的 url
 * 三者一对比就知道是不是匹配失败。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { installStreamSensor } from '../../sensor/stream.js'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)

const TARGET = 'https://speed.cloudflare.com/__down?bytes=2000000'
const line = (label, value) => console.log(label.padEnd(22) + value)

// 先装传感器（此时 undici 可能已被宿主加载；装不上也不影响本次诊断——
// 我们要看的是 event.url 的形状，所以这里同时接受「已注入」和「未注入」）。
const events = []
const dispose = installStreamSensor({
  onBytes: (e) => events.push(e),
  gate: () => true,
})
line('install', typeof dispose === 'function' ? 'ok' : 'null')
line('events sink', 'ready')

const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = pathToFileURL(undiciPath).href
const undici = await import(undiciUrl)
line('undici.fetch.name', undici.fetch && undici.fetch.name)
line('is wrapped', undici.fetch && undici.fetch.name === 'ddpFetch')

// 完全照 requestPinned：自定义 Agent + redirect manual + signal。
const { Agent } = undici
const agent = new Agent({ connections: 1 })
const ac = new AbortController()
const timeout = setTimeout(() => ac.abort(), 20_000)

let res
try {
  res = await undici.fetch(TARGET, {
    dispatcher: agent,
    redirect: 'manual',
    signal: ac.signal,
    headers: { 'user-agent': 'ddp-probe' },
  })
} finally {
  clearTimeout(timeout)
}

line('status', String(res.status))
line('location', String(res.headers.get('location') || '(none)'))
line('content-length', String(res.headers.get('content-length')))
line('response.url', String(res.url || '(empty)'))

const body = Buffer.from(await res.arrayBuffer())
line('body bytes', String(body.length))

await new Promise((r) => setTimeout(r, 500))
line('event count', String(events.length))
if (events.length > 0) {
  const first = events[0]
  const last = events[events.length - 1]
  line('event[0].url', first.url)
  line('event[0].url === TARGET', String(first.url === TARGET))
  line('last.bytes', String(last.bytes))
  line('last.total', String(last.total))
  line('last.done', String(last.done))
} else {
  console.log('\nNO EVENTS — 包装层没有接到这个请求')
  console.log('可能原因：')
  console.log('  1. fetch 没被替换（undici.fetch.name 不是 ddpFetch）')
  console.log('  2. gate 关着（这里强制 true，所以不是这个）')
  console.log('  3. res.body 为空（HEAD / 204 / redirect manual 无 body）')
}

await agent.close?.()
if (typeof dispose === 'function') dispose()
process.exit(0)
