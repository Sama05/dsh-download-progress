/**
 * 决定性诊断：`Module._cache` 能不能看到 ESM 加载的 CJS 模块？
 *
 * 跑法（插件仓库根目录）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\DeepSeek Harness\DeepSeek Harness.exe' docs/probe\cache-visibility.mjs
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *
 * ## 这一条决定 `streamInstalled()` 的判据是否成立
 *
 * `sensor/stream.js` 的 `proveInjection()` 与 `undiciLoaded()` 都靠
 * `Module._cache`（= `require.cache`）找 undici 条目。上一个探针显示：
 * 即便 `await import(undiciUrl)` 成功、fetch 被包住，`Module._cache` 里
 * **undici main entries = 0**。
 *
 * 若确实如此，那么在活宿主里：
 *   - `proveInjection()` → 永远 false（查不到条目）
 *   - `undiciLoaded()`   → 永远 false（同样查不到）
 *   - `streamInstalled()` = `sawEvent || wrapped || !undiciLoaded()` = **永远 true**
 *
 * 也就是「自证」其实什么都没证，报 ok 依旧是无条件的。真机 bytes=0 而
 * capabilities=ok 正是这个后果。
 *
 * 判据：import 之后立刻查三种视图（Module._cache / require.cache /
 * process.moduleLoadList），看哪个能看见它。
 */
import Module from 'node:module'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const HOST_BASE =
  'D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js'
const requireFromHost = createRequire(HOST_BASE)
const undiciPath = requireFromHost.resolve('undici')
const undiciUrl = pathToFileURL(undiciPath).href

const line = (label, value) => console.log(label.padEnd(34) + value)

function counts() {
  const mc = typeof Module._cache === 'object' && Module._cache ? Module._cache : {}
  const rc = requireFromHost.cache || {}
  let inMc = 0
  let inRc = 0
  for (const k of Object.keys(mc)) if (String(k).replace(/\\/g, '/').endsWith('/undici/index.js')) inMc++
  for (const k of Object.keys(rc)) if (String(k).replace(/\\/g, '/').endsWith('/undici/index.js')) inRc++
  return { inMc, inRc, mcSize: Object.keys(mc).length, rcSize: Object.keys(rc).length }
}

console.log('=== BEFORE import ===')
let c = counts()
line('Module._cache entries', String(c.mcSize))
line('require.cache entries', String(c.rcSize))
line('undici main in _cache', String(c.inMc))
line('undici main in require.cache', String(c.inRc))

console.log('\n=== ESM import ===')
const mod = await import(undiciUrl)
line('import ok, fetch.name', mod.fetch && mod.fetch.name)

console.log('\n=== AFTER import ===')
c = counts()
line('Module._cache entries', String(c.mcSize))
line('require.cache entries', String(c.rcSize))
line('undici main in _cache', String(c.inMc))
line('undici main in require.cache', String(c.inRc))

// CJS require 一次，看是否才写缓存
console.log('\n=== CJS require of the same file ===')
try {
  const viaRequire = requireFromHost(undiciPath)
  line('require ok, fetch.name', viaRequire.fetch && viaRequire.fetch.name)
  line('same object as import?', String(viaRequire === mod))
} catch (err) {
  line('require failed', String(err && err.message).slice(0, 80))
}
c = counts()
line('Module._cache entries', String(c.mcSize))
line('undici main in _cache', String(c.inMc))
line('undici main in require.cache', String(c.inRc))

// 用 Module._cache 找得到吗？
const mc = Module._cache || {}
const hit = Object.keys(mc).filter((k) => String(k).replace(/\\/g, '/').endsWith('/undici/index.js'))
line('keys found in _cache', String(hit.length))
for (const k of hit) {
  const exp = mc[k] && mc[k].exports
  line('  fetch.name', exp && exp.fetch ? exp.fetch.name : '(none)')
}

console.log('\n=== VERDICT ===')
console.log(
  c.inMc === 0
    ? 'Module._cache 看不到 → proveInjection() 永远 false, undiciLoaded() 永远 false,\n' +
        'streamInstalled() 永远 true。自证无效，这是真机 bytes=0 却报 ok 的原因。'
    : 'Module._cache 能看到 → 自证判据成立，问题在别处。',
)
process.exit(0)
