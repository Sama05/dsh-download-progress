/**
 * 诊断：宿主里 `web_fetch` 到底走哪条 fetch，传感器的 load 钩子有没有命中。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/why-no-bytes.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * 它按顺序回答四个问题：
 *   1. 宿主里 `import('undici')` 解析到哪个文件？
 *   2. 那个 URL 结尾是不是 `/undici/index.js`？——这是 stream.js 的唯一匹配条件
 *   3. load 钩子在这次 import 上有没有真的跑起来？
 *   4. 手动造一个 Response 流，sink 收不收得到事件？
 */
import Module from 'node:module'

const line = (label, value) => console.log(label.padEnd(26) + value)

line('node', process.version)
line('electron', process.versions.electron || '(not electron)')
line('registerHooks', typeof Module.registerHooks)

// 观测钩子：只记录被加载的 URL，不修改任何东西。
const loaded = []
const hooks = Module.registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('undici')) loaded.push(url)
    return nextLoad(url, context)
  },
})

line('hooks installed', hooks && typeof hooks.deregister === 'function' ? 'yes' : 'no')

// 1) 宿主自己的解析结果
let resolved = '(failed)'
try {
  resolved = import.meta.resolve('undici')
} catch (err) {
  resolved = 'ERR ' + String(err && err.message).slice(0, 80)
}
line('import.meta.resolve', resolved)
line('endsWith suffix', resolved.endsWith('/undici/index.js') ? 'YES' : 'NO  <-- 这就是原因')

// 2) 真去 import，看钩子记录到什么
let imported = '(failed)'
try {
  const mod = await import('undici')
  imported = 'ok, exports: ' + Object.keys(mod).slice(0, 8).join(',')
} catch (err) {
  imported = 'ERR ' + String(err && err.message).slice(0, 80)
}
line('import("undici")', imported)
line('hook-loads seen', String(loaded.length))
for (const url of loaded.slice(0, 6)) console.log('    ' + url)

// 3) 宿主有没有全局 fetch，它和 undici 的是不是同一个
line('globalThis.fetch', typeof globalThis.fetch)
try {
  const mod = await import('undici')
  line('undici.fetch===global', mod.fetch === globalThis.fetch ? 'same function' : 'DIFFERENT')
} catch {
  /* 上面已经报过 */
}

hooks.deregister()
console.log('\ndone')
process.exit(0)
