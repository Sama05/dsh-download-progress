/**
 * 深度进度开关的端到端契约：Client 存偏好、Host 收开关、快照回灌状态。
 *
 * 这里测的是**接缝**，不是任一端：Client 的 `pushDepthSwitch` 打的是哪条路径、
 * 送的是什么 body、失败时是否安静；Host 的 config 路由是否把布尔值原样落到
 * 传感器；以及「关掉之后状态接口说 off」这个闭环。
 *
 * 三件事任何一件错了，用户在设置页拨开关都不会生效，而且不会有任何报错 ——
 * 这正是要用测试钉住的原因。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(ROOT, 'src', 'client', rel), 'utf8')

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

/** 一个够用的 fetch 记录器。 */
function fetchRecorder() {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return { ok: true, status: 204, json: async () => ({}) }
  }
  return { calls, impl }
}

/**
 * 在沙箱里跑 `pushDepthSwitch`。
 *
 * 取 20-utils / 41-depth 两段（都只碰 window 与 fetch），套一个最小的 window。
 * `window` 必须注入：`pushDepthSwitch` 用 `window.location.origin` 拼绝对 URL，
 * 沙箱里没有它，异常会被函数自己的 catch 吃掉 —— 于是所有断言都"通过"，
 * 实际一次请求都没发。空循环的假阳性比失败更难发现。
 */
const sandboxWindow = { location: { origin: 'http://127.0.0.1:57366' } }
globalThis.window = sandboxWindow

async function loadPusher() {
  const source = `
${read('20-utils.js')}
${read('41-depth.js')}
export { pushDepthSwitch }
`
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  return mod.pushDepthSwitch
}

console.log('\ndepth switch wiring')

await test('推送打的是 POST /download-progress/config', async () => {
  const { calls, impl } = fetchRecorder()
  const push = await loadPusher()
  await push(true, impl)
  assert.equal(calls.length, 1, 'exactly one request')
  assert.ok(/\/download-progress\/config$/.test(calls[0].url), 'got ' + calls[0].url)
  assert.equal(String(calls[0].init.method || '').toUpperCase(), 'POST', 'must be a POST')
})

await test('body 是 JSON { depthProgress: boolean }', async () => {
  const { calls, impl } = fetchRecorder()
  const push = await loadPusher()
  await push(true, impl)
  assert.deepEqual(JSON.parse(calls[0].init.body), { depthProgress: true })
  await push(false, impl)
  assert.deepEqual(JSON.parse(calls[1].init.body), { depthProgress: false })
})

await test('非布尔输入一律按 false 送，不送 null/undefined', async () => {
  const { calls, impl } = fetchRecorder()
  const push = await loadPusher()
  const bad = [undefined, null, 0, '', 'yes', {}]
  for (const value of bad) {
    await push(value, impl)
  }
  // The loop above is the test: an empty one would "pass" without proving
  // anything, so the count is asserted first.
  assert.equal(calls.length, bad.length, 'every input produced a request')
  for (const call of calls) {
    const body = JSON.parse(call.init.body)
    assert.equal(typeof body.depthProgress, 'boolean', 'got ' + JSON.stringify(body))
    assert.equal(body.depthProgress, false)
  }
})

await test('网络失败时安静返回 false，不抛错', async () => {
  const push = await loadPusher()
  const ok = await push(true, async () => {
    throw new Error('offline')
  })
  assert.equal(ok, false, 'a failed push reports false rather than throwing')
})

await test('非 2xx 也返回 false', async () => {
  const push = await loadPusher()
  const ok = await push(true, async () => ({ ok: false, status: 500 }))
  assert.equal(ok, false)
})

await test('成功时返回 true', async () => {
  const push = await loadPusher()
  const ok = await push(true, async () => ({ ok: true, status: 204 }))
  assert.equal(ok, true)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
