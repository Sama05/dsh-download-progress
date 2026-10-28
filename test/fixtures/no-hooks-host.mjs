/**
 * 测试夹具：一个"宿主不支持 hook"的进程，报告它的 capabilities。
 *
 * 被 `snapshot-route.test.mjs` 用 `spawnSync` 拉起。做成独立文件而不是内联
 * `-e` 字符串，是因为内联版本要把整段脚本塞进模板字符串里转义，一有引号就报
 * `SyntaxError` —— 测试的复杂度不该花在引号上。
 *
 * 它做的事：删掉 `Module.registerHooks`，把开关打开，然后读一帧快照，打印
 * `capabilities`。
 */
import Module from 'node:module'

delete Module.registerHooks

const { apply } = await import('../../index.js')

const routes = []
apply({
  effect: (fn) => {
    try {
      fn()
    } catch {
      /* 采样器立刻启动是预期行为 */
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
})

const config = routes.find((route) => route.path === '/download-progress/config')
const state = routes.find((route) => route.path === '/download-progress/state')

// 先把开关打开：只有"想开却开不了"才该报 unavailable。
const handlers = {}
config.handler(
  {
    on(name, fn) {
      handlers[name] = fn
    },
  },
  { writeHead() {}, end() {} },
)
handlers.data?.(JSON.stringify({ depthProgress: true }))
handlers.end?.()

let body = null
state.handler(
  { method: 'GET', headers: {} },
  {
    writeHead() {},
    end(payload) {
      body = JSON.parse(payload)
    },
  },
)

process.stdout.write(JSON.stringify(body.capabilities))
// `apply()` 启动了采样定时器，进程不会自己退出。
process.exit(0)
