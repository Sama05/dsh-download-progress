/**
 * 把流传感器报来的字节落到卡片上。
 *
 * 任务与事件的对应靠 URL：`beginTask` 已经把 `web_fetch` / 搜索的 URL 记在
 * `task.url` 上，流事件又带着自己的 `url`。两者指同一个资源就是这个任务的进度。
 *
 * ## 为什么不能直接 `!==`
 *
 * 曾经这里写的是 `if (task.url !== url) continue`。真机因此一个事件都收不到：
 *
 *   - `task.url` 是**模型给的原文**（`args.url`）
 *   - 事件的 `url` 是 undici `fetch(input)` 收到的那个值，中间隔着 `web_fetch`
 *     自己的规范化（`new URL(...).href`：统一 scheme/host 大小写、去掉默认端口、
 *     补齐百分号编码…）
 *
 * 两个字符串只要有一个字符不同，严格相等就永远 false —— 卡片在、进度恒 0，
 * 而且没有任何报错。`test/stream-match.test.mjs` 钉住了这条。
 *
 * ## 规范化到什么程度
 *
 * 只抹平**语义等价**的差异（RFC 3986：scheme/host 大小写、默认端口、
 * 百分号编码、hash 片段）。**不动 query 参数顺序**——服务端可以按顺序返回不同
 * 内容，把那两个当成同一个资源会张冠李戴。
 *
 * 规范化失败（非法 URL）时退回原文比较：宁可漏一次，不要把无关字节记到卡上。
 */

import { tasks } from './registry.js'

/** 默认端口表：规范化时把「显式写出默认端口」折成「不写」。 */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }

/**
 * 把 URL 折成一个可比较的规范形式。
 *
 * @param {string} raw
 * @returns {string} 规范化后的字符串；解析失败时返回原始输入
 */
function canonicalUrl(raw) {
  const input = String(raw || '')
  if (!input) return ''
  let u
  try {
    u = new URL(input)
  } catch {
    return input
  }
  // `URL` 已经把 scheme/host 小写、补全百分号编码；还差两件事：
  //   1. 去掉默认端口（`https://a:443/` 与 `https://a/` 是同一个资源）
  //   2. 去掉 hash（不会发到服务端，改它不改变响应）
  const port = DEFAULT_PORTS[u.protocol] === u.port ? '' : u.port
  const auth = u.username
    ? u.username + (u.password ? ':' + u.password : '') + '@'
    : ''
  return `${u.protocol}//${auth}${u.hostname}${port ? ':' + port : ''}${u.pathname}${u.search}`
}

/**
 * 两帧之间至少要有这么长的跨度才更新速度。
 *
 * 同一毫秒里到达的两个 chunk 会让 `delta / span` 除出一个假峰值；宁可保留
 * 上一次的读数，等跨度够了再更新。
 */
const MIN_STREAM_SPEED_SPAN_MS = 50

/**
 * @param {{url: string, bytes: number, total: number, done: boolean}} event
 * @param {number} [at] 事件到达时刻（毫秒）。测试用它造确定的时间跨度；
 *   生产路径不传，取 `Date.now()`。
 */
export function noteStreamBytes(event, at) {
  if (!event || typeof event !== 'object') return
  const raw = String(event.url || '')
  if (!raw) return
  const url = canonicalUrl(raw)
  const bytes = Number(event.bytes) || 0
  const total = Number(event.total) || 0
  const done = event.done === true
  const now = Number.isFinite(at) ? at : Date.now()
  for (const task of tasks.values()) {
    // 没有 url 的任务（安装、包管理器）永远不该被字节事件命中。
    if (!task.url) continue
    if (canonicalUrl(task.url) !== url) continue

    // 速度在这里算，不等 `sample()`。
    //
    // `sample()` 只处理 `kind === 'download'`（它的活是 stat 文件），fetch /
    // search 任务在那里提前 return。真机因此出现过「bytes 已经 10 MB、speed
    // 恒为 0」。流事件自己带着时间与字节数，本来就够算。
    //
    // 用真实跨度而不是固定分母：轮询抖动、事件合并都会让两帧间隔从 4 ms 变到
    // 2 s，除以固定值会算出天文数字。
    const previousBytes = Number(task.bytes) || 0
    const previousAt = Number(task.streamAt) || Number(task.startedAt) || now
    const delta = bytes - previousBytes
    if (delta > 0) {
      const span = now - previousAt
      if (span >= MIN_STREAM_SPEED_SPAN_MS) task.speed = (delta * 1000) / span
    } else if (done) {
      // 结束了就不再谎报在传输：0 是诚实的读数。
      task.speed = 0
    }

    task.bytes = bytes
    if (total > 0) task.total = total
    task.streamAt = now
    // 流观测是活着的：它直接来自正在读的字节，不受 `START_GRACE_MS` 影响。
    // `idleTicks` 与 `lastGrowthAt` 一起维持，"还在收字节" 与 "已经停了"
    // 在 `sweep()` 里靠它判断，所以这里必须同步更新。
    task.idleTicks = 0
    task.lastGrowthAt = now
    if (done) task.streamDone = true
  }
}
