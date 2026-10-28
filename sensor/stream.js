/**
 * 深度进度：包装宿主内置 undici 的 `fetch`，把响应体读成可计数的流。
 *
 * ## 为什么是 hook 而不是 dispatcher
 *
 * `diagnostics_channel` 的 `undici:request:*` 只报「开始/结束」，不报中间字节；
 * 想拿逐字节进度只能包住 `fetch` 的返回值。宿主的 `web_fetch` 用
 * `await import("undici")` 取函数，而那份 undici 是 app.asar 里的**真实文件模块**
 * （不是 `node:` 内置），它的源码可以被 `Module.registerHooks` 的 `load` 钩子改写，
 * 并且实测 CJS `require` 与 ESM `import` 拿到的是同一个函数对象 —— 所以包一次够。
 *
 * ## 唯一安全的包装方式：重包，不改原 body
 *
 * 实测（设计文档 §4.4）：改 `res.body` 或 `res.body.tee()` 后替换，都会让宿主
 * 自己的 `res.arrayBuffer()` 报 `Body is unusable: Body has already been read`，
 * 也就是插件会弄坏宿主的每一个 HTTP 请求。只有 `new Response(stream, {...})`
 * 返回一个新对象是干净的：宿主消费新对象，原对象没人碰。
 *
 * ## 装不上的三种情况，都降级为 null
 *
 *   1. 没有 `Module.registerHooks`（Node < 22.15）
 *   2. 找不到 undici（宿主的打包方式变了）
 *   3. 没有 `onBytes` 回调（没有消费者，装了也没有意义）
 */

import Module from 'node:module'
import { probeModules } from '../detect.js'

/**
 * 哪份 undici 值得改写。
 *
 * 按路径尾巴匹配，不按精确路径，也不自己 `resolve('undici')`：
 * 宿主的 `web_fetch` 用的是 `await import("undici")`，那次解析发生在**宿主自己
 * 的模块图**里（app.asar 的 node_modules），从插件所在目录解析是找不到的。
 * 唯一可靠的判据是「被加载的模块 URL 是不是某处 undici 的主入口」。
 *
 * `@fastify/undici` 之类的包名也以 `undici` 结尾，所以后缀带着 `/`：
 * `/undici/index.js` 匹配 `.../node_modules/undici/index.js`，不匹配
 * `.../node_modules/undici-types/index.d.ts`（扩展名不同）。
 */
const UNDICI_SUFFIX = '/undici/index.js'

/**
 * 事件回传槽的名字。
 *
 * 包装片段跑在被加载的 undici 模块作用域里，拿不到本模块的闭包，所以只能
 * 通过一个全局槽把字节回调交过去。用 `Symbol.for` 而不是字符串，避免和宿主
 * 自己的全局变量撞名，也避免被枚举到。
 */
const SINK = Symbol.for('dsh-download-progress.stream-sink')

/**
 * 注入到 undici 源码末尾的包装片段。
 *
 * 写成字符串是因为它要成为被 require 的模块的一部分 —— 这是 hook 的全部意义：
 * 在**那个模块自己的**作用域里替换它导出的 `fetch`，而不是在外部猜它的导出形状。
 *
 * 三个必须：
 *   - 用 `new Response(...)` 重包，不改原 body（见文件头）。
 *   - 任何异常都 `return res`，绝不让包装层成为宿主 HTTP 的错误来源。
 *   - 通过全局 Symbol 槽回传事件，因为片段跑在另一个模块作用域里。
 */
const WRAPPER = `
;(function () {
  try {
    var M = module.exports
    var realFetch = M.fetch
    var RealResponse = M.Response || globalThis.Response
    if (typeof realFetch !== 'function' || typeof RealResponse !== 'function') return
    M.fetch = async function ddpFetch(input, init) {
      var res = await realFetch.apply(this, arguments)
      try {
        var sink = globalThis[Symbol.for('dsh-download-progress.stream-sink')]
        if (typeof sink !== 'function' || !res || !res.body) return res
        var url = typeof input === 'string' ? input : (input && input.url) || ''
        var total = Number(res.headers.get('content-length')) || 0
        var reader = res.body.getReader()
        var bytes = 0
        var stream = new ReadableStream({
          async pull(controller) {
            var step = await reader.read()
            if (step.done) {
              try { sink({ url: url, bytes: bytes, total: total, done: true }) } catch (e) {}
              controller.close()
              return
            }
            bytes += step.value.byteLength
            try { sink({ url: url, bytes: bytes, total: total, done: false }) } catch (e) {}
            controller.enqueue(step.value)
          },
          cancel(reason) { return reader.cancel(reason) },
        })
        return new RealResponse(stream, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
      } catch (e) {
        return res
      }
    }
  } catch (e) {}
})()
`

/** 每个进程只该有一条 hook；重复调用返回同一个 disposer。 */
let active = null

/**
 * 装上深度进度传感器。
 *
 * @param {{onBytes?: (event: {url: string, bytes: number, total: number, done: boolean}) => void}} options
 * @returns {null | (() => void)} 装不上返回 null；否则返回幂等的卸装函数
 */
export function installStreamSensor(options) {
  if (active) return active.dispose

  const onBytes = options && typeof options.onBytes === 'function' ? options.onBytes : null
  if (!onBytes) return null

  try {
    if (!probeModules().hooks) return null
  } catch {
    return null
  }

  // 事件槽：包装片段跑在被加载的 undici 模块作用域里，只能通过全局把字节
  // 交给这里。消费者抛错不能回到流里，否则一次 UI 异常会中断一个下载。
  const sink = (event) => {
    if (!event || typeof event !== 'object') return
    try {
      onBytes({
        url: String(event.url || ''),
        bytes: Number(event.bytes) || 0,
        total: Number(event.total) || 0,
        done: event.done === true,
      })
    } catch {
      /* 消费者抛错不能回到流里 */
    }
  }
  const hadSink = Object.prototype.hasOwnProperty.call(globalThis, SINK)
  const previousSink = globalThis[SINK]
  globalThis[SINK] = sink

  let hooks = null
  try {
    hooks = Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(specifier, context)
      },
      load(url, context, nextLoad) {
        const result = nextLoad(url, context)
        // 只改 undici 主入口，别的模块原样放行 —— 这条 hook 全局生效，
        // 每一行多余的工作都会摊到宿主的每次 import 上。
        if (url.endsWith(UNDICI_SUFFIX) && result && result.source) {
          return { ...result, source: String(result.source) + WRAPPER }
        }
        return result
      },
    })
  } catch {
    restoreSink(hadSink, previousSink)
    return null
  }
  if (!hooks || typeof hooks.deregister !== 'function') {
    restoreSink(hadSink, previousSink)
    return null
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      hooks.deregister()
    } catch {
      /* 已经卸掉 */
    }
    restoreSink(hadSink, previousSink)
    active = null
  }
  active = { dispose }
  return dispose
}

/**
 * 传感器是否真的装上了。
 *
 * `capabilities()` 用它区分 `ok`（在跑）与 `degraded`（想开但装不上）。
 *
 * @returns {boolean}
 */
export function streamInstalled() {
  return active !== null
}

/**
 * @param {boolean} had 装之前全局槽是否存在
 * @param {unknown} previous 装之前的原值
 */
function restoreSink(had, previous) {
  try {
    if (had) globalThis[SINK] = previous
    else delete globalThis[SINK]
  } catch {
    /* 全局对象被冻结：没有可恢复的东西 */
  }
}
