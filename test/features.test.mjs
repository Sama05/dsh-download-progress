/**
 * `detect/features.js` 的单元测试。
 *
 * 唯一的验收点：探测函数在任何环境下都只能返回布尔值，绝不抛错。
 * 它跑在插件加载路径上，抛一次就等于整个插件装不上。
 *
 * 如何测「宿主没有这个能力」：生产代码不接受「注入一个假 Module」的参数
 * （那是为测试改设计），所以起一个子进程，在它加载被测模块之前把
 * `Module.registerHooks` 删掉 / 换成一个抛错函数。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { probeModules } from '../detect/features.js'

const FEATURES_URL = new URL('../detect/features.js', import.meta.url).href

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
 * 在一个干净的子进程里改掉 `Module`，再 import 被测模块。
 *
 * @param {string} preamble 在 import 之前执行的代码
 * @returns {{hooks: boolean}}
 */
function probeInChild(preamble) {
  const script = `
    import Module from 'node:module'
    ${preamble}
    const { probeModules } = await import(${JSON.stringify(FEATURES_URL)})
    process.stdout.write(JSON.stringify(probeModules()))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(
    result.status,
    0,
    'child must exit cleanly; stderr=' + String(result.stderr || '').slice(0, 300),
  )
  return JSON.parse(result.stdout)
}

console.log('\nprobeModules')

test('返回 { hooks: boolean }，值域只有 true/false', () => {
  const got = probeModules()
  assert.equal(typeof got, 'object', 'must be an object')
  assert.equal(typeof got.hooks, 'boolean', 'hooks must be a boolean')
})

test('本机 Node 有 registerHooks 时 hooks 为 true', () => {
  // Node ≥ 22.15 有。这条把"探测真的在看 Module"钉住，
  // 而不是无论环境如何都返回 true。
  const [major, minor] = process.versions.node.split('.').map(Number)
  const capable = major > 22 || (major === 22 && minor >= 15)
  if (capable) assert.equal(probeModules().hooks, true, 'Node ' + process.versions.node + ' 应有 registerHooks')
})

test('重复调用返回同一个缓存对象（不重复装 hook）', () => {
  const a = probeModules()
  const b = probeModules()
  assert.equal(a, b, 'the probe must be memoised, not re-install hooks on every call')
})

test('宿主没有 registerHooks 时返回 false，不抛错', () => {
  const got = probeInChild('delete Module.registerHooks')
  assert.equal(got.hooks, false, 'a host without registerHooks must probe as false')
})

test('registerHooks 抛错时返回 false，不把异常抛给调用方', () => {
  const got = probeInChild("Module.registerHooks = () => { throw new Error('hostile host') }")
  assert.equal(got.hooks, false, 'a throw inside the host must degrade, not propagate')
})

test('registerHooks 返回的对象没有 deregister 时返回 false', () => {
  // 装了却卸不掉，比没有更糟：宿主的模块状态被改写了却没法恢复。
  const got = probeInChild('Module.registerHooks = () => ({})')
  assert.equal(got.hooks, false, 'no deregister means not usable')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
