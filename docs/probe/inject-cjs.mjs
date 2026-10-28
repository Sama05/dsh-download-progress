/**
 * 诊断：`registerHooks` 的 `load` 钩子对 **CJS** 模块注入源码，到底生不生效。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/inject-cjs.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么必须单独跑这一条
 *
 * 上一个探针 `source-type.mjs` 报 `mark present: false`，但那个探针自己有两个
 * bug，不能拿它当结论：
 *   1. 它 import 的 URL 末尾带了 `?probe=2`，而匹配条件写的是
 *      `url.endsWith('/undici/index.js')` —— 加了 query 就不再以它结尾，钩子压根
 *      没进去；
 *   2. 它在第 1 段已经 import 过同一个模块（CJS 缓存按文件路径，不认 query），
 *      第 2 段很可能直接拿到缓存，连 load 都没走。
 *
 * 这个探针把这些都清掉：全新进程、一次 import、无 query、钩子内计数并打日志。
 * 判据是 `mark present` —— 注入的那行 `globalThis.__DDP_MARK__ = true` 有没有执行。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = new URL('file:///' + undiciPath.replace(/^\/+/, '').replace(/\\/g, '/')).href

console.log('target :', undiciUrl)
console.log(' suffix match :', undiciUrl.endsWith('/undici/index.js'))

let hookCalls = 0
let injections = 0

const hooks = Module.registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    // 不带 query —— 和宿主 `await import("undici")` 解析出来的 URL 完全一致。
    if (url.endsWith('/undici/index.js')) {
      hookCalls++
      const raw = result && result.source
      if (raw == null) {
        console.log(' hook entered but source was null/undefined — format:', result && result.format)
        return result
      }
      const text =
        ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
          : String(raw)
      injections++
      console.log(' hook entered, injecting; decoded length =', text.length)
      return {
        format: result.format || 'commonjs',
        source: text + '\n;globalThis.__DDP_MARK__ = (globalThis.__DDP_MARK__||0)+1;',
        // 告诉 Node「我给的 source 是完整的，别再回落读盘」。
        shortCircuit: true,
      }
    }
    return result
  },
})

const mod = await import(undiciUrl)
console.log('')
console.log('hookCalls      :', hookCalls)
console.log('injections     :', injections)
console.log('mark present   :', globalThis.__DDP_MARK__ === 1)
console.log('fetch usable   :', typeof mod.fetch)
console.log('fetch is fn    :', typeof mod.fetch === 'function')

hooks.deregister()
process.exit(0)
