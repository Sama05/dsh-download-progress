# DSH 上传下载全量捕获与拦截 —— 开发设计文档

- 日期：2026-10-29
- 状态：设计稿（未开始实现）
- 目标插件：`D:\AIworks\dsh-download-progress`（`@local/dsh-download-progress` 0.3.0）
- 验证产物：`D:\AIworks\_transfer-probe\design-probe.mjs`（11/11 通过）、`D:\AIworks\_transfer-probe\undici-channel-probe.cjs`

---

## 1. 需求原文与解读

### 1.1 用户原始表述（保留原话要点）

> 「我想实现的是 DSH 调用任何上传下载时，都要进行捕获，如果有需要就可以在这里做一下判断，后续如果要修改需求的话，可以很方便地在这里做拦截筛选。」

> 「如果再加上要求兼容性以及非侵入性，尽量实现全版本通用的话，还有几条路线可用？」

> 「那如果我可以接受适当的插件功能降级，比如低版本功能不齐，但是插件基本功能还是可以使用的，高版本功能齐了，插件才会全功能都能使用，不只是 DSH 版本的问题，还有工具的问题，如果有相对应的工具才会去捕获，没有的话，要保证插件基础功能可以使用。」

### 1.2 需求拆解

| 编号 | 需求 | 可验证的判据 |
|---|---|---|
| R1 | 捕获 DSH 中发生的上传与下载 | 每个传输行为产生一条统一形状的事件 |
| R2 | 拦截筛选集中在一个可改点 | 改需求只改策略表，不改采集层 |
| R3 | 非侵入 | 不 patch 宿主、不改 `globalThis`、不 import 宿主内部包 |
| R4 | 兼容性 | 宿主升级时最坏为功能退化，不产生加载错误或崩溃 |
| R5 | 渐进增强 | 高版本 / 有对应工具 ⇒ 全功能；低版本 / 无工具 ⇒ 基础功能仍可用 |
| R6 | 判断依据是**能力**，不是版本号 | 探测运行时能力与工具存在性 |
| R7 | 无对应工具时必须保证基础功能可用 | 增强层不可用时 L0 行为逐字不变 |

> 「既然我已经接受了逐级降级，那么是否也可以试探性的侵入？比如先检测是否有相对应东西，然后再去调用它，如果没有，那么就按照基础的来。」

> 「既然一个都实现不了，那就不要写到文档里」

### 1.3 试探性侵入：逐项实测结论

用户允许「探测有无 → 有就用 → 没有退回基础」。据此对本机所有可行的侵入手段逐项实测：

| 手段 | 对进度检测的作用 | 结论 |
|---|---|---|
| **`Module.registerHooks` 改写 undici 源码** | ✅ **有效**。宿主打包的 undici 是 `app.asar/dsh/node_modules/undici/index.js`（**file:// 真实模块**，不是 `node:` 内置），其 `load` hook 拿到真实源码可改写；ESM `await import("undici")` 与 CJS `require` 拿到的是**同一个函数**，所以宿主 `requestPinned` 走的正是被包装的那个 `fetch`。实测可拿到**逐字节百分比** | **进设计，作为 L2+ 可选层（默认关，用户开关控制）** |
| `NODE_OPTIONS=--require` 注入 | ❌ 机制可跑（preload 实测被执行），但宿主 `runner-launch-B2zsQ1Dz.js` 的 `RUNNER_CONTROL_ENV_PREFIXES = ["NODE_","TSX_"]` 会 `Reflect.deleteProperty` 掉所有 `NODE_*` | 否决：宿主主动剥除 + 不可撤销 |
| patch `child_process.spawn` | ❌ patch 生效但宿主真实启动走 `launchWindowsJob`，`index.js:1560` 调它时**没传 `internals`** | 否决：Windows 主路径不经过被 patch 的入口 |
| patch `fs` default 导出 | ❌ ESM namespace 是冻结快照、`import {}` 是解构绑定 | 否决：只覆盖 `import fs from 'node:fs'` 一种写法 |
| ETW 内核 provider（**管理员权限下重测**） | ⚠️ **能跑，但按 PID 归因不可靠**。见 §3.7 的实测数字：8 MiB loopback 归因 0.27%、外网经代理 1.6%、直连 0%；加大缓冲 4 倍后仍为 0；Kernel-File 写入进程 PID 出现 0 次 | 否决：管理员权限不解决归因问题 |

**仍然成立的核心边界**：`run_code` 在**独立 OS 子进程**中执行（§3.1），所有进程内手段（含 registerHooks）都跨不过去。L2+ 只覆盖**宿主进程内**的 HTTP。

**当前有效路线数：4 条主线（L0–L3）+ 2 条可选（L4 进程计数器、L2+ undici 进度包装）。**

### 1.4 明确不做（本轮范围外）

- 不改插件现有行为（本文档只描述目标形态与迁移路径）
- 不引入原生模块、不需要管理员权限
- 不做内核层 hook（ETW 实测归因不可靠，见 §3.7）、不做子进程 env 注入、不 patch `globalThis`
- 不追求「`run_code` 子进程内部」的进度（永久盲区，见 §4.3）

---

## 2. 结论先行

**可行，但必须分层，且「全量」有明确边界。**

- **L0 基础层**：无条件加载，任何 DSH 版本 / 任何 profile / 任何工具集都可用。它就是当前 0.3.0 的全部能力。
- **L1–L4 增强层**：启动时逐项探测能力，探测失败即静默跳过，L0 不受任何影响。
- 判断依据是**运行时能力探测**，不是版本号比较。

**已实测确认的边界**：`run_code` 工具在**独立子进程**中执行用户 JS，进程内的任何钩子都跨不过去。这决定了「全量捕获」在非侵入前提下**不可能 100%**，只能做到「有对应采集源就捕获，没有就降级」。

---

## 3. 已实测的证据

全部为本机实测，命令与结果可复现。验证脚本见 `D:\AIworks\_transfer-probe\`。

### 3.1 `run_code` 是独立子进程（决定 L2 的上限）

`D:\AI\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-ptc-runtime-node\lib\index.js:1153`：

```js
const handle = this.ctx.subprocess.spawn({
  argv: this.confined?.argv ?? argv,
  cwd,
  env,                    // 明确剔除 ELECTRON_RUN_AS_NODE
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
})
```

同文件内 `worker_threads` 出现 0 次、`vm` 模块 0 次、`process.pid` 0 次。**结论：不是 worker、不是 vm，是 OS 子进程。** 进程内钩子（含 `diagnostics_channel`）无法观测它。

### 3.2 宿主打包的是独立 undici 8.11.2，通道可订阅

`undici-channel-probe.cjs` 在宿主自己的 Electron node（node 24.21.0 / electron 44.7.0）下运行：

```
bundledUndici: loaded
bundledFetch:  ok
channelHits:   create:3  headers:3  trailers:3     ← 宿主打包 undici 的 fetch 同样发通道事件
agentFetch:    ok
agentChannelHits: create:1  headers:1  trailers:1  ← 自定义 dispatcher 也发
```

**结论：L2 对 `web_fetch` 有效。** 宿主 `requestPinned` 走 `await import("undici")` + 自定义 dispatcher，通道事件照样发出。

### 3.3 `jobs` 服务事件字段（决定 L3 的归因能力）

`dsh-jobs-local/lib/index.js:579` 的 `view(job)` 真实形状：

```js
{ id, kind, label, owner, status, startedAt, output:{total,earliest}, ...progress, ...detail, ...finishedAt }
```

`recordSessionEvent` 追加到会话的事件（`:608`）：

```js
{ jobId, owner, kind, label, startedAt, ...toolCall }
```

**结论**：`owner` 就是会话 id，能归因到具体会话。**但不含命令行**——这是 L3 的固有边界，不是实现缺陷。

### 3.4 `fs` 模块 patch 在 ESM 下无效（排除一条路线）

`fs-patch-probe.mjs` 结果：

```
patchSerialized: false           ← import { writeFileSync } 是解构绑定，patch 无效
eSMNamespaceSharesObject: false  ← node:fs 的 ESM namespace 是冻结快照
events: [{ via:'writeFileSync', file:'...bin.2', bytes:2048 }]   ← 只有 default 导出那次被记录
onDisk: [4096, 2048]                                             ← namespace 写入的 4096 完全没进钩子
```

**结论：进程内拦截文件写入这条路线否决。**

### 3.5 官方 `fs` 服务零事件（否决第二条路线）

扫描 `dsh-fs` / `dsh-fs-local` / `dsh-subprocess` / `dsh-subprocess-local` / `dsh-jobs` / `dsh-jobs-local` 六个包：

```
dsh-fs                emit(): (none)   事件: (none)
dsh-fs-local          emit(): (none)   事件: tools/execute（他人发出）
dsh-subprocess        emit(): (none)   事件: (none)
dsh-subprocess-local  emit(): (none)
dsh-jobs              emit(): (none)   事件: workspace/session-activity, workspace/session-stop
dsh-jobs-local        emit(): (none)   事件: job/registered, job/settled
```

**结论：官方文件服务只提供 API，不提供写入事件流。**

### 3.6 进程级 IO 计数器免管理员可读（L4 的数据源）

```
Win32_PerfRawData_PerfProc_Process
node           33876   IOReadBytes 4390899393   IOWriteBytes 177877293
powershell     22952   IOReadBytes     349614   IOWriteBytes       120
```

当前会话 `Admin=False` 仍可读。**代价**：单次查询 200–400 ms；实测对短命 `curl`（20 ms 内结束）5 次采样全漏。

### 3.7 管理员权限下的 ETW：能跑，但**按 PID 归因不可靠**

当前会话 `Admin=True`（用户以管理员启动 DSH）。实测结果：

**能做**：
```
logman create trace ... -p Microsoft-Windows-Kernel-Network 0xffff 5  → code 0
GrowWhileRunning: true          ← 会话运行中 ETL 持续增长
midConvert: code 0, 3768 行     ← 运行中就能 tracerpt 解析，不必等结束
47000 个 KNET 事件 / 1.4 MB ETL（8 MiB 下载）
```

**做不到**（这是关键）：
```
curl 下载 8 MiB loopback → 归因到 curl PID 的字节：22468（0.27%）
curl 下载 5.8 MiB 外网经代理 → 归因到 curl PID：95800（1.6%）
curl 下载 5.8 MiB 外网直连   → 归因到 curl PID：0
加大缓冲 -bs 1024 -nb 128 / -bs 4096 -nb 64 → 仍然 0
加入 Clash 代理 PID 一起统计 → 仍只有 95800（1.6%）
```

**为什么不行（推断，非实测确认）**：`Microsoft-Windows-Kernel-Network` 的 `DataReceived` 事件里 PID 字段记的是**当时谁在收发这一批**。经代理时真正的大流量由 Clash 进程（PID 38772）收发，但实测该 PID 也没记到大部分字节（只统计到 95800）；直连时 curl 的 PID 一条都没记到。这说明该 provider 的 PID 归因在实际链路上**不可依赖**，不是缓冲区大小问题。

**Kernel-File 更差**：
```
-p Microsoft-Windows-Kernel-File 0xffffffffffffffff → 生成 319304 行 / 129 MB CSV（单次 4 MB 写入）
写入进程 PID 在该 CSV 里出现 0 次
用 0x80（FileWrite）/ 0x110 掩码重试 → 依然是 0 次
```
`Kernel-File` 的事件里 PID 字段不是文件写入者（实测 300339 个事件全归到 PID 27304，与写入进程 20520 无关）。

**结论**：管理员权限让 ETW **可以启动**，但不能让它**可靠归因**。这条路不进入正式设计。

### 3.8 现有 L0 能力基线（回归锚点）

`design-probe.mjs` 实测（import 插件真实代码，零修改），11/11 全绿，`duration_ms 70.35`：

| 形态 | 结果 |
|---|---|
| `curl -o D:\x\a.zip` | ✅ 目标解析正确 |
| `curl --output=D:\x\b.bin` | ✅ |
| `wget -O D:\x\c.iso` | ✅ |
| `Invoke-WebRequest -OutFile D:\x\d.png` | ✅ |
| `aria2c -d D:\x -o e.bin` | ✅ |
| `git clone --depth 1 <url> D:\x\r` | ✅ 目录目标 |
| `Start-BitsTransfer -Source <url> -Destination D:\x\f.iso` | ✅ `staged` |
| `curl -o $dst`（变量） | ✅ 按设计丢弃，`targets=[]`，卡片降级为「载入中」 |

这 8 行是「基础功能可用」的可执行定义：任何改动后这一条测试必须仍然全绿。

---

## 4. 分层架构

### 4.1 总览

```
                     ┌──────────────── 采集层（可插拔传感器） ────────────────┐
                     │ L0  sensor/tools.js    tools/execute（官方 waterfall）  │  ← 恒可用
                     │ L1  sensor/install.js  plugin_manager 事件              │  ← 探测
                     │ L2  sensor/net.js      diagnostics_channel undici       │  ← 探测
                     │ L3  sensor/jobs.js     jobs 服务 job/* 事件             │  ← 探测
                     │ L4  sensor/proc.js     Win32_PerfRawData（可选，默认关） │  ← 探测 + 开关
                     │ L2+ sensor/stream.js   undici fetch 包装（可选，默认关） │  ← 探测 + 用户开关
                     └──────────────────────────┬─────────────────────────────┘
                                                │ 归一化
                                                ▼
                                    统一事件 TransferEvent
                          { source, sessionId, kind, dir, subject, total, bytes, raw }
                                                │
                                                ▼
                     ┌────────────── 决策层（唯一可改点） ──────────────┐
                     │  policy.js                                       │
                     │    POLICY = 规则表（一行一条）                    │
                     │    decide(event) → { act, rule, reason }          │
                     │    act ∈ allow | track | warn | ask | block       │
                     └──────────────┬───────────────────────────────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
         tools 源：真拦截（return block）      其余源：仅观测 + UI/日志
```

### 4.2 统一事件形状（`event.js`）

```js
{
  source:    'tools' | 'install' | 'net' | 'jobs' | 'proc',
  sessionId: string,
  at:        number,
  kind:      'download' | 'upload' | 'install' | 'fetch' | 'exec' | 'other',
  dir:       'in' | 'out' | 'unknown',
  subject:   string,        // URL / 目标路径 / 包名 / job 标签，最长 200 字
  total:     number | null, // 总量（content-length / HEAD 探测）
  bytes:     number | null, // 已有字节（只有 disk/proc 源能给）
  raw:       object,        // 原始载荷，仅供诊断，不进 UI
}
```

**硬约束（已由测试锁定）**：四个源的归一化结果字段集合必须完全一致（`design-probe.mjs` 的「统一事件：四个源归一化后字段集合完全一致」）。

### 4.3 各层能力与边界

| 层 | 数据源 | 能捕获 | 捕获不到 | 能拦截 | 可撤销 | 默认 |
|---|---|---|---|---|---|---|
| **L0** | `ctx.on('tools/execute')` | 所有工具名 + 参数全文 + 会话 + 命令文字面量路径 | 工具内部的运行时行为 | ✅ **唯一能真拦的位置** | — | 开 |
| **L1** | `plugin_manager` 事件 | 安装日志流、阶段 | — | ✅（同 tools 通道） | — | 开 |
| **L2** | undici 4 通道 | 宿主进程内 HTTP 的 URL、方法、方向、总量、起止 | 逐字节进度；`run_code` 子进程内的 HTTP | ❌ | 是（unsubscribe） | 开 |
| **L2+** | **包装 undici `fetch`** | **逐字节进度 + content-length + 实时速率**（宿主进程内 HTTP） | `run_code` 子进程内的 HTTP | ❌ | 是（`deregister()` 实测零残留） | **关（用户开关）** |
| **L3** | `jobs` 服务事件 | 子进程 job 的发生、结束、会话归属、标签 | 命令行、URL、字节 | ❌ | 是（ctx.effect） | 开 |
| **L4** | WMI 性能计数器 | 任意进程的累计读写字节 | URL、文件名、进度曲线 | ❌ | 是（停轮询） | 关 |

### 4.4 L2+ 关键实现约束（实测得出，写错会弄坏宿主）

**必须用「新 Response」重包，不能改原 body。** 三种写法实测对比：

| 写法 | 结果 |
|---|---|
| `Object.defineProperty(res, 'body', {value: wrappedStream})` | ❌ 宿主 `res.arrayBuffer()` 报 `Body is unusable: Body has already been read` |
| `res.body.tee()` 后替换 `res.body` | ❌ 同样报错（见上一行）；`bodyUsed` 强行改 false 也无效 |
| **`new Response(stream, {status, statusText, headers})` 返回新对象** | ✅ 宿主正常消费（`consumed: 131072`），同时拿到 8 次 chunk 事件，`bytes` 单调递增至 `total` |

**宿主真实调用形态下同样成立**（`requestPinned` 用 `await import("undici")` + 自定义 `Agent` dispatcher + `redirect:'manual'` + `signal`）：
```
requestPinned-like → downloadChunks: 2,​ downloadReachedTotal: true,​ errors: []
upload            → uploadRecords: 1,​ uploadTotal: 65536
```

**上传方向只能拿总量，不能拿中间进度**：`init.body` 是 Buffer/string，一次交给 undici，没有可观测的流式读取点。上传的 `total` 可从 `body.byteLength` 得到。

**包不到的东西**：`Agent` 内部的 socket 层（所以拿不到 TCP 重传/压缩前的字节）；`run_code` 子进程（跨进程）。

### 4.5 探测方式与开关

```js
// detect/features.js
export function canWrapUndiciHooks(Module) {
  try {
    if (typeof Module?.registerHooks !== 'function') return false
    const hooks = Module.registerHooks({
      resolve: (s, c, next) => next(s, c),
      load: (u, c, next) => next(u, c),
    })
    if (!hooks || typeof hooks.deregister !== 'function') return false
    hooks.deregister()
    return true
  } catch { return false }
}
```

**注意**：`available: true` 不等于 `enabled: true`。用户必须在设置页显式开启，因为这条会**改写第三方模块源码**（虽然是可撤销的）。

**快照字段**（`schemaVersion: 2`）：
```js
capabilities: {
  tools: 'ok', install: 'ok', net: 'pending'|'ok'|'unavailable'|'degraded:<原因>',
  jobs: 'ok', proc: 'off',
  stream: 'off' | 'ok' | 'degraded:<原因>',   // ← L2+ 状态
}
```

**默认关闭的理由（写进设置页文案）**：
> 开启后会用 `Module.registerHooks` 改写宿主内置 undici 的 `fetch`，以获取逐字节下载进度。仅影响宿主进程内的 HTTP（如 `web_fetch`、搜索）。关闭时完全卸载、不残留。对 `run_code` 子进程内的下载无效果。

---

## 5. 能力探测（`detect/features.js`）

### 5.1 三种探测手法（按可靠性排序）

| 手法 | 实现 | 适用 | 可靠性 |
|---|---|---|---|
| 官方服务形状检查 | `ctx.get(name)` + 点号路径成员检查 | `jobs` / `sessions` / `workingDirectory` | 高 |
| 全局对象 try-subscribe | `dc.subscribe(ch, noop)` 再 `unsubscribe` | `diagnostics_channel` | 中 |
| 工具目录存在性 | 判断工具名是否已注册 | `run_code` / `pwsh` / `plugin_manager` | 高 |

### 5.2 必须避免的两个坑（已由测试暴露）

**坑 1：成员检查必须用点号路径。**
第一版写成顶层名字查找，于是真实的 jobs 服务 `{ events: { subscribe } }` 被判定为不可用，L3 整层被静默关掉。测试「能力探测：ctx 缺失 / 抛错 / 形状不对，一律 false」抓到了这个缺陷。定稿写法：

```js
export function hasService(ctx, name, members) {
  try {
    const service = ctx?.get?.(name)
    if (!service) return false
    for (const path of members) {           // 必须传 'events.subscribe'，不是 'events'
      let cursor = service
      for (const key of path.split('.')) {
        if (cursor == null || typeof cursor !== 'object') return false
        cursor = cursor[key]
      }
      if (typeof cursor !== 'function') return false
    }
    return true
  } catch {
    return false
  }
}
```

**坑 2：`diagnostics_channel` 订阅任意名字都不报错。**
实测 `dc.subscribe('definitely:not:a:channel', noop)` 返回正常。**因此「通道存在」不能用 try/catch 判断**，只能等真的收到第一个事件才把 L2 标记为 `ok`，之前一律 `pending`。

### 5.3 探测结果进快照

```js
{
  schemaVersion: 2,        // ← 从 1 升到 2（见 §7.2）
  buildTag: '0.4.0',
  capabilities: {          // ← 新增字段
    tools:   'ok',
    install: 'ok',
    net:     'pending' | 'ok' | 'unavailable' | 'degraded:<原因>',
    jobs:    'ok',
    proc:    'off',        // 用户没开
  },
  tasks: [...],
  background: [...],
}
```

### 5.4 为什么不用版本号判断

1. 插件无法预知未来版本的形态，写死 `>=0.2.1` 后新版本会被误判
2. 同一版本在不同 profile 下工具集不同（本机就有 `desktop` / `web` / `tmtest` 三个 profile）
3. 服务名可以改，但「这个服务现在拿得到吗」永远能当场问
4. 版本号无法表达「工具存在性」这一层（用户明确要求「有相对应的工具才会去捕获」）

---

## 6. 降级契约

### 6.1 传感器接口

```js
{
  id:    'net',
  probe: (ctx) => boolean,          // false ⇒ 该层不加载
  start: (ctx, emit) => () => void, // 抛错 ⇒ 标 degraded，主流程继续
  cost:  'none' | 'low' | 'polling',// 供设置页显示
}
```

### 6.2 四条硬约束（必须写成测试）

| 编号 | 约束 | 测试位置 |
|---|---|---|
| C1 | 任何 `probe()` 返回 false ⇒ L0 完全不受影响 | `design-probe.mjs`「降级契约：任何一个传感器 start() 抛错，其余照常运行」 |
| C2 | 任何 `start()` 抛错 ⇒ 捕获后标 `degraded`，`tools/execute` 照常 `return next()` | 同上 + 「tools/execute 观察器抛错仍必须 return next()」 |
| C3 | `dispose()` 必须清掉所有定时器与订阅 | 待实现（沿用现有 `ctx.effect` 模式） |
| C4 | 全部增强层不可用时，L0 解析结果与基线逐字一致 | 「端到端：全部增强层不可用，L0 解析结果与基线逐字一致」 |

### 6.3 L0 不变的证明方式

每次改动后跑 `design-probe.mjs` 的前两条（L0 基线）与最后一条（端到端），三条必须同时绿。这是「基础功能可用」的可执行定义，不是口头承诺。

---

## 7. 策略入口（`policy.js`）

### 7.1 表驱动设计

```js
export const POLICY = [
  { id: 'in-transfer',   when: (e) => e.kind === 'download' && e.dir === 'in',  act: 'track' },
  { id: 'out-transfer',  when: (e) => e.kind === 'upload',                      act: 'track' },
  { id: 'opaque-exec',   when: (e) => e.kind === 'exec',                        act: 'warn'  },
  { id: 'big-transfer',  when: (e) => (e.total ?? 0) > 100e6,                   act: 'ask'   },
  { id: 'blocked-host',  when: (e) => e.dir === 'out' && isBlocked(e.subject),  act: 'block' },
]

export function decide(event) {
  try {
    for (const rule of POLICY) if (rule.when(event)) return { act: rule.act, rule: rule.id }
    return { act: 'allow', rule: 'default' }
  } catch {
    return { act: 'allow', rule: 'error-fallback' }
  }
}
```

**设计要点**：
- 一条规则一行，加需求只加一行
- 先匹配先返回，顺序即优先级
- 任何异常默认 `allow`——策略层抛错绝不能挂掉工具调用

### 7.2 `act` 的真实含义（必须写清，否则会做出假承诺）

| act | tools 源 | 其它源 |
|---|---|---|
| `allow` | `return next()` | 忽略 |
| `track` | `return next()` + 建卡 | 建卡 / 记录 |
| `warn` | `return next()` + 提示 | 提示 |
| `ask` | `return next()` + 询问（不改决策） | 仅提示 |
| `block` | **不调 `next()`，返回拒绝原因** | **无法拦截，只能记录「已发生」** |

**唯一真正能拦住的位置是 `tools/execute`。** 其余源都是「事后观测」，看到时传输已经在跑。

### 7.3 `schemaVersion` 从 1 升到 2 的理由

插件的 `index.js:47-54` 写明规则：「加字段不 bump」。但 `capabilities` 是例外：
- 客户端**必须读它**才能判断「该不该显示降级提示」
- 它描述的是**运行时状态**而非任务数据，语义上属于新契约
- 旧客户端读到 `schemaVersion: 2` 会走「不认识就忽略」路径，不会崩

---

## 8. 文件结构（目标形态）

```
dsh-download-progress/
├─ index.js                 # 接线：注册传感器、策略、路由（收缩）
├─ event.js                 # 新增：TransferEvent 归一化
├─ policy.js                # 新增：POLICY 表 + decide()
├─ detect/
│  ├─ features.js           # 新增：能力探测（hasService / canSubscribe / toolNames）
│  ├─ classify.js           # 保持：命令 → 传输判定（L0 核心，零改动）
│  ├─ targets.js / spec.js / patterns.js / vars.js / remote.js / segments.js / tools.js  # 保持
├─ sensor/
│  ├─ tools.js              # 新增：从 index.js 抽出 tools/execute 观察
│  ├─ install.js            # 新增：plugin_manager 事件
│  ├─ net.js                # 新增：undici 通道订阅
│  ├─ jobs.js               # 迁移：background/jobs.js 拆出采集部分
│  └─ proc.js               # 新增（L4，默认关）
├─ state/  plan/  script/ background/  src/client/       # 保持
└─ test/
   ├─ features.test.mjs     # 新增：能力探测（本次 design-probe 前 5 条演化为正式测试）
   ├─ policy.test.mjs       # 新增：策略表
   └─ l0-baseline.test.mjs  # 新增：L0 回归锚点
```

**Ponytail 自检**：每个新增点都对应一条用户需求，删掉就会破坏它：

| 新增点 | 对应需求 | 删掉会怎样 |
|---|---|---|
| `event.js` | R1 统一事件 | 五个源各自为政，策略层要写五套判断 |
| `policy.js` | R2 唯一可改点 | 改需求要动采集层 |
| `detect/features.js` | R6 能力探测 | 只能靠版本号，违反 R6 |
| `sensor/*` | R5 渐进增强 | 无法逐层降级 |

`state/` `plan/` `script/` `detect/` 零改动——这是「L0 不动」的结构保证。

---

## 9. 实施顺序

| 步 | 内容 | 风险 | 验证 |
|---|---|---|---|
| 1 | 抽 `event.js` + `policy.js`，`classify()` 改为产出统一事件，行为不变 | 低（纯重构） | L0 基线三条测试必须全绿；现有 `pnpm test` 全绿 |
| 2 | 抽 `detect/features.js`，`capabilities` 进快照，`schemaVersion` → 2 | 低 | 探测在畸形 ctx 下全返回 false；客户端忽略未知字段不崩 |
| 3 | 把 `background/jobs.js` 拆成 `sensor/jobs.js`（只搬不改） | 低 | 后台卡行为不变 |
| 4 | 加 `sensor/net.js`（L2），先只记录不建卡 | 中（订阅影响宿主 HTTP 路径） | `capabilities.net` 从 `pending` 变 `ok`；`web_fetch` 卡能拿到 `total` |
| 5 | 加 `sensor/proc.js`（L4），默认关，设置页给开关 | 中（轮询成本） | 开启后能看到任意进程读写量；关闭后零开销 |
| 6 | **加 `sensor/stream.js`（L2+），默认关，设置页给开关** | **中（改写第三方模块源码）** | 开关打开后 `web_fetch` 卡显示百分比；关闭后 `capabilities.stream` 变 `off` 且 L0 不变；`deregister()` 后零 hook 调用 |
| 7 | 客户端显示降级状态 + L2+ 开关（设置页诊断区） | 低 | 人能直接看到「哪层没生效、为什么」，能开关 L2+ |

**第 6 步的验证要点（实测已锁定的三条）**：
1. 必须 `new Response(...)` 重包，不能改原 `body`（否则宿主报 `Body is unusable`）
2. `capabilities.stream` 在开关关闭时必须是 `off`，不是 `unavailable`
3. 关闭后调 `hooks.deregister()`，实测「卸掉后零 hook 调用」

---

## 10. 代价与风险清单

| 项 | 代价 | 缓解 |
|---|---|---|
| L2 订阅 undici 4 通道 | 每个宿主 HTTP 请求多 4 次回调 | 只读字段，不做重活；实测通道事件本身微秒级 |
| L2 可能误报自身请求 | 会抓到客户端轮询 `/download-progress/state` | 按 `origin` + `path` 前缀排除自身 |
| **L2+ 改写 undici 源码** | 宿主内所有 ESM 加载都过一遍 hook；**改错会弄坏宿主的 HTTP 请求** | 默认关；只用 rewrap 写法（§4.4）；drop 掉任何异常时返回原 res；提供「一键关闭」 |
| **L2+ 与其它插件冲突** | 别的插件也可能装 hook，顺序不确定 | 只做 rewrap 不改原对象；不依赖被自己改写过的返回值 |
| **L2+ 关不彻底** | 若 `deregister()` 漏调，副作用残留 | 测试验证「卸掉后零 hook 调用」；`ctx.effect` 里注册 disposer |
| L3 引入 `job/*` 事件名依赖 | 中等稳定（不如 `tools/execute`） | 订阅失败即静默降级为 `unavailable` |
| L4 轮询 200–400 ms/次 | 常驻 CPU 成本 | 默认关；给独立开关与频率设置；只在用户显式开启时跑 |
| `policy.js` 在 tools 同步路径 | 抛错会挂工具调用 | 全程 try/catch + 默认 `allow`（C2） |
| `capabilities` 进快照 | 客户端契约变化 | `schemaVersion` → 2，旧客户端忽略未知字段 |

---

## 11. 未验证项

| # | 项 | 性质与判据 |
|---|---|---|
| U1 | `web_fetch` 的响应体是否会触发 `undici:request:trailers` | **推断**。实测的是自带 `fetch()`，`requestPinned` 走 `fetch(url,{dispatcher})`，两者均发 `headers` 事件；但宿主内实际链路未跑过。判据：开 L2 后发一次 `web_fetch`，看 `capabilities.net` 是否转 `ok` 并记录到一条事件 |
| U2 | L4 对真实下载进程的采样命中率 | **部分实测**。小文件（20 ms 结束）5 次全漏；大文件未测。判据：跑一个 100 MB 慢速下载，统计采样命中次数 |
| U3 | `jobs` 的 `progress` 字段在大文件下载时是否有值 | **推断**。`view()` 里 `...job.state.progress` 是可选展开；`bash` 类型 producer 是否填它未实测 |
| U4 | 宿主升级后 `undici:request:*` 通道名是否稳定 | **无法穷尽验证**（属否定断言）| 缓解：L2 只在收到事件后才标 `ok`，通道改名自动退化为 `unavailable`，不报错 |
| U5 | 三个 profile（`desktop` / `web` / `tmtest`）下能力探测结果是否一致 | **未测**。只在 `desktop` 上验过。判据：分别启动并读 `/download-progress/state` 的 `capabilities` |
| U6 | **L2+ 在真实 `web_fetch` 链路上是否正常** | **未测**。实测环境是自己 `import undici` 后调 fetch，与宿主 `requestPinned` 的调用形态一致但**没在活的宿主里跑过**。判据：开启 L2+ 后发一次 `web_fetch`，确认不报错且卡片有百分比 |
| U7 | **L2+ 与其它 22 个已装插件是否冲突** | **未测**。没查到别的插件登记 hooks 的证据，但未穷尽。判据：开启 L2+ 跑一轮完整会话，`dsh --dump-config` 无告警、工具调用正常 |
| U8 | `registerHooks` 的 `load` hook 对 CJS `require` 路径是否同样触发 | **未测**。实测只覆盖 ESM `import` 与 `node:` 内置。影响：若宿主某处用 CJS `require("undici")`，可能不被包装 |

---

## 12. 附：验证产物

```bash
# 设计自洽性测试（11 条，全绿）
node --test D:\AIworks\_transfer-probe\design-probe.mjs

# 下列探针须在宿主自己的 Electron node 下跑（实测环境 node 24.21.0 / electron 44.7.0）
$env:ELECTRON_RUN_AS_NODE='1'
H='D:\AI\DeepSeek Harness\DeepSeek Harness.exe'

# L2 前提：宿主打包 undici 是否发 diagnostics_channel 事件
& $H D:\AIworks\_transfer-probe\undici-channel-probe.cjs

# L2+ 可行性（4 个，依次证明：源码可改 → ESM 同步 → 逐字节进度 → rewrap 不破坏消费）
& $H D:\AIworks\_transfer-probe\hooks-undici-probe.cjs      # 源码可改写 + fetch 被替换
& $H D:\AIworks\_transfer-probe\hooks-esm-check.cjs         # ESM 命名空间与 CJS 同一函数
& $H D:\AIworks\_transfer-probe\hooks-progress-probe.cjs    # 逐字节进度（32 个样本单调递增）
& $H D:\AIworks\_transfer-probe\hooks-rewrap-probe.cjs      # rewrap 可行，tee 会弄坏宿主
& $H D:\AIworks\_transfer-probe\hooks-host-shape-probe.cjs  # 宿主真实调用形态下成立
```

全部是**一次性验证产物**，不进入插件仓库，不参与插件 `pnpm test`。若本设计进入实施阶段，`design-probe.mjs` 的 11 条断言应迁移为 `test/features.test.mjs` / `test/policy.test.mjs` / `test/l0-baseline.test.mjs` 三个正式测试文件；L2+ 的四条验证应移入 `test/stream.test.mjs`（含「关闭后零 hook 调用」这条）。
