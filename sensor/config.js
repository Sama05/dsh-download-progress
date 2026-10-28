/**
 * 深度进度开关的 Host 侧状态。
 *
 * ## 为什么这个开关不能"即时生效"
 *
 * 开关控制的是「包装函数要不要记字节」，但**包装本身必须在插件启动时就装上**
 * （`index.js` 的 `apply()` 里），因为：
 *
 *   - 钩子靠 `Module.registerHooks` 的 `load` 钩子改写 undici 源码；
 *   - undici 是 CJS 包，**缓存命中时 `load` 钩子根本不触发**（实测：已加载后
 *     再注册，hits = 0）；
 *   - 宿主启动时早就 import 过它了（`require.cache` 里 108 条 undici 条目）。
 *
 * 所以「等用户打开开关再装」这条路的结局是：钩子注册成功、`capabilities.stream`
 * 报 ok、一个字节都拿不到。这个坑真机踩过，`docs/probe/late-hook.mjs` 有证据。
 *
 * 结论：钩子常驻，开关只决定 `noteStreamBytes` 收不收事件。关着时包装函数原样
 * 透传（不建流、不计数），代价是一次函数调用。
 *
 * ## 为什么"需重启"这件事要说出来
 *
 * 用户拨开关的直觉期待是"立刻生效"。这条做不到：钩子已经装好，但**已经加载过的
 * undici** 无法被追认包装。所以 UI 上必须明说「改动需要重启应用生效」，否则
 * 用户拨完发现没变化，会认为功能坏了 —— 那是比不提供功能更糟的体验。
 *
 * 唯一的真相源仍是 Client 的 localStorage：Host 不落盘，每次插件挂载时由
 * Client 回灌一次。
 *
 * 严格只认 `true`：路由的 body 来自网络，任何 truthy 值都不该打开一个会读
 * 宿主所有 HTTP 响应的计数器。
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
