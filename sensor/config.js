/**
 * 深度进度开关的 Host 侧状态。
 *
 * 唯一的真相源是 Client 的 localStorage：Host 不落盘，每次插件挂载时由
 * Client 回灌一次。这样「用户关掉后重启应用」不会留一个偷偷开着的 hook，
 * 「用户开着却重启了插件」也能在一个 round trip 内恢复。
 *
 * 严格只认 `true`：路由的 body 来自网络，任何 truthy 值都不该点亮一条会
 * 改写宿主模块的 hook。
 */

let on = false

/**
 * @param {unknown} next
 */
export function setDepthProgress(next) {
  on = next === true
}

/**
 * @returns {boolean}
 */
export function depthProgress() {
  return on
}
