# 深度进度（L2+ undici 流观测）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给插件加一层可开关的「深度进度」—— 通过包装宿主内置 undici 的 `fetch` 拿到 web_fetch / 搜索的逐字节进度；默认关闭，开关由用户在设置页控制；开关状态与「这条为什么没进度」都要在 UI 上说清楚。

**Architecture:** 新增 `sensor/` 层（不依赖 `state/`，只产事件），`index.js` 作为接线层把事件转给 `state/`。开关走一条新的 `POST /download-progress/config` 路由，Client 是开关的唯一真相源（localStorage），每次挂载时回灌给 Host。快照新增 `capabilities` 与每任务的 `progressSource`，Client 的 adapter 据此生成「为什么没有百分比」的提示。

**Tech Stack:** Node ESM（Host）、单文件浏览器 bundle（Client，由 `scripts/build-client.mjs` 拼接）、`node:module` 的 `registerHooks`（Node ≥ 22.15）、无第三方依赖、无测试框架（`node:assert/strict`）。

**Spec:** `docs/superpowers/specs/2026-10-29-transfer-capture-design.md`（§4.4 的 rewrap 硬约束、§4.5 的开关设计是本次实现的依据）

## Global Constraints

- Node `>=18`（package.json `engines`），但 L2+ 依赖 `Module.registerHooks`（≥22.15）⇒ **必须探测后降级**，不能让老 Node 加载失败。
- `schemaVersion` 从 `1` 升到 `2`（CONTRACT.md「删字段/改语义才升版本」，`capabilities` 是新的运行时状态契约，按 spec §7.3 升版）。
- Host 侧零第三方依赖；不 `require` 宿主内部包（只 `import('node:module')` 这样的内置）。
- **L2+ 必须默认关闭**，且关闭时 `capabilities.stream === 'off'`（不是 `'unavailable'`）。
- **禁止改 `res.body`**，只能用 `new Response(stream, {...})` 重包 —— spec §4.4，改原 body 会让宿主报 `Body is unusable`。
- 所有 Host 侧异常路径必须 `return next()`；所有探测函数在畸形输入下返回 `false`，绝不抛错。
- `architecture.mjs` 是机器校验的层边界，新增层必须同步登记，不允许静默豁免。
- 客户端视图（`Card` / `Overlay` / `InlineBar` / `SettingsPage`）**只读 view-model**，wire 字段只能在 adapter 里读（`contract.mjs` 会拦住）。

## Review Focus

以下是 spec 没写、但真实使用会遇到的输入，每个都由某个 task 的测试钉住：

1. **用户开了开关，但这个下载方式本来就拿不到进度** —— 卡片必须写明原因（「此下载方式不提供字节进度」），不能空白或用不确定条假装在等。
2. **hook 装上后宿主某个 fetch 抛错** —— 必须返回原 `res`，绝不让插件弄坏宿主的 HTTP。
3. **开关关闭后 hook 没卸干净** —— 关掉后宿主行为必须与从未开过完全一致。
4. **L2+ 与 web_fetch 的响应体消费冲突** —— 宿主调 `res.arrayBuffer()` 必须仍然可用（这是 rewrap 的存在理由）。
5. **老 Node（无 `registerHooks`）** —— 插件照常加载，`capabilities.stream` 为 `'unavailable'`，设置页开关置灰并说明原因。

---

## 文件结构

```
dsh-download-progress/
├─ index.js                     改：接线 stream 传感器 + config 路由
├─ CONTRACT.md                  改：新字段 + 新路由 + schemaVersion 2
├─ state/
│  ├─ snapshot.js               改：capabilities + progressSource
│  ├─ begin.js                  改：plan.kind → progressSource
│  └─ stream.js                 新：把 stream 事件落到 task 上
├─ detect/
│  └─ features.js               新：探测 Module.registerHooks
├─ sensor/
│  ├─ stream.js                 新：装/卸 undici fetch 包装
│  └─ config.js                 新：Host 侧的开关状态（内存）
├─ architecture.mjs             改：ALLOWED 加 sensor 层
├─ src/client/
│  ├─ 30-settings.js            改：depthProgress 设置项
│  ├─ 60-data.js                改：frame 保留 capabilities
│  ├─ 70-views.js               改：ctx 加 progressSource/streamState，产出 hint
│  ├─ 90-overlay.js             改：把 capabilities 传到 Card
│  ├─ 95-settings-page.js       改：开关行
│  └─ 99-plugin.js              改：挂载时 POST 开关给 Host
└─ test/
   ├─ features.test.mjs         新
   ├─ stream-sensor.test.mjs    新
   └─ contract-fields.test.mjs  新
```

---

## Task 1: 契约先行 —— CONTRACT.md 与快照字段

**Files:**
- Modify: `CONTRACT.md:38-58`（字段表）、`CONTRACT.md:24-36`（路由与版本规则）
- Modify: `state/snapshot.js:105-134`（`snapshot()` 字面量）
- Modify: `state/registry.js:86`（`BUILD_TAG`）
- Test: `contract.mjs`（现成，会失败）

**Interfaces:**
- Produces: 快照顶层 `capabilities: { modules: string, stream: string }`；每个 task 新增 `progressSource: 'file' | 'stream' | 'none'`。后续 task 6/7/8 依赖这两个名字。

- [ ] **Step 1: 改 CONTRACT.md（先立契约）**

在 `## 路由` 段落下加：

```markdown
`GET /download-progress/state` → 200，`cache-control: no-store`

另有一条写路由，只用于开关，不参与轮询：

`POST /download-progress/config`，body `{"depthProgress": boolean}` → 204。
Client 在设置变更时以及每次挂载时各 POST 一次；Host 只在内存里记住，不落盘
（localStorage 是开关的唯一真相源）。
```

`schemaVersion` 那节改成：

```markdown
- **加字段不升版本。** Client 忽略它不认识的字段，所以新字段可以独立上线。
- **删字段 / 改语义才升版本。** 并在本文档记录迁移方式。
- **当前为 `2`。** 1 → 2 的变更：新增顶层 `capabilities` 与每任务 `progressSource`，
  用于让界面说清「这条为什么没有百分比」。老 Client 读到 2 只按未知字段忽略，不整块空白。
```

在字段表末尾加两行：

```markdown
| `progressSource` | string | 这条任务的进度从哪来：`file`（磁盘采样）/ `stream`（HTTP 流观测）/ `none`（无法度量） |
```

在 `## 后台任务` 之前加顶层字段表：

```markdown
## 顶层字段

| 字段 | 类型 | 含义 |
| `schemaVersion` | number | wire 版本，当前 `2` |
| `buildTag` | string | Host 半边的构建标记，排查缓存旧 bundle 用 |
| `capabilities` | object | 运行时能力探测结果 |
| `tasks` | array | 见下文字段表 |
| `background` | array | 见「后台任务」 |

`capabilities` 的两个键：

| 字段 | 类型 | 含义 |
| `modules` | string | `Module.registerHooks` 可用性：`ok` / `unavailable` |
| `stream` | string | 深度进度开关状态：`off`（用户没开）/ `ok`（已开且可用）/ `unavailable`（宿主不支持）/ `degraded`（装上但报错） |
```

- [ ] **Step 2: 跑 contract.mjs，确认它失败**

Run: `node contract.mjs`
Expected: `FAIL  CONTRACT.md documents transfer field 'progressSource' but the host no longer sends it` 以及顶层字段未被识别。这是 RED。

- [ ] **Step 3: 在 snapshot.js 里加字面量**

`state/snapshot.js` 的 `return { ... }` 里，`unresolved` 那行之后加：

```js
      // Which layer is measuring this task, so the client can explain a card
      // that has no percentage instead of leaving it blank. `file` is the
      // disk sampler, `stream` is the undici wrapper, `none` means neither can
      // see this kind of work at all.
      progressSource: task.progressSource || 'none',
```

`state/registry.js` 的 `BUILD_TAG` 改成 `'0.4.0'`，`package.json` 的 `version` 同步改成 `0.4.0`。

- [ ] **Step 4: 再跑 contract.mjs**

Run: `node contract.mjs`
Expected: `CONTRACT OK — wire shape, adapters and versioning agree`（此时 `progressSource` 恒为 `'none'`，Task 5 才给它真正的值）。

- [ ] **Step 5: 提交**

```bash
git add CONTRACT.md state/snapshot.js state/registry.js package.json
git commit -m "feat(contract): 快照升到 2，加 capabilities 与 progressSource，并声明开关路由"
```

---

## Task 2: 能力探测 `detect/features.js`

**Files:**
- Create: `detect/features.js`
- Create: `test/features.test.mjs`
- Modify: `detect.js:38`（barrel 加 export）
- Modify: `package.json:34`（`test` 脚本串接新测试）

**Interfaces:**
- Produces: `probeModules(): { hooks: boolean }`。Task 4 的 `sensor/stream.js` 与 Task 5 的 `index.js` 都读它。

- [ ] **Step 1: 写会失败的测试**

`test/features.test.mjs`：

```js
/**
 * `detect/features.js` 的单元测试。
 *
 * 唯一的验收点：探测函数在任何畸形输入下都只能返回布尔值，绝不抛错。
 * 它跑在插件加载路径上，抛一次就等于整个插件装不上。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { probeModules } from '../detect/features.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  }
}

console.log('\nprobeModules')

test('返回 { hooks: boolean }，值域只有 true/false', () => {
  const got = probeModules()
  assert.equal(typeof got, 'object', 'must be an object')
  assert.equal(typeof got.hooks, 'boolean', 'hooks must be a boolean')
})

test('本机 Node 有 registerHooks 时 hooks 为 true', () => {
  // Node 24 有；这条断言把"探测逻辑真的在看 Module"钉住，
  // 而不是无论环境如何都返回 true。
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 23) assert.equal(probeModules().hooks, true, 'Node ' + major + ' 应有 registerHooks')
})

test('宿主没有 registerHooks 时返回 false，不抛错', () => {
  // 生产代码不接受"注入一个假 Module"的参数（那等于为测试改设计），
  // 所以这里起一个子进程，在它加载模块之前把 registerHooks 删掉。
  const script = `
    import Module from 'node:module'
    delete Module.registerHooks
    const { probeModules } = await import(${JSON.stringify(new URL('../detect/features.js', import.meta.url).href)})
    process.stdout.write(JSON.stringify(probeModules()))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'the child must exit cleanly: ' + (result.stderr || '').slice(0, 300))
  const got = JSON.parse(result.stdout)
  assert.equal(got.hooks, false, 'a host without registerHooks must probe as false')
})

test('registerHooks 抛错时返回 false', () => {
  const script = `
    import Module from 'node:module'
    Module.registerHooks = () => { throw new Error('hostile host') }
    const { probeModules } = await import(${JSON.stringify(new URL('../detect/features.js', import.meta.url).href)})
    process.stdout.write(JSON.stringify(probeModules()))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'a throw must be caught, not propagated: ' + (result.stderr || '').slice(0, 300))
  assert.equal(JSON.parse(result.stdout).hooks, false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
```

- [ ] **Step 2: 跑它，确认失败**

Run: `node test/features.test.mjs`
Expected: `FAIL 返回 { hooks: boolean }...` + `Cannot find module .../detect/features.js`。

- [ ] **Step 3: 实现**

`detect/features.js`：

```js
/**
 * 运行时能力探测：这一版宿主能不能装模块 hook？
 *
 * 挂在插件加载路径上，所以它唯一的契约是「永远返回布尔值，绝不抛错」。
 * 判据是 Node 的 `Module.registerHooks`（≥22.15）同时具备 `deregister`：
 * 只有能卸掉才算可用 —— 一条装了卸不掉的 hook 会把宿主留在被改写的状态里，
 * 那比没有进度更糟。
 *
 * 探测方式是"装一个空的再立刻卸掉"，不是查版本号：版本号无法表达
 * `--no-experimental-*` 之类的启动参数，而真装一次能。
 */
import Module from 'node:module'

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/features.test.mjs`
Expected: `3 passed, 0 failed`。

- [ ] **Step 5: 接进 barrel 和 npm test**

`detect.js` 末尾加一行：

```js
export { probeModules } from './detect/features.js'
```

`package.json` 的 `test` 脚本，在 `node architecture.mjs` 之后插入 `node test/features.test.mjs &&`。

- [ ] **Step 6: 跑整套测试**

Run: `npm test`
Expected: 全绿，且新测试的输出出现在其中。

- [ ] **Step 7: 提交**

```bash
git add detect/features.js detect.js test/features.test.mjs package.json
git commit -m "feat(features): 探测 Module.registerHooks 可用性，可装才可卸才算可用"
```

---

## Task 3: `sensor/` 层 —— 放行 + 开关状态

**Files:**
- Modify: `architecture.mjs:68-75`（`ALLOWED` 加 `sensor`）
- Create: `sensor/config.js`
- Modify: `package.json:38-57`（`files` 加 `sensor/`）

**Interfaces:**
- Produces: `setDepthProgress(boolean): void`、`depthProgress(): boolean`。Task 4/5/8 都读这个。

- [ ] **Step 1: 先建目录和一个占位，跑 architecture 确认它 FAil**

先只写 `sensor/config.js`（下一步的完整内容），然后：

Run: `node architecture.mjs`
Expected: `FAIL sensor/config.js is a top-level module with no layer` —— 不，`config.js` 在 `sensor/` 里，不在顶层。此时 `unclassified()` 只扫顶层，所以**不会**失败；`sourceFiles()` 也没扫 `sensor/`。这就是 layer 测试的漏洞面：新层要先登记。

所以这一步的正确 RED 是：**先改 architecture.mjs 加 `sensor` 到 ALLOWED，再建文件**，确认它开始检查。

- [ ] **Step 1（修正）: 在 architecture.mjs 里登记新层**

`ALLOWED` 加一行（放在 `detect` 之后、`plan` 之前，因为 sensor 只用 `detect.js`）：

```js
  detect: ['utils.js', 'detect.js', 'detect/'],
  // `sensor` 在 `state` 之下：它只产事件，不认识任务表。
  // 把 stream 的字节数落到卡片上是 `index.js`（接线层）的事，
  // 传感器自己碰 `state/` 会让"谁在改一张卡"失去单点。
  sensor: ['utils.js', 'detect.js', 'sensor/'],
```

Run: `node architecture.mjs`
Expected: `ok   N files respect the layer boundaries`（此时 `sensor/` 还是空的，但已被纳入扫描）。

- [ ] **Step 2: 写会失败的测试**

`test/stream-sensor.test.mjs` 先只放 config 的断言（后面 Task 4 会追加）：

```js
/**
 * `sensor/` 层的单元测试。分两段：开关状态（本节）、undici 包装（下一节）。
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
  setDepthProgress(true)
  setDepthProgress(undefined)
  assert.equal(depthProgress(), false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
```

- [ ] **Step 3: 跑它确认失败**

Run: `node test/stream-sensor.test.mjs`
Expected: `Cannot find module .../sensor/config.js`。

- [ ] **Step 4: 实现**

`sensor/config.js`：

```js
/**
 * 深度进度开关的 Host 侧状态。
 *
 * 唯一的真相源是 Client 的 localStorage：Host 不落盘，每次插件挂载时由
 * Client 回灌一次。这样"用户关掉后重启应用"不会留一个偷偷开着的 hook，
 * 而"用户开着却重启了插件"也能在一个 round trip 内恢复。
 *
 * 严格只认 `true`：路由的 body 来自网络，任何 truthy 值都不该点亮一条会
 * 改写宿主模块的 hook。
 */

let on = false

/** @param {unknown} next */
export function setDepthProgress(next) {
  on = next === true
}

/** @returns {boolean} */
export function depthProgress() {
  return on
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/stream-sensor.test.mjs`
Expected: `3 passed, 0 failed`。

- [ ] **Step 6: 登记到 package.json**

`files` 数组里 `"detect/"` 之后加 `"sensor/"`。`test` 脚本在 `test/features.test.mjs` 之后加 `node test/stream-sensor.test.mjs &&`。

- [ ] **Step 7: 提交**

```bash
git add architecture.mjs sensor/config.js test/stream-sensor.test.mjs package.json
git commit -m "feat(sensor): 新层登记与深度进度开关状态（默认关，只认 true）"
```

---

## Task 4: `sensor/stream.js` —— undici `fetch` 包装

**Files:**
- Create: `sensor/stream.js`
- Modify: `test/stream-sensor.test.mjs`（追加包装测试）

**Interfaces:**
- Consumes: `probeModules()`（Task 2）、`depthProgress()`（Task 3）
- Produces: `installStreamSensor({ onBytes }): () => void`。`onBytes({ url, bytes, total, done })` 由 `index.js` 传入。返回值是幂等的卸装函数；装不上时返回 `null`。

- [ ] **Step 1: 追加会失败的测试**

`test/stream-sensor.test.mjs` 末尾、`console.log(\`\n${passed} passed...\`)` 之前插入：

```js
/* ------------------------------------------------------------------ *
 * undici 包装
 *
 * 这段测的是 spec §4.4 那三条硬约束：源码可改、rewrap 不破坏消费、
 * 卸掉后宿主恢复原样。
 * ------------------------------------------------------------------ */

console.log('\nstream sensor')

const { installStreamSensor } = await import('../sensor/stream.js')

test('没有 registerHooks 的宿主上返回 null，不抛错', () => {
  // 生产接口不接受"注入一个假依赖"的参数，所以这条也在子进程里测：
  // 在 import 之前把 registerHooks 删掉，再装传感器。
  const script = `
    import Module from 'node:module'
    delete Module.registerHooks
    const { installStreamSensor } = await import(${JSON.stringify(new URL('../sensor/stream.js', import.meta.url).href)})
    const got = installStreamSensor({ onBytes: () => {} })
    process.stdout.write(JSON.stringify({ dispose: got === null ? 'null' : typeof got }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'must degrade, not throw: ' + (result.stderr || '').slice(0, 300))
  assert.equal(JSON.parse(result.stdout).dispose, 'null', 'an incapable host gets null')
})

test('装上后 onBytes 收到单调递增的字节与总量', async () => {
  const seen = []
  const dispose = installStreamSensor({ onBytes: (event) => seen.push(event) })
  assert.equal(typeof dispose, 'function', 'a capable host must hand back a disposer')
  try {
    const url = await startSlowServer()
    const res = await fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.length, SLOW_TOTAL, 'the consumer must still get every byte')
    await new Promise((r) => setTimeout(r, 300))
    const mine = seen.filter((e) => e.url === url)
    assert.ok(mine.length >= 2, 'at least two byte events, got ' + mine.length)
    assert.equal(mine[mine.length - 1].bytes, SLOW_TOTAL, 'the last event must reach the total')
    assert.equal(mine[mine.length - 1].total, SLOW_TOTAL, 'the total comes from content-length')
    for (let i = 1; i < mine.length; i++) {
      assert.ok(mine[i].bytes >= mine[i - 1].bytes, 'byte count must never step back')
    }
  } finally {
    dispose()
  }
})

test('卸掉后不再收到事件，宿主 fetch 恢复原函数', async () => {
  const before = globalThis.fetch
  const seen = []
  const dispose = installStreamSensor({ onBytes: (event) => seen.push(event) })
  dispose()
  const count = seen.length
  const url = await startSlowServer()
  const res = await fetch(url)
  await res.arrayBuffer()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(seen.length, count, 'no events after dispose')
  assert.equal(globalThis.fetch, before, 'the global fetch must be put back')
})

test('宿主 fetch 抛错时原样抛出，包装层不吞异常', async () => {
  const dispose = installStreamSensor({ onBytes: () => {} })
  try {
    await assert.rejects(() => fetch('http://127.0.0.1:1/never'), 'connection refused must surface')
  } finally {
    dispose()
  }
})
```

测试文件顶部需要服务器辅助（与上面的 import 放在一起，不要另行 import）：

```js
const SLOW_TOTAL = 64 * 1024
const SLOW_CHUNK = 8 * 1024
let server = null

/** 一个慢速服务：每 chunk 之间停 15ms，保证产生多个字节事件。 */
async function startSlowServer() {
  if (server) return server.url
  const srv = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-length': String(SLOW_TOTAL) })
    const buf = Buffer.alloc(SLOW_CHUNK, 7)
    for (let sent = 0; sent < SLOW_TOTAL; sent += SLOW_CHUNK) {
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r))
      await new Promise((r) => setTimeout(r, 15))
    }
    res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  server = { srv, url: `http://127.0.0.1:${srv.address().port}/slow.bin` }
  return server.url
}

process.on('exit', () => {
  try {
    server?.srv.close()
  } catch {
    /* already gone */
  }
})
```

- [ ] **Step 2: 跑它确认失败**

Run: `node test/stream-sensor.test.mjs`
Expected: `Cannot find module .../sensor/stream.js`。

- [ ] **Step 3: 实现 `sensor/stream.js`**

```js
/**
 * 深度进度：包装宿主内置 undici 的 `fetch`，把响应体读成可计数的流。
 *
 * ## 为什么是 hook 而不是 dispatcher
 *
 * `diagnostics_channel` 的 `undici:request:*` 只报"开始/结束"，不报中间字节；
 * 想拿逐字节进度只能包住 `fetch` 的返回值。宿主的 `web_fetch` 用
 * `await import("undici")` 取函数，而那份 undici 是 app.asar 里的**真实文件模块**
 * （不是 `node:` 内置），它的源码可以被 `Module.registerHooks` 的 `load` 钩子改写，
 * 并且 CJS `require` 与 ESM `import` 拿到的是同一个函数对象 —— 所以包一次够。
 *
 * ## 唯一安全的包装方式：重包，不改原 body
 *
 * 实测（spec §4.4）：改 `res.body` 或 `res.body.tee()` 后替换，都会让宿主自己的
 * `res.arrayBuffer()` 报 `Body is unusable: Body has already been read`，也就是
 * 插件会弄坏宿主的每一个 HTTP 请求。只有 `new Response(stream, {...})` 返回一个新
 * 对象是干净的：宿主消费新对象，原对象没人碰。
 *
 * ## 装不上的三种情况，都降级为 null
 *
 *   1. 没有 `Module.registerHooks`（Node < 22.15）
 *   2. undici 不在预期路径（宿主流行的打包方式变了）
 *   3. 开关是关的（用户没点头，任何改写都不该发生）
 */
import Module from 'node:module'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { probeModules } from '../detect.js'

/**
 * 宿主打包的 undici 主入口。用 `require.resolve` 而不是拼路径：分辨率交给
 * Node，换个宿主布局也还能找到；找不到就降级。
 */
const UNDICI_SPEC = 'undici'

/**
 * 注入到 undici 源码末尾的包装片段。
 *
 * 写成字符串是因为它要成为被 require 的模块的一部分 —— 这是 hook 的全部意义：
 * 在**那个模块自己的**作用域里替换它导出的 `fetch`，而不是在外部猜它的导出形状。
 *
 * 三个必须：
 *   - 用 `new Response(...)` 重包，不改原 body（见文件头）。
 *   - 任何异常都 `return res`，绝不让包装层成为宿主 HTTP 的错误来源。
 *   - 通过 `globalThis` 上的一个槽回传事件，因为片段跑在另一个模块作用域里。
 */
const WRAPPER = `
;(function () {
  try {
    var M = module.exports
    var realFetch = M.fetch
    var RealResponse = M.Response || globalThis.Response
    if (typeof realFetch !== 'function' || typeof RealResponse !== 'function') return
    M.fetch = async function ddpFetch(input, init) {
      var res = await realFetch.apply(this, arguments)
      try {
        var sink = globalThis.__DDP_STREAM_SINK__
        if (typeof sink !== 'function' || !res || !res.body) return res
        var url = typeof input === 'string' ? input : (input && input.url) || ''
        var total = Number(res.headers.get('content-length')) || 0
        var reader = res.body.getReader()
        var bytes = 0
        var stream = new ReadableStream({
          async pull(controller) {
            var step = await reader.read()
            if (step.done) {
              try { sink({ url: url, bytes: bytes, total: total, done: true }) } catch (e) {}
              controller.close()
              return
            }
            bytes += step.value.byteLength
            try { sink({ url: url, bytes: bytes, total: total, done: false }) } catch (e) {}
            controller.enqueue(step.value)
          },
          cancel(reason) { return reader.cancel(reason) },
        })
        return new RealResponse(stream, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
      } catch (e) {
        return res
      }
    }
  } catch (e) {}
})()
`

/** 每个进程只该有一条 hook；重复调用返回同一个 disposer。 */
let active = null

/**
 * 装上深度进度传感器。
 *
 * @param {{onBytes: (event: {url: string, bytes: number, total: number, done: boolean}) => void}} options
 * @returns {null | (() => void)} 装不上返回 null；否则返回幂等的卸装函数
 */
export function installStreamSensor(options) {
  if (active) return active.dispose
  try {
    if (!probeModules().hooks) return null
  } catch {
    return null
  }

  const onBytes = options && typeof options.onBytes === 'function' ? options.onBytes : null
  if (!onBytes) return null

  let resolution = null
  try {
    resolution = createRequire(import.meta.url).resolve(UNDICI_SPEC)
  } catch {
    return null
  }

  // 事件槽：包装片段跑在被加载的 undici 模块作用域里，只能通过全局把字节
  // 交给这里。返回事件的消费者是接线层（index.js），它再把字节落到任务上。
  const sink = (event) => {
    if (!event || typeof event !== 'object') return
    try {
      onBytes({
        url: String(event.url || ''),
        bytes: Number(event.bytes) || 0,
        total: Number(event.total) || 0,
        done: event.done === true,
      })
    } catch {
      /* 消费者抛错不能回到流里 */
    }
  }
  const hadSink = Object.prototype.hasOwnProperty.call(globalThis, '__DDP_STREAM_SINK__')
  const previousSink = globalThis.__DDP_STREAM_SINK__
  globalThis.__DDP_STREAM_SINK__ = sink

  const targetUrl = pathToFileURL(resolution).href
  let hooks = null
  try {
    hooks = Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(specifier, context)
      },
      load(url, context, nextLoad) {
        const result = nextLoad(url, context)
        if (url === targetUrl && result && result.source) {
          return { ...result, source: String(result.source) + WRAPPER }
        }
        return result
      },
    })
  } catch {
    restoreSink(hadSink, previousSink)
    return null
  }
  if (!hooks || typeof hooks.deregister !== 'function') {
    restoreSink(hadSink, previousSink)
    return null
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      hooks.deregister()
    } catch {
      /* 已经卸掉 */
    }
    restoreSink(hadSink, previousSink)
    active = null
  }
  active = { dispose }
  return dispose
}

/** @param {boolean} had @param {unknown} previous */
function restoreSink(had, previous) {
  try {
    if (had) globalThis.__DDP_STREAM_SINK__ = previous
    else delete globalThis.__DDP_STREAM_SINK__
  } catch {
    /* 全局对象被冻结：没有可恢复的东西 */
  }
}
```

- [ ] **Step 4: 跑测试，逐个修到全绿**

Run: `node test/stream-sensor.test.mjs`
Expected: `7 passed, 0 failed`。

若「宿主 fetch 恢复原函数」那条失败，检查 dispose 是否真的 `deregister()` 且测试用的是全局 `fetch`（Node 内置）而不是 undici 的 —— 这条断言比的是 `globalThis.fetch` 引用不变，只要包装只作用在 undici 模块导出上就成立。

- [ ] **Step 5: 跑整套测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add sensor/stream.js test/stream-sensor.test.mjs
git commit -m "feat(sensor): 包装 undici fetch 取逐字节进度，rewrap 不改原 body"
```

---

## Task 5: 接线 —— config 路由 + 传感器挂载/卸载

**Files:**
- Modify: `index.js:56`（`SCHEMA_VERSION` → 2）、`index.js:254-281`（路由段）
- Create: `state/stream.js`
- Modify: `state.js:34`（barrel 加 export）

**Interfaces:**
- Consumes: `installStreamSensor`（Task 4）、`setDepthProgress`/`depthProgress`（Task 3）、`probeModules`（Task 2）
- Produces: `noteStreamBytes(event): void`（`state/stream.js`）；快照 `capabilities: { modules, stream }`

- [ ] **Step 1: 写会失败的测试**

`test/contract-fields.test.mjs`：

```js
/**
 * 快照顶层字段与开关路由的集成测试。
 *
 * 走真实 `apply()`，用一个假 ctx 抓路由，再断言：
 *   1. 路由里有一条 GET 和一条 POST
 *   2. 默认 `capabilities.stream === 'off'`
 *   3. POST 打开后变 `'ok'`（本机 Node 支持 hook）
 *   4. POST 关掉后回到 `'off'`
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

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

function boot() {
  const routes = []
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    on: () => {},
    get: () => undefined,
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  apply(ctx)
  return routes
}

function readState(routes) {
  const route = routes.find((r) => r.kind === 'exact' && r.path === '/download-progress/state')
  let body = null
  route.handler({ method: 'GET', url: route.path, headers: {} }, {
    writeHead() {},
    end(payload) {
      body = JSON.parse(payload)
    },
  })
  return body
}

function postConfig(routes, payload) {
  const route = routes.find((r) => r.path === '/download-progress/config')
  let status = null
  let body = ''
  route.handler(
    { method: 'POST', url: route.path, headers: {}, on: (name, fn) => name === 'data' && fn(JSON.stringify(payload)), setEncoding() {} },
    {
      writeHead(code) {
        status = code
      },
      end(text) {
        body = text || ''
      },
    },
  )
  return { status, body }
}

console.log('\nsnapshot fields and the switch route')

const routes = boot()

test('有 GET 状态路由与 POST 配置路由各一条', () => {
  assert.equal(routes.filter((r) => r.path === '/download-progress/state').length, 1)
  assert.equal(routes.filter((r) => r.path === '/download-progress/config').length, 1)
})

test('schemaVersion 是 2', () => {
  assert.equal(readState(routes).schemaVersion, 2)
})

test('顶层带 capabilities，默认 stream 为 off', () => {
  const body = readState(routes)
  assert.equal(typeof body.capabilities, 'object')
  assert.equal(typeof body.capabilities.modules, 'string')
  assert.equal(body.capabilities.stream, 'off', 'a fresh host must report off')
})

test('POST 打开后 stream 变成 ok（本机支持 hook）', () => {
  const { status } = postConfig(routes, { depthProgress: true })
  assert.equal(status, 204)
  assert.equal(readState(routes).capabilities.stream, 'ok')
})

test('POST 关掉后回到 off', () => {
  postConfig(routes, { depthProgress: false })
  assert.equal(readState(routes).capabilities.stream, 'off')
})

test('POST 畸形 body 不抛错，也不点亮开关', () => {
  for (const bad of [null, {}, { depthProgress: 'yes' }, { depthProgress: 1 }]) {
    const { status } = postConfig(routes, bad)
    assert.equal(status, 204, 'still a valid response')
    assert.equal(readState(routes).capabilities.stream, 'off', 'only a real true turns it on')
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
```

- [ ] **Step 2: 跑它确认失败**

Run: `node test/contract-fields.test.mjs`
Expected: `schemaVersion 是 2` FAIL（现在是 1）+ `有 GET 状态路由与 POST 配置路由` FAIL。

- [ ] **Step 3: 实现 `state/stream.js`**

```js
/**
 * 把流传感器报来的字节落到卡片上。
 *
 * 任务与事件的对应靠 URL：`beginTask` 从命令行或脚本里已经解出一个 `url`，
 * 流事件又带着自己的 `url`。两者相等就是这个任务的进度。不相等的一律忽略 ——
 * 一个 `web_fetch` 期间宿主自己还在发别的请求（轮询状态接口、遥测），
 * 按"最近一条"匹配会把那些字节记到用户看得见的卡片上。
 */

import { tasks } from './registry.js'

/**
 * @param {{url: string, bytes: number, total: number, done: boolean}} event
 */
export function noteStreamBytes(event) {
  if (!event || typeof event !== 'object') return
  const url = String(event.url || '')
  if (!url) return
  const bytes = Number(event.bytes) || 0
  const total = Number(event.total) || 0
  for (const task of tasks.values()) {
    if (task.kind !== 'fetch' && task.kind !== 'search') continue
    if (task.url !== url) continue
    task.bytes = bytes
    if (total > 0) task.total = total
    task.progressSource = 'stream'
    task.lastGrowthAt = Date.now()
    if (event.done) task.streamDone = true
  }
}
```

- [ ] **Step 4: 给任务补 `url` 与 `progressSource`**

`state/begin.js`，在 `const task = { ... }` 里加两个字段（放在 `targets: []` 之后）：

```js
    // 这条任务的进度从哪来。`fetch` / `search` 没有落盘文件，只能靠流观测；
    // 解析出目标路径的下载靠磁盘采样；其余（安装、包管理）两侧都看不见。
    progressSource: 'none',
    // 流传感器按 URL 匹配任务，所以 fetch/search 必须记住自己的 URL。
    url: '',
```

同文件，`if (plan.kind === 'download') {` 那段之前插入：

```js
  if (plan.kind === 'fetch' || plan.kind === 'search') {
    // `web_fetch` 的 URL 在 `detail` 里（见 classify.js 的 fetch 分支）。
    task.url = text(plan.detail)
    task.progressSource = 'stream'
  } else if (plan.kind === 'download') {
    task.progressSource = 'file'
  }
```

并把原来的 `if (plan.kind === 'download') {` 改成 `else if` 链的一部分（保持缩进与逻辑等价）：

```js
  } else if (plan.kind === 'download') {
```

（注意：`download` 分支内部 `if (!expanded) return null` 时，`progressSource` 已经写成 `'file'`，但任务对象没入库，无副作用。）

- [ ] **Step 5: 改 `index.js`**

顶部 import 加：

```js
import { probeModules } from './detect.js'
import { depthProgress, setDepthProgress } from './sensor/config.js'
import { installStreamSensor } from './sensor/stream.js'
import { noteStreamBytes } from './state.js'
```

`SCHEMA_VERSION` 改成 `2`。

在 `apply()` 里，`ctx.effect(() => { const timer = setInterval(...) })` 之后加：

```js
  // 深度进度传感器。开关是运行时状态：用户在设置页打开 -> Client POST ->
  // 这里装；关掉 -> 这里卸。装不上（老 Node / 找不到 undici）就把能力报成
  // `unavailable`，而不是让插件加载失败。
  ctx.effect(() => {
    let dispose = null
    let installed = false
    let degraded = false
    const sync = () => {
      const want = depthProgress()
      if (want && !installed) {
        try {
          dispose = installStreamSensor({ onBytes: noteStreamBytes })
          installed = dispose !== null
          degraded = want && !installed
        } catch {
          installed = false
          degraded = true
        }
      } else if (!want && installed) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 已经卸掉 */
        }
        dispose = null
        installed = false
        degraded = false
      }
    }
    sync()
    const timer = setInterval(sync, 1000)
    return () => {
      clearInterval(timer)
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 已经卸掉 */
      }
    }
  })
```

在快照路由之前加 POST 路由：

```js
  // 开关的唯一写入口。Client 是真相源（localStorage），这里只记住它的选择。
  // 任何 body 都回 204：一个畸形请求不该让设置页看到红字。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => {
        let raw = ''
        try {
          req.on('data', (chunk) => {
            raw += String(chunk)
            if (raw.length > 4096) raw = ''
          })
          req.on('end', () => {
            try {
              const body = raw ? JSON.parse(raw) : null
              setDepthProgress(body && body.depthProgress)
            } catch {
              /* 畸形 JSON：保持原状 */
            }
            res.writeHead(204)
            res.end()
          })
        } catch {
          try {
            res.writeHead(204)
            res.end()
          } catch {
            /* 连接已经断了 */
          }
        }
      },
    }),
  )
```

顶部常量区加：

```js
/** 深度进度开关的写路由。不参与轮询，只在设置变更时 POST 一次。 */
const CONFIG_PATH = '/download-progress/config'
```

快照 body 加 `capabilities`：

```js
          body = JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            buildTag: BUILD_TAG,
            capabilities: capabilities(),
            tasks: snapshot(),
            background: backgroundSnapshot(),
          })
```

`capabilities()` 放在 `apply()` 外面：

```js
/**
 * 运行时能力，随每一帧下发。
 *
 * `stream` 有四个值，含义必须分清：`off` 是"用户没开"，`unavailable` 是
 * "这台机器开不了"，`degraded` 是"开了但装不上"，`ok` 才是"在跑"。
 * 界面据此决定是提示"去打开"还是"此环境不支持"。
 *
 * @returns {{modules: string, stream: string}}
 */
function capabilities() {
  let modules = 'unavailable'
  try {
    modules = probeModules().hooks ? 'ok' : 'unavailable'
  } catch {
    /* 探测本身出问题也只是一条能力缺失 */
  }
  let stream = 'off'
  if (depthProgress()) {
    if (modules !== 'ok') stream = 'unavailable'
    else stream = streamInstalled() ? 'ok' : 'degraded'
  }
  return { modules, stream }
}
```

`streamInstalled()` 需要 `sensor/stream.js` 导出一个查询。加：

```js
/** 传感器是否真的装上了。`capabilities()` 用它区分 `ok` 与 `degraded`。 */
export function streamInstalled() {
  return active !== null
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node test/contract-fields.test.mjs`
Expected: `6 passed, 0 failed`。

- [ ] **Step 7: 跑整套**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add index.js state.js state/stream.js state/begin.js sensor/stream.js test/contract-fields.test.mjs
git commit -m "feat(host): 深度进度开关路由与传感器生命周期，能力随快照下发"
```

---

## Task 6: Client 数据层 —— 保留 capabilities

**Files:**
- Modify: `src/client/60-data.js:36`（`frame` 初值）、`60-data.js:93-105`（`adopt`）
- Modify: `src/client/70-views.js:90-136`（`describe` 的 ctx 与 hint）

**Interfaces:**
- Consumes: `frame.capabilities`（Task 5 的 wire 字段）
- Produces: `describe(task, { showSpeed, capabilities })` 产出的 view-model 多两个键：`hint: string`、`sourceLabel: string`

- [ ] **Step 1: 写会失败的测试**

在 `test/` 下建一个只测 adapter 的脚本（client 源码是拼接片段，直接 import 不了，所以用文本断言 + 一个最小求值）：

`test/client-adapter.test.mjs`：

```js
/**
 * Client 侧 adapter 的行为测试。
 *
 * `src/client/**` 是拼接成单个 bundle 的片段，不能直接 import，所以这里把
 * 需要的那一段取出来、套在最小运行环境里跑。测的是 `contract.mjs` 允许读 wire
 * 的那两个 adapter：`describe()` 与 `briefOf()`。
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

/* 把 20-utils + 70-views 捏成一个可在 Node 里跑的模块。 */
const SOURCE = `
${read('20-utils.js')}
${read('70-views.js')}
export { describe, briefOf, VIEWS }
`

const mod = await import('data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64'))
const { describe } = mod

console.log('\ndescribe() hints')

test('开着的深度进度 + fetch 任务 + 有 total → 给百分比，无 hint', () => {
  const view = describe(
    { kind: 'fetch', bytes: 512, total: 1024, speed: 0, elapsedMs: 1000, progressSource: 'stream' },
    { capabilities: { stream: 'ok' } },
  )
  assert.equal(view.percent, 50, 'a measured fetch must get a percentage')
  assert.equal(view.hint, '', 'nothing to explain when it is measuring')
})

test('深度进度关着 + fetch 任务 → 不给百分比，提示去打开', () => {
  const view = describe(
    { kind: 'fetch', bytes: 0, total: 0, speed: 0, elapsedMs: 3000, progressSource: 'stream' },
    { capabilities: { stream: 'off' } },
  )
  assert.equal(view.percent, null)
  assert.ok(/深度进度/.test(view.hint), 'hint must name the switch, got: ' + view.hint)
  assert.ok(/打开/.test(view.hint), 'hint must say it can be turned on')
})

test('深度进度开着但宿主不支持 → 提示环境不支持，不催用户去开', () => {
  const view = describe(
    { kind: 'fetch', bytes: 0, total: 0, speed: 0, elapsedMs: 3000, progressSource: 'stream' },
    { capabilities: { stream: 'unavailable' } },
  )
  assert.equal(view.percent, null)
  assert.ok(/不支持/.test(view.hint), 'got: ' + view.hint)
  assert.ok(!/打开/.test(view.hint), 'must not tell the user to flip a switch that cannot work')
})

test('深度进度开着但装不上 → 提示降级，不是"没开"', () => {
  const view = describe(
    { kind: 'fetch', bytes: 0, total: 0, speed: 0, elapsedMs: 3000, progressSource: 'stream' },
    { capabilities: { stream: 'degraded' } },
  )
  assert.equal(view.percent, null)
  assert.ok(/降级|装不上|失败/.test(view.hint), 'got: ' + view.hint)
})

test('磁盘采样的下载没有 total → 不提深度进度', () => {
  const view = describe(
    { kind: 'download', bytes: 100, total: 0, speed: 10, elapsedMs: 1000, progressSource: 'file' },
    { capabilities: { stream: 'off' } },
  )
  assert.equal(view.percent, null)
  assert.ok(!/深度进度/.test(view.hint), 'the switch is irrelevant to disk sampling')
})

test('磁盘采样的下载开了深度进度也照常工作（开关不破坏既有能力）', () => {
  const view = describe(
    { kind: 'download', bytes: 512, total: 1024, speed: 10, elapsedMs: 1000, progressSource: 'file' },
    { capabilities: { stream: 'ok' } },
  )
  assert.equal(view.percent, 50, 'turning the switch on must not affect disk sampling')
})

test('capabilities 缺失（老 Host）也不抛错', () => {
  const view = describe(
    { kind: 'fetch', bytes: 0, total: 0, speed: 0, elapsedMs: 1000, progressSource: 'stream' },
    {},
  )
  assert.equal(typeof view.hint, 'string')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
```

- [ ] **Step 2: 跑它确认失败**

Run: `node test/client-adapter.test.mjs`
Expected: `view.hint` 为 `undefined` ⇒ `AssertionError`。

- [ ] **Step 3: 改 `70-views.js` 的 `describe`**

`describe(task, options)` 的 `ctx` 加两个键：

```js
        progressSource: String(task.progressSource || 'none'),
        stream: streamState(options && options.capabilities),
```

在 `ctx.preparing = ...` 之后、`const build = ...` 之前加 hint 计算：

```js
      // 为什么这条没有百分比，一句人话。
      //
      // 三种"没有"必须分清，否则用户会以为插件坏了：
      //   1. 这类任务本来就没有字节可数（安装、包管理）—— 不提开关
      //   2. 有字节可数，但需要深度进度，而用户没开 —— 提醒去开
      //   3. 需要深度进度，开了却用不了 —— 说清是环境不支持还是装不上
      ctx.hint = noPercentHint(ctx)
```

`describe` 的返回值加 `hint` 与 `sourceLabel`：

```js
      return {
        name,
        meta,
        percent,
        determinate: percent !== null,
        log: ctx.log,
        hint: ctx.hint,
        sourceLabel: sourceLabelOf(ctx),
      }
```

同文件加两个小函数（放在 `describe` 之前）：

```js
    /**
     * 这一帧的能力状态，是四个已知值之一。
     *
     * 老 Host 不送 `capabilities`，那就按 `'off'` 处理：与"用户没开"同义，
     * 界面的说法仍然是"可以打开"，而不是"不支持"。
     */
    function streamState(capabilities) {
      const value = capabilities && capabilities.stream
      return value === 'ok' || value === 'unavailable' || value === 'degraded' ? value : 'off'
    }

    /**
     * 一句"为什么没有百分比"。
     *
     * 只在确实拿不到分数时产出，而且只在**这条任务本来可以**有分数时才提到
     * 深度进度：给一个安装卡片说"打开深度进度吧"是在骗人，那条路本来就没有
     * 字节流。
     */
    function noPercentHint(ctx) {
      if (ctx.hasTotal) return ''
      // 磁盘采样的下载没有 total 只是"服务端没给 content-length"，
      // 深度进度也救不了它。
      if (ctx.progressSource !== 'stream') return ''
      if (ctx.stream === 'ok') {
        // 装着、能用，但还没开始收字节：说在准备，不催用户。
        return ctx.bytes === 0 ? '正在建立连接...' : ''
      }
      if (ctx.stream === 'unavailable') return '当前环境不支持深度进度（需要新版 Node）'
      if (ctx.stream === 'degraded') return '深度进度开启失败，已降级为仅计时'
      return '打开「深度进度」可显示百分比'
    }

    /** 卡片底部那行小字：这条进度是谁给的。 */
    function sourceLabelOf(ctx) {
      if (ctx.progressSource === 'file') return ''
      if (ctx.progressSource === 'stream') return ctx.stream === 'ok' ? 'HTTP 流观测' : ''
      return ''
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/client-adapter.test.mjs`
Expected: `7 passed, 0 failed`。

- [ ] **Step 5: 重建 bundle 并跑整套**

Run: `node scripts/build-client.mjs && npm test`
Expected: `client.js matches src/client` + 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/client/70-views.js test/client-adapter.test.mjs client.js package.json
git commit -m "feat(client): 说清每条任务为什么没有百分比，区分没开/不支持/降级"
```

---

## Task 7: Client 把 capabilities 送到卡片上

**Files:**
- Modify: `src/client/60-data.js:36`、`:93-105`
- Modify: `src/client/90-overlay.js`（渲染 Card 处）
- Modify: `src/client/85-inline.js`（渲染 InlineBar 处）

**Interfaces:**
- Consumes: `describe(task, { capabilities })`（Task 6）
- Produces: `frame.capabilities` 透传给 `Card` 与 `InlineBar` 的 `capabilities` prop

- [ ] **Step 1: 改 `60-data.js`**

`frame` 初值：

```js
      frame: { tasks: [], background: [], capabilities: null },
```

`adopt()` 的返回：

```js
        return {
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          background: Array.isArray(data.background) ? data.background : [],
          // 能力随帧走：界面要在同一帧里同时知道"有哪些任务"和"能测什么"，
          // 分两次读会出现卡片已更新、提示还停在上一秒的情况。
          capabilities: data.capabilities && typeof data.capabilities === 'object' ? data.capabilities : null,
        }
```

`miss()` 与 `EMPTY_FRAME` 也带上 `capabilities: null`。

- [ ] **Step 2: 改两个渲染点**

`90-overlay.js` 里渲染 `<Card>` 的地方，把 capabilities 传下去：

```js
            task: task,
            capabilities: frame.capabilities,
```

`Card` 内部：

```js
      const view = describe(task, { showSpeed: props.showSpeed, capabilities: props.capabilities })
```

并把 hint 与 sourceLabel 画出来（在 `view.log` 那行之后）：

```js
        view.hint ? h('div', { className: 'ddp-log ddp-hint' }, view.hint) : null,
```

`85-inline.js` 的 `briefOf(task, capabilities)` 同样收 capability，hover 文案里带上 hint：

```js
      const hint = noPercentHint({
        hasTotal,
        progressSource: String(task.progressSource || 'none'),
        stream: streamState(capabilities),
        bytes,
      })
      ...
      const bits = [label + (elapsed > 0 ? ' · ' + elapsed + 's' : '')]
      if (hint) bits.push(hint)
```

- [ ] **Step 3: 加 CSS**

`src/client/css/overlay.css` 末尾加：

```css
/* 卡片底部的「为什么没进度」提示：比日志行亮一点，因为它是可操作信息。 */
.ddp-hint {
  color: var(--ddp-accent);
  opacity: 0.9;
}
```

- [ ] **Step 4: 重建 + 跑测试**

Run: `node scripts/build-client.mjs && npm test`
Expected: 全绿（`contract.mjs` 会检查视图没有直接读 wire 字段，`hint`/`sourceLabel` 都由 adapter 产出）。

- [ ] **Step 5: 提交**

```bash
git add src/client/60-data.js src/client/85-inline.js src/client/90-overlay.js src/client/css/overlay.css client.js
git commit -m "feat(client): 能力随帧下发到卡片与简易条"
```

---

## Task 8: 设置页开关 + 回灌 Host

**Files:**
- Modify: `src/client/30-settings.js:16-37`（`DEFAULTS`）、`:227-247`（`normalize`）
- Modify: `src/client/95-settings-page.js:64`（`SettingsPage`）
- Modify: `src/client/99-plugin.js:10`（挂载时 POST）

**Interfaces:**
- Consumes: `POST /download-progress/config`（Task 5）
- Produces: `settings.depthProgress: boolean`（默认 `false`）

- [ ] **Step 1: 加设置项**

`30-settings.js` 的 `DEFAULTS` 加：

```js
      // 默认关：打开后插件会改写宿主内置 undici 的 fetch 以取逐字节进度。
      // 这是唯一有全局副作用的功能，必须由用户点头。
      depthProgress: false,
```

`normalize()` 的返回加：

```js
        depthProgress:
          typeof src.depthProgress === 'boolean' ? src.depthProgress : DEFAULTS.depthProgress,
```

- [ ] **Step 2: 设置页加一行**

`95-settings-page.js`，在「显示下载速度」那一行之后插入：

```js
        toggleRow({
          label: '深度进度（需改写宿主模块）',
          hint:
            '打开后可以给网页抓取、搜索这类没有落盘文件的请求显示百分比与速度。' +
            '实现方式是包装宿主内置 undici 的 fetch，属于有意为之的侵入；默认关闭，' +
            '关闭后完全卸载、不残留。对 shell 里跑的 curl / wget 无影响（那些本来靠磁盘采样）；' +
            '对 run_code 子进程内的下载同样无效。',
          checked: settings.depthProgress,
          onChange: (next) => set({ depthProgress: next }),
        }),
```

- [ ] **Step 3: 挂载与变更时回灌 Host**

`20-utils.js` 里加一个发送函数（放在 `readJSON`/`writeJSON` 旁边）：

```js
    /**
     * 把当前开关状态告诉 Host。
     *
     * 失败无所谓：Host 每次能力上报都会读它自己的状态，下一次变更或下一次
     * 插件挂载会再发一遍。绝不能让一次失败的 POST 影响界面。
     *
     * @param {boolean} on
     */
    function pushDepthProgress(on) {
      try {
        fetch(new URL('/download-progress/config', window.location.origin).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ depthProgress: on === true }),
        }).catch(() => {})
      } catch {
        /* 没有 window、或者路由不存在：静默 */
      }
    }
```

`30-settings.js` 的 `writeSettings` 里，写完 localStorage 后调用：

```js
      if (Object.prototype.hasOwnProperty.call(patch, 'depthProgress')) {
        pushDepthProgress(cache.depthProgress)
      }
```

`99-plugin.js` 的 `apply(ctx)` 开头：

```js
        // Host 不落盘：开关的真相源是这里的 localStorage，所以每次挂载都回灌一次。
        // 顺序放在 warm() 之前，让第一帧的能力就已经是用户的真实选择。
        pushDepthProgress(readSettings().depthProgress)
```

- [ ] **Step 4: 重建 + 跑测试**

Run: `node scripts/build-client.mjs && npm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/client/30-settings.js src/client/95-settings-page.js src/client/99-plugin.js src/client/20-utils.js client.js
git commit -m "feat(client): 深度进度开关，默认关，挂载与变更时回灌 Host"
```

---

## Task 9: 全量回归与文档

**Files:**
- Modify: `README.md`（能力边界表）
- Modify: `CONTRACT.md`（若前几步的字段名有出入）
- Verify: 全部测试

- [ ] **Step 1: 跑整套测试**

Run: `npm test`
Expected: 全绿。把输出贴进提交说明。

- [ ] **Step 2: 真机验证（必须做，不能只看测试）**

1. 重新加载插件（改 `cordis.patch.yml` 的 bundle 会让宿主 3 秒内自重启；或重启应用）。
2. 读 `http://127.0.0.1:56649/download-progress/state`，确认 `schemaVersion: 2`、`capabilities.stream: "off"`。
3. 发一次 `web_fetch`，确认卡片出现但**没有**百分比，且 hint 是「打开「深度进度」可显示百分比」。
4. 在设置页打开「深度进度（需改写宿主模块）」，再读状态接口，确认 `capabilities.stream: "ok"`。
5. 再发一次 `web_fetch`，确认**这次有百分比**。
6. 关掉开关，读状态接口确认回到 `"off"`，并再发一次 `web_fetch` 确认 hint 又回到提醒。

- [ ] **Step 3: 更新 README 的能力边界表**

在「能拿到真实进度」的表里加一行：

```markdown
| `web_fetch` / 搜索（需开启「深度进度」） | 打开设置页的「深度进度（需改写宿主模块）」后，这些请求有百分比与速度；关闭时只有计时 |
```

- [ ] **Step 4: 提交**

```bash
git add README.md CONTRACT.md
git commit -m "docs: 深度进度的能力边界与开关说明"
```

---

## Self-Review

**1. Spec coverage**

| spec 要求 | 落在哪个 task |
|---|---|
| L2+ 可撤销地包装 undici `fetch` | Task 4 |
| 必须 rewrap 不改 body（§4.4） | Task 4 Step 3 的 `new Response(...)` + 测试「宿主 fetch 抛错时原样抛出」 |
| 默认关闭 + 用户开关（§4.5） | Task 3（默认 false）、Task 8（设置页） |
| `capabilities.stream` 四态，`off` ≠ `unavailable` | Task 5 `capabilities()`、Task 6 `streamState()` 与两条 hint 测试 |
| 开关能从 Client 传到 Host | Task 5 的 POST 路由 + Task 8 的回灌 |
| `schemaVersion` → 2 | Task 1 |
| 关掉后完全恢复 | Task 4「卸掉后不再收到事件，宿主 fetch 恢复原函数」 |
| 探测失败只降级不崩 | Task 2 三条、Task 4「没有 registerHooks 时返回 null」 |
| 层边界机器校验 | Task 3（登记 `sensor`） |

**2. Placeholder scan**：无 TBD / 「类似 Task N」/ 「加适当的错误处理」。

**3. Type consistency**：
- `probeModules()` 返回 `{ hooks: boolean }` —— Task 2 定义，Task 4 与 Task 5 都按这个形状读。
- `installStreamSensor(options)` 返回 `null | () => void` —— Task 4 定义，Task 5 只判 `!== null`。
- `onBytes({ url, bytes, total, done })` —— Task 4 定义事件形状，Task 5 的 `noteStreamBytes` 按同名字段读。
- `capabilities: { modules, stream }` —— Task 5 产出，Task 6 的 `streamState(capabilities)` 只读 `stream`。
- `describe(task, { showSpeed, capabilities })` —— Task 6 定义，Task 7 按这个签名调用。
- `progressSource` —— Task 1 定字段名，Task 5 写值，Task 6 读，三处一致。

**4. Review Focus**：五条输入各有测试钉住（Task 6 的 hint 四条、Task 4 的抛错与卸装两条、Task 2 的老 Node 一条）。
