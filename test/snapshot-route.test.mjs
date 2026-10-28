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
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

test('宿主没有 hook 但 http 层可包时，stream 仍是 ok（两条覆盖线互不依赖）', () => {
  // 夹具是一个独立脚本：它删掉 registerHooks、打开开关、读一帧快照。
  // 做成文件而不是内联 -e 字符串，是为了不让引号转义变成测试的主要难点。
  //
  // 这里考的是**两条覆盖线的独立性**：`registerHooks` 只影响 undici 那层；
  // http/https 那层换的是模块导出，任何 Node 都能做。所以在「无 hook」的宿主
  // 上，只要 http 层装上，诚实答案就是 `ok` —— 说 `unavailable` 会变成
  // 「明明能用却说不能用」，比谎报更糟。
  const fixture = fileURLToPath(new URL('./fixtures/no-hooks-host.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, 'fixture must boot: ' + String(result.stderr || '').slice(0, 400))
  const caps = JSON.parse(result.stdout)
  assert.equal(caps.modules, 'unavailable', 'no registerHooks means modules is unavailable')
  assert.equal(
    caps.stream,
    'ok',
    'the http layer does not need registerHooks, so the switch still measures',
  )
})

test('两层都装不上时才报 unavailable', () => {
  // 用子进程把两层的安装都打成失败：删掉 registerHooks（undici 层失去能力），
  // 再把 http/https 的 request/get 设成不可写（http 层 patch 失败）。
  const script = `
    import Module from 'node:module'
    import http from 'node:http'
    import https from 'node:https'
    delete Module.registerHooks
    for (const mod of [http, https]) {
      for (const key of ['request', 'get']) {
        Object.defineProperty(mod, key, { value: mod[key], writable: false, configurable: false })
      }
    }
    const { apply } = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)})
    const routes = []
    apply({
      effect: (fn) => { try { fn() } catch {} ; return () => {} },
      on: () => {},
      get: () => undefined,
      webServer: { register: (r) => (routes.push(r), () => {}) },
    })
    const cfg = routes.find((r) => r.path === '/download-progress/config')
    const hs = {}
    cfg.handler({ on: (n, f) => (hs[n] = f) }, { writeHead() {}, end() {} })
    hs.data?.(JSON.stringify({ depthProgress: true }))
    hs.end?.()
    const state = routes.find((r) => r.path === '/download-progress/state')
    let body = null
    state.handler({ method: 'GET', headers: {} }, { writeHead() {}, end: (p) => { body = JSON.parse(p) } })
    process.stdout.write(JSON.stringify({ caps: body.capabilities, stream: body.stream }))
    process.exit(0)
  `
  const tmp = fileURLToPath(new URL('./fixtures/no-layer-host.mjs', import.meta.url))
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, script, 'utf8')
  const result = spawnSync(process.execPath, [tmp], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, 'fixture must boot: ' + String(result.stderr || '').slice(0, 400))
  const out = JSON.parse(result.stdout)
  assert.equal(out.stream.http, false, 'the http layer must have failed to install')
  assert.equal(
    out.caps.stream,
    'unavailable',
    'no hooks and no patchable http module means the switch cannot work at all',
  )
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
