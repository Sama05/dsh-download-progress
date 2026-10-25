# AGENTS.md — 实现笔记（给 AI / 维护者）

> 这不是用户文档。安装步骤、能力边界、优缺点在 [README.md](README.md)。
> 这里记录：**为什么这么实现、依赖了 DSH 的哪些内部契约、哪些路走不通（附证据）、升级时会先坏在哪里**。
> 内容会随 DSH 版本漂移而失效，所以每条结论都尽量带上当时的证据形态，方便复核。

- 包名：`@local/dsh-download-progress`
- 版本：`0.3.0`
- 运行位置：Host 半在 DSH 主进程，Client 半在 DSH Web UI 的渲染进程
- 零外部依赖：只用 `node:fs` / `node:path`（Host 半）+ 宿主提供的 `react`（Client 半）
- 许可证：MIT，见 [LICENSE](LICENSE)

---

## 1. 触发机制（这是整个插件的难点）

### 1.1 结论先说

DSH **没有**"下载进度"这类事件。工具层只有两个端点事件：

| 事件 | 时机 | 内容 |
| --- | --- | --- |
| `session/event` → `tool/call` | 工具开始 | `turn, step, callId, name, arguments` |
| `session/event` → `tool/result` | 工具结束 | `turn, step, message, error?` |

中间过程是黑盒（`tool/stream`、`tool/progress`、`tool/partial` 在源码里搜不到）。
所以**"网卡收了多少字节"永远拿不到**，能拿到的只有"文件在磁盘上长大了多少"。

### 1.2 用到的官方扩展点

全部是官方扩展点，没有改任何 DSH 核心代码、没有 monkey-patch：

| 用途 | 扩展点 | 说明 |
| --- | --- | --- |
| **触发**（核心） | `ctx.on('tools/execute', (exec, next) => ...)` | waterfall，包住**所有**工具执行。`exec` 含 `callId / name / arguments / agent`。不拥有决策时**必须** `return next()`，本插件全程如此 |
| 安装进度 | `plugin-manager/install-log` | 流式 pnpm 输出，`chunk.text` 是真实的一行日志 |
| 安装阶段 | `plugin-manager/install-state` | `progress.phase` = `installing` / `cancelling` / `applying` |
| 数据下发 | `ctx.webServer.register({ kind:'exact', path:'/download-progress/state' })` | Host 每 1s 采样一次，Client 每 1s 拉一次 JSON |
| **UI 挂载** | `ctx.slots.register({ name:'shell.overlay', ... })` | 全帧浮动层，**在布局流之外** |
| **简易条挂载** | `ctx.slots.register({ name:'conversation.input.left', order:2000 })` | 输入框上方那一行的 list 槽位，跟「完全权限」同排。见 §3.3 |

### 1.3 为什么是 `shell.overlay` 而不是输入框停靠区

`shell.overlay` 是"Frame-wide floating layer, above every column and outside their scroll containers"，
`replaceRisk: none`，且"the layer itself is click-through"。

因为它在布局流之外，**出现/消失不会挤动任何东西**——这直接满足"进度条触发时窗口不要抖动/错位"。
换成 `conversation.input.dock` 之类的停靠槽位，每出现一条就会把输入框往下推，必然抖。

**但 2026-10-22 追加了可选的第二形态**（§3.3）：`conversation.input.left` 是个**已经存在**的工具行
（权限 chip 就住那儿），往里塞一个 `22px` 高、`flex:0 0 auto` 的 chip **不会改变行高**，
所以「不抖动」这条对它同样成立。两者由「显示方式」开关二选一，默认仍只开浮层。

### 1.4 已排除的路径（都试过，有证据）

| 方案 | 为什么不行 |
| --- | --- |
| 包装 `globalThis.fetch` | `dsh-web-fetch-http` 的 `requestPinned` 是 `await import("undici")` 后 `fetch(url,{dispatcher})`，自带私有 dispatcher，全局钩子抓不到 |
| 替换全局 undici dispatcher | 同上，`requestVia` 用的是 `route.dispatcher` |
| 监听 `tool/stream` 之类 | 源码里不存在这类事件 |
| `ctx.tools.guard` | 签名是同步的、只能返回拒绝原因，无法观测 |
| `subprocess` 服务 | 只有 `spawn`/`spawnTerminal`，**没有** spawn 事件，无法拦截子进程 |

---

## 2. 能显示什么、不能显示什么

### 2.1 有真实进度（进度条 + 已下载/总大小 + 速度 + 悬停百分比）

判据：命令行里能解析出**落盘目标路径**，且目标 URL 的 `HEAD` 能拿到 `Content-Length`。

| 形态 | 例子 |
| --- | --- |
| `curl -o <文件>` / `--output` / `--output-document` | `curl -L -o D:\x\a.zip https://...`；`--output=D:\x\a.zip` 等号写法同样识别 |
| `curl -O` / `--remote-name` | 目标推断为 `cwd + basename(url)` |
| `wget -O <文件>` | 同上；`--output-document=o.bin` 也可 |
| `Invoke-WebRequest -OutFile <文件>` | 必须有 `-OutFile`；`-OutFile:D:\x` 冒号写法也认（PS 参数语法允许 `-Param:Value`） |
| `git clone <url> <dir>` | 采样目录总体积 |
| `powershell -File <脚本>` / `pwsh -File <脚本>` | 静态解析脚本里的落盘路径，见 2.1.1 |
| `certutil -urlcache -split -f <url> <文件>` | 合法 urlcache 动作才认，`-hashfile` 等不算 |

进度 = 目标文件体积 / `Content-Length`；速度 = 滑动窗口（约 1s 跨度）算出的字节速率。
Host 每秒采样一次；Client 空闲期每秒拉一次，**有卡在跑时 400 ms 补一拍**（见 8.6.2）。

**`Start-BitsTransfer` 走另一条路**：实测（2026-10-25，`lab/work/write-shape.mjs` 每 200 ms stat）
BITS 先把字节写进同目录 `BITxxxx.tmp`，14.8 s 时一次性写满 41943040 字节，跑完才改名到
`-Destination`——**目标文件在整个传输期间不存在**。所以它被登记为 `staged:true`：不探
`Content-Length`、不算百分比，卡片只画「下载中 + 已耗时」，且 `sweep()` 里不会因「不增长」
被判成停住。`Start-BitsTransfer <url>`（无 `-Destination`）目标路径由 BITS 自定，一律不猜。

`certutil` 的写盘形状**本机未能实测**（`certutil.exe` 在该环境被策略拦，spawn EPERM，
三种提权方式都试过）。按普通文件采样处理，属推断而非实测结论。

`git clone` 的目标是**目录**，而 Windows 上 `stat(dir).size` 恒为 0——早期版本直接
`stat` 目标，于是整个 clone 期间读到「0 字节、无增长」，空闲计数器几秒后就把卡片收了。
现在 clone 任务带 `clone` 标记，采样走 `directoryBytes()` 累加目录树（跳过符号链接/junction，
最多 20000 条目、12 层，超限就停在当时的和，宁可少数也不会卡住主线程）。

卡片底部另有一行状态信息（`.ddp-log`，透明度 0.55，单行截断）：显示**下载来源 URL**；
命令里没有 URL 时退回目标文件路径，再退回命令行首行。只显示这一行，不堆历史。

### 2.1.1 `-File` 脚本这条路（`script.js`）

**为什么需要**：`powershell -NoProfile -ExecutionPolicy Bypass -File E:\win22h2\get-iso.ps1`
这行命令里没有任何路径、没有下载器名、没有 `-OutFile`，`classify()` 的三条下载判定全不沾，
在分类阶段就被否掉。但脚本里明明有 `Invoke-WebRequest -OutFile` 或 `& curl.exe -o $Out`。

**做过又被否掉的两条路（别再试）**：

- **进程 IO 计数**：`Get-CimInstance Win32_Process` 的 `ReadTransferCount` / `WriteTransferCount`
  只统计**文件/设备**读写，**socket 流量完全不计入**。实测 12 MiB 下载只让它动了 0 字节。
- **TCP 扩展统计**：`GetPerTcpConnectionEStats`（iphlpapi）理论上能按 4-tuple 拿 `DataBytesIn`，
  但需要先 `SetPerTcpConnectionEStats` 启用、要遍历 `Get-NetTCPConnection`、还要处理端口字节序，
  单次开销到不了 1 Hz 采样预算，且子进程（`& curl.exe`）的连接归属 PID 判定不稳。放弃。

**现在这条路**：检测到 `-File <路径>` → 同步读一次脚本（`readFileSync`，实测
**0.409 ms / 1612 字节**）→ 纯文本解析出落盘路径和 URL → 后面跟普通下载一样走文件大小采样。

能算的（`script.js` 的 `parseScript`）：

- 单层字面量赋值：`$iso = "D:\x\a.iso"` / `$Out = 'x.iso'`
- `param([string]$Out = 'C:\x.iso')` 的默认值
- `$env:USERPROFILE` / `$env:TEMP` 等环境变量展开（大小写不敏感）
- `Join-Path $dir 'name'` 的链式求值（`Join-Path` 嵌套也吃）
- `-OutFile` / `-o` / `--output` / `-Destination` 后面的路径参数
- 脚本里的 URL（供 `Content-Length` 探测）

**一律不猜**（解析不出就返回空 → 不出卡片，绝不出错卡片）：

- 循环里的赋值（`foreach` / `for` 体内）
- `Get-Content cfg.json` 之类运行时才知道的取值
- `+` 拼接、here-string、`$(...)` 子表达式
- 含 `$` / `%` 无法解析的路径

安全边界：只读、只解析、不执行；`classify()` 全程 try/catch，观测失败绝不影响被观测的 tool call。


### 2.2 只能显示"进行中"（不确定态进度条）

| 形态 | 显示文案 | 底部信息行 |
| --- | --- | --- |
| 插件安装 | `插件安装中...下载中...`；`applying` 阶段换成 `插件安装中...应用配置中...` | pnpm 输出的**最新一行**（整块输出只取最后一行） |
| 网页抓取 | `正在抓取网页中...<N>s`，秒数实时递增 | 被抓取的 URL |
| 搜索（research/web_search 等） | `正在搜索「<摘要，最多 50 字>」中...请稍后` | `工具名 · 完整查询词`（不受 50 字限制） |

搜索卡片的标题取自 `searchQuery(args)`：真实工具（`web_search` / `advanced_search` /
`multi_search`）声明的是 **`queries` 数组**，早期只读 `query`/`question`/`q` 三个标量键，
于是真实调用一律取到空串，卡片渲染成 `正在搜索「…」中` 完全没有主题。现在先读标量
（仍优先，兼容旧参数），没有就把 `queries` 用 ` · ` 连起来。
| 其他包管理器命令（pip/npm/docker pull…） | `载入中...`（统一未定义条，后续若拿到数据流再细化） | 命令行首行 |

### 2.3 拿不到的（明确说明）

- **`Invoke-WebRequest` 不带 `-OutFile`**：全在内存里，磁盘上没有可采样的文件 → 不触发。
- **目标是目录/多文件**：只采样已知的顶层目标。`git clone` 是唯一的例外，
  见下一条。
- **命令里用变量拼路径**（如 `-o $dst`）：插件只能读到命令行文本里的字面量 `$dst`，解析出的路径不存在 → 任务约 5 秒后被回收，不显示进度。
- **纯内存下载 / API 调用**：无落盘 → 无进度。
- **上传（`curl -T` / `--upload-file`）**：本端不写文件，卡片只可能永远停在 0 B，
  所以**整段排除**。排除是**按命令段**判的：`curl -T a u && curl -o out u2` 这种
  既传又下的命令仍然出卡片（下载那一段确实在长）。`-T` 只在与 `curl` 同一个命令段、
  且作为独立参数时才算，`git commit -m "add -T support"`、URL 里的 `?upload-file=`
  都不误判。
- **`-File` 脚本里路径要跑起来才知道**：`Get-Content cfg.json` 取值、`+` 拼接、here-string、
  `$(...)` 子表达式、循环内赋值——一律不猜，不出卡片（理由见 2.1.1）。脚本被改写后，
  要等**下一次**工具调用才会重新读，不会热更新。

---

## 3. UI 独立抽出的做法（改样式只动一处）

Client 半**发布产物**是单文件 `client.js`（宿主按一个 bundle 下发，它不能写 `import`），
但**源码**在 `src/client/` 里按职责分片，由 `scripts/build-client.mjs` 按固定顺序拼回去：

```
src/client/
├── 01-prologue.js      ← 顶部注释 + 模块头
├── styles-open.js      ← CSS 模板字符串的开头（后面插 css/*.css）
├── css/overlay.css     ← 浮层视觉（改外观只动这里）
├── css/inline.css      ← 简易条视觉
├── css/settings.css    ← 设置页视觉
├── styles-close.js     ← 模板字符串收尾
├── 20-utils.js         ← 纯函数（截断、去重、格式化）
├── 30-settings.js      ← 设置项与默认值
├── 40-samples.js       ← 调试模式的模拟数据
├── 50-presence.js      ← 「有没有任务在跑」的探测
├── 60-data.js          ← taskStore（全插件唯一的轮询器）+ describe()
├── 70-views.js         ← VIEWS 表：wire → view-model
├── 75-sessions.js      ← 会话 id/标题解析
├── 78-scope.js         ← 当前会话过滤
├── 80-drag.js          ← 拖动定位
├── 85-inline.js        ← InlineBar（对话框简易条，见 §3.3）
├── 90-overlay.js       ← Card + Overlay（浮层）
├── 95-settings-page.js ← 设置页
└── 99-plugin.js        ← 三个槽位挂载
```

**改任何一片都必须跑 `node scripts/build-client.mjs`**，它把 `src/client/**` 拼成 `client.js`；
`node scripts/build-client.mjs --check` 会在产物过期时失败并指出第一处差异（`npm test` 第一条就是它）。
顺序是显式写死的一张表，不是目录序：浏览器从上往下读，切片顺序错了会出 TDZ 错误，
而这种错误**在 Node 里看不见，只在真机 UI 里炸**。

- **改颜色/圆角/动画/位置** → 只改 `src/client/css/*.css`。
- **改文案/文案格式** → 只改 `describe()`；简易条的极简文案单独在 `briefOf()`（§3.3）。
- **改卡片结构** → 只改 `Card()`。
- **改简易条结构** → 只改 `InlineBar()`。
- **改数据获取/失败策略** → 只改 `taskStore`。两个表面（浮层 + 简易条）都在不同槽位、
  不同 React 树里，靠模块级 store 共享同一帧；`subscribe()` 引用计数，第一个订阅者启动、
  最后一个退订停止。**不要**让任何表面自己 `fetch('/download-progress/state')`——
  那会分裂成两份可能不一致的列表，bug 就只在一个表面上出现。

样式注入走 `ctx.effect(() => { 建 <style id="dsh-download-progress-style">; return () => 移除 })`，
随插件卸载自动清理，不污染全局。

主题色全部用宿主 token 并带兜底值：
`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1`、`--dsw-alias-label-primary`、
`--dsw-alias-label-secondary`、`--dsw-alias-brand-primary`、`--dsw-alias-bg-layer-2/3`、`--dsw-alias-scrollbar-bg-l2`。

### 3.1 视觉规格（当前实现）

- 位置：`position:fixed; top:76px; left:50%; transform:translateX(-50%)`（默认顶部居中，可拖动，见 §3.2.2），
  宽度 `min(560px, 100vw-48px)`，`z-index:10000`。
  固定定位 + 不参与布局 ⇒ 出现/消失零位移。
- 平时只渲染一条 56×6px 的把手（`.ddp-handle`，opacity .22，hover 变亮变宽），
  鼠标移上去才展开卡片列表，见 §3.2.1。调试模式下把手带文字标签（`.ddp-handle--debug`）。
- 容器 `pointer-events:none`，只有把手与卡片列表 `pointer-events:auto` ⇒ 不挡住下面的内容。
- 进度条高 5px，圆角；填充色 `--dsw-alias-brand-primary` 的 **62% 透明版本**
  （`color-mix(in srgb, … 62%, transparent)`，不支持 `color-mix` 的引擎回落到实色），
  槽底色能透出来，不再是压住轨道的一整块纯色；`width` 有 `transition: .45s linear`。
- 动画：填充层叠一条 1.5s 循环的高光扫过（`@keyframes ddp-shine`）；
  不确定态用 38% 宽的滑块来回跑（`@keyframes ddp-slide`）。
- 悬停百分比：`.ddp-track:hover .ddp-tip{opacity:1}`，提示框在轨道右上方。
- **每条卡片底部一行状态信息**（`.ddp-log`）：11px、`opacity:.55`、单行 `ellipsis`。
  只显示**最新一行**，内容按形态不同（见 §2.1/§2.2）：下载给 URL、抓取给 URL、
  搜索给「工具名 · 完整查询词」、插件安装给 pnpm 最新一行、其他给命令行首行。
  拿不到任何信息时不渲染这一行。
- 多任务：竖向堆叠，`max-height:calc(var(--ddp-rows) * 62px + (var(--ddp-rows) - 1) * 8px + 6px)`
  （按卡片实际高度 + 间距算，刚好容纳设定条数，超出滚动）。

### 3.2 设置界面（`settings.section`）

插件在「设置 → 插件」里自带一页配置，用的是官方列表槽位 `settings.section`
（`list` / `scope: root` / `replaceRisk: none`，描述原文 "One settings page per list entry"），
没有自定义页面、没有改设置容器。

| 配置项 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| 显示下载进度浮层 | 开 / 关 | 开 | 关掉后**不再轮询状态接口**，也不渲染任何浮层（Host 半仍在采样，开销可忽略） |
| 显示方式 | 浮层 / 对话框简易条 / 两者都显示 | 浮层 | 选「简易条」后上方浮层不再出现，进度改画在输入框那一行。见 §3.3 |
| 显示下载速度 | 开 / 关 | 开 | 关掉后文案只留「已下载 / 总大小」；简易条则只留条 / 任务类型 |
| 调试模式（显示模拟数据） | 开 / 关 | **关** | 关：只显示真实下载，没有下载就完全不显示。开：没有下载时出现一条把手，悬停展开 5 张模拟卡片调 UI |
| 新任务的排列位置 | 最新在前 / 最新在后 | 最新在前 | 多条任务时最新出现的排顶部还是底部（`newest-first` 会把 Host 的插入顺序反转） |
| 最多同时显示条数 | 1–6 | 3 | 通过 CSS 变量 `--ddp-rows` 控制 `max-height`，超出滚动 |
| 主题 | 跟随系统 / 亮色 / 暗色 | 跟随系统 | 只作用于浮层。见 §3.2.4；新增主题只需在 `THEMES` 里加一项，下拉自动出现 |
| 出现动画 | 上浮淡入 / CRT 开关机 / 水波纹 / 横向滑入 / 下落弹入 / 弹性放大 / 横扫揭示 / 翻折展开 / 旋转入位 / 模糊聚焦 / 无动画 | 上浮淡入 | 浮层出现与收起时的动效。见 §3.2.5 |
| 浮层位置 | 拖动把手 / 拖动卡片 / 「重置位置」按钮 | 顶部居中（`y=76px`） | 位置不用下拉框选，直接拖 |

配置存在 `localStorage['dsh-download-progress:settings']`，**不落 Host 配置文件**——
这样升级/重装插件不会丢，也不需要引入任何持久化服务。
读取时逐字段做合法性归一化（未知值回落默认），所以手改坏 localStorage 不会让页面崩。

### 3.2.1 默认只显示真实数据；模拟数据要手动开

**调试模式关闭（默认）**：浮层只显示真实下载。没有下载任务时**什么都不渲染**（`return null`，
连把手都没有），所以屏幕上永远不会出现一个来路不明的进度条。

**调试模式打开**：没有下载任务时出现一条**带文字标签的把手**（`.ddp-handle.ddp-handle--debug`，
140px × 20px、"下载进度条 · 示例预览"、透明度 0.72），并且**勾上的瞬间就展开 5 张模拟卡片**，
不需要悬停——否则只多一条 6px 淡线，看起来和没开一样。

| 调试模式 | 有真实下载 | 屏幕上看到什么 |
| --- | --- | --- |
| 关 | 有 | 有几个任务就显示几张真实卡片（把手不显示） |
| 关 | 无 | **什么都不显示** |
| 开 | 有 | 只显示真实卡片（示例数据让位，永不混排） |
| 开 | 无，刚勾上 | 带标签的把手 + **立刻展开 5 张模拟卡片** |
| 开 | 无，鼠标移开 | 收起成带标签的把手 |
| 开 | 无，鼠标移到把手上 | 再次展开 **5 张模拟卡片**（下载 / 安装 / 抓取 / 搜索 / 载入中），并画出虚线轮廓 `.ddp-wrap--peek` |

设计要点：

- **模拟数据默认不可见**：`debugMode` 默认 `false`，避免把假进度条误当成真下载。
- **两者永不混排**：只要有一个真实任务，模拟数据立即让位。
- **模拟数据不落盘**：只有 `peekState` 在内存里，刷新即清空；`localStorage` 里存的是 5 个偏好加位置坐标。
- **模拟数据是真动的**：下载形态按 3.4 MB/s 推进、速度带轻微正弦抖动，跑满 28.3 MB 停留 1.2s 再循环；
  安装形态日志行每 1.2s 换一条、6s 后切到 `applying` 阶段。用来验证"每秒刷新一次"的观感。
- **模拟卡片行数不受"最多显示条数"限制**：`--ddp-rows` 在预览时取 `max(maxVisible, 卡片数)`，
  保证 5 种形态能一次看全；真实任务仍严格按设置裁剪。
- **悬停不会误收起**：把手和卡片列表之间的 6px 空隙用 `.ddp-handle::after` 透明扩展命中区补上，
  再加 180ms 的收起宽限期（`LEAVE_GRACE_MS`），期间指针回到把手或卡片就取消收起。

### 3.2.2 拖动定位

- **默认位置在上方**：`top:76px` + `left:50%` + `translateX(-50%)`（水平居中、靠上），
  这样不会压在输入框/发送按钮上。
- **两个拖动起点**：调试模式下拖那条细把手；有真实任务时拖任意卡片。
  （调试模式关且没有任务时浮层不渲染，也没东西可拖。）
- **怎么拖**：`pointerdown` + window 上的 `pointermove/pointerup`，指针移出元素也能继续跟手。
  事件挂在 `window` 上而不是元素上，所以**即使设置页弹窗打开着也能拖**（早先版本挂元素上，弹窗遮住就拖不动）。
- **坐标基准是容器不是把手**：拖动开始时用 `event.currentTarget.closest('.ddp-wrap')` 量矩形。
  早先按把手自身量，而 `top/left` 定位在容器上，把手又在容器内部偏移 12px ⇒ 每拖一次容器上跳 12px；
  加宽后 clamp 的上限也会算错。
- **5px 阈值**：按下后位移不到 5px 不算拖动，所以点一下不会误移动。
- **钳制**：拖动位置被限制在视口内（四边各留 8px），拖不出屏幕。
- **`translateX(-50%)` 永远不动，`left` 永远指中心点**：拖动时 `left = drag.x + drag.half + 'px'`（像素），
  松手后 `left = 设置里的百分比`。两个分支共用同一个 transform，因为 `left` 有 180ms 过渡而 `transform` 没有：
  早先拖动态写 `transform:none`、松手改回 `translateX(-50%)`，就在松手的瞬间把卡片**瞬移半张宽度**，
  再被过渡拉回来——肉眼看到的就是"松手先往左闪一下又弹回原位"。
  所以 `left` 的语义统一为"卡片中心"，任何分支都不许把 transform 改回 `none`。
- **列表不显示滚动条**（`scrollbar-width:none` + `::-webkit-scrollbar{width:0}`）：经典滚动条**占布局宽度**，
  条目一超过条数上限就会出现，卡片随之整体变窄 6px、日志行重新折行——看着像渲染错位。
  现在只用滚轮/触控板滚动，轨道不占位。所以主题里的 `--ddp-scroll` 变量已无引用，一并删掉。
- **记忆的是比例，不是像素**：松手时写进 localStorage 的是卡片**中心点占视口宽度的百分比**
  （`left: 66.67%` + `translateX(-50%)`），`x: null` 表示"水平居中"。
  早先存的是像素，窗口一变宽/变窄它就停在原地、看起来"不居中"了；换成百分比后由浏览器在每次布局时解析，
  窗口怎么改都保持同样的相对位置，而且**不增加任何 JS 开销**。
  旧版本留下的像素值（>100）在下一次读取时被判为非法，自动退回居中。
- **窗口变窄时的兜底**：百分比在极窄窗口下可能让卡片贴边溢出，所以 `window.resize` 里按实测卡片宽度
  重算一次百分比上下限（`(半宽+8)/视口宽`），越界才修正并写回；不越界什么都不做。
- **「重置位置」**：把 `x` 置回 `null`、`y` 回到 76。
- **拖动时不抖**：拖动中给 `.ddp-wrap` 加 `.ddp-wrap--drag`，关掉 `top/left` 的过渡
  （否则会拖尾），并禁用文本选择与悬停百分比气泡。
- **拖动/缩放窗口时不拖累宿主**：`window.resize` 用 `requestAnimationFrame` 节流，并在手势期间给容器加
  `.ddp-wrap--resizing`，临时把 `backdrop-filter` 关掉——实时缩放时每帧重新模糊一大块背景才是真正贵的地方，
  松手后 200ms 自动恢复。玻璃效果在窗口还在动的时候本来就看不出来，所以肉眼无感。

### 3.2.3 层级（z-index）

浮层 `z-index: 10000`，不会被设置弹窗盖住。
层级抬高没有副作用：容器本身 `pointer-events:none`，只有把手和卡片列表 `pointer-events:auto`，
且宽度上限 560px，不会挡住必须点击的按钮。

### 3.2.4 主题（可扩展注册表）

三种主题：**跟随系统**（默认）/ **亮色** / **暗色**。只作用于浮层，不改 DSH 自身主题。

实现方式是「主题 = 一组 CSS 自定义属性」：

```js
const THEME_TOKENS = {
  light: { '--ddp-accent': '#2f7fe0', '--ddp-fg': '#1b1b1f', '--ddp-card-bg': 'rgba(255,255,255,.97)', … },
  dark:  { '--ddp-accent': '#4c8dff', '--ddp-fg': '#e8e8ea', '--ddp-card-bg': 'rgba(32,32,36,.96)', … },
}

const THEMES = [
  { id: 'auto',  label: '跟随系统', tokens: null },   // 空 = 不覆盖
  { id: 'light', label: '亮色',     tokens: THEME_TOKENS.light },
  { id: 'dark',  label: '暗色',     tokens: THEME_TOKENS.dark },
]
```

`Overlay` 把选中的 tokens `Object.assign` 到 `.ddp-wrap` 的 inline style 上；
CSS 里每条颜色规则写成 `var(--ddp-fg, var(--dsw-alias-label-primary, #e8e8ea))`
——**三级回落**：主题给了就用主题，没给就沿用 DSH 当前主题，连宿主变量都没有才用兜底色。

这样设计的三个好处：

- **「跟随系统」零成本**：`tokens: null` 什么都不覆盖，自动继承 `--dsw-alias-*`，
  而宿主那套变量本来就跟着应用主题（应用跟系统时也就跟着系统）。
- **加主题不改 CSS**：新增一个主题 = 往 `THEME_TOKENS` 加一个对象、往 `THEMES` 加一行；
  设置页下拉是从 `allThemes()` 生成的，**选项自动出现**，不用再动设置页代码。
- **外部主题零改代码**：见下。

只覆盖**颜色**类变量，不覆盖尺寸/间距/圆角——换主题不会改变布局，也就不会让浮层抖一下。

#### 加一个自己的主题（不改代码）

在浏览器控制台执行一次（以 `localStorage` 为例）：

```js
localStorage['dsh-download-progress:themes'] = JSON.stringify([
  {
    id: 'solarized',
    label: 'Solarized',
    tokens: {
      '--ddp-accent': '#b58900',
      '--ddp-fg': '#657b83',
      '--ddp-card-bg': 'rgba(253,246,227,.97)',
      '--ddp-track-bg': 'rgba(0,0,0,.10)',
      '--ddp-pop-bg': '#fdf6e3',
    },
  },
])
```

刷新页面后，设置页「主题」下拉里就会多出「Solarized」。规则：

- 键必须是 `--ddp-*`，且 `--ddp-rows`（布局变量）被**明确拒绝**，外部主题改不了排版；
- 值与内置主题同一套变量名（`--ddp-accent` / `--ddp-fg` / `--ddp-fg-dim` / `--ddp-grip` /
  `--ddp-card-bg` / `--ddp-card-border` / `--ddp-track-bg` / `--ddp-pop-bg` / `--ddp-pop-border` /
  `--ddp-scroll` / `--ddp-inner-hi` / `--ddp-glass` /
  `--ddp-sheen` / `--ddp-ripple` / `--ddp-chip-bg` / `--ddp-chip-border`）；
- 与内置 id 重名的条目会被丢弃（内置优先）；值只接受 `#..`、`rgba(..)`、颜色名这类安全字符；
- 不填的变量自动回落到宿主 `--dsw-alias-*`，所以**只写一两个变量也能用**。

### 3.2.5 卡片质感与出现动画

**质感：苹果式毛玻璃（frosted glass）**。真正的"玻璃感"来自 `backdrop-filter` 对背后内容取景模糊，
卡片本身只是一层**很淡的半透明染色**；底色一旦不透明，模糊就完全看不到了。

| 来源 | CSS | 变量 | 作用 |
| --- | --- | --- | --- |
| 半透明底 | `background: var(--ddp-card-bg, color-mix(in srgb, var(--dsw-alias-bg-overlay) 62%, transparent))` | `--ddp-card-bg` | 染色层。亮色压到 **0.26**、暗色 **0.40**，只为让背后的模糊透得出来 |
| 模糊 + 饱和 | `backdrop-filter: var(--ddp-glass, blur(24px) saturate(180%))` | `--ddp-glass` | 玻璃的主体。亮色主题**不加** `brightness()`——那会把片子推向纸白；暗色保留 `1.06` |
| 细边框 | `1px solid var(--ddp-card-border, var(--dsw-alias-border-l1))` | `--ddp-card-border` | 玻璃的"切边"。亮色 10% 黑、暗色 12% 白；去掉外阴影后，边界感全靠这条线 |
| 内顶亮线 | `inset 0 1px 0 var(--ddp-inner-hi, …)` | `--ddp-inner-hi` | 顶边一道细亮线，读作被光照到的玻璃上沿 |
| 内底暗线 | `inset 0 -1px 0 var(--ddp-card-border, …)` | `--ddp-card-border` | 底边同色 1px，读作玻璃厚度；复用边框色，不额外引入变量 |
| 顶部渐层 | `::before` 的 `linear-gradient(180deg, …)` | `--ddp-sheen` | 玻璃上沿略亮、到 46% 处淡出 |

**外投影已被彻底移除，别再往回加**。原因不是审美，是几何：`.ddp-list` 是滚动容器，
必须是 `overflow-y:auto`，而滚动容器会对后代做 clip。卡片的 `box-shadow` 只能画在
padding-box 里，向外扩散的部分被切成一个硬矩形——用户看到的就是"所有进度条背后还有一层盒子"。
玻璃在这个结构下只能靠**模糊 + 边框**立起来，任何向外扩散的阴影都只能得到一个环或一个底板。
当前 `box-shadow` 只剩两条 inset（上亮线 + 下暗线），`--ddp-shadow` 变量已删除
（外部主题写了会被忽略，无害）；`.ddp-card:hover` 只 `translateY(-1px)`，不再重复声明阴影。

`.ddp-list` 的 `padding` 为 `4px`：卡片之间靠自身边框分隔，不该贴着滚动视口边缘被切掉。

亮色主题尤其容易翻车：`--ddp-card-bg` 一旦到 0.6 以上、再叠 `brightness(1.04)` 和
0.42 的顶部渐层，就不会像玻璃，而像一张白卡片。当前三者的取值是 0.26 / 无提亮 / 0.14，
是照着"能透出背后内容、又压得住文字"调出来的；要改就三个一起改。

两个刻意的取舍：

- **没有左上角光斑了**。之前那版 `radial-gradient(130% 110% at 0% 0%, …)`（`--ddp-gloss`）会读成
  一块打在卡片上的塑料高光；苹果的 vibrancy 是"模糊 + 低不透明度 + 细边 + 柔影"，不靠高光造立体。
  变量已删除，外部主题写了也会被忽略（无害）。
- **`auto` 主题也走 `color-mix`**。主题给了 `--ddp-card-bg` 就直接用主题值；没给（跟随系统）就把宿主
  `--dsw-alias-bg-overlay` 降到 74% 透明——这样跟随系统时同样是玻璃，而不是一块实心底色。

`.ddp-card` 现在是 `position:relative; overflow:hidden; isolation:isolate`；光泽层 `::before`、
波纹层 `::after` 都是 `z-index:0`，内容统一 `z-index:1`。**`overflow:hidden` 是为了把波纹裁在圆角内**；
悬停百分比的 `.ddp-tip` 气泡向上弹出（`bottom: calc(100% + 6px)`），实测仍在卡片内部
（tip 顶边 ≈ 卡片内 10px），不会被裁。悬停时卡片上抬 1px；拖动过程中 `.ddp-wrap--drag` 关掉这个上抬。

**出现动画十选一 + 无动画**，**挂在每张卡片上**（`.ddp-card` 带 `ddp-ease-<id> ddp-anim--in|out`）：

| id | 设置项 | 效果 |
| --- | --- | --- |
| `float` | 上浮淡入（默认） | 淡入 + 上移 10px + 轻微缩放 |
| `crt` | CRT 开关机 | 出现：从一条过曝的细亮线（`scaleY(.004)` + `brightness(2.6)`）纵向展开，过冲 6% 再回落；收起：反向压成亮线后消失 |
| `ripple` | 水波纹 | 出现：卡片从 `scale(.94)` 弹性涨到 1，同时 `::after` 圆形波光从中心 `scale(.12)` 扩散到 2.2 并淡出；收起：缩到 `.96` 淡出 |
| `slide` | 横向滑入 | 从左侧 16px 外滑入；收起向右 14px 淡出（唯一方向不对称的一种） |
| `drop` | 下落弹入 | 从上方 14px 落下，回弹靠 `cubic-bezier(.34,1.42,.5,1)`；收起向上 10px 淡出 |
| `pop` | 弹性放大 | 从 `scale(.86)` 弹到 1，回弹靠 `cubic-bezier(.2,1.5,.4,1)`；收起缩到 `.9` |
| `wipe` | 横扫揭示 | `clip-path:inset(0 100% 0 0)` → `inset(0)` 硬边扫过，不淡入；收起反向扫掉 |
| `flip` | 翻折展开 | `perspective(620px) rotateX(-74deg)` 翻下来，中途过冲 6deg；收起 `rotateX(58deg)` |
| `spin` | 旋转入位 | `rotate(-8deg) scale(.9)` 螺旋归位；收起 `rotate(5deg) scale(.94)` |
| `blur` | 模糊聚焦 | `filter:blur(9px)` + `scale(1.02)` 收成清晰；收起再糊掉 |
| `none` | 无动画 | 直接出现 / 直接消失 |

**新增一种动画要做两件事**：`ENTER_ANIMS` 表里加一行（`id` / `label` / `outMs`），
CSS 里加一对 `.ddp-anim--in.ddp-ease-<id>` + `.ddp-anim--out.ddp-ease-<id>` 和对应
`@keyframes ddp-<id>-in` / `-out`。`smoke.mjs` 会遍历下拉框里每个 id，**逐个断言
「卡片拿到该类」+「CSS 有该规则」+「有该 @keyframes」**，所以漏任何一个都会当场红。
下拉框是 11 项（10 种 + 无动画），`options !== 11` 也会红——加动画时记得同步改这个数字。

**为什么新加的六种不用 `filter`**：卡片上的 `filter` 会创建新的 backdrop root，
动画期间毛玻璃模糊失效（见下面的 CRT 瑕疵）。`slide`/`drop`/`pop`/`wipe`/`flip`/`spin`
只用 `transform` 和 `clip-path`，玻璃全程保留；只有 `blur` 是明知故犯——它要的就是
「从糊到清」那一下，玻璃重新聚焦正是效果本身。

**水波纹怎么做的**：`::after` 是一个 `width:200%; aspect-ratio:1` 的圆，`radial-gradient(circle,
var(--ddp-ripple) 0%, transparent 62%)`，平时 `opacity:0`，只有 `.ddp-ease-ripple::after` 播
`ddp-ripple-wave` 关键帧。因为卡片 `overflow:hidden`，波光被圆角裁住，看起来是**光从玻璃内部涌上来**，
而不是外面飘一圈光晕（后者会盖到相邻卡片）。关键帧里缩放和居中位移写在同一个 `transform` 上，
所以每帧都要写全 `translate(-50%,-50%) scale(…)`。

`--ddp-ripple` 是波纹颜色（亮色偏蓝 `rgba(90,140,255,.24)`，暗色 `rgba(120,170,255,.22)`），主题可换。

已知小瑕疵：`crt` 和 `blur` 两种用 `filter` 的动画会创建新的 backdrop root，动画期间
（`crt` 约 300ms、`blur` 约 380ms）毛玻璃模糊会失效（卡片退化成纯半透明色）。时长极短，
且 `blur` 的「重新聚焦」正是效果本身，暂不处理。

**动画是逐条的，不是整个框一起动**——这是刻意的：

- 类挂在 `.ddp-card` 上而不是 `.ddp-list` 上，所以整个列表不会作为一块整体缩放/过曝；
- 入场按 `index * 55ms` 错峰（`animation-fill-mode: backwards`，否则延迟期间卡片会先以满不透明度闪一下再跳回动画起点）；
- 新出现的一条下载只播它自己，已有的卡片不受影响；
- 退出时列表保留最后一帧内容（`held.list`），所以每张卡能各自播完熄灯动画，而不是容器整体淡出。

代价是动画**不占布局**：`transform` 与 `filter` 只影响绘制，卡片高度和 `--ddp-rows` 算出的 `max-height` 都不变，
所以窗口不会因为动画而抖动或错位。

加一种动画要改三处（都很短）：`ENTER_ANIMS` 加一行（含退出时长 `outMs`）、CSS 加一对
`@keyframes` 和两条 `.ddp-anim--in.ddp-ease-<id>` / `.ddp-anim--out.ddp-ease-<id>` 规则。
设置页下拉由 `ENTER_ANIMS` 生成，会自动多出选项。

`outMs` 是给 `usePresence` 用的：宿主必须在退出动画播完前保持节点挂载，`none` 填 `0` 就立即卸载。

### 3.3 对话框简易条（`conversation.input.left`）

用户 2026-10-22 追加的第二形态：有人嫌顶部弹出的浮层吵，希望进度「安静地长在输入框上」。

**槽位**：`ctx.slots.register({ name: 'conversation.input.left', id: 'dsh-download-progress', order: 2000 }, InlineBar)`，
就是「完全权限」那一行所在的 **list 槽位**。

**唯一的硬约束是「不要挤别人」**（同一行还住着额度条、技能 chip 等）：

- 根节点 `flex:0 0 auto`，宽 `max-width:min(240px,40vw)` —— 只占自己要的宽度，绝不 `flex:1`；
- 一行放不下时先牺牲自己：轨道 `flex:0 1 auto`（`min-width:36px`，首选 64px），
  文字 `flex:0 1 auto` + `ellipsis`；
- `order:2000` 排在这些已知邻居之后（额度 4、技能 chip 1000），后来的插件挑更大 order 就能把它往后推；
- **本会话没有任务时 `return null`** —— 不渲染空 chip，空闲时那一行一个像素都不占。

**极简内容**（需求原文：一条进度条 + 速度，不显示详情，悬停才给百分比）：

**三种形态，由数据决定，不由设置决定**（2026-10-22 追加）：

| 形态 | 什么时候 | 画什么 | 悬停气泡 |
| --- | --- | --- | --- |
| `bar` 长条 | 能算出比例（下载且知道总大小、HEAD 没被拒） | 细轨道 + 填充 + 流光扫过 + 速度 | `28.0%` |
| `ring` 圆环 | 有任务、有类型，但拿不到比例（搜索/抓取/安装/下载未知大小） | 一个 `conic-gradient` 弧一直转，**不印任何字** | `搜索中 · 12s` / `下载中 · 2.86 MB · 512 KB/s` |
| `dots` 三点 | 连任务类型都没有 | 三个点依次呼吸 | `处理中` |

**为什么三个 body 都常驻 DOM**：形态切换要"自然过渡"，而 `width:auto` 无法过渡、只有固定宽度能。
所以三个 body 全部渲染，用 `ddp-mx--<shape>` 类把不用的两个压到 `width:0 / max-width:0 / opacity:0`，
切换时轨道从 64px 收到 0、圆环从 0 涨到 13px，同一 300ms 内交叉完成 —— 胶囊宽度是滑过去的，不是跳过去的。
**条件渲染任何一个 body 都会让宽度跳变，看起来像硬切。**

**流光**：`.ddp-mx-fill::after` 一条 `linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent)`，
`translateX(-100%) → 100%` 循环 1.9s。**挂在 fill 上而不是 track 上**：光只在"已完成"的字节上流动，
扫过空轨道会让人误以为进度在动而实际没有。

**hover**：胶囊本体 `background/border/box-shadow` 过渡 + 上抬 1px（与浮层卡片同一套交互语言）；
内部元素加速（流光 1.9s→1.1s、圆环 .85s→.55s），所以指过去是"有反应"的。气泡同时从 `translateY(3px)` 弹到位。
**不用 scale 放大**：`transform` 会创建新的 backdrop root，hover 期间毛玻璃会失效（和 §3.2.5 里 CRT 的毛病同源）。

| 情况 | 画什么 |
| --- | --- |
| 同会话多个任务 | 跟最早那条走，右侧 `+N` 数字 chip（22px 高的行画堆叠条只会更难读） |
| 关掉「显示下载速度」 | 长条态只留条；圆环/三点本来就没字 |

**只显示当前会话**：用槽位自己传下来的 `props.sessionId` 过滤（`sessionKeyOf(task) === sessionId`），
不是用 `currentOnly` 那套 `useSessions` 探测——它长在哪个输入框上就只报那个会话，切会话天然跟着换。

**主题共用**：根节点 `style={themeTokens(settings.theme)}`，跟 `Overlay` 同一个注册表（`THEMES` /
`--ddp-*`）；新增一条 `--ddp-mx-bg` / `--ddp-mx-border` / `--ddp-mx-glass` 就够给简易条单独调材质，
不填就跟随 `--ddp-fg` / `--ddp-accent` 等既有 token。

**显示方式开关**：`settings.display` = `overlay`（默认，行为与升级前完全一致）/ `inline` / `both`。
`overlay` 时简易条**一个节点都不注册渲染**（`wantsInline` 为假 → `return null`，不订阅轮询）；
`inline` 时 `Overlay` 自己返回 `null`。两种形态各自独立判空，不会同时抢屏。
两者的轮询由模块级 `taskStore` 引用计数管理：只要还有任一表面订阅就保持一个 1s 循环，
全部关掉才停——所以 `overlay` 模式下简易条不渲染，浮层仍照常刷新。

**hooks 顺序**：`InlineBar` 里 `useSettings` / `useTasks` 全在顶部，`return null` 只出现在它们之后——
与 §5.4 同一条规矩，`smoke.mjs` 的 hook 计数守卫也覆盖了它。

---

## 4. 数据契约

`GET /download-progress/state` → `{ "tasks": [ ... ] }`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | 工具 `callId` |
| `kind` | `download` \| `install` \| `fetch` \| `search` \| `pkg` | 形态 |
| `name` | string | 工具名 |
| `label` | string | 展示名（文件名 / 查询词 / 包名） |
| `bytes` | number | 已落盘字节 |
| `total` | number \| null | 总字节（HEAD 探测，拿不到为 null） |
| `speed` | number | 字节/秒 |
| `phase` | string | 安装阶段 |
| `log` | string | 最新一条安装日志 |
| `startedAt` / `elapsedMs` | number | 起始时间 / 已用时 |
| `done` | boolean | 工具调用是否已返回 |
| `unresolved` | boolean | 下载类但没解析出落盘目标 |

`done` 与"是否还在长"是**两件事**：工具超时转后台后 `done` 立刻为 `true`，
但只要文件还在增长，任务就继续保留并继续显示进度（`sweep()` 里 `ready = done && 文件已静止`）。
连续 3 个采样周期文件没长 + 1.2s 延迟后，任务才被移除。

---

## 5. 兼容性说明（为什么后续版本不容易坏）

1. **只用官方扩展点**：`tools/execute` waterfall、`plugin-manager/*` 事件、`webServer.register`、`slots.register`。
   没有改核心文件、没有 monkey-patch 任何内部对象。
2. **waterfall 不夺权**：所有分支都 `return next()`，不改变任何工具的行为。
   即使插件崩了，也只影响自己那条 `try/catch`（`sweep` 外层也有兜底）。
3. **不写死宿主内部结构**：不 `require` 任何 `@deepseek-ai/*` 包；Client 半只 `require('react')`。
   主题色全部走 CSS 变量 + 兜底值，宿主换主题也不崩。
4. **零外部依赖**：没有 `dependencies`，不会因为上游包升级而断。
5. **数据通道是 HTTP 轮询**：不依赖 Client↔Host 的事件白名单
   （`API_REMOTE_FORWARDED_EVENTS` 是硬编码白名单，自定义事件名 `$on` 收不到——这也是当初不用 `ctx.remote.$on` 的原因）。
6. **槽位 `replaceRisk: none`**：`shell.overlay` 官方标注为可安全追加。

### 5.1 已知的脆弱点（升级时优先看这里）

- **`shell.overlay` 槽位名**：若上游改名，`slots.register` 会失败（表现为浮层不出现，不影响 DSH）。
- **`conversation.input.left` 槽位名或传入的 `sessionId`**：前者改名则简易条不出现；后者缺失时
  简易条**整个不渲染**（拿不到会话就没法只显示本会话，宁可空白也不串会话）。
- **`tools/execute` 签名**：若 waterfall 签名变了，`classify()` 拿不到 `exec.name/arguments` 就静默不触发。
- **`plugin-manager/install-log` 载荷字段**：用的是 `chunk.text`，若改字段名则安装日志行变空（进度条本身仍在）。
- **命令行解析是启发式的**：curl/wget 参数组合极多，未覆盖的写法会退化成"不触发"或"载入中"。

### 5.2 一个踩过的坑（重装/改包名时会遇到）

`clientModules` 服务对 `package.json` 的解析结果有**按 `baseUrl + loaderName` 的永久缓存**，
命中就直接返回（包括缓存下来的 `null`）。如果某次扫描时 `dsh.client` 还不存在，
会缓存 `null`，之后即使补上字段，禁用/启用插件也不会生效。

两种解法：

1. 改包名（`sourceKey` 变化，缓存自然失效）；
2. 不重启应用——在 Host 半里拿到服务自己清：

```js
const cm = ctx.get('clientModules')
cm.pkgMeta.delete(`${cm.baseUrl}\0@local/dsh-download-progress`)  // 键是 baseUrl + \0 + 包名
cm.dirty.add('@local/dsh-download-progress')
cm.flush()
```

第 2 种只在开发期用，**不要留在正式代码里**（`pkgMeta` / `dirty` 是内部字段，随时可能改名）。

### 5.3 客户端 bundle 的版本号

下发 URL 形如 `plugins/??<包名>/client.js&rev=<hash>`，`rev` 由 `client.js` 的
`mtime / ctime / size` 算出（`artifactRevision(baseline)`）。改了文件 → `rev` 变 → URL 变 → 浏览器必然重新拉取。
所以**改了 `client.js` 通常刷新一下页面就能看到**，不必重装插件。

### 5.4 条件 `return` 必须在所有 hook 之后

浮层有"什么都不显示"和"正常渲染"两种出口。如果把 `return null` 写在 `usePresence` /
`React.useState` 之前，两次渲染的 hook 调用数量就不同，React 直接抛
`Rendered fewer hooks than expected` 并**卸载整个组件**——表现为：
勾上调试模式没反应，关掉再打开就彻底打不开了（报错只在 console 里，界面上什么都没有）。

规则：`Overlay` 里所有 hook 集中在顶部，`return null` 只允许出现在
最后一个 hook 之后（当前在 `const ordered = ...` 之后）。

`smoke.mjs` 里有守卫：假 React 统计每次渲染的 hook 调用数，
只要和第一次渲染不一致就 throw，所以这类 bug 在本地就能拦住。

### 5.5 `engines.dsh` 必须带 prerelease 段

`package.json` 写的是 `"dsh": ">=0.2.0-rc.1"`，**不是** `">=0.2.0"`。

原因：semver 的 range 里如果没有 prerelease 标记，默认**不匹配任何 prerelease 版本**。
当前运行的 DSH 是 `0.2.1-rc.2`（prerelease），`>=0.2.0` 会把它判成不满足，
插件在安装/启用时被 `incompatible-version` 拒绝。写成 `>=0.2.0-rc.1` 后 range 才允许
prerelease 参与比较，`0.2.1-rc.2` 通过。

生态里的既有插件都是这么写的，可作参照：

| 插件 | `engines.dsh` |
| --- | --- |
| dsh-cost-meter | `>=0.2.0-rc.1 <0.3.0-0` |
| dsh-mnemon | `>=0.2.0-rc.2 <0.2.1-0 \|\| >=0.2.1-rc.1 <0.3.0-0` |
| dsh-tool-manager | `>=0.2.0-rc.2` |
| dsh-llm-retry-settings | `>=0.1.6-alpha.1` |

上界故意不封（没有 `<0.3.0-0`）：本插件只用稳定扩展点，且所有观测逻辑都有 `try/catch`
兜底，未来内部形状变了最坏是浮层不出现，不会伤到宿主。

### 5.6 硬编码审计（换机器 / clone 后能不能跑）

审计结论：**没有任何本机路径、端口、用户名、密钥**。逐项：

| 看起来像硬编码的东西 | 实际是什么 | 换机器会坏吗 |
| --- | --- | --- |
| `ROUTE_PATH = '/download-progress/state'` | 相对路径，挂到宿主自己的 web server 上 | 不会 |
| Client 轮询地址 | `new URL(ROUTE, window.location.origin)`，失败再退回相对路径 | 不会 |
| `localStorage['dsh-download-progress:settings']` | 存储键，按 origin 隔离 | 不会 |
| `@local/dsh-download-progress` | 包名。`@local` scope 不需要 registry | 不会 |
| `smoke-host.mjs` 里的 `D:\work`、`C:\a b\f.zip` | 测试桩的假 cwd / 假路径 | 不会 |
| `smoke.mjs` 加载 client.js 的路径 | 已改成 `fileURLToPath(import.meta.url)` 相对解析 | 不会 |
| UI 全中文文案 | 设计如此（项目是中文文档） | 不会，但英文用户看得懂的程度有限 |

验证方式：把仓库 clone 到临时目录后直接跑
`node smoke.mjs` / `node smoke-host.mjs` / `import('./index.js')`，全部通过。
说明代码不依赖本仓库所在位置。

**唯一需要注意的耦合**：改包名时要同时改三处——`package.json` 的 `name`、
`cordis.patch.yml` 的 `name`、以及 `client.js` 顶部
`window.__ModuleLoader__.load({ id: ... })` 的 `id`。前两者不一致会导致 bundle
挂载不上；第三处不一致会让客户端半注册到错误的模块 id 下，页面里静默不出现。

---

### 5.7 压测与真机实测抓出的五个真 bug

用户要求先把 bug 都测完，于是先写两个压力脚本
（`stress-host.mjs` / `stress-client.mjs`）再上真机 10 并发。下面前四条是
压测时实测复现的，第五条是重载后真机下载才撞到的，都不是假想问题。

**① 任务寿命上限（真死锁）**
`sample()` 只在「文件变大了」时重置 `idleTicks`。若下载工具持续
`SetLastWriteTime` 却不写数据，或路径被解析成一个永不出现的文件，任务永远
不回收，卡片永久挂在窗口上。修法：`MAX_TASK_MS = 30 * 60 * 1000`，在
`sweep()` 里先于采样判一次硬上限。

**② 文件消失导致进度条倒退**
下载器「写临时名再改名」时，被采样的路径会消失一个 tick，`statSync` 抛错。
若直接按 0 计算，进度条会在卡片退休前一刻弹回空。修法：`task.bytes` 只涨不跌
（`if (size >= task.bytes) task.bytes = size`），而空闲计数仍按真实 `size` 走，
所以退休时机不受影响（`stress-host.mjs` 有断言覆盖）。

**③ 命令长度无上限**
Agent 会把整个文件塞进 `pwsh -Command "..."`。`classify()` 对十万字符做五条
正则扫描，在 host 主进程上每 dispatch 一次就阻塞一次。修法：`MAX_SCAN_CHARS =
20000`，`classify()` 只在前 2 万字符上匹配特征——所有模式都锚定在命令开头，
截断不损失识别率（返回值里的 `command` 仍是完整原文，供日志行使用）。

**④ 起始宽限：文件还没创建就被判空闲**
`run_in_background` 的 `tools/execute` 会**立刻** resolve，此时 curl 可能还在
DNS / TLS 握手，文件尚不存在。首个 tick 读到 0 字节就累加 `idleTicks`，3 秒后
卡片退休——而退休后不会再有第二次机会，因为工具调用已经结束了。修法：
`START_GRACE_MS = 5000`，目标文件不存在且未超过宽限期时直接 `return`，不累加
空闲计数。

三条修法都有断言：`stress-host.mjs` 里分别是 `30 minute ceiling`、
`vanished file keeps its last size`、`not-yet-created target gets a start grace`。

**⑤ 失败的 HEAD 被当成文件大小（`probeTotal` 没看 `res.ok`）**
`probeTotal()` 用 HEAD 探总大小，原来只读 `content-length`。Cloudflare 会直接
拒掉 HEAD 并返回 403，而错误页正文恰好 1 字节 ⇒ `content-length: 1` 被当成了
文件总大小，卡片渲染成 `0 B / 1 B`。修法：`if (!res.ok) return`，非 2xx 一律
保持 `total = null`（不确定进度条）。回归测试在 `smoke-host.mjs`，用本地 HTTP
服务返回「403 + content-length: 1」断言 `total` 仍为 `null`；临时撤掉这行修复
该测试会失败，恢复后通过。

**⑥ 目标文件是旧的，卡片第一帧就锁死在 100 %**
`sample()` 只 stat 目标文件，不区分「这个文件是这次下载写的」还是「上次下载留下的」。
重跑一次已经下完的 `curl -o file` 时，磁盘上那个 29.6 MB 的旧文件被直接当成测量值，
卡片从第一帧就显示 `29.6 MB / 29.6 MB`、速度 0，然后被 sweep 当成已完成退休——
用户看到的是「下载卡闪一下就没了」。修法：任务记 `freshTarget`，在下载器自己碰过文件之前
不计量（curl 会截断、aria2c 会预分配、续传会重写尾部，这三种都会把 mtime 推进本次派发的窗口）。
判定条件是 `st.mtimeMs < task.startedAt - TARGET_FRESH_SLACK_MS`，这个 2000 ms 容差**不能去掉**：
NTFS 的写入时间戳有亚毫秒滞后，而 `Date.now()` 只有毫秒分辨率，
首帧就写盘的派发会得到比 `startedAt` 早几分之一毫秒的 mtime，严格 `>=` 比较会让那些卡片永远停在 0 B
（实测 `stress-host.mjs` 的 24 并发样本里恰好有一张因此卡死）。旧文件是几分钟到几小时前的，
两秒窗口足以分开两者。未碰过文件的场景仍由 `START_GRACE_MS` + 空闲计数兜底退休。

客户端侧另有一处容错（不是 bug 修复，是设计）：`POLL_FAILURES_BEFORE_CLEAR`
允许连续多次轮询失败才清空列表，避免宿主重启、路由短暂 502 时浮层闪一下消失。
`cache: 'no-store'` 已足够，实测没有出现 304 语义问题。

真机 10 并发验证（每路 `curl --limit-rate 150k --max-time 12`，字面量 `-o` 路径）：
10 张卡片同时出现、各自独立算速度、`done` 为真但文件仍在增长时继续显示，
全部中断后 3 tick + `LINGER_MS` 内清空，无残留文件句柄占盘。

---

## 6. 安装 / 卸载 / 调试

安装（以 desktop profile 为例；`target` 填本目录的绝对路径）：

```
plugin_manager action=install_bundle target="<本目录绝对路径>"
```

卸载：

```
plugin_manager action=remove_bundle target="@local/dsh-download-progress"
```

调试要点：

- Host 半改动 → `plugin_manager action=set_plugin enabled=false` 再 `true` 即可重载。
- Client 半改动 → 刷新页面（`Ctrl+R`）即可；bundle 的 `rev` 随文件 mtime 变化（见 §5.3）。
- 验证数据：`curl http://127.0.0.1:<端口>/download-progress/state`。
- 验证渲染：用 OCR 查窗口底部（y 约在输入框上方 20px）是否出现 `<文件名>` + `<已下载> / <总大小> · <速度>`。
- 离线冒烟（不需要浏览器、不需要 React）：

```
node smoke.mjs
node smoke-host.mjs
```

`smoke.mjs` 在假的 `window` 里加载 `client.js`，用极简 React 替身把三个槽位各渲染一次，
断言：5 种任务形态的文案、只有已知总大小才出百分比、`--ddp-rows` 来自设置、
设置页有 9 个配置项（3 个复选框 + 6 个下拉 + 1 个重置按钮）、调试模式默认关，
以及浮层状态机：**调试模式关 + 无任务 = 什么都不渲染**、**调试模式开 + 无任务 = 只有把手**、
**悬停把手展开 5 张示例卡**、**180ms 宽限期内回到卡片不收起**、**离开并等过宽限期才收起**、
**有真实任务时只显示真实卡片且把手隐藏**、**拖把手 40px 只移动 40px（不额外上跳 12px）**，
以及主题：**「跟随系统」不覆盖任何 `--ddp-*`**、**亮色/暗色设上对应 token**、
**切回「跟随系统」把所有覆盖清掉**、**主题 token 不会盖掉 `top` 定位**、
**localStorage 里的第三方主题会出现在下拉里、与内置重名的被丢弃、`--ddp-rows` 与非法值被过滤**，
以及出现动画：**默认 `float`**、**下拉切到任意 id（`crt` / `ripple` / `slide` / `drop` / `pop` /
`wipe` / `flip` / `spin` / `blur` / `none`）时每张卡片的 `ddp-ease-*` 类跟着变**、**动画类只在卡片上，
容器不带**、**入场按 55ms 错峰**。`smoke.mjs` 会遍历下拉框逐 id 断言这三件事，加新动画自动覆盖。

简易条另有一组断言（`---- inline bar ----`）：**注册进 `conversation.input.left`（order 2000）**、
**`display=overlay` 时工具行里没有 chip**、**别的会话 / 没有会话时什么都不渲染**、
**已知比例 = `ddp-mx--bar` + 条(50%) + 速率 + 悬停百分比、且没有详情行、三个 body 都还挂着**、
**`display=inline` 时浮层不渲染任何东西**、
**搜索 = `ddp-mx--ring`、自身不印字、文案进悬停气泡**、**抓取/安装/下载未知大小各自的气泡措辞**、
**下载未知大小仍报已落盘字节**、**完全没有 kind = `ddp-mx--dots` + 三个点 + `处理中` 气泡**、
**多任务带 `+N`**、**关掉速度开关后不印速率**、**主题 token 能到 chip 上**。
改简易条跑一次就知道有没有改崩。
改完 UI 跑一次就知道有没有改崩。

`smoke-host.mjs` 则直接 import 三个 Host 模块（`utils.js` / `detect.js` / `state.js`，都不依赖宿主），
用假 `fs` 喂时间序列来断言：分类规则、命令行路径解析（引号 / `cwd` / `-O` / 变量不可解析）、
速度滑动窗口、收尾回收时机、以及 `/download-progress/state` 的 JSON 字段契约。
它不需要启动 DSH，所以改 Host 逻辑也能离线回归。

---

## 7. 文件清单

**每个目录都有一个同名 barrel 文件**（`detect.js` / `state.js` / `script.js` / `background.js`），
只做 re-export，所以外部调用方永远是 `import ... from './detect.js'`，不必知道内部怎么分。
`client.js` 是唯一的例外——它是**构建产物**，源码在 `src/client/`。

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包声明；`dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 声明 Web 客户端半 |
| `cordis.patch.yml` | bundle 挂载：`insert` 一行 `id: dsh-download-progress` |
| `index.js` | Host 半入口：只做接线（订阅事件、起采样定时器、注册路由）。**最外层只此一个文件** |
| `detect.js` | barrel：工具分类的公开面 |
| `detect/tools.js` | 哪些工具名算搜索 / 抓取 / shell |
| `detect/patterns.js` | 旗标正则、建在正则上的两个 token 读取器，以及「这一段在跑哪个程序？」的程序名判定 |
| `detect/segments.js` | 一条命令在哪结束、下一条在哪开始 |
| `detect/vars.js` | 普通赋值，以及命令真正生效的 cwd |
| `detect/remote.js` | URL 想被存成什么名字 |
| `detect/targets.js` | 命令会写到哪些路径（按 `spec.js` 的表逐段遍历，不再靠三个布尔拼顺序） |
| `detect/spec.js` | **下载器注册表**：一张 `TRANSFERS` 表声明每个程序认哪个旗标、是否 staged、是否要位置参数。**加新下载器只改这里** |
| `detect/downloaders.js` | aria2c 与 git，两个不靠旗标的下载器 |
| `detect/classify.js` | 判定本身 |
| `script.js` | barrel：`-File` 静态解析的公开面 |
| `script/read.js` | 读一次脚本文件（含编码回退），绝不执行 |
| `script/comments.js` | 先剥注释——注释里的 `-o xxx` 不是参数 |
| `script/vars.js` | `$Var = '...'` 的收集与解析（含 `$env:`、`Join-Path` 链） |
| `script/targets.js` | 从调用点解析出落盘路径 |
| `script/plan.js` | 组装成一份 plan（含 URL / 变量表） |
| `script/tuning.js` | 大小上限与超时 |
| `plan.js` | barrel：命令行 → 执行计划（目标、URL、bulk、staged）的公开面 |
| `plan/expand.js` | `expandPlan()`：把 detect 的解析与 script 的 `-File` 结果合成一份计划 |
| `plan/aria2.js` | `-i` 清单：读取、解析成真实路径 |
| `state.js` | barrel：任务簿记的公开面 |
| `state/tuning.js` | 每一个时长与上限，都注明了它是被哪个 bug 定下来的 |
| `state/registry.js` | 任务表本身，以及别人读它的那几个把手 |
| `state/aria2.js` | `-i` 清单：读取、解析成真实路径 |
| `state/probes.js` | 提供分母的 HEAD 探针 |
| `state/disk.js` | 磁盘上真正的字节数（aria2c bitmap、git clone 目录树） |
| `state/begin.js` | 一次 dispatch → 一张卡 |
| `state/sample.js` | 一个 tick：量目标、算速率 |
| `state/sweep.js` | 收掉完成的卡；install 事件 |
| `state/snapshot.js` | Client 轮询的那份 wire 形状 |
| `background.js` | barrel：后台任务簿记的公开面 |
| `background/tuning.js` | 宽限期、linger、reconcile 间隔、行数上限 |
| `background/tables.js` | 哪些工具算「等待」、哪些算 shell |
| `background/tools.js` | 工具名/参数的读取助手 |
| `background/jobs.js` | bash 后台 job 的生产者 |
| `background/subagent.js` | 子代理的生产者 |
| `background/workflow.js` | workflow 的生产者 |
| `background/waits.js` | `waiting` 的推断（owner 是否阻塞在等它） |
| `background/snapshot.js` | 后台那几行的 wire 形状 |
| `utils.js` | 无副作用的纯函数（截断、取行、去重、URL 提取） |
| `client.js` | **构建产物**：`src/client/**` 按序拼接。不要手改，改源码再 build |
| `src/client/*` / `src/client/css/*` | Client 半源码，见 §3 |
| `scripts/build-client.mjs` | 拼接 + `--check` 漂移守卫 |
| `smoke.mjs` | 离线冒烟测试（假 window + 假 React，不需要浏览器） |
| `smoke-host.mjs` | Host 半离线测试（假 `fs`，不需要启动 DSH） |
| `script.test.mjs` | `script.js` 的单元测试：赋值收集、值解析、目标提取、不可解析必须返回空、退化输入、编码矩阵、`-File` 路径解析、开销 |
| `contract.mjs` | 机器校验 Host/Client 契约（见 `CONTRACT.md`） |
| `stress-host.mjs` | Host 半压力测试（30 并发、畸形入参、上限与 wire 类型） |
| `stress-round2.mjs` | 第二轮压测：1000 张卡、探针并发上限、模拟一小时 sweep、恶意会话名/日志、边 sweep 边注册 |
| `stress-client.mjs` | Client 半压测：50 卡、脏数据、路由挂掉、320px 窄窗 |
| `bench.mjs` | 性能基准（`--json` / `--save` / `--after`），基线在 `bench/baseline.json` |
| `NOTES-FOR-AI.md` | 本文档：实现笔记。刻意不叫 `AGENTS.md`，避免被 DSH 当项目指令每轮自动注入 |
| `locale/en.json` / `locale/zh.json` | 插件元数据标题（插件列表里显示的名字） |
| `icon.svg` | 插件图标 |
| `LICENSE` | MIT 许可证 |
| `.gitignore` | 忽略 `node_modules/`、测试下载残留（`*.bin`、`*.log`） |

**拆分的理由（2026-10-23 重构）**：`index.js` 曾是 340 行、混着正则、状态机和接线，改一处要通读全部；
`client.js` 一度 2611 行、`state.js` 1219 行、`detect.js` 929 行——单个文件超长时，
"改颜色"和"改采样"落在同一屏里，AI 与人都会改错地方。现在按职责分片，**除 `client.js`
这个拼接产物外，最大一片 335 行**（`src/client/90-overlay.js`），Host 侧最大 212 行。
Host 侧是原生 ESM `import`（Node 自己解析，不需要打包器、不增加依赖），
Client 侧因为宿主只下发一个 bundle，用 `scripts/build-client.mjs` 做纯字符串拼接，产物仍是单文件。

> **新增源文件必须同时进 `package.json` 的 `files` 数组。** 目录级条目（`detect/`、`state/`、
> `script/`、`background/`）已覆盖子文件；但 `src/`、`scripts/`、`bench/` **不进包**
> ——`client.js` 已经是产物，装包的人不需要源码。`background.js` 漏过一次（`f12693e` 修）。

---

## 8. 优势与已知短板

写给评估这个插件的人：它能做什么、靠什么做到、以及在什么情况下会让你失望。

### 8.1 优势

| 优势 | 具体表现 |
| --- | --- |
| **零核心改动** | 不 patch 宿主、不改 `cordis.yml`、不碰 `agent-loop`。用的是官方公开的扩展点：`tools/execute` 瀑布钩子、`plugin-manager/install-log` 事件、`webServer.register` 路由、`shell.overlay` / `settings.section` / `conversation.input.left` 插槽。宿主升级时这些名字变了才会坏，见 §5.1 |
| **零第三方依赖** | Host 半只用 `node:fs` / `node:path`；Client 半只用宿主已提供的 `react`。**没有 npm 依赖**，`git clone` 下来就能装。Client 侧有一个拼接步骤（`scripts/build-client.mjs`），但它只用 `node:fs`，不需要 `npm install`、不需要打包器；发布包里带的是拼好的 `client.js`，安装的人不跑它 |
| **不绑会话、跟着文件走** | 用户把 `curl` 丢进后台（`run_in_background`）后工具会提前返回，插件不看工具何时结束，而是看**文件是否还在变大**——最后 3 秒没长才收起。这是唯一能覆盖后台下载的信号 |
| **UI 与逻辑彻底分离** | 全部样式集中在 `src/client/css/*.css`（拼进 `client.js` 顶部的 `CSS` 模板字符串）和一个 `<style>` 注入点，所有颜色走 `--ddp-*` / `--dsw-alias-*` 变量。改外观不动一行逻辑，换主题只加一个 token 对象 |
| **出现不推挤布局** | 挂在 `shell.overlay`（浮动层，不参与排版），`position: fixed` + `transform` 定位，且拖动只写 `top/left`。出现/收起/悬停展开都不会让聊天区跳动 |
| **离线可测** | `smoke.mjs` 用假 window + 假 React 跑真实组件树，覆盖 30+ 条断言：槽位注册、卡片渲染、拖动基准、悬停宽限期、主题切换、hook 数量一致性。不需要浏览器、不需要启动 DSH |
| **可扩展的主题** | 内置跟随系统/亮色/暗色，且支持从 `localStorage` 读外部主题（JSON 里写一套 `--ddp-*` 变量即可），不必改代码 |
| **几乎不吃窗口缩放的性能** | 没有浮层时 DOM 里一个节点都没有；有浮层时 `window.resize` 期间临时关掉 `backdrop-filter`（实时缩放时每帧重模糊一大块背景才是贵的地方）。状态轮询实测 **1.41 ms/次、1 次/秒**（约 0.14% 单核），见 §8.2 |

### 8.2 短板（先说清楚，避免误解）

| 短板 | 原因 | 影响 |
| --- | --- | --- |
| **不是"网卡收了多少"** | 宿主只在工具开始/结束时发事件，中间字节流不对外暴露（§1.4 逐条验证过） | 显示的是**目标文件在磁盘上长了多少**，所以不落盘的下载（`curl \| tar`、输出到 stdout）没有进度 |
| **命令里的变量路径解析不了** | 插件只能读命令**文本**，不能求值 | `-o $dst` 会显示为字面量 `$dst` 且没有进度；必须写 `-o D:\path\file.bin` |
| **总大小常常未知** | 需要额外发一次 `HEAD` 且对方要给 `Content-Length` | 拿不到总大小时降级为不确定进度条 + "已下载 12.4 MB · 3.2 MB/s"，没有百分比 |
| **搜索/抓取只有"进行中"** | `web_fetch` 与搜索工具的响应是一次性返回的，没有中间事件 | 只有计时器，没有字节数——这是宿主能力边界，不是实现偷懒 |
| **靠轮询而不是推送** | Client 半每秒 `fetch` 一次状态路由（`POLL_MS = 1000`） | 页面隐藏（`document.hidden`）时自动跳过轮询；代价是最多 1 秒延迟，换来不需要新增 Host→Client 事件白名单。实测单次往返 **1.41 ms**，即每秒约 0.14% 单核 |
| **只在 desktop profile 验证过** | CLI 对 desktop profile 有写死限制，安装是手工链接的 | 换 profile / 换机器要重装，见 §6 |

### 8.3 一句话定位

它解决的是**"agent 在后台默默下载，用户不知道要等多久"** 这一个场景，用宿主已有的最小扩展点做到，代价是只能看见落盘的文件。
如果哪天宿主开始对外投影工具执行的字节进度，这个插件应当改为消费那个事件，而不是继续 `fs.stat`——`state.js` 已经把这层隔离好了。

### 8.4 第二轮压测发现的两个真实问题（已修，2026-10-22）

压测脚本 `stress-round2.mjs`，全部断言带数字输出，不是只报红绿。

**问题一：HEAD 探针无上限并发。**
`probeTotal()` 是 fire-and-forget，`beginTask()` 发起后立即返回，上游没有任何节流。
一个 `for` 循环发 200 个 curl，就会在同一瞬间打开 200 个 HEAD 请求，各占一个 socket
和一根 6 秒的 `AbortSignal.timeout`。修法是模块级信号量 `PROBE_CONCURRENCY = 8`：

```js
async function probeTotal(url, task) {
  await acquireProbeSlot()
  try { /* … fetch … */ } finally { releaseProbeSlot() }
}
```

`releaseProbeSlot()` 把空出的槽**直接交给下一个等待者**（`probesInFlight` 不减再加），
所以计数始终准确。实测 40 个并发下载打到本地慢速服务：峰值并发 8，40 个全部拿到
`content-length`（排队不丢结果）。

**副作用（意外收益）：注册耗时 303 ms → 8 ms。**
改之前 `beginTask()` 里同步调用 `fetch()`，1000 张卡的注册开销主要是 1000 次 fetch 的
同步部分。改成先 `await` 拿槽位后，fetch 真正落到微任务里，注册路径只剩正则与 Map 写入。

**问题二：`String()` 会抛异常，而它跑在宿主分发路径上。**
`classify()` 和 `beginTask()` 直接接宿主的 `exec`，参数是调用方构造的任意对象。
`String({toString: null})` 抛 `TypeError: Cannot convert object to primitive value`
——这不是"某张卡显示不出来"，而是**整个工具调用失败**。
`utils.js` 因此新增 `text()`：安全强转，`null`/`undefined` → `''`，裸对象 → `''`
（不返回无意义的 `[object Object]`），其余走 `String()` 并兜住异常。
`utils.js` 全部四个字符串函数、`detect.js` 六处、`state.js` 七处、`index.js` 一处都已换掉。

顺带修掉一个真实的键冲突：`id: String(exec?.callId ?? fallback)` 在 `callId === ''`
时**不会**回退（`??` 只认 `null`/`undefined`），所有空 callId 的调用会挤在同一个键上、
互相覆盖。改成 `text(exec?.callId) || fallback`。

**压测测到的数字（本机，作为回归基线）：**

| 场景 | 结果 |
| --- | --- |
| 1000 张卡注册 | 8 ms（修前 303 ms） |
| 1000 张卡 `snapshot()` | <1 ms |
| 1000 张卡 wire body | 242 KB |
| 3600 次 sweep / 50 个增长中的文件 | 1236 ms，堆 +2.7 MB（无泄漏） |
| 200 KB 命令行的 `extractTargets` | 0.2 ms |
| 40 个并发下载的探针峰值 | 8 |

`snapshot()` 与 `sweep()` 本身没有改：它们的复杂度已经是线性的，且实测远低于预算，
提前优化只会换来没必要的复杂度。

---

### 8.4.1 后台行的三次翻车（0.2.2 / 0.2.3 / 0.2.4，2026-10-25）

这三版连着修同一个区域，每次都是「上一版只测了一个方向」。记在这里是因为**测试的盲区比代码的 bug 更贵**。

#### 0.2.2：把「注册时是什么」冻成了结论

```
noteJobEvent() 注册那一刻：row.foreground = startedUnderShell()
```

问题：`run_in_background` 的 job 恰恰是在 shell 工具调用**尚未返回时**注册的，和「前台命令自己的输出登记」时刻相同、形状相同 ⇒ 被永久判成 foreground ⇒ `backgroundSnapshot` 里被 `isForegroundJob()` 过滤掉，**整类后台任务被吞**。

当时的测试只断言了「前台命令不许画成后台任务」，**没有反向断言「真后台必须出现」**，所以整类任务消失也测不出来。

#### 0.2.3：注册时不猜答案，只记事实

```
background/tables.js     shellEndedAt: Map<sessionId, number>   // 上次 shell 调用返回时刻
background/tuning.js     SHELL_SETTLE_MS = 1500                 // 等总线上的 settle 事件落地
background/jobs.js       shellContext() 返回 { underShell, detached }
                         detached = tool.args?.run_in_background === true
background/waits.js      isForegroundJob(row, now)：
                           type !== 'job' || !underShell  → false（不是 job，不过滤）
                           detached === true              → false（真后台一定露出）
                           endedAt === 0                  → true （调用还在飞）
                           now - endedAt < SETTLE_MS      → true （同上）
                           否则 live = running|stopping  → !live
background/snapshot.js   resetBackground() 里 shellEndedAt.clear()
```

**关键事实**：`dsh-jobs` 服务只发 `registered` / `settled` / `progress`，**根本不发 `removed`**（全 asar 扫过：只有 `dsh-jobs-local/lib/index.js` 同时含这三个词）。所以「靠 removed 事件自然消失」这条路不存在，过滤必须留在 Host 侧。

#### 0.2.4：第二类幽灵行 —— 没有会话归属的 subagent/workflow

```
background/subagent.js   owner 推不出来 ⇒ 不登记（原来会登记成 sessionId: ''）
background/workflow.js   同上
background/snapshot.js   出口统一强制：type 是 subagent/workflow 且无 sessionId ⇒ continue
```

**这类行是什么**：mnemon 的空闲检查点（idle review）会派生一个子代理跑检查任务。它**从 `tools/execute` 工具系统之外启动**，所以 `ownerOfRunning('subagent')` 推断不出父会话，返回空串。

**为什么用户在每个会话都看得到它**：客户端「只看当前会话」`currentOnly` 默认 **false**（这是用户明确要求的，不许改默认值，见主文档第 4 节第 5 条），无归属行匹配不上任何过滤条件 ⇒ 每个会话的浮层都画它。用户既无法归因，也无法等待，更关不掉。

**为什么在 `snapshot.js` 出口再拦一道**：producer 可能有新的、忘检查的。所有行都要过这一个闸，规则放这里才不会漏。这不是冗余——第 12 节测试专门验证了手工往 `subs` 里塞无归属行也会被拦。

**被否掉的方案**：事件里其实带了父 id（宿主 `createLifecycleEmitter` 里是 `emit(name, info, parent)`），但那个 `parent` 只用于**作用域过滤**（当 carrier 用），监听器回调拿到的是 `callback(info)`，**第三个实参永远到不了监听器**。所以别想着「直接用 parent」，只能用推断 + 无归属就丢弃。

#### 这三版共同的教训

| 教训 | 具体 |
| --- | --- |
| **只测一个方向等于没测** | 0.2.2 只测「前台别冒出来」，漏了「真后台必须出来」 |
| **`LINGER_MS` 同名不同值** | `state/tuning.js:15` = `1200`（任务卡滞留）；`background/tuning.js:47` = `4000`（后台行滞留）。`smoke-host.mjs` 顶部 import 的是前者，写背景行断言必踩。已用 `BG_LINGER_MS` 别名区分 |
| **「没出现」≠「修好了」** | 必须先证明被测的东西确实发生了。详见下一节 |

### 8.4.2 怎么验证「某行不再出现」（可复用的取证流程）

**不要**用截图，也**不要**只问用户「还在吗」。用独立 Node 进程采样状态路由：

```js
// 关键：走独立 node 进程，不经 DSH 工具系统
// ⇒ 采样本身不会在后台任务区登记任何行，不污染被测对象
setInterval(async () => {
  const body = await (await fetch(url, { cache: 'no-store' })).json()
  const orphan = body.background.filter(r => r && !String(r.sessionId || ''))
  // 必须记录每行的 归属（owned / ORPHAN），否则分不清「没修好」和「压根没触发」
}, 400)
```

**然后必须先证明触发源真的动了**。验证 0.2.4 那次，第一次的「没出现」是**无效证据**：

| 检查项 | 结果 |
| --- | --- |
| `C:\Users\Sama05\.mnemon\` 在上次启动后有无新写入 | **无**（一个文件都没写） |
| 有无新的子代理会话目录 | **无** |
| 最近一次检查点运行时刻 | 20:43:46 |

原因：`minIntervalMs` 默认 300000ms，上次 20:43:46 + 5min = 21:13:46 之前全被节流挡掉。**检查点没跑，当然没有那行。**

第二次（有效）同时满足：新的子代理会话（21:21:54）+ 写下了新记忆文档（21:22:37）+ mnemon 库落盘（21:22:52）；探针在该窗口 153 次采样 `bg` 恒为 0、`ORPHAN` 全程 0。

**判据公式**：`触发源确有活动 AND 目标现象全程未出现` 才算验证通过。缺前半句 = 什么都没证明。

---

## 8.5 代码规范与性能基线（2026-10-23 重构）

### 8.5.1 依据（都是可查的原始文档，不是印象）

| 规则 | 默认/建议值 | 出处 |
| --- | --- | --- |
| `max-lines` | 默认 **300**，文档原话「Recommendations usually range from **100 to 500 lines**」 | https://eslint.org/docs/latest/rules/max-lines |
| `max-lines-per-function` | 默认 **50**；Airbnb 声明 50 | https://eslint.org/docs/latest/rules/max-lines-per-function |
| `complexity` | 默认 **20**；Airbnb 声明 20 | https://eslint.org/docs/latest/rules/complexity |
| `max-depth` / `max-params` / `max-statements` | Airbnb：4 / 3 / 10 | airbnb/javascript `rules/style.js` |
| `max-len` | Airbnb **100**；Google **80** | airbnb/javascript；https://google.github.io/styleguide/jsguide.html §4.4 |
| `import/no-cycle` | **必须为 0**，文档原文「Cyclic dependency are **always** a dangerous anti-pattern」 | https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-cycle.md |
| Google JS Style Guide | **完全不管文件行数**，只管 80 列宽；且顶部横幅已声明「no longer being updated, migrate to TypeScript」 | 同上 |

两个**官方文档明写的陷阱**，决定了不能只开一条规则：

- `complexity` 把默认参数、解构默认值、可选链 `a?.b?.c` 的每一段、`||=` / `&&=` 各算一条分支
  ⇒ 拆函数时把默认值挪到参数上，复杂度反而升高。
- `max-lines-per-function` 文档指出：16 行嵌套长链只算 1 statement / complexity = 1
  ⇒ 长链不会被它逮住。**两条必须同时开，不能互替。**

（完整调研报告：`D:\AIworks\notes\js-esm-code-standards-research.md`，204 行，含 10+ 页面正文摘录与未验证项。）

### 8.5.2 落地结果

| 项 | 重构前 | 重构后 |
| --- | --- | --- |
| 最大源文件 | `client.js` 2611 行 | `src/client/90-overlay.js` **335 行**（`client.js` 是拼接产物） |
| 次大源文件 | `state.js` 1219 行 | `src/client/85-inline.js` 322 行 |
| Host 侧最大文件 | `detect.js` 929 行 | `state/probes.js` 212 行 |
| 源文件总数 | 15 | 70 个 js/css（另有 10 个测试脚本、`lab/` 不计） |
| 循环依赖 | 未校验 | **0**（分层 import，每层只 import 上层） |
| barrel 风险 | — | 四个 barrel 只做 re-export，**不含逻辑**，所以不会引入「barrel 导致 tree-shaking 失效 / 隐式循环」那两个经典问题 |

barrel 的代价是真实存在的（多一次模块解析、IDE 跳转多一跳），这里接受它是因为：
`package.json` 的 `exports` 和所有测试都写着 `./detect.js` 这类路径，改成目录会破坏外部契约；
而 barrel 只 re-export、不含逻辑，`import/no-cycle` 仍能保证无环。

### 8.5.3 性能基线（`npm run bench`，中位数，本机）

重构前后各跑一次，基线存 `bench/baseline.json`，重构后存 `bench/after.json`：

| benchmark | 0.2.4 前 | 0.3.0 后 | 变化 |
| --- | --- | --- | --- |
| `sample/1-card` | 0.0583 ms | 0.0402 ms | −31% |
| `sample/30-cards` | 1.4330 ms | 0.6946 ms | **−52%** |
| `snapshot/30-cards` | 0.0413 ms | 0.0425 ms | ±0% |
| `classify/curl` | 0.0088 ms | 0.0072 ms | −18% |
| `classify/-File` | 0.0068 ms | 0.0074 ms | +9% |
| `script/plan` | 0.3559 ms | 0.3773 ms | +6% |
| `targets/curl` | 0.0074 ms | 0.0062 ms | −16% |
| `targets/8-flags` | 0.0114 ms | 0.0091 ms | −20% |
| `client/parse-in-vm` | 0.6404 ms | 0.6277 ms | −2% |
| `client/read-bytes` | 0.1558 ms | 0.1876 ms | +20% |
| `host/import-cost` | 1.3186 ms | 1.535 ms | +16% |

**0.3.0 的主要收益在 `sample/*`**：原来每张卡每拍都调 `aria2Completed()`
（该函数第一件事是 `readFileSync('x.aria2')`，靠 catch ENOENT 判断「没有旁车」）。
只有 aria2c 会写旁车，curl/wget 卡白付一次抛异常读取 —— 30 卡合计 0.58 ms，
占 `sample()` 的一半。改成 `task.aria2 ? aria2Completed(target) : undefined` 后
30 卡从 1.43 ms 降到 0.69 ms，顺带修掉「curl 输出旁残留的 .aria2 被误当成进度」。
剩下的 0.69 ms 里 30 次 `statSync` 是必要成本（单独实测下限 0.48 ms），没法再省。

`host/import-cost` +16% 是新增 `detect/spec.js`、`plan/` 两层后的固定解析成本，
**进程启动时一次**；`client/read-bytes` +20% 是绝对值 0.03 ms 的抖动，不是回归。
每秒真的在跑的 `sample/*` 与 `snapshot/*` 都是持平或大幅下降——这是重构的验收线。

### 8.5.4 微基准的方法论（`bench.mjs` 头部有同样说明）

- 用 `hrtime.bigint()`，不用 `Date.now()`（后者在 Windows 上只有 ~15.6 ms 分辨率）。
- 每个 benchmark 先 warm-up：V8 在函数被调用若干次后才优化，而**重构改变函数数量就改变
  warm-up 曲线**——不 warm-up 的话，拆分本身会被误读成性能回退。
- 报 **median + p95**，不报平均值：GC 抖动会把平均值拉歪。
- `--json` 出机器可读结果，`--save` 写基线，`--after` 写 `after.json`，便于前后对比。

### 8.6 0.3.0 的结构性改动（2026-10-25）

这一版没加新功能，全是「让下一次改它更容易」的地基。

#### 8.6.1 新增 `plan/` 层：把「命令行 → 执行计划」从任务簿记里搬出来

原来 `state/begin.js` 同时干两件事：解析命令（detect + script）和建任务对象。
后果是 `state/` 反向 import 了 `detect.js` 与 `script.js` 的内部符号，`state` 与
`detect` 变成双向依赖。现在中间夹一层 `plan/`：

```
plan/expand.js   expandPlan(plan, cwd) -> {aria2, clone, bulk, targets, url, remote, staged, label, log}
plan/aria2.js    原 state/aria2.js 整体搬过来
```

`state/begin.js` 的 download 分支从 40 行塌成 15 行：`expandPlan` → 赋值 → retarget
→ label/log → 探针。它现在只剩五个 import：`PKG_RE`（一个纯正则）、`expandPlan`、
`utils` 里的 `clip/firstLine/text`、`probes` 里的两个探针、`registry` 里的三个符号。

**注意**：`state.js` 里有 `export { expandPlan } from './plan.js'`，必须从 barrel 转出。
写成 `'./plan/expand.js'` 会让 `architecture.mjs` 判违规，而且曾真的触发过
`ERR_MODULE_NOT_FOUND`（当时还叫 `state/aria2.js`）。

#### 8.6.2 `architecture.mjs`：把分层规则变成测试

新文件，约 200 行，纯 Node。一张 `ALLOWED` 表写死每层能 import 谁：

```
utils      -> 无
script     -> utils.js, script.js, script/
detect     -> utils.js, detect.js, detect/
plan       -> utils.js, detect.js, script.js, plan/
state      -> utils.js, detect.js, plan.js, plan/, state/
background -> utils.js, background.js, background/
```

每层只列**别人的** barrel：自己的 barrel 不在允许清单里（`state/x.js` import
`state.js` 就是绕一圈拿私有名字，而且与 re-export 构成环）。`index.js`、`utils.js`、
`client.js` 在 `EXEMPT` 表里逐条写明豁免理由；`unclassified()` 会点名任何既不属于某层、
又没被豁免的顶层 `.js`，所以新加一个根目录模块不会悄悄逃出检查。

扫 `from '...'` / `import '...'`，用 `posix.normalize(join(dirname(rel), spec))` 解析到
包根再比前缀。违规就打印该层的允许清单并 exit 1。已接在 `npm test` 第二位。

**为什么值得**：`extensibility-invariants` 说「禁止跨模块导入内部符号」，但规则写在
skill 里没人执行。现在越界的那一行会当场变红。

#### 8.6.3 `detect/spec.js`：下载器注册表

原来 `classify` 与 `targets` 各自硬编码 curl / wget / aria2c / iwr 的旗标与顺序，
加一个下载器要改两处以上，且两处的「谁优先」容易写反。现在是一张表：

```js
TRANSFERS = [
  { id: 'curl',  heads: {curl},  out: CURL_OUTFILE_RE, remoteName: CURL_REMOTE_NAME_RE, upload: CURL_UPLOAD_RE },
  { id: 'wget',  heads: {wget},  out: WGET_OUTFILE_RE },
  { id: 'aria2c', heads: {aria2c}, out: ARIA_OUTFILE_RE, dir: ARIA_DIR_RE },
  { id: 'iwr',   heads: {invoke-webrequest, iwr}, out: PS_OUTFILE_ARG_RE, needsOut: true },
  { id: 'bits',  heads: {start-bitstransfer}, out: PS_DESTINATION_RE, staged: true, last: true },
  { id: 'certutil', heads: {certutil}, action: CERTUTIL_URL_RE, last: true },
]
```

`transferOf(segment)` 按段头查表，顺带校验 `action`（certutil 只认 `-urlcache`）与
`needsOut`（iwr 必须带 `-OutFile`）。`classify` 与 `targets` 都改走这张表。

**加一个新下载器现在只改 `spec.js` 一处**：加一行 + 一条 `ok(...)` 断言。

`bits` 行同时有 `out` 和 `last`，因为 PowerShell 两种写法都合法：命名参数
`-Destination x`（`-Source` 前后都行）与位置参数 `Start-BitsTransfer <url> <path>`。
只读位置参数会漏掉前者 —— 反序时末尾的 token 是 URL，被当 URL 丢掉，卡片变成
「载入中」；只读命名参数会漏掉后者。`lastPositional()` 用引号感知分词，所以
`'D:\My ISOs\a.iso'` 不会被空格切开。

**没有 `input` 字段**：aria2c 的 `-i` 清单由 `detect/downloaders.js` 的
`aria2InputSpec()` 自己解析，注册表里再存一份是死数据。

#### 8.6.4 四类原来漏识别的写法（都有 RED 测试）

| 写法 | 原来 | 为什么 |
| --- | --- | --- |
| `$r = Invoke-WebRequest … -OutFile x` | 不出卡 | `expandLauncher()` 为了识别 `$p = Start-Process` 会剥 `$x = ` 前缀，但剥完发现不是 Start-Process 就把**原段**返回，段头成了 `$r` |
| `FOO=1 curl -o a.bin u` | 不出卡 | 同上，bash 的 `NAME=value` 前缀没被剥 |
| `-OutFile:D:\a.zip` | 不出卡 | `PS_OUTFILE_ARG_RE` 只认空格分隔；`-Param:Value` 是合法的 PS 参数语法（实测过参数绑定） |
| `curl --output=D:\a.bin` | **出卡但目标为空** | `CURL_OUTFILE_RE` 只认空格分隔 ⇒ 卡片永远停在「载入中」 |

`expandLauncher()` 的修法是加一步 `isCommandShaped(body)`：剥完之后必须以非引号开头、
且至少两个 token 才当作命令，否则返回原段——这样 `$o = 'D:\out.bin'` 这类纯赋值
仍然留在 `collectAssignments` 的视野里，`-o $o` 还能解析。

复查又抓到四类，都已补 RED：

| 写法 | 原来 | 为什么 |
| --- | --- | --- |
| `Start-BitsTransfer -Destination D:\a.iso -Source https://x/a.iso` | 出卡但目标为空 | 目标原来取「最后一个位置参数」；PS 命名参数不分先后，反序时末尾是 URL，被当 URL 丢掉 |
| `powershell -File get.ps1`（脚本里写 BITS） | `staged=false` | `expandPlan` 只看命令行；`-File` 形态的命令行只有 powershell，脚本正文才是真相 |
| `registry` 里没有 `out` 的行（bits/certutil） | 每段空转 2 万次 | `flagValues(source, undefined)` → `matchAll(undefined)` 是零宽匹配，逐字符命中 |
| wire key 断言缺 `name/sessionId/sessionTitle/startedAt` | 漏测 | 断言是字段表的子集，少一个字段也全绿 |

`staged` 现在有两个来源：命令行的 `commandSegments(command).some(transferIsStaged)`，与
脚本正文的 `scriptPlan().staged`（`script/tuning.js` 的 `STAGED_PROGRAM_RE`）。后者是
`detect/spec.js` 里 `staged: true` 的镜像——script 层不能 import detect，所以两边各有一处，
加新 staged 下载器时要同时改这两处。

#### 8.6.5 端到端提速：预热 + 400 ms 补拍

- **预热**：`99-plugin.js` 的 `apply()` 里 `taskStore.warm()`。原来第一次请求发生在
  浮层 mount 的 effect 里，而 DSH 什么时候渲染那个槽位不可控 ⇒ 首帧白等一个 RTT。
  现在插件一加载就发请求，`subscribe()` 的「frame 非空即回放」直接命中。
  插件被关掉时不预热（`readSettings().enabled`）。
- **补拍**：`tick()` 成功后若帧非空，`schedule()` 用 `setTimeout` 排一次 400 ms 后的
  tick；基线 `setInterval(1000)` 不动。**必须是 `setTimeout` 而不是第二个 `setInterval`**
  ——`stress-client.mjs` 有一条断言「两个 surface 必须共用一个 poller」
  （`app.intervals.length === 1`），第二个 interval 会直接把它打红。
- **CSS 跟着调**：`.ddp-fill` 的 `transition: width` 从 `.45s` 改 `.28s`。原来的值比
  1 s 轮询短，但比 400 ms 补拍长 ⇒ 活跃期宽度动画永远追不上，进度条会「黏住」。

#### 8.6.6 采样降本：别给不写旁车的下载器查旁车

见 8.5.3 的表。根因一句话：`aria2Completed()` 靠 `readFileSync` 抛 ENOENT 判断
「没有旁车」，而 curl/wget 永远没有旁车 ⇒ 每卡每拍白付一次异常。30 卡 0.58 ms。
`task.aria2 ? aria2Completed(target) : undefined` 一行修完，顺带修掉正确性问题。

#### 8.6.7 UI：把无限动画赶出主线程布局

`.ddp-card` 加 `contain: layout paint`；`ddp-slide` / `ddp-shine` 从 `margin-left` /
`left` 改成 `transform: translateX`。这两个动画是 `infinite` 的，卡片在屏幕上停几分钟
就一直跑；动布局属性意味着每帧重排整张列表，而列表里每张卡还各带毛玻璃。

**换算不能拍脑袋**：不定态条自身宽 = 父宽 38%，父宽 −38%→100% 换成自身是
−100%→263%；高光条保留 `left:-40%` 基准，父宽 140% ⇒ 自身 0→350%。
`stress-client.mjs` 新增两条守卫：`.ddp-card` 必须 `contain`、所有 `@keyframes` 里
禁止出现 `width/height/left/right/top/bottom/margin/padding`。

**踩坑**：CSS 嵌在 JS 模板字面量里，**CSS 注释中不能出现反引号**，否则模板字符串提前
结束，报 `SyntaxError: Unexpected identifier`。

---

## 9. AI 开发声明

本插件是 **AI 辅助开发（AI-assisted）** 的产物，请在使用、分发或二次开发时保留本声明。

| 项 | 说明 |
| --- | --- |
| 实现方式 | 由 DeepSeek 模型（`deepseek-v4.1-flash`）在 DeepSeek Harness（DSH）内部以 agent 会话方式完成需求分析、源码探查、编码与验证 |
| 人类角色 | 提出需求、验收效果、决定设计取舍（进度条位置、动画类型、主题方案等） |
| 验证方式 | 代码侧由 `smoke.mjs` 离线断言覆盖；运行时行为通过真实下载任务 + DSH 状态路由实测 |
| 未覆盖部分 | 视觉观感（模糊强度、动画流畅度、颜色对比）由人类目视验收 —— 模型无法读取屏幕截图 |

之所以单列这一节，是因为这个插件的**触发机制来自对 DSH 宿主源码的逐层确认**（哪些扩展点可用、哪些事件根本不存在），
结论写在第 1 节里供后来者复用；如果发现与新版本 DSH 不符，优先怀疑版本漂移而不是代码写错。

本声明不改变 [LICENSE](LICENSE) 的授权条款 —— 代码仍是 MIT，可自由使用与修改，只请求保留出处与本节说明。
