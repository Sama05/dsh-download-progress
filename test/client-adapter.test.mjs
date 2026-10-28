/**
 * Client 侧 adapter 的行为测试。
 *
 * `src/client/**` 是拼接成单个 bundle 的片段，不能直接 import，所以这里把需要
 * 的那几段取出来、套在最小运行环境里跑。测的是 `contract.mjs` 允许读 wire 的
 * adapter：`describe()`。
 *
 * 重点是「为什么没有百分比」这一句：四种 stream 状态必须给出**不同**的说法，
 * 因为它们对用户的含义完全不同 —— 「你可以打开」和「打开也没用」不能混。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(ROOT, 'src', 'client', rel), 'utf8')

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
 * 把片段捏成一个能在 Node 里 import 的模块。
 *
 * 只取 `20-utils`（`clamp` / `secs` / `fmtBytes` / `logOf` 等纯函数）与
 * `70-views`（`describe` 及其辅助）。不含任何碰 `window` / `document` 的片段，
 * 所以能在 Node 里直接跑 —— 这一点也是设计约束：adapter 必须保持纯净。
 */
const SOURCE = `
${read('20-utils.js')}
${read('70-views.js')}
export { describe }
`

const mod = await import('data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64'))
const { describe } = mod

/** 一条 fetch 类的 wire 任务。 */
function fetchTask(over) {
  return {
    kind: 'fetch',
    bytes: 0,
    total: 0,
    speed: 0,
    elapsedMs: 3000,
    progressSource: 'stream',
    label: '',
    log: '',
    phase: '',
    unresolved: false,
    staged: false,
    ...over,
  }
}

console.log('\ndescribe() hints')

test('开着 + 在收字节 + 有 total → 给百分比，无 hint', () => {
  const view = describe(fetchTask({ bytes: 512, total: 1024, speed: 10 }), {
    capabilities: { stream: 'ok' },
  })
  assert.equal(view.percent, 50, 'a measured fetch must get a percentage')
  assert.equal(view.hint, '', 'nothing to explain while it is measuring')
})

test('关着 + fetch → 不给百分比，提示可以打开', () => {
  const view = describe(fetchTask(), { capabilities: { stream: 'off' } })
  assert.equal(view.percent, null)
  assert.ok(/深度进度/.test(view.hint), 'hint must name the switch, got: ' + view.hint)
  assert.ok(/打开/.test(view.hint), 'hint must say it can be turned on')
})

test('开着但宿主不支持 → 说环境不支持，不催用户去开', () => {
  const view = describe(fetchTask(), { capabilities: { stream: 'unavailable' } })
  assert.equal(view.percent, null)
  assert.ok(/不支持/.test(view.hint), 'got: ' + view.hint)
  assert.ok(!/打开/.test(view.hint), 'must not tell the user to flip a switch that cannot work')
})

test('开着但装不上 → 说降级，不说"没开"', () => {
  const view = describe(fetchTask(), { capabilities: { stream: 'degraded' } })
  assert.equal(view.percent, null)
  assert.ok(/降级/.test(view.hint), 'got: ' + view.hint)
  assert.ok(!/打开/.test(view.hint), 'degraded is not off')
})

test('开着 + 还没收到字节 → 说在建立连接，不催用户', () => {
  const view = describe(fetchTask({ bytes: 0, speed: 0 }), { capabilities: { stream: 'ok' } })
  assert.equal(view.percent, null)
  assert.ok(/连接/.test(view.hint), 'got: ' + view.hint)
  assert.ok(!/打开/.test(view.hint))
})

test('磁盘采样的下载没有 total → 完全不提深度进度', () => {
  const view = describe(
    {
      kind: 'download',
      bytes: 100,
      total: 0,
      speed: 10,
      elapsedMs: 1000,
      progressSource: 'file',
      label: 'a.bin',
      log: '',
      phase: '',
      unresolved: false,
      staged: false,
    },
    { capabilities: { stream: 'off' } },
  )
  assert.equal(view.percent, null)
  assert.ok(!/深度进度/.test(view.hint), 'the switch is irrelevant to disk sampling, got: ' + view.hint)
})

test('磁盘采样的下载开了深度进度也照常工作', () => {
  const view = describe(
    {
      kind: 'download',
      bytes: 512,
      total: 1024,
      speed: 10,
      elapsedMs: 1000,
      progressSource: 'file',
      label: 'a.bin',
      log: '',
      phase: '',
      unresolved: false,
      staged: false,
    },
    { capabilities: { stream: 'ok' } },
  )
  assert.equal(view.percent, 50, 'turning the switch on must not affect disk sampling')
})

test('安装类任务（progressSource 为 none）不提深度进度', () => {
  const view = describe(
    {
      kind: 'install',
      bytes: 0,
      total: 0,
      speed: 0,
      elapsedMs: 2000,
      progressSource: 'none',
      label: 'pkg',
      log: '',
      phase: 'installing',
      unresolved: false,
      staged: false,
    },
    { capabilities: { stream: 'off' } },
  )
  assert.ok(!/深度进度/.test(view.hint), 'an install has no byte stream at all, got: ' + view.hint)
})

test('capabilities 缺失（老 Host）当作 off 处理，不抛错', () => {
  const view = describe(fetchTask(), {})
  assert.equal(typeof view.hint, 'string')
  assert.ok(/打开/.test(view.hint), 'an old host reads as "you can turn it on"')
})

test('capabilities 是畸形值时也不抛错', () => {
  for (const bad of [null, { stream: 123 }, { stream: {} }, { stream: 'nonsense' }]) {
    const view = describe(fetchTask(), { capabilities: bad })
    assert.equal(typeof view.hint, 'string', 'hint must stay a string for ' + JSON.stringify(bad))
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
