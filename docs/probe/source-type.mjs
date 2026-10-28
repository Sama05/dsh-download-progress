/**
 * 诊断：对 CJS 模块，`load` 返回的 `source` 到底是什么类型，`String()` 之后是什么。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/source-type.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么这一条决定了 L2 成不成立
 *
 * `sensor/stream.js` 的 `load` 钩子写的是：
 *     return { ...result, source: String(result.source) + WRAPPER }
 *
 * undici 是 **CJS**（`format: 'commonjs'`），它的 `source` 不是字符串而是一个
 * ArrayBufferView（Buffer / Uint8Array）。`String(buffer)` 得到的是
 * `'<Buffer 27 75 73 ...>'` 这种调试字符串，**不是源码** —— 于是被注入的模块
 * 变成一段语法错误的垃圾，或者 Node 直接忽略返回的 source、回落到磁盘原文。
 * 两种情况都表现为「capabilities.stream 报 ok，但一个字节事件都没有」。
 *
 * 这个探针把三件事量出来：
 *   1. source 的真实构造类型
 *   2. `String(source)` 前 60 个字符长什么样
 *   3. 用正确的解码方式（Buffer.from(view).toString('utf8')）拼上包装片段后，
 *      import 回来的 fetch 是不是真的被替换了
 */
import Module from 'node:module'
import { createRequire } from 'node:module'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = new URL('file:///' + undiciPath.replace(/^\/+/, '').replace(/\\/g, '/')).href

console.log('=== 1. shape of the CJS source ===')
let shape = null
{
  const hooks = Module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (url.endsWith('/undici/index.js') && !shape) {
        const s = result.source
        shape = {
          format: result.format,
          ctor: s && s.constructor ? s.constructor.name : typeof s,
          isView: ArrayBuffer.isView(s),
          isBuffer: typeof Buffer !== 'undefined' && Buffer.isBuffer(s),
          byteLength: s && typeof s.byteLength === 'number' ? s.byteLength : null,
          stringifiedHead: String(s).slice(0, 60),
          decodedHead: ArrayBuffer.isView(s) ? Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('utf8').slice(0, 60) : '(not a view)',
        }
      }
      return result
    },
  })
  await import(undiciUrl)
  hooks.deregister()
}
console.log(JSON.stringify(shape, null, 2))

console.log('\n=== 2. does a correct decode + append actually replace fetch? ===')
{
  const MARK = '__DDP_PROBE_WRAPPED__'
  const hooks = Module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (url.endsWith('/undici/index.js') && result && result.format === 'commonjs') {
        const text = ArrayBuffer.isView(result.source)
          ? Buffer.from(result.source.buffer, result.source.byteOffset, result.source.byteLength).toString('utf8')
          : String(result.source)
        // 用最笨的标记证明「注入的代码真的执行了」。
        return {
          format: 'commonjs',
          source: text + '\n;globalThis.' + MARK + ' = true;',
          shortCircuit: true,
        }
      }
      return result
    },
  })
  const mod = await import(undiciUrl + '?probe=2')
  console.log('mark present :', globalThis[MARK] === true)
  console.log('fetch usable :', typeof mod.fetch)
  hooks.deregister()
}

process.exit(0)
