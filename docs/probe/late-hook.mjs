/**
 * 诊断：**在 undici 已经被 import 过之后**再注册 load 钩子，还管用吗？
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/late-hook.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 这一条要证明什么
 *
 * 真实宿主启动时会先 import 一堆东西（插件市场、更新检查、mnemon embedding…），
 * 其中任何一处都可能在用户打开开关**之前**就把 undici 加载了。CJS 模块有缓存，
 * 命中缓存时 **不会走 load 钩子** —— 于是：
 *
 *   - `Module.registerHooks()` 成功 → `streamInstalled()` 返回 true
 *   - `capabilities.stream` 报 `ok`
 *   - 但 `fetch` 从来没被替换，一个字节事件都不会来
 *
 * 这正是真机实测到的现象（`bytes: 0`，`progressSource: stream`）。
 * 如果这个探针证明「late hook 不生效」，那么 `stream.js` 的「报 ok」判据就是错的：
 * 它把「钩子注册成功」当成了「注入成功」。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = new URL('file:///' + undiciPath.replace(/^\/+/, '').replace(/\\/g, '/')).href

console.log('=== A. import FIRST, register hook AFTER (模拟宿主真实顺序) ===')
{
  const before = await import(undiciUrl)
  console.log('  first import ok, fetch is fn :', typeof before.fetch === 'function')

  let hits = 0
  const hooks = Module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (url.endsWith('/undici/index.js')) {
        hits++
        const raw = result && result.source
        const text = ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
          : String(raw)
        return {
          format: result.format || 'commonjs',
          source: text + '\n;globalThis.__LATE_MARK__ = true;',
          shortCircuit: true,
        }
      }
      return result
    },
  })

  // 再 import 一次：CJS 缓存命中，预期钩子不再触发。
  const after = await import(undiciUrl)
  hooks.deregister()

  console.log('  hook hits on re-import :', hits)
  console.log('  mark present           :', globalThis.__LATE_MARK__ === true)
  console.log('  conclusion             :', hits === 0 ? 'LATE HOOK IS USELESS — 缓存命中，注入不发生' : 'hook still fired')
}

console.log('')
console.log('=== B. 绕过缓存：直接改 CJS 的 exports 对象 ===')
{
  // CJS 模块的 exports 是 require.cache 里的同一个对象。拿到它就能直接替换 fetch，
  // 完全不需要 load 钩子、也不受「何时加载」影响。
  const cached = requireFromHost.cache
  const keys = Object.keys(cached).filter((k) => k.replace(/\\/g, '/').endsWith('/undici/index.js'))
  console.log('  require.cache hits :', keys.length)
  for (const k of keys) console.log('    ' + k)

  if (keys.length > 0) {
    const exp = cached[keys[0]].exports
    const original = exp.fetch
    exp.fetch = function probeFetch() {
      globalThis.__EXPORTS_MARK__ = true
      return original.apply(this, arguments)
    }
    const mod = await import(undiciUrl)
    console.log('  exports patched survives import :', mod.fetch === exp.fetch ? 'YES' : 'no')
    console.log('  patched fn is ours              :', mod.fetch.name === 'probeFetch')
  } else {
    console.log('  (undici not in require.cache — 说明它是被 ESM 侧加载的，见 C)')
  }
}

console.log('')
console.log('=== C. ESM 侧加载时，CJS 是否仍进 require.cache ===')
{
  const cached = requireFromHost.cache
  const anyUndici = Object.keys(cached).filter((k) => k.includes('undici'))
  console.log('  total undici entries in require.cache :', anyUndici.length)
}

process.exit(0)
