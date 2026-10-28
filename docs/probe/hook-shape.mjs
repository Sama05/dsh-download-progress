/**
 * 诊断：`Module.registerHooks` 的 `load` 钩子在宿主真实的 undici import 上
 * 到底收到什么 —— URL 形式、format、source 是否为空。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/hook-shape.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 要回答的三个问题
 *
 * 1. `load` 收到的 url 用正斜杠还是反斜杠？
 *    —— 线上匹配写的是 `url.endsWith('/undici/index.js')`，只有正斜杠才命中。
 * 2. undici 是 CJS 包（`module.exports.fetch = ...`），ESM 侧 import 它时
 *    `nextLoad()` 返回的 `source` 是不是 `null`？
 *    —— 线上代码写的是 `if (result && result.source)`，source 为 null 就整个跳过，
 *    包装永远装不上，而 `capabilities.stream` 仍然报 `ok`（因为 hook 本身注册成功了）。
 *    这是「报 ok 却没字节」最可能的成因。
 * 3. 从宿主 base 出发 import 时，钩子有没有真的被调用？
 */
import Module from 'node:module'
import { createRequire } from 'node:module'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'

const seen = []
const hooks = Module.registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.includes('undici')) {
      seen.push({
        url,
        format: result && result.format,
        sourceType: result && result.source === null ? 'null' : typeof (result && result.source),
        sourceLen: result && result.source ? String(result.source).length : 0,
      })
    }
    return result
  },
})

const requireFromHost = createRequire(HOST_BASE)

// 关键：和 requestPinned 一样，用 **那个文件** 作解析基准。
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = new URL('file:///' + undiciPath.replace(/^\/+/, '').replace(/\\/g, '/')).href

console.log('resolved path :', undiciPath)
console.log('as file url   :', undiciUrl)
console.log('endsWith(/undici/index.js) :', undiciUrl.endsWith('/undici/index.js'))
console.log('')

const mod = await import(undiciUrl)
console.log('import ok, has fetch:', typeof mod.fetch)
console.log('')
console.log('load hook saw', seen.length, 'undici loads:')
for (const row of seen) {
  console.log('  url      :', row.url)
  console.log('  format   :', row.format)
  console.log('  source   :', row.sourceType, '(' + row.sourceLen + ' chars)')
  console.log('')
}

hooks.deregister()
process.exit(0)
