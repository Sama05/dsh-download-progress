/**
 * 在宿主自己的 Electron node 里验证 stream sensor。
 *
 * 为什么必须在宿主里跑：`sensor/stream.js` 靠 `Module.registerHooks` 改写**宿主
 * 加载的那份 undici**。系统 Node 也能跑，但它加载的是自己的内置 undici，和宿主
 * 的模块图无关 —— 那样的"通过"证明不了任何事。
 *
 * 跑法（在插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/stream-in-host.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么先自己造一份 undici 再 import
 *
 * 宿主的 undici 在 `app.asar` 里，从插件目录 `import('undici')` 解析不到
 * （实测：ERR_MODULE_NOT_FOUND）。这恰恰就是插件在真实运行时的处境 —— 它**只
 * 能按路径后缀匹配**宿主加载的那份，不能自己解析。
 *
 * 所以这个探针造一个最小 `undici` 包（转发到 Node 内置 fetch，导出名与真包一致），
 * 让 hook 有东西可包。这验证的是**包装机制**：路径匹配、load 钩子、rewrap 不破坏
 * 消费、事件计数。真实宿主里那份 undici 的导出形状由 `probeModules()` 已经确认可用。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { installStreamSensor, streamInstalled } from '../../sensor/stream.js'

const line = (label, value) => console.log(label.padEnd(24) + value)

line('node', process.version)
line('electron', process.versions.electron || '(not electron)')
line('registerHooks', typeof Module.registerHooks)

// 造一份被 import 的 undici 主入口。
const dir = mkdtempSync(join(tmpdir(), 'ddp-probe-undici-'))
mkdirSync(join(dir, 'node_modules', 'undici'), { recursive: true })
writeFileSync(
  join(dir, 'node_modules', 'undici', 'index.js'),
  [
    `'use strict'`,
    `const realFetch = globalThis.fetch`,
    `module.exports.fetch = realFetch`,
    `module.exports.Response = globalThis.Response`,
    `module.exports.Headers = globalThis.Headers`,
    `module.exports.Request = globalThis.Request`,
    '',
  ].join('\n'),
  'utf8',
)
const undiciUrl = pathToFileURL(join(dir, 'node_modules', 'undici', 'index.js')).href
line('undici entry', undiciUrl.endsWith('/undici/index.js') ? 'matches suffix' : 'NO')

const CHUNK = 16 * 1024
const TOTAL = 512 * 1024

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'content-length': String(TOTAL), 'content-type': 'application/octet-stream' })
  const buf = Buffer.alloc(CHUNK, 9)
  for (let sent = 0; sent < TOTAL; sent += CHUNK) {
    // `res.write()` returning false means the socket buffer is full: the event to
    // wait for is 'drain' on the RESPONSE, not on the server. Waiting on the
    // server's 'drain' never fires and the loop hangs forever — which is exactly
    // what happened the first time this probe ran.
    if (!res.write(buf)) await new Promise((r) => res.once('drain', r))
    await new Promise((r) => setTimeout(r, 4))
  }
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/payload.bin`

// A probe that hangs is worse than one that fails: nobody reads a stuck job's
// output. Every await below is bounded, so the worst case is a red result.
const fail = (why) => {
  console.log('\nSTREAM SENSOR FAILED — ' + why)
  try {
    server.close()
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
const guard = setTimeout(() => fail('probe exceeded 20s'), 20_000)
guard.unref?.()

const events = []
const dispose = installStreamSensor({
  onBytes: (e) => {
    if (e.url === url) events.push(e)
  },
})
line('sensor installed', typeof dispose === 'function' ? 'yes' : 'no')
line('streamInstalled()', String(streamInstalled()))

if (typeof dispose !== 'function') {
  // 装不上也要给出可读的理由：这正是 `degraded` 状态要解释的事。
  console.log('\nSTREAM SENSOR NOT INSTALLED — 见上面 registerHooks 一行')
  server.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(2)
}

const undici = await import(undiciUrl)
const res = await undici.fetch(url)
line('response status', String(res.status))
line('header content-length', String(res.headers.get('content-length')))
const buf = Buffer.from(await res.arrayBuffer())
line('bytes received', String(buf.length))
line('bytes intact', buf.length === TOTAL && buf.every((b) => b === 9) ? 'yes' : 'NO')

// 事件是流式产生的，最后一个可能在 arrayBuffer 返回之后才到。
await new Promise((r) => setTimeout(r, 300))
const last = events[events.length - 1]
line('byte events', String(events.length))
line('last event bytes', last ? String(last.bytes) : '(none)')
line('last event total', last ? String(last.total) : '(none)')
line('last event done', last ? String(last.done) : '(none)')

const monotonic = events.every((e, i) => i === 0 || e.bytes >= events[i - 1].bytes)
line('monotonic', monotonic ? 'yes' : 'NO')

dispose()
line('after dispose', String(streamInstalled()))

const ok =
  buf.length === TOTAL &&
  buf.every((b) => b === 9) &&
  events.length >= 2 &&
  monotonic &&
  last &&
  last.bytes === TOTAL &&
  last.total === TOTAL &&
  last.done === true

clearTimeout(guard)
console.log(
  ok
    ? '\nSTREAM SENSOR OK — 路径匹配命中，字节数可读，body 完好，dispose 干净'
    : '\nSTREAM SENSOR FAILED',
)
server.close()
rmSync(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
