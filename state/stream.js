/**
 * 把流传感器报来的字节落到卡片上。
 *
 * 任务与事件的对应靠 URL：`beginTask` 已经把 `web_fetch` / 搜索的 URL 记在
 * `task.url` 上，流事件又带着自己的 `url`。两者相等就是这个任务的进度。
 *
 * 不相等的一律忽略 —— 一次 `web_fetch` 期间宿主自己还在发别的请求
 * （客户端轮询状态接口、遥测、插件市场检查），按「最近一条」匹配会把那些字节
 * 记到用户看得见的卡片上，卡片就会在用户没下载任何东西的时候自己动。
 */

import { tasks } from './registry.js'

/**
 * @param {{url: string, bytes: number, total: number, done: boolean}} event
 */
export function noteStreamBytes(event) {
  if (!event || typeof event !== 'object') return
  const url = String(event.url || '')
  if (!url) return
  const bytes = Number(event.bytes) || 0
  const total = Number(event.total) || 0
  const done = event.done === true
  for (const task of tasks.values()) {
    if (task.url !== url) continue
    task.bytes = bytes
    if (total > 0) task.total = total
    // 流观测是活着的：它直接来自正在读的字节，不受 `START_GRACE_MS` 影响。
    // `idleTicks` 与 `lastGrowthAt` 一起维持，"还在收字节" 与 "已经停了"
    // 在 `sweep()` 里靠它判断，所以这里必须同步更新。
    task.idleTicks = 0
    task.lastGrowthAt = Date.now()
    if (done) task.streamDone = true
  }
}
