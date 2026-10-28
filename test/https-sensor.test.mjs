/**
 * `sensor/https.js` 的测试：包装 http/https，旁听字节。
 *
 * ## 为什么这层需要单独的测试
 *
 * 它和 `stream.js` 是**并列的两条覆盖线**，不是同一个东西的两种写法：
 *   - `stream.js`  hook 源码，只覆盖 undici
 *   - `https.js`   换模块导出，覆盖所有不走 undici 的客户端
 *
 * 这一层要钉住的三个性质：
 *   1. **只旁听不消费**：调用方拿到的字节必须与不装传感器时逐字节一致
 *   2. **`get` 也被覆盖**：Node 的 `https.get` 引用模块作用域内的 `request`，
 *      换 `exports.request` 影响不到它 —— 必须单独换。这一条曾经在探针里
 *      暴露过（`events (https.get) = 0`）
 *   3. **prepend 而不是 append**：调用方传进 `request(url, cb)` 的响应回调
 *      早于我们的监听器注册。用 `on` 会排在它后面，漏掉开头的 chunk
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { httpSensorInstalled, installHttpSensor } from '../sensor/https.js'

const SINK = Symbol.for('dsh-download-progress.stream-sink')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  }
}

const CHUNK = 8 * 1024
const TOTAL = 64 * 1024

/** 一起慢速服务器：每个 chunk 之间停 3ms，保证产生多个 data 事件。 */
let server = null
async function slowUrl() {
  if (server) return server.url
  const srv = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-length': String(TOTAL),
      'content-type': 'application/octet-stream',
    })
    const buf = Buffer.alloc(CHUNK, 7)
    for (let sent = 0; sent < TOTAL; sent += CHUNK) {
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r))
      await new Promise((r) => setTimeout(r, 3))
    }
    res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  server = { srv, url: `http://127.0.0.1:${srv.address().port}/f.bin` }
  return server.url
}

/** 收全响应体（模拟调用方的消费方式）。 */
function fetchAll(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

/**
 * 装传感器并在结束时卸掉。
 *
 * `seen` 是共享的：传感器的 sink 通过全局 Symbol 槽交给本模块，
 * 和 `stream.js` 用的是同一个槽。
 */
async function withSensor(gate, fn) {
  const seen = []
  const previous = globalThis[SINK]
  globalThis[SINK] = (e) => seen.push(e)
  const dispose = installHttpSensor({ gate })
  try {
    await fn(seen)
  } finally {
    if (typeof dispose === 'function') dispose()
    globalThis[SINK] = previous
  }
}

console.log('\nhttp/https sensor')

await test('装上之后 http.get 请求能被计数，body 逐字节一致', async () => {
  const url = await slowUrl()
  await withSensor(
    () => true,
    async (seen) => {
      const body = await fetchAll(url)
      assert.equal(body.length, TOTAL, 'the caller must still get every byte')
      assert.ok(body.every((b) => b === 7), 'the bytes must be untouched')
      await new Promise((r) => setTimeout(r, 150))
      const mine = seen.filter((e) => e.url === url)
      assert.ok(mine.length >= 2, 'at least two byte events, got ' + mine.length)
      assert.equal(mine[mine.length - 1].bytes, TOTAL, 'the last event reaches the total')
      assert.equal(mine[mine.length - 1].total, TOTAL, 'the total comes from content-length')
      assert.equal(mine[mine.length - 1].done, true, 'the stream ended')
    },
  )
})

await test('http.request 也被覆盖（不只是 get）', async () => {
  const url = await slowUrl()
  await withSensor(
    () => true,
    async (seen) => {
      const body = await new Promise((resolve, reject) => {
        const req = http.request(url, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks)))
        })
        req.on('error', reject)
        req.end()
      })
      assert.equal(body.length, TOTAL)
      await new Promise((r) => setTimeout(r, 150))
      assert.ok(seen.filter((e) => e.url === url).length >= 2, 'request() must be counted too')
    },
  )
})

await test('门关着时零事件，但 body 仍完整', async () => {
  const url = await slowUrl()
  await withSensor(
    () => false,
    async (seen) => {
      const body = await fetchAll(url)
      assert.equal(body.length, TOTAL, 'the body must still be complete while gated off')
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(seen.length, 0, 'gated off must produce zero events, got ' + seen.length)
    },
  )
})

await test('卸掉之后不再计数，且模块导出恢复原函数', async () => {
  const url = await slowUrl()
  const seen = []
  const previous = globalThis[SINK]
  globalThis[SINK] = (e) => seen.push(e)
  const originalGet = http.get
  const dispose = installHttpSensor({ gate: () => true })
  assert.equal(httpSensorInstalled(), true)
  assert.notEqual(http.get, originalGet, 'the module export must be replaced')
  dispose()
  assert.equal(httpSensorInstalled(), false, 'dispose must clear the installed flag')
  assert.equal(http.get, originalGet, 'dispose must put the original back')
  const body = await fetchAll(url)
  assert.equal(body.length, TOTAL)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(seen.length, 0, 'no events after dispose')
  globalThis[SINK] = previous
})

await test('重复装返回同一个 disposer，不会叠两层', async () => {
  const a = installHttpSensor({ gate: () => true })
  const b = installHttpSensor({ gate: () => true })
  assert.equal(a, b, 'installing twice must reuse the live sensor')
  a()
})

await test('没有 sink 时也不报错（只缺消费者，不是错误）', async () => {
  const previous = globalThis[SINK]
  delete globalThis[SINK]
  const url = await slowUrl()
  const dispose = installHttpSensor({ gate: () => true })
  try {
    const body = await fetchAll(url)
    assert.equal(body.length, TOTAL, 'a missing sink must not break the request')
  } finally {
    if (typeof dispose === 'function') dispose()
    globalThis[SINK] = previous
  }
})

await test('取不到 URL 的请求不产生事件，不误伤任何任务', async () => {
  await withSensor(
    () => true,
    async (seen) => {
      // 一个没有 hostname 的 options：urlFromArgs 返回空串。
      const body = await new Promise((resolve) => {
        let settled = false
        const req = http.request({ path: '/x' }, () => {})
        req.on('error', () => {
          if (!settled) {
            settled = true
            resolve(Buffer.alloc(0))
          }
        })
        try {
          req.end()
        } catch {
          /* 已经失败 */
        }
        setTimeout(() => {
          if (!settled) {
            settled = true
            resolve(Buffer.alloc(0))
          }
        }, 300)
      })
      assert.equal(body.length, 0)
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(seen.length, 0, 'an unresolvable URL must not emit events')
    },
  )
})

if (server) server.srv.close()
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
