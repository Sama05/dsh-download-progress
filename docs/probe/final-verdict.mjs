/**
 * 决定性探针：注入源码里的 `module.exports.fetch = wrapper` 能不能穿过 ESM 那层。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe\final-verdict.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 这不是又一次试错，这是把修法钉死
 *
 * 已知：
 *   - `load` 钩子对 CJS **首次加载**注入有效（inject-cjs: mark present=true）
 *   - CJS 缓存命中时 `load` 钩子**不触发**（late-hook: hits=0）
 *   - 真机上 `capabilities.stream=ok` 但 `bytes=0` ⇒ 钩子注册成功但注入没发生
 *
 * 还没证明的、决定修法的那一条：
 *   宿主 `requestPinned` 写的是 `const { Agent, fetch } = await import("undici")`。
 *   如果注入发生在首次加载，那个 `fetch` 是包装后的函数，还是 ESM 层提前拍下的
 *   旧快照？只有前者成立，包装才有意义。
 *
 * 判据：注入后 `(await import(url)).fetch.name === 'ddpFetch'`。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = new URL('file:///' + undiciPath.replace(/^\/+/, '').replace(/\\/g, '/')).href

const WRAPPER = `
;(function () {
  try {
    var M = module.exports
    var real = M.fetch
    if (typeof real !== 'function') return
    var wrapped = function ddpFetch() { return real.apply(this, arguments) }
    wrapped.__ddpWrapped = true
    M.fetch = wrapped
  } catch (e) {}
})()
`

let injected = 0
const hooks = Module.registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/undici/index.js')) return result
    const raw = result && result.source
    if (raw == null) return result
    const text = ArrayBuffer.isView(raw)
      ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
      : String(raw)
    injected++
    return { format: result.format || 'commonjs', source: text + WRAPPER, shortCircuit: true }
  },
})

// 首次加载（无 query，与宿主解析结果同一 URL）。
const mod = await import(undiciUrl)

console.log('injected              :', injected)
console.log('mod.fetch.name        :', mod.fetch && mod.fetch.name)
console.log('mod.fetch.__ddpWrapped:', mod.fetch && mod.fetch.__ddpWrapped === true)
console.log('module.exports.fetch  :', (() => {
  const c = requireFromHost.cache
  for (const k of Object.keys(c)) {
    if (k.replace(/\\/g, '/').endsWith('/undici/index.js')) {
      const e = c[k].exports
      return e && e.fetch ? e.fetch.name + ' / wrapped=' + (e.fetch.__ddpWrapped === true) : '(none)'
    }
  }
  return '(no cache entry)'
})())

console.log('')
console.log(
  mod.fetch && mod.fetch.__ddpWrapped === true
    ? 'VERDICT: WORKS — 首次加载注入能穿透到 import 的 named export。修法 = 抢在 undici 首次加载前装钩子 + 自证。'
    : 'VERDICT: DOES NOT WORK — ESM snapshot 挡住了 exports 替换，需要换手段。',
)

hooks.deregister()
process.exit(0)
