/**
 * 深进度：包装 Node 的 `http` / `https` 模块，旁听响应字节。
 *
 * ## 为什么需要这一层（与 `stream.js` 并列，不是替代）
 *
 * Node 里「不用 undici」的 HTTP 客户端最终都落在 `http.request` / `https.request`：
 *
 *   - `dsh-free-search` 的 `fs-quality-fetch`（`lib/fetch_provider.js:201`
 *     调 `transport.request`，transport 就是 `node:https`）
 *   - `node-fetch` v2、`axios`(node adapter)、`got`、`request`
 *   - 任何手写 `https.get`
 *
 * undici 是**独立实现**，不走 `http.request`。所以两个都要包：
 *
 *   stream.js  包 undici.fetch   → 宿主内置 web_fetch
 *   https.js   包 http/https.*   → 接管插件、第三方客户端
 *
 * 这一层比 undici 那层**稳得多**：`http.request` 是 Node 的公开稳定 API，
 * 不需要 hook 源码、不受 CJS 缓存影响、装在任何时刻都立即生效 —— 也就是说
 * 它没有 `stream.js` 那个「必须抢在首次加载前」的时序陷阱。
 *
 * ## 只旁听，不消费
 *
 * 计数用 `res.on('data')` 旁听，不改 pipe、不读 `res.read()`、不换流。
 * 消费方（`fs-quality-fetch` 会 `res.pipe(gunzip)`）拿到的是原样的流。
 *
 * 用 `prependListener('response')` 而不是 `on`：调用方通常把自己的
 * `'response'` 回调传进 `https.request(url, cb)`，那个回调在 `ClientRequest`
 * 构造时就注册了。普通 `on` 会排到它后面，那时流已经 flowing、开头几个
 * chunk 可能已经发出去 —— 漏掉的就是最开始的字节。
 */

import http from 'node:http'
import https from 'node:https'

/** 事件回传槽：与 `stream.js` 共用同一条管道，上层不必区分来源。 */
const SINK = Symbol.for('dsh-download-progress.stream-sink')

/** 开关槽：关着时连旁听都不挂。 */
const GATE = Symbol.for('dsh-download-progress.stream-gate')

/** 每个模块只该被包一次；重复调用返回同一个 disposer。 */
let active = null

/**
 * 从 `https.request` 的实参里取 URL。
 *
 * 三种调用形态都真实存在：
 *   request(url)                     string
 *   request(url)                     URL 对象
 *   request({hostname, port, path})  options 对象（`fs-quality-fetch` 用这种）
 *
 * 取不到就返回空串：空 URL 的事件会被 `noteStreamBytes` 丢弃，不会误记到
 * 别的任务上。
 *
 * @param {unknown[]} args
 * @returns {string}
 */
function urlFromArgs(args) {
  try {
    const first = args[0]
    if (typeof first === 'string') return new URL(first).href
    if (first instanceof URL) return first.href
    if (first && typeof first === 'object') {
      const proto = String(first.protocol || 'https:')
      const host = String(first.hostname || first.host || '')
      if (!host) return ''
      const port = first.port ? ':' + first.port : ''
      const path = String(first.path || first.pathname || '/')
      return `${proto}//${host}${port}${path}`
    }
  } catch {
    /* 非法 URL：当作取不到 */
  }
  return ''
}

/**
 * 给一个 `ClientRequest` 挂上字节旁听。
 *
 * 任何异常都吞掉：包装层绝不能成为宿主 HTTP 的错误来源。这不是防御性编程
 * 的洁癖 —— `fs-quality-fetch` 的请求失败会让 `web_fetch` 直接报错，用户看到
 * 的就是「插件把网页抓取弄坏了」。
 *
 * @param {import('node:http').ClientRequest} req
 * @param {string} url
 */
function watch(req, url) {
  try {
    // prepend：插到调用方自己的 'response' 回调之前（见文件头）。
    req.prependListener('response', (res) => {
      try {
        if (typeof globalThis[GATE] === 'function' && !globalThis[GATE]()) return
        const total = Number(res.headers && res.headers['content-length']) || 0
        let bytes = 0
        const emit = (done) => {
          try {
            const sink = globalThis[SINK]
            if (typeof sink !== 'function') return
            sink({ url, bytes, total, done })
          } catch {
            /* 消费者抛错不能回到流里 */
          }
        }
        res.on('data', (chunk) => {
          bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          emit(false)
        })
        res.on('end', () => emit(true))
        // 连接中途断掉也算结束，否则卡片会一直等到 quiet 窗口超时。
        res.on('error', () => emit(true))
      } catch {
        /* 旁听失败不影响请求本身 */
      }
    })
  } catch {
    /* 同上 */
  }
}

/**
 * 把 `mod.request` / `mod.get` 换成一版会计数的。
 *
 * `get` 不能靠「内部会调 request」白拿：Node 的 `https.get` 引用的是模块
 * **作用域内**的 `request` 函数，不是 `exports.request`，所以换 exports 不影响它。
 * 必须单独换。实现与 Node 原版一致：发请求、立刻 end、把 req 交回去。
 *
 * @param {{request: Function, get: Function}} mod
 * @returns {() => void} 恢复原函数的 disposer
 */
function patchModule(mod) {
  const realRequest = mod.request
  const realGet = mod.get

  const wrappedRequest = function (a, b, c) {
    const req = realRequest.apply(this, arguments)
    try {
      watch(req, urlFromArgs(arguments.length === 0 ? [] : [a, b]))
    } catch {
      /* 挂不上就不计数，请求照发 */
    }
    return req
  }

  const wrappedGet = function () {
    // 和 Node 自身实现一致：request(...) 之后立刻 end()，把 req 交回去。
    const req = wrappedRequest.apply(this, arguments)
    try {
      req.end()
    } catch {
      /* 已经 end 过 */
    }
    return req
  }

  mod.request = wrappedRequest
  mod.get = wrappedGet

  return () => {
    try {
      mod.request = realRequest
      mod.get = realGet
    } catch {
      /* 模块被冻结：没有可恢复的 */
    }
  }
}

/**
 * 装上 http/https 字节旁听。
 *
 * 与 `installStreamSensor` 的契约一致：可重复调用（幂等）、返回 disposer、
 * 装不上返回 `null`。它不需要 `probeModules()` 那样的能力探测 —— 这两次赋值
 * 在任何 Node 上都能做。
 *
 * @param {{gate?: () => boolean}} [options]
 * @returns {null | (() => void)}
 */
export function installHttpSensor(options) {
  if (active) return active.dispose

  const gate = options && typeof options.gate === 'function' ? options.gate : () => true
  const hadGate = Object.prototype.hasOwnProperty.call(globalThis, GATE)
  const previousGate = globalThis[GATE]
  try {
    globalThis[GATE] = gate
  } catch {
    /* 全局对象被冻结：门控退化成恒真，仍可计数 */
  }

  let restoreHttp = null
  let restoreHttps = null
  try {
    restoreHttp = patchModule(http)
    restoreHttps = patchModule(https)
  } catch {
    // 一半成功也要退干净，否则宿主会带着一个半包的 http 跑下去。
    try {
      if (restoreHttp) restoreHttp()
    } catch {
      /* 已经恢复 */
    }
    try {
      if (restoreHttps) restoreHttps()
    } catch {
      /* 已经恢复 */
    }
    restoreGate(hadGate, previousGate)
    return null
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      if (restoreHttps) restoreHttps()
    } catch {
      /* 已经恢复 */
    }
    try {
      if (restoreHttp) restoreHttp()
    } catch {
      /* 已经恢复 */
    }
    restoreGate(hadGate, previousGate)
    active = null
  }
  active = { dispose }
  return dispose
}

/**
 * http/https 层是否装着。
 *
 * 这一层没有「注入是否发生」的问题（赋值即生效），所以只需看 disposer 在不在。
 *
 * @returns {boolean}
 */
export function httpSensorInstalled() {
  return active !== null
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
