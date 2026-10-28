/**
 * 运行时能力探测：这一版宿主能不能装模块 hook？
 *
 * 挂在插件加载路径上，所以它唯一的契约是「永远返回布尔值，绝不抛错」。
 * 判据是 `Module.registerHooks`（Node ≥ 22.15）**同时**具备 `deregister`：
 * 只有能卸掉才算可用 —— 一条装了卸不掉的 hook 会把宿主留在被改写的状态里，
 * 那比没有进度更糟。
 *
 * 探测方式是"装一个空的再立刻卸掉"，不是查版本号：版本号无法表达
 * `--no-experimental-*` 之类的启动参数、也无法表达宿主自己是否已经装过
 * 冲突的 hook，而真装一次能。
 */

import Module from 'node:module'

/** 探测结果只算一次：它装过一次 hook，重复探测没有意义。 */
let cached = null

/**
 * @returns {{hooks: boolean}}
 */
export function probeModules() {
  if (cached) return cached
  let hooks = false
  try {
    if (Module && typeof Module.registerHooks === 'function') {
      const installed = Module.registerHooks({
        // 透传，不改变任何解析结果：这次装的目的是探测，不是拦截。
        resolve: (specifier, context, nextResolve) => nextResolve(specifier, context),
        load: (url, context, nextLoad) => nextLoad(url, context),
      })
      if (installed && typeof installed.deregister === 'function') {
        installed.deregister()
        hooks = true
      }
    }
  } catch {
    /* 老 Node、被 --no-experimental 关掉、或者宿主自己的 hook 打架：都是"不可用" */
    hooks = false
  }
  cached = { hooks }
  return cached
}
