/**
 * 决定性探针：**先 import 过 undici，再装钩子**，请求还能不能被计数？
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe\esm-snapshot.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 要证的是哪一条
 *
 * `late-hook.mjs` 的 B 段已经量到：修改 `require.cache[...].exports.fetch` 之后，
 * `(await import(...)).fetch` **不跟着变**（`patched fn is ours: false`）——
 * 也就是 ESM 的命名导出是**快照**，不是指向 `module.exports` 的 live binding。
 *
 * 如果这一点成立，那么真机现象就有唯一解释：
 *
 *   1. 宿主启动早期某处 import 过 undici → ESM namespace 建立，`fetch` 绑定到
 *      **原始函数**，快照定型
 *   2. 插件激活，`load` 钩子注册成功；但 undici 已在 CJS 缓存里，**钩子不再触发**
 *      （`late-hook.mjs` A 段：hits = 0）
 *   3. `proveInjection()` 查 `module.exports.fetch` → 不是 `ddpFetch` → false
 *   4. `undiciLoaded()` 查缓存 → **有** → true
 *   5. `streamInstalled()` = `sawEvent(false) || wrapped(false) || !undiciLoaded(false)`
 *      = **false** → 应该报 degraded
 *
 * 但真机报的是 `ok`（`capabilities.stream = "ok"`）。所以要么 3/4 的判据在活宿主
 * 里行为不同，要么还有第四条路。这个探针同时量全部四个值，把矛盾摆出来。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { installStreamSensor, streamInstalled } from '../../sensor/stream.js'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = pathToFileURL(undiciPath).href

const line = (label, value) => console.log(label.padEnd(30) + value)

function inspect() {
  const cache = Module._cache || {}
  let loaded = false
  let wrapped = false
  for (const k of Object.keys(cache)) {
    if (!String(k).replace(/\\/g, '/').endsWith('/undici/index.js')) continue
    loaded = true
    const exp = cache[k] && cache[k].exports
    if (exp && exp.fetch && exp.fetch.name === 'ddpFetch') wrapped = true
  }
  return { loaded, wrapped }
}

// 本地慢速服务（http；isPublicIpAddress 的检查不在这一层，我们要测的是包装）
const TOTAL = 512 * 1024
const CHUNK = 32 * 1024
const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'content-length': String(TOTAL), 'content-type': 'application/octet-stream' })
  const buf = Buffer.alloc(CHUNK, 5)
  for (let sent = 0; sent < TOTAL; sent += CHUNK) {
    if (!res.write(buf)) await new Promise((r) => res.once('drain', r))
    await new Promise((r) => setTimeout(r, 3))
  }
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/x.bin`

console.log('=== STEP 1: 宿主早期先 import（模拟 web-fetch 插件初始化） ===')
const early = await import(undiciUrl)
line('early fetch.name', early.fetch && early.fetch.name)
line('cache 里 undici 已加载', String(inspect().loaded))

console.log('\n=== STEP 2: 现在才装钩子（模拟插件激活） ===')
const events = []
const dispose = installStreamSensor({ onBytes: (e) => events.push(e), gate: () => true })
line('install 返回', typeof dispose === 'function' ? 'function' : String(dispose))
const after = inspect()
line('cache: loaded / wrapped', `${after.loaded} / ${after.wrapped}`)
line('streamInstalled()', String(streamInstalled()))

console.log('\n=== STEP 3: 再 import 一次并发请求 ===')
const late = await import(undiciUrl)
line('late fetch.name', late.fetch && late.fetch.name)
line('late === early ?', String(late.fetch === early.fetch))

const res = await late.fetch(url)
const body = Buffer.from(await res.arrayBuffer())
line('body bytes', String(body.length))
await new Promise((r) => setTimeout(r, 300))
line('event count', String(events.length))

console.log('\n=== 结论 ===')
if (events.length > 0) {
  console.log('钩子对晚到的请求仍然有效 —— 真机 bytes=0 另有原因')
} else if (after.wrapped) {
  console.log('module.exports 被包住了，但请求没被计数 ⇒ ESM 快照：web_fetch 拿的是旧 fetch')
} else {
  console.log('注入没发生（wrapped=false）⇒ 早 import 之后钩子永久错过')
  console.log('此时 streamInstalled() 应报 false（degraded），真机却报 ok —— 判据有 bug')
}

if (typeof dispose === 'function') dispose()
server.close()
process.exit(0)
