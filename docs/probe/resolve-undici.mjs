/**
 * 从 web-fetch 插件自己的目录去解析 undici，看真实 URL 是什么。
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe/resolve-undici.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * 为什么需要这个：`requestPinned` 在
 * `app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js`
 * 里做 `await import("undici")`，解析基准是**那个文件**，不是插件目录。
 * 我先前在 `docs/probe/` 下解析失败，那只是探针自己的位置不对。
 *
 * 它同时回答：deno/asar 之下的真实 URL 长什么样，是否以 `/undici/index.js` 结尾
 * ——这决定了 `sensor/stream.js` 的匹配条件能不能命中。
 */
import { createRequire } from 'node:module'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'

const line = (label, value) => console.log(label.padEnd(28) + value)

line('base file', HOST_BASE)

// 和 requestPinned 完全一样的解析基准：从那个文件出发。
const requireFromHost = createRequire(HOST_BASE)
try {
  const resolved = requireFromHost.resolve('undici')
  line('require.resolve', resolved)
  line('endsWith suffix', resolved.endsWith('/undici/index.js') ? 'YES — 会命中' : 'NO — 不会命中')
  line('as file url', 'file:///' + resolved.replace(/^\/+/, '').replace(/\\/g, '/'))
} catch (err) {
  line('require.resolve', 'ERR ' + String(err && err.message).slice(0, 120))
}

// ESM 侧：import.meta.resolve 只在模块里可用，这里用 createRequire 的结果即可，
// 因为 undici 是 CJS 包（index.js 里是 module.exports），两条路径解析到同一个文件。

// 再确认那个文件真的可读
import { readFileSync } from 'node:fs'
try {
  const src = readFileSync(requireFromHost.resolve('undici'), 'utf8')
  line('readable', 'yes, ' + src.length + ' bytes')
  line('has module.exports', src.includes('module.exports') ? 'yes' : 'no')
  line('exports.fetch', /module\.exports\.fetch\s*=/.test(src) ? 'yes' : 'no')
} catch (err) {
  line('readable', 'ERR ' + String(err && err.message).slice(0, 120))
}

process.exit(0)
