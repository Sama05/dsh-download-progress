/**
 * 真机缺陷的回归测试：**undici 已经被加载过**之后，传感器必须能自证是否真的装上。
 *
 * ## 这条测试存在的理由
 *
 * 2026-10-29 真机实测到：`capabilities.stream = "ok"`，`web_fetch` 卡片也出了，
 * 但 `bytes: 0`，一个字节事件都没有。四步探针定位到根因：
 *
 *   - `Module.registerHooks` 注册成功 → `streamInstalled()` 返回 true
 *   - 但 CJS 缓存命中时 `load` 钩子**根本不触发**（late-hook.mjs: hits=0）
 *   - 宿主启动时早已加载过 undici（require.cache 里 108 条 undici 条目）
 *   - ⇒ 注入从未发生，`fetch` 还是原函数
 *
 * 所以「钩子注册成功」不等于「注入成功」。这条测试要求传感器在**装完之后自证**：
 * 拿宿主那份 undici 的 exports，看 `fetch` 是不是自己的包装函数。不是就说没装上。
 *
 * RED：当前 `installStreamSensor` 只看 `registerHooks` 是否返回对象，返回 true，
 * 这条测试会失败。GREEN：加自证。
 *
 * 测试用子进程而不是同进程：CJS 缓存是进程级、不可重置的。要造出「已加载」
 * 这个前置状态，最干净的办法是起一个新进程先 import 再装传感器。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  }
}

/**
 * 造一个临时包目录，里面有一份 `undici/index.js`（转发到全局 fetch）。
 *
 * 用它而不是宿主的真 undici：测试不该依赖某个安装路径。匹配规则是按后缀，
 * 所以这份和宿主那份等价。
 */
function makeFakeUndici() {
  const dir = mkdtempSync(join(tmpdir(), 'ddp-late-'))
  mkdirSync(join(dir, 'node_modules', 'undici'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', 'undici', 'index.js'),
    [
      `'use strict'`,
      `const realFetch = globalThis.fetch`,
      `module.exports.fetch = realFetch`,
      `module.exports.Response = globalThis.Response`,
      `module.exports.Headers = globalThis.Headers`,
      '',
    ].join('\n'),
    'utf8',
  )
  return dir
}

/**
 * 在子进程里：先 import（模拟宿主启动时已加载），再装传感器，报出结果。
 *
 * @param {string} scenario 'late' 先加载后装 | 'early' 先装后加载
 * @param {string} fakeDir 假 undici 包目录
 */
function runScenario(scenario, fakeDir) {
  const script = `
import { pathToFileURL } from 'node:url'
import { installStreamSensor, streamInstalled } from ${JSON.stringify(pathToFileURL(join(ROOT, 'sensor', 'stream.js')).href)}

const undiciUrl = pathToFileURL(${JSON.stringify(join(fakeDir, 'node_modules', 'undici', 'index.js').replace(/\\/g, '/'))}).href
if (${JSON.stringify(scenario)} === 'late') {
  // 宿主真实顺序：undici 早就加载过了。
  await import(undiciUrl)
  const dispose = installStreamSensor({ onBytes: () => {} })
  const mod = await import(undiciUrl)
  const wrapped = mod.fetch && mod.fetch.name === 'ddpFetch'
  console.log(JSON.stringify({
    installed: streamInstalled(),
    disposeType: typeof dispose,
    wrapped,
  }))
} else {
  const dispose = installStreamSensor({ onBytes: () => {} })
  const mod = await import(undiciUrl)
  const wrapped = mod.fetch && mod.fetch.name === 'ddpFetch'
  console.log(JSON.stringify({
    installed: streamInstalled(),
    disposeType: typeof dispose,
    wrapped,
  }))
}
process.exit(0)
`
  const tmp = join(fakeDir, 'runner.mjs')
  writeFileSync(tmp, script, 'utf8')
  const res = spawnSync(process.execPath, [tmp], { encoding: 'utf8', timeout: 30_000 })
  if (res.status !== 0) {
    throw new Error('child failed: ' + String(res.stderr || '').slice(0, 500))
  }
  return JSON.parse(res.stdout.trim().split('\n').pop())
}

console.log('\nstream sensor self-proof (the bug found on the live host)')

const fakeDir = makeFakeUndici()
try {
  test('首次加载前就装：注入生效，fetch 是我们的包装函数', () => {
    const r = runScenario('early', fakeDir)
    assert.equal(r.wrapped, true, 'import via a fresh module graph must see the wrapper')
    assert.equal(r.installed, true)
    assert.equal(r.disposeType, 'function')
  })

  test('undici 已加载后才装：必须自证失败，而不是谎报 ok', () => {
    const r = runScenario('late', fakeDir)
    // 这是真机那一刻的状态：CJS 缓存里有 undici，load 钩子不会再来。
    assert.equal(r.wrapped, false, 'the cached module cannot be re-wrapped by a load hook')
    // 关键断言：没装上就不能说装上了。旧代码这里报 true，正是谎报的来源。
    assert.equal(
      r.installed,
      false,
      'streamInstalled() must report the truth, not "the hook object exists"',
    )
    // 装不上时返回的 disposal 可以是 null —— 调用方据此把状态报成 degraded。
    assert.ok(
      r.disposeType === 'object' || r.disposeType === 'function',
      'a failed install returns null or a no-op, got ' + r.disposeType,
    )
  })
} finally {
  rmSync(fakeDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
