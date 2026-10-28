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
 * 开关槽：包装片段问「现在要不要记字节」。
 *
 * 为什么单独一个槽而不是把门控塞进 `SINK`：门控必须发生在**建流之前**。
 * 如果只在 sink 里判断，`getReader()` 和 `ReadableStream` 都已经造好了，
 * 开关关着时每个宿主 HTTP 响应仍然多走一遍流管道 —— 那是真实开销，
 * 不是一个布尔检查。
 */
const GATE = Symbol.for('dsh-download-progress.stream-gate')

/**
 * 注入到 undici 源码末尾的包装片段。
 *
 * 写成字符串是因为它要成为被 require 的模块的一部分 —— 这是 hook 的全部意义：
 * 在**那个模块自己的**作用域里替换它导出的 `fetch`，而不是在外部猜它的导出形状。
 *
 * 四个必须：
 *   - 用 `new Response(...)` 重包，不改原 body（见文件头）。
 *   - 任何异常都 `return res`，绝不让包装层成为宿主 HTTP 的错误来源。
 *   - 通过全局 Symbol 槽回传事件，因为片段跑在另一个模块作用域里。
 *   - 开关关着时**原样返回 res**，不建流、不读一个字节。钩子常驻是必须的
 *     （见 sensor/config.js 的注释），但常驻不等于有开销。
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
        // 槽有三种状态：函数（记字节）、假值（开关关着）、不存在（没装）。
        // 关着时一个字节都不该多读 —— 直接交回原响应。
        var sink = globalThis[Symbol.for('dsh-download-progress.stream-sink')]
        if (typeof sink !== 'function' || !res || !res.body) return res
        // 门控在建流之前：关着就原样交回，不 getReader、不造 ReadableStream。
        var gate = globalThis[Symbol.for('dsh-download-progress.stream-gate')]
        try { if (typeof gate === 'function' && !gate()) return res } catch (e) { return res }
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
 * @param {{
 *   onBytes?: (event: {url: string, bytes: number, total: number, done: boolean}) => void,
 *   gate?: () => boolean,
 * }} options
 * @returns {null | (() => void)} 装不上返回 null；否则返回幂等的卸装函数
 */
export function installStreamSensor(options) {
  if (active) return active.dispose

  const onBytes = options && typeof options.onBytes === 'function' ? options.onBytes : null
  if (!onBytes) return null

  // `gate` 让开关关着时包装层也原样透传。
  //
  // 钩子必须在插件启动时就装（原因见 sensor/config.js），但「常驻」不该等于
  // 「一直在读字节」。门关着时把槽设成假值，包装片段看到非函数就立刻 return res
  // —— 不建流、不 getReader、一个字节都不多读。
  const gate = options && typeof options.gate === 'function' ? options.gate : () => true

  try {
    if (!probeModules().hooks) return null
  } catch {
    return null
  }

  // 事件槽：包装片段跑在被加载的 undici 模块作用域里，只能通过全局把字节
  // 交给这里。消费者抛错不能回到流里，否则一次 UI 异常会中断一个下载。
  const sink = (event) => {
    if (!event || typeof event !== 'object') return
    // 收到事件本身就是最硬的证据：包装确实在工作。记下来，能力上报据此直接
    // 报 ok，不必再依赖缓存内省。
    if (active) active.sawEvent = true
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
  // 槽本身是一个函数，它只把事件转给 sink —— 但**门关着时它仍然会被调用**。
  // 所以真正的门槛放在包装片段里：它先看槽是不是函数，是函数才建流。为了让
  // 「门关着」在片段那边表现为假值，这里传一个会自己缩回去的门控函数。
  //
  // 简化：门控放在 sink 里不够（那时流已经建好了），所以改成在片段里查一个
  // 独立的布尔槽。见 GATE。
  const hadSink = Object.prototype.hasOwnProperty.call(globalThis, SINK)
  const previousSink = globalThis[SINK]
  const hadGate = Object.prototype.hasOwnProperty.call(globalThis, GATE)
  const previousGate = globalThis[GATE]
  globalThis[SINK] = sink
  globalThis[GATE] = gate

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
          return { ...result, source: decodeSource(result.source) + WRAPPER, shortCircuit: true }
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

  // 自证：钩子注册成功 ≠ 注入成功。
  //
  // undici 是 CJS 包，CJS 缓存命中时 `load` 钩子**根本不触发**（实测：
  // 已加载后再注册钩子，hits = 0）。宿主启动时早就 import 过它了，所以用户
  // 打开开关时，钩子虽然注册成功、`fetch` 却从未被替换 —— 卡片照样出，一个
  // 字节事件都不会来。真机上就是这样：`capabilities.stream = ok` 而 `bytes = 0`。
  //
  // 判据不能只看注册结果，也不能在安装这一刻一锤定音：
  //   - undici 已加载（宿主常态）⇒ 立刻就能查缓存，不是我们的函数就是没装上；
  //   - undici 还没加载 ⇒ 此刻缓存是空的，查不到不代表失败，钩子会在它被加载
  //     时注入。这种情况要留到「它真的加载之后」再判。
  //
  // 所以 `streamInstalled()` 是一个**持续判断**，不是一次性的开关。

  const disposed = { value: false }
  const dispose = () => {
    if (disposed.value) return
    disposed.value = true
    try {
      hooks.deregister()
    } catch {
      /* 已经卸掉 */
    }
    restoreSink(hadSink, previousSink)
    restoreGate(hadGate, previousGate)
    active = null
  }
  active = { dispose, sawEvent: false, wrapped: () => proveInjection() }
  return dispose
}

/**
 * 传感器是否真的装上了（能拿到字节）。
 *
 * 三个条件任一成立即算装上：
 *   1. 宿主那份 undici 的 `fetch` 已经是我们的包装函数
 *   2. 已经真的收到过字节事件（最硬的证据）
 *   3. 钩子还挂在宿主上，且 undici 尚未加载（等它加载就会注入）
 *
 * 条件 3 是必要的：插件启动时装钩子、undici 稍后才加载，这个窗口里既查不到
 * 包装也还没有事件，但它确实会生效。把它判成失败，会让正常路径误报降级。
 *
 * @returns {boolean}
 */
export function streamInstalled() {
  if (active === null) return false
  if (active.sawEvent) return true
  if (active.wrapped()) return true
  return !undiciLoaded()
}

/**
 * 把 `load` 钩子拿到的 `source` 变成字符串。
 *
 * CJS 模块的 `source` 是 **Buffer**，不是字符串：`String(buffer)` 得到的是
 * `'<Buffer 27 75 73 ...>'` 这种调试字符��，不是源码。直接拼包装片段会得到一段
 * 语法垃圾。必须按字节解码。
 *
 * @param {unknown} source
 * @returns {string}
 */
function decodeSource(source) {
  if (typeof source === 'string') return source
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString('utf8')
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  }
  return String(source)
}

/**
 * 宿主那份 undici 的 `fetch` 现在是我们的包装函数吗？
 *
 * 判据是函数名 `ddpFetch`（写死在 `WRAPPER` 里），不依赖缓存对象的具体形状：
 * 有的宿主用 `require.cache`，有的用别的加载器，名字匹配对两者都成立。
 *
 * @returns {boolean}
 */
function proveInjection() {
  try {
    const cached =
      typeof Module._cache === 'object' && Module._cache ? Module._cache : require.cache
    for (const key of Object.keys(cached || {})) {
      if (!String(key).replace(/\\/g, '/').endsWith(UNDICI_SUFFIX)) continue
      const exports = cached[key] && cached[key].exports
      if (exports && typeof exports.fetch === 'function' && exports.fetch.name === 'ddpFetch') {
        return true
      }
    }
  } catch {
    /* 拿不到缓存就是无法自证，按失败处理 */
  }
  return false
}

/**
 * 宿主已经加载过 undici 了吗？
 *
 * 「加载过但没被我们包住」= 注入永久错过了（CJS 缓存不会失效），这是真正的
 * 降级。区分这一条与「还没加载」，是 `streamInstalled()` 不误报的关键。
 *
 * @returns {boolean}
 */
function undiciLoaded() {
  try {
    const cached =
      typeof Module._cache === 'object' && Module._cache ? Module._cache : require.cache
    for (const key of Object.keys(cached || {})) {
      if (String(key).replace(/\\/g, '/').endsWith(UNDICI_SUFFIX)) return true
    }
  } catch {
    /* 拿不到缓存就当作已加载：宁可报降级，不要谎报 ok */
    return true
  }
  return false
}

/**
 * 传感器内部的三个分项，供诊断。
 *
 * `capabilities.stream` 只有 ok / degraded 两个值，回答「能不能用」；真机出问题时
 * 还需要知道**为什么**：没收到事件？注入没发生？还是 undici 压根还没加载？
 * 这三个值把 `streamInstalled()` 的判断依据摊开，不必再靠外部探针猜。
 *
 * @returns {{active: boolean, sawEvent: boolean, wrapped: boolean, loaded: boolean}}
 */
export function streamDiagnostics() {
  if (active === null) {
    return { active: false, sawEvent: false, wrapped: false, loaded: undiciLoaded() }
  }
  return {
    active: true,
    sawEvent: active.sawEvent === true,
    wrapped: proveInjection(),
    loaded: undiciLoaded(),
  }
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

/**
 * @param {boolean} had
 * @param {unknown} previous
 */
function restoreGate(had, previous) {
  try {
    if (had) globalThis[GATE] = previous
    else delete globalThis[GATE]
  } catch {
    /* 全局对象被冻结：没有可恢复的东西 */
  }
}
