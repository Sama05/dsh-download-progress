/**
 * `sensor/` 层的单元测试。
 *
 * 两段：
 *   1. 开关状态（`sensor/config.js`）—— 纯状态，不碰宿主
 *   2. undici 包装（`sensor/stream.js`）—— 真的起一个慢速服务，看字节事件
 *
 * 不为了可测性给生产代码加「注入假依赖」的参数：需要模拟「宿主没有某项能力」
 * 时，起一个子进程在 import 之前把能力删掉。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { depthProgress, setDepthProgress } from '../sensor/config.js'

const STREAM_URL = new URL('../sensor/stream.js', import.meta.url).href

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  }
}

/** 异步测试版本：等它落定，再判断它有没有抛。 */
async function testAsync(name, fn) {
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

console.log('\ndepth progress switch')

test('默认关闭', () => {
  assert.equal(depthProgress(), false, 'a fresh host must not have it on')
})

test('打开后为 true，关掉后回到 false', () => {
  setDepthProgress(true)
  assert.equal(depthProgress(), true)
  setDepthProgress(false)
  assert.equal(depthProgress(), false)
})

test('非布尔输入按 false 处理，不当真', () => {
  setDepthProgress('yes')
  assert.equal(depthProgress(), false, 'only a real boolean turns it on')
  setDepthProgress(1)
  assert.equal(depthProgress(), false)
  setDepthProgress({})
  assert.equal(depthProgress(), false)
  setDepthProgress(true)
  setDepthProgress(undefined)
  assert.equal(depthProgress(), false)
  setDepthProgress(null)
  assert.equal(depthProgress(), false)
})

/* ------------------------------------------------------------------ *
 * undici 包装
 *
 * 这段测的是设计文档 §4.4 的三条硬约束：源码可改、rewrap 不破坏宿主消费、
 * 卸掉后宿主恢复原样。
 * ------------------------------------------------------------------ */

const CHUNK = 8 * 1024
const TOTAL = 64 * 1024
let slowServer = null
let fakeUndici = null

/** 一个慢速服务：每 chunk 之间停 15ms，保证产生多个字节事件。 */
async function slowUrl() {
  if (slowServer) return slowServer.url
  const srv = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-length': String(TOTAL), 'content-type': 'application/octet-stream' })
    const buf = Buffer.alloc(CHUNK, 7)
    for (let sent = 0; sent < TOTAL; sent += CHUNK) {
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r))
      await new Promise((r) => setTimeout(r, 15))
    }
    res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  slowServer = { srv, url: `http://127.0.0.1:${srv.address().port}/slow.bin` }
  return slowServer.url
}

/**
 * 造一份 `node_modules/undici/index.js`。
 *
 * 为什么不直接用全局 `fetch`：hook 的匹配规则是「被加载的模块 URL 以
 * `/undici/index.js` 结尾」，而全局 `fetch` 是 Node 内置的，不经过任何
 * `node_modules/undici`。要测包装，就得有一份**真的被 import 的** undici 主入口。
 *
 * 造的是最小可用的 shim：把全局 `fetch` / `Response` 转发出去，导出名与真包一致。
 * 这不是给生产代码加测试专用接口 —— 生产代码按路径匹配，测试提供那个路径。
 */
async function undiciUrl() {
  if (fakeUndici) return fakeUndici.url
  const dir = mkdtempSync(join(tmpdir(), 'ddp-undici-'))
  mkdirSync(join(dir, 'node_modules', 'undici'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', 'undici', 'index.js'),
    [
      `'use strict'`,
      `// 最小 undici shim：导出名与真包一致，转发到 Node 内置的实现。`,
      `const realFetch = globalThis.fetch`,
      `const RealResponse = globalThis.Response`,
      `module.exports.fetch = realFetch`,
      `module.exports.Response = RealResponse`,
      `module.exports.Headers = globalThis.Headers`,
      `module.exports.Request = globalThis.Request`,
      '',
    ].join('\n'),
    'utf8',
  )
  fakeUndici = { dir, url: pathToFileURL(join(dir, 'node_modules', 'undici', 'index.js')).href }
  return fakeUndici.url
}

/** 按宿主的方式取 undici：`await import(<undici 主入口>)`。 */
async function importUndici() {
  return import(await undiciUrl())
}

console.log('\nstream sensor')

const { installStreamSensor, streamInstalled } = await import(STREAM_URL)

await testAsync('没有 registerHooks 的宿主上返回 null，不抛错', () => {
  const script = `
    import Module from 'node:module'
    delete Module.registerHooks
    const m = await import(${JSON.stringify(STREAM_URL)})
    const got = m.installStreamSensor({ onBytes: () => {} })
    process.stdout.write(JSON.stringify({ dispose: got === null ? 'null' : typeof got }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, 'must degrade, not throw: ' + String(result.stderr || '').slice(0, 300))
  assert.equal(JSON.parse(result.stdout).dispose, 'null', 'an incapable host gets null')
})

await testAsync('装上后宿主照常拿到全部字节（rewrap 不破坏消费）', async () => {
  const seen = []
  const dispose = installStreamSensor({ onBytes: (e) => seen.push(e) })
  assert.equal(typeof dispose, 'function', 'a capable host must hand back a disposer')
  assert.equal(streamInstalled(), true, 'the sensor reports itself installed')
  try {
    const url = await slowUrl()
    const undici = await importUndici()
    const res = await undici.fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.length, TOTAL, 'the consumer must still get every byte')
    assert.equal(Number(res.headers.get('content-length')), TOTAL, 'headers must survive the rewrap')
    await new Promise((r) => setTimeout(r, 300))
    const mine = seen.filter((e) => e.url === url)
    assert.ok(mine.length >= 2, 'at least two byte events, got ' + mine.length)
    assert.equal(mine[mine.length - 1].bytes, TOTAL, 'the last event must reach the total')
    assert.equal(mine[mine.length - 1].total, TOTAL, 'the total comes from content-length')
    for (let i = 1; i < mine.length; i++) {
      assert.ok(mine[i].bytes >= mine[i - 1].bytes, 'byte count must never step back')
    }
  } finally {
    dispose()
  }
})

await testAsync('卸掉后不再收到事件，且传感器报告未装', async () => {
  const seen = []
  const dispose = installStreamSensor({ onBytes: (e) => seen.push(e) })
  assert.equal(streamInstalled(), true)
  dispose()
  assert.equal(streamInstalled(), false, 'dispose must clear the installed flag')
  const count = seen.length
  const url = await slowUrl()
  const undici = await importUndici()
  const res = await undici.fetch(url)
  await res.arrayBuffer()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(seen.length, count, 'no events after dispose')
})

await testAsync('重复装同一个传感器返回同一个 disposer，不会叠两层', async () => {
  const a = installStreamSensor({ onBytes: () => {} })
  const b = installStreamSensor({ onBytes: () => {} })
  assert.equal(a, b, 'installing twice must reuse the live sensor')
  a()
})

await testAsync('宿主 fetch 连不上时原样抛错，包装层不吞异常', async () => {
  const dispose = installStreamSensor({ onBytes: () => {} })
  try {
    const undici = await importUndici()
    await assert.rejects(
      () => undici.fetch('http://127.0.0.1:1/never'),
      'a connection failure must surface to the caller',
    )
  } finally {
    dispose()
  }
})

await testAsync('没有 onBytes 回调时直接返回 null（没有消费者的传感器没有意义）', async () => {
  assert.equal(installStreamSensor({}), null)
  assert.equal(installStreamSensor(null), null)
})

await testAsync('gate 关着时一个字节事件都不产生，但 body 照样完整', async () => {
  // 这条测的是「钩子常驻不带来开销」这个承诺。钩子必须在插件启动时就装
  // （见 sensor/config.js），所以关着开关时它仍然挂着；如果门控失效，用户的
  // 每个 HTTP 响应都会被多读一遍流。
  let gateOpen = false
  const seen = []
  const dispose = installStreamSensor({
    onBytes: (e) => seen.push(e),
    gate: () => gateOpen,
  })
  assert.equal(typeof dispose, 'function')
  try {
    const url = await slowUrl()
    const undici = await importUndici()

    // 门关着：消费完整 body，一个事件都不该来。
    const res = await undici.fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.length, TOTAL, 'the body must still be complete while gated off')
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(seen.length, 0, 'gated off must produce zero byte events, got ' + seen.length)

    // 开门：同一个包装函数立刻开始记字节。
    gateOpen = true
    const res2 = await undici.fetch(url)
    const buf2 = Buffer.from(await res2.arrayBuffer())
    assert.equal(buf2.length, TOTAL, 'the body must be complete while gated on')
    await new Promise((r) => setTimeout(r, 250))
    assert.ok(seen.length >= 2, 'gated on must produce events, got ' + seen.length)
    assert.equal(seen[seen.length - 1].bytes, TOTAL, 'and must reach the total')
  } finally {
    dispose()
  }
})

if (slowServer) slowServer.srv.close()
if (fakeUndici) rmSync(fakeUndici.dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
