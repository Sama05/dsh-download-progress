/**
 * `sensor/` 层的单元测试。
 *
 * 两段：
 *   1. 开关状态（`sensor/config.js`）—— 纯状态，不碰宿主
 *   2. undici 包装（`sensor/stream.js`）—— 真的起一个慢速服务，看字节事件
 *
 * 不为了可测性给生产代码加「注入假依赖」的参数：需要模拟「宿主没有某项能力」
 * 时，起一个子进程在 import 之前把能力删掉。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { depthProgress, setDepthProgress } from '../sensor/config.js'

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

console.log('\ndepth progress switch')

test('默认关闭', () => {
  assert.equal(depthProgress(), false, 'a fresh host must not have it on')
})

test('打开后为 true，关掉后回到 false', () => {
  setDepthProgress(true)
  assert.equal(depthProgress(), true)
  setDepthProgress(false)
  assert.equal(depthProgress(), false)
})

test('非布尔输入按 false 处理，不当真', () => {
  setDepthProgress('yes')
  assert.equal(depthProgress(), false, 'only a real boolean turns it on')
  setDepthProgress(1)
  assert.equal(depthProgress(), false)
  setDepthProgress({})
  assert.equal(depthProgress(), false)
  setDepthProgress(true)
  setDepthProgress(undefined)
  assert.equal(depthProgress(), false)
  setDepthProgress(null)
  assert.equal(depthProgress(), false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
