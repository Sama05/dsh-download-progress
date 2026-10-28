/**
 * `noteStreamBytes` 的 URL 匹配测试。
 *
 * ## 这条测试要钉住什么
 *
 * 2026-10-29 真机：`web_fetch` 卡片在、`progressSource: stream`、
 * `capabilities.stream: ok`，但 `bytes` 恒 0。探针用**同一个常量**做 target，
 * 事件 192 个；真机一个都没有。差别只在「谁生成这个 URL 字符串」：
 *
 *   - 探针：`const TARGET = 'https://…?bytes=2000000'`，两端是同一个字面量
 *   - 真机：`task.url = args.url`（模型给的原文），事件 url 来自
 *     `undici.fetch(input)` 的 `input`，中间隔着 `web_fetch` 自己的
 *     URL 规范化（`new URL(...).href` 会把 `?a=1` 之外的东西也统一：
 *     大写 scheme/host、去掉默认端口、query 编码、末尾斜杠…）
 *
 * 严格 `!==` 在这种场景下是错的：它要求两个字符串**逐字节相同**，而实际
 * 只需要「指向同一个资源」。规范化后比较才是正确判据。
 */
import assert from 'node:assert/strict'

import { noteStreamBytes } from '../state/stream.js'
import { tasks } from '../state/registry.js'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    // 每个用例从干净的任务表开始，避免互相污染。
    tasks.clear()
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  } finally {
    tasks.clear()
  }
}

/** 造一条最小可用的任务，只要 `url` 与进度字段。 */
function seed(id, url) {
  const task = {
    id,
    kind: 'fetch',
    url,
    bytes: 0,
    total: 0,
    speed: 0,
    elapsedMs: 0,
    progressSource: 'stream',
    idleTicks: 0,
    lastGrowthAt: 0,
    streamDone: false,
    targets: [],
  }
  tasks.set(id, task)
  return task
}

console.log('\nnoteStreamBytes URL matching')

test('完全相同的 URL 能匹配（基线）', () => {
  const t = seed('a', 'https://example.com/f.bin')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 100, total: 200, done: false })
  assert.equal(t.bytes, 100)
  assert.equal(t.total, 200)
})

test('scheme / host 大小写不同仍然匹配', () => {
  const t = seed('a', 'HTTPS://Example.COM/f.bin')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 50, total: 100, done: false })
  assert.equal(t.bytes, 50, 'URL host is case-insensitive per RFC 3986')
})

test('默认端口省略与否仍然匹配', () => {
  const t = seed('a', 'https://example.com:443/f.bin')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 10, total: 20, done: false })
  assert.equal(t.bytes, 10, 'an explicit default port and an omitted one are the same origin')
})

test('hash 片段不同仍然匹配（hash 不发到服务端）', () => {
  const t = seed('a', 'https://example.com/f.bin#section')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 7, total: 14, done: false })
  assert.equal(t.bytes, 7)
})

test('已经百分号编码的路径与未编码的写法匹配', () => {
  const t = seed('a', 'https://example.com/a b.bin')
  noteStreamBytes({ url: 'https://example.com/a%20b.bin', bytes: 3, total: 6, done: false })
  assert.equal(t.bytes, 3)
})

test('query 参数顺序不同时不匹配（不是同一个资源）', () => {
  const t = seed('a', 'https://example.com/f?b=2&a=1')
  noteStreamBytes({ url: 'https://example.com/f?a=1&b=2', bytes: 9, total: 9, done: false })
  assert.equal(t.bytes, 0, 'query order can change the response; do not treat them as equal')
})

test('不同路径不匹配', () => {
  const t = seed('a', 'https://example.com/a.bin')
  noteStreamBytes({ url: 'https://example.com/b.bin', bytes: 9, total: 9, done: false })
  assert.equal(t.bytes, 0)
})

test('空 url 的事件被丢弃，不误伤任何任务', () => {
  const t = seed('a', '')
  noteStreamBytes({ url: '', bytes: 9, total: 9, done: false })
  assert.equal(t.bytes, 0, 'a task with no url must never absorb unrelated bytes')
})

test('完全没有 url 的任务不会被任何事件命中', () => {
  const t = seed('a', 'https://example.com/f.bin')
  t.url = ''
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 9, total: 9, done: false })
  assert.equal(t.bytes, 0, 'install / pkg tasks have no url and must stay untouched')
})

test('done 事件写下 streamDone', () => {
  const t = seed('a', 'https://example.com/f.bin')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 100, total: 100, done: true })
  assert.equal(t.streamDone, true)
})

test('字节数与 total 单调推进，done 之前不会回退', () => {
  const t = seed('a', 'https://example.com/f.bin')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 10, total: 100, done: false })
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 70, total: 100, done: false })
  assert.equal(t.bytes, 70)
  assert.equal(t.total, 100)
})

test('速度由流事件自身算出来，不等磁盘采样', () => {
  // 真机实测：`web_fetch` 的卡片 bytes 已经 10 MB，但 `speed` 恒为 0。
  // 因为 `sample()` 只处理 `kind === 'download'`，fetch 任务提前 return ——
  // 而速度原来只在 `sample()` 里算。流事件自己有时间和字节数，应当自己算。
  const t = seed('a', 'https://example.com/f.bin')
  const start = Date.now()
  // 三帧，跨度约 600ms，字节 0 → 300k → 600k
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 0, total: 1e6, done: false }, start)
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 300_000, total: 1e6, done: false }, start + 300)
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 600_000, total: 1e6, done: false }, start + 600)
  assert.ok(t.speed > 0, 'a stream-measured task must report a rate, got ' + t.speed)
  // 600k / 0.6s = 1 MB/s，允许 ±50% 的定时抖动。
  assert.ok(t.speed > 500_000 && t.speed < 1_500_000, 'expected ~1 MB/s, got ' + Math.round(t.speed))
})

test('漏掉很多帧之后速度不会被算成天文数字', () => {
  // 一次延迟很长的轮询会让「跨度」变得很大、字节增量也很大，两者相除仍然
  // 合理；但如果只按字节增量除以一个很小的固定分母，就会爆表。这里钉住
  // 「用真实跨度」这一点。
  const t = seed('a', 'https://example.com/f.bin')
  const start = Date.now()
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 0, total: 1e9, done: false }, start)
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 2_000_000, total: 1e9, done: false }, start + 2000)
  assert.ok(t.speed > 500_000 && t.speed < 1_500_000, 'expected ~1 MB/s over 2s, got ' + Math.round(t.speed))
})

test('done 事件把 streamDone 置位，卡片才能退场', () => {
  const t = seed('a', 'https://example.com/f.bin')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 100, total: 100, done: false })
  assert.equal(t.streamDone, false, 'not finished yet')
  noteStreamBytes({ url: 'https://example.com/f.bin', bytes: 100, total: 100, done: true })
  assert.equal(t.streamDone, true, 'the body ended')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
