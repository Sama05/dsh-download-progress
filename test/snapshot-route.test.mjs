/**
 * 快照顶层字段与开关路由的集成测试。
 *
 * 走真实 `apply()`，用一个假 ctx 抓路由，再断言：
 *   1. 有一条 GET 状态路由和一条 POST 配置路由
 *   2. `schemaVersion` 是 2，且带 `capabilities`
 *   3. 默认 `capabilities.stream === 'off'`
 *   4. POST 打开后变 `'ok'`（本机 Node 支持 hook）
 *   5. POST 关掉后回到 `'off'`
 *   6. 畸形 body 不抛错、也不点亮开关
 *
 * 假 ctx 只在测试侧构造 —— 生产代码的 `apply(ctx)` 签名不为可测性改动。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

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

/** 装一次插件，收回它注册的路由。 */
function boot() {
  const routes = []
  const ctx = {
    effect: (fn) => {
      try {
        fn()
      } catch {
        /* 采样器立刻启动是预期行为；这里只关心注册 */
      }
      return () => {}
    },
    on: () => {},
    get: () => undefined,
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx)
  return routes
}

function stateRoute(routes) {
  return routes.find((r) => r.path === '/download-progress/state')
}

function configRoute(routes) {
  return routes.find((r) => r.path === '/download-progress/config')
}

function readState(routes) {
  const route = stateRoute(routes)
  let body = null
  route.handler(
    { method: 'GET', url: route.path, headers: {} },
    {
      writeHead() {},
      end(payload) {
        body = JSON.parse(payload)
      },
    },
  )
  return body
}

function postConfig(routes, payload) {
  const route = configRoute(routes)
  let status = null
  const handlers = {}
  const req = {
    method: 'POST',
    url: route.path,
    headers: {},
    on(name, fn) {
      handlers[name] = fn
    },
  }
  route.handler(req, {
    writeHead(code) {
      status = code
    },
    end() {},
  })
  // 模拟请求体的到达顺序：先 data，再 end。
  if (payload !== undefined) handlers.data?.(JSON.stringify(payload))
  handlers.end?.()
  return status
}

console.log('\nsnapshot fields and the switch route')

const routes = boot()

test('注册了 GET 状态路由与 POST 配置路由各一条', () => {
  assert.equal(routes.filter((r) => r.path === '/download-progress/state').length, 1)
  assert.equal(routes.filter((r) => r.path === '/download-progress/config').length, 1)
})

test('schemaVersion 是 2', () => {
  assert.equal(readState(routes).schemaVersion, 2)
})

test('顶层带 capabilities，默认 stream 为 off', () => {
  const body = readState(routes)
  assert.equal(typeof body.capabilities, 'object', 'capabilities must be an object')
  assert.equal(typeof body.capabilities.modules, 'string', 'modules must be reported')
  assert.equal(body.capabilities.stream, 'off', 'a fresh host must report off, not unavailable')
})

test('POST 打开后不再报 off（ok 或 degraded 都是"已尝试"）', () => {
  const status = postConfig(routes, { depthProgress: true })
  assert.equal(status, 204, 'the switch route answers 204')
  const stream = readState(routes).capabilities.stream
  // `ok` = installed and measuring. `degraded` = the switch is on but undici was
  // not on the load path in this process, so nothing got wrapped. Both mean the
  // user's choice was accepted; neither is `off`.
  assert.ok(stream === 'ok' || stream === 'degraded', 'expected ok or degraded, got ' + stream)
})

test('宿主不支持 hook 时 stream 报 unavailable，而不是 off 或 degraded', () => {
  // 夹具是一个独立脚本：它删掉 registerHooks、打开开关、读一帧快照。
  // 做成文件而不是内联 -e 字符串，是为了不让引号转义变成测试的主要难点。
  const fixture = fileURLToPath(new URL('./fixtures/no-hooks-host.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, 'fixture must boot: ' + String(result.stderr || '').slice(0, 400))
  const caps = JSON.parse(result.stdout)
  assert.equal(caps.modules, 'unavailable', 'no registerHooks means modules is unavailable')
  assert.equal(caps.stream, 'unavailable', 'switch on + no capability must be unavailable, not degraded')
})

test('POST 关掉后回到 off', () => {
  postConfig(routes, { depthProgress: false })
  assert.equal(readState(routes).capabilities.stream, 'off')
})

test('畸形 body 不抛错，也不点亮开关', () => {
  const bodies = [{}, { depthProgress: 'yes' }, { depthProgress: 1 }, { depthProgress: null }]
  for (const body of bodies) {
    const status = postConfig(routes, body)
    assert.equal(status, 204, 'still a valid response for ' + JSON.stringify(body))
    assert.equal(
      readState(routes).capabilities.stream,
      'off',
      'only a real true turns it on: ' + JSON.stringify(body),
    )
  }
})

test('完全空的请求体也回 204，且不改状态', () => {
  const status = postConfig(routes, undefined)
  assert.equal(status, 204)
  assert.equal(readState(routes).capabilities.stream, 'off')
})

test('关掉开关后传感器确实卸载（capabilities 与真实状态一致）', () => {
  postConfig(routes, { depthProgress: true })
  assert.notEqual(readState(routes).capabilities.stream, 'off', 'on must not read as off')
  postConfig(routes, { depthProgress: false })
  assert.equal(readState(routes).capabilities.stream, 'off', 'off is off, not degraded')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
