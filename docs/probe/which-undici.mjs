/**
 * 诊断：宿主里到底有几份 undici？`web_fetch` 用的是哪一份？
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe\which-undici.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 为什么问这个
 *
 * 实测结论已经清楚：
 *   - 包装层对 https 完全正常（192 事件 / 2 MB / URL 精确匹配）
 *   - 真机 `web_fetch` 卡片在、`progressSource=stream`、`capabilities=ok`，但 bytes 恒 0
 *
 * 两者唯一的差别是「谁在调 fetch」。如果宿主里存在两份 undici（比如
 * `app.asar/dsh/node_modules` 一份、profile 的 `node_modules` 另一份），
 * 而 `web-fetch-http` 解析到的是**我没包住的那份**，现象就完全对得上：
 * 钩子装成功（后缀匹配命中某一个文件），但实际请求走另一份未注入的模块。
 *
 * 这个探针枚举宿主进程里所有 undici 主入口，逐个报它们的 fetch 名字。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'

const line = (label, value) => console.log(label.padEnd(30) + value)

// 1) 通过 Module._cache / require.cache 枚举所有已加载的 undici 主入口
const cache =
  typeof Module._cache === 'object' && Module._cache ? Module._cache : require.cache || {}
const entries = []
for (const key of Object.keys(cache)) {
  const norm = String(key).replace(/\\/g, '/')
  if (!norm.endsWith('/undici/index.js')) continue
  const exp = cache[key] && cache[key].exports
  entries.push({
    path: key,
    fetchName: exp && exp.fetch ? exp.fetch.name : '(no fetch)',
    wrapped: exp && exp.fetch && exp.fetch.name === 'ddpFetch',
  })
}

line('undici main entries', String(entries.length))
for (const e of entries) {
  console.log('  path      : ' + e.path)
  console.log('  fetch.name: ' + e.fetchName + (e.wrapped ? '   <-- wrapped' : ''))
}

// 2) 从不同基准解析，看指向同一个文件吗
const bases = [
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js',
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/package.json',
]
for (const base of bases) {
  try {
    const r = createRequire(base)
    const p = r.resolve('undici')
    const exp = r.cache[p] && r.cache[p].exports
    line('resolve from ' + base.split('/').slice(-2).join('/'), p)
    console.log('  fetch.name: ' + (exp && exp.fetch ? exp.fetch.name : '(not loaded)'))
  } catch (err) {
    line('resolve from ' + base, 'ERR ' + String(err && err.message).slice(0, 70))
  }
}

// 3) 所有含 undici 的缓存条目里，有没有第二份独立的主入口
const mains = Object.keys(cache).filter((k) =>
  String(k).replace(/\\/g, '/').includes('/undici/'),
)
line('total undici cached files', String(mains.length))

process.exit(0)
