# 数据契约（Host ↔ Client）

这个插件分两半，中间只有一个窄缝：Host 每 1 秒吐一份 JSON，Client 读它渲染。

```
Host                                    Client
detect.js  命令识别                      taskStore.adopt()   收帧 + 版本兼容
state.js   任务表 → snapshot()           adapter             唯一读 wire 字段的地方
index.js   路由 /download-progress/state  views              只吃 view-model
```

**加 UI 功能只改 `views`。改底层只改 Host，UI 侧最多改 adapter 里的字段映射。**

这条约定由 `contract.mjs` 机器校验（`node contract.mjs`），它会拦住三类退化：

1. 视图函数里直接写 `task.bytes` 这种 wire 字段访问
2. `snapshot()` 加了字段但本文档没记
3. 本文档记了字段但 `snapshot()` 不再发送

## 路由

`GET /download-progress/state` → 200，`cache-control: no-store`

```json
{ "schemaVersion": 1, "tasks": [ /* 见下表 */ ] }
```

`schemaVersion` 规则：

- **加字段不升版本。** Client 忽略它不认识的字段，所以新字段可以独立上线。
- **删字段 / 改语义才升版本。** 并在本文档记录迁移方式。
- Client 永不因为版本号拒绝一帧 —— 老 bundle 遇到新字段只是不显示，不该整块空白。

## 字段表

`tasks[]` 每一项：

| 字段 | 类型 | 含义 |
| `id` | string | 任务 id，一次工具调用一个 |
| `kind` | string | `download` / `install` / `fetch` / `search` / `pkg` |
| `name` | string | 原始名称（通常是 URL 或包名） |
| `label` | string | 给人看的短名，可能为空 |
| `sessionId` | string | 发起这次调用的会话 id，空串表示不属于任何会话 |
| `sessionTitle` | string | 会话显示名；Host 解析不到时回退成 `会话 <id 尾 8 位>` |
| `bytes` | number | 已传输字节 |
| `total` | number | 总字节；`0` / 负数 / 非有限值表示未知 |
| `speed` | number | 字节/秒，Host 已取整 |
| `phase` | string | 安装类任务的阶段（`applying` 等），其余为空 |
| `log` | string | 最新一行日志，可能为空 |
| `startedAt` | number | 开始时间（epoch ms） |
| `elapsedMs` | number | 已耗时，Host 每帧现算 |
| `done` | boolean | 工具调用已返回（文件可能仍在增长） |
| `unresolved` | boolean | 是下载但没解析出目标：UI 画不确定态，不画 `0 B / 0 B` |

## 谁是 adapter

`client.js` 里只有这几个函数允许读上表字段：

| 函数 | 产出 |
| `logOf(task)` | 一行日志文本 |
| `describe(task, opts)` | 卡片 view-model：`{ name, meta, percent, determinate, log }` |
| `fallbackView(task, ctx)` | 未知 `kind` 的兜底 view-model |
| `sessionKeyOf(task)` | 分组键 |
| `sessionNameOf(task)` | 分组标题 |
| `briefOf(task)` | 简易条 view-model：`{ shape, pct, speed, ... }` |

视图组件（`Card` / `Group` / `Overlay` / `InlineBar` / `SettingsPage` 及其子组件）**只读 view-model**。

### 改一个 wire 字段名要动几处

1. `state.js` 的 `snapshot()`
2. 本文件字段表
3. 对应的 adapter 函数（通常一行）

视图零改动。如果视图报错，说明有地方绕过了 adapter —— `contract.mjs` 应该先一步拦住。

### 加一个 UI 功能要动几处

只动 `views`。如果发现必须读一个新字段，那是**加**字段：Host 加、本文档加、adapter 加一行，视图仍只读 view-model。

## 后台任务

同一路由里还有 `background[]`，描述正在跑、但没有进度可画的后台工作（bash 后台 job / 子代理 / workflow）。它沿用同一套规则：加字段不升版本，视图只通过 `describeBackground` 读它。

```json
{ "schemaVersion": 1, "tasks": [ /* ... */ ], "background": [ /* 见下表 */ ] }
```

`background[]` 每一项：

| 字段 | 类型 | 含义 |
| `id` | string | 后台任务 id（job id / 子代理 id / workflow run id） |
| `type` | string | `job` / `subagent` / `workflow` |
| `label` | string | 给人看的短名，Host 已保证非空 |
| `detail` | string | 一行补充（job 的 progress 行、子代理的 provider、workflow 的当前 phase） |
| `sessionId` | string | 归属会话 id；解析不到为空串 |
| `sessionTitle` | string | 会话显示名，规则同 `tasks[].sessionTitle` |
| `status` | string | `running` / `stopping` / `done` / `failed` |
| `waiting` | boolean | **关键区分**：agent 当前 step 正阻塞在等它 |
| `startedAt` | number | 开始时间（epoch ms），Host 推断不出来时取首帧时间 |
| `elapsedMs` | number | 已耗时，Host 每帧现算 |

`status` 与 `waiting` 是两件事，UI 用两套文案：

- `status === 'running'` → 「后台运行中」
- `waiting === true` → 「等待后台任务」：agent 停了，是在等它，不是在干活

`waiting` 由 Host 推断：`jobs` 的 owner 上若有正在执行的工具调用，且那个调用不是起 job 的 `bash` 本身，就认为它在等。子代理 / workflow 由 `tools/execute` 的当前工具名判定。

### 谁是 background 的 adapter

| 函数 | 产出 |
| `describeBackground(row)` | 一行 view-model：`{ label, detail, state, waiting, meta, type }` |
| `backgroundBrief(rows)` | 简易条 view-model，形状同 `briefOf`，`shape` 固定 `ring` |

背景行**不画进度条**：它没有分数，画一条不动的轨道比一句状态更糟。
