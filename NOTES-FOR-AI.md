# AGENTS.md — 实现笔记（给 AI / 维护者）

> 这不是用户文档。安装步骤、能力边界、优缺点在 [README.md](README.md)。
> 这里记录：**为什么这么实现、依赖了 DSH 的哪些内部契约、哪些路走不通（附证据）、升级时会先坏在哪里**。
> 内容会随 DSH 版本漂移而失效，所以每条结论都尽量带上当时的证据形态，方便复核。

- 包名：`@local/dsh-download-progress`
- 版本：`0.1.1`
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

### 1.3 为什么是 `shell.overlay` 而不是输入框停靠区

`shell.overlay` 是"Frame-wide floating layer, above every column and outside their scroll containers"，
`replaceRisk: none`，且"the layer itself is click-through"。

因为它在布局流之外，**出现/消失不会挤动任何东西**——这直接满足"进度条触发时窗口不要抖动/错位"。
换成 `conversation.input.dock` 之类的停靠槽位，每出现一条就会把输入框往下推，必然抖。

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
| `curl -o <文件>` / `--output` / `--output-document` | `curl -L -o D:\x\a.zip https://...` |
| `curl -O` / `--remote-name` | 目标推断为 `cwd + basename(url)` |
| `wget -O <文件>` | 同上 |
| `Invoke-WebRequest -OutFile <文件>` | 必须有 `-OutFile` |
| `git clone <url> <dir>` | 采样目录总体积 |

进度 = 目标文件体积 / `Content-Length`；速度 = 滑动窗口（约 1s 跨度）算出的字节速率。
两者都**每秒采样一次**，Client 每秒拉一次。

卡片底部另有一行状态信息（`.ddp-log`，透明度 0.55，单行截断）：显示**下载来源 URL**；
命令里没有 URL 时退回目标文件路径，再退回命令行首行。只显示这一行，不堆历史。

### 2.2 只能显示"进行中"（不确定态进度条）

| 形态 | 显示文案 | 底部信息行 |
| --- | --- | --- |
| 插件安装 | `插件安装中...下载中...`；`applying` 阶段换成 `插件安装中...应用配置中...` | pnpm 输出的**最新一行**（整块输出只取最后一行） |
| 网页抓取 | `正在抓取网页中...<N>s`，秒数实时递增 | 被抓取的 URL |
| 搜索（research/web_search 等） | `正在搜索「<摘要，最多 50 字>」中...请稍后` | `工具名 · 完整查询词`（不受 50 字限制） |
| 其他包管理器命令（pip/npm/docker pull…） | `载入中...`（统一未定义条，后续若拿到数据流再细化） | 命令行首行 |

### 2.3 拿不到的（明确说明）

- **`Invoke-WebRequest` 不带 `-OutFile`**：全在内存里，磁盘上没有可采样的文件 → 不触发。
- **目标是目录/多文件**：只采样已知的顶层目标。
- **命令里用变量拼路径**（如 `-o $dst`）：插件只能读到命令行文本里的字面量 `$dst`，解析出的路径不存在 → 任务约 5 秒后被回收，不显示进度。
- **纯内存下载 / API 调用**：无落盘 → 无进度。

---

## 3. UI 独立抽出的做法（改样式只动一处）

Client 半是单文件 `client.js`，样式与结构分离得很干净：

```
client.js
├── CSS            ← 所有视觉样式都在这一个模板字符串里（改外观只动这里）
├── describe(task) ← 数据 → 文案的映射（改文案只动这里）
├── Card           ← 单条进度卡片（结构）
└── Overlay        ← 列表容器 + 1s 轮询
```

- **改颜色/圆角/动画/位置** → 只改 `CSS` 常量。
- **改文案/文案格式** → 只改 `describe()`。
- **改卡片结构** → 只改 `Card()`。

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
| 显示下载速度 | 开 / 关 | 开 | 关掉后文案只留「已下载 / 总大小」 |
| 调试模式（显示模拟数据） | 开 / 关 | **关** | 关：只显示真实下载，没有下载就完全不显示。开：没有下载时出现一条把手，悬停展开 5 张模拟卡片调 UI |
| 新任务的排列位置 | 最新在前 / 最新在后 | 最新在前 | 多条任务时最新出现的排顶部还是底部（`newest-first` 会把 Host 的插入顺序反转） |
| 最多同时显示条数 | 1–6 | 3 | 通过 CSS 变量 `--ddp-rows` 控制 `max-height`，超出滚动 |
| 主题 | 跟随系统 / 亮色 / 暗色 | 跟随系统 | 只作用于浮层。见 §3.2.4；新增主题只需在 `THEMES` 里加一项，下拉自动出现 |
| 出现动画 | 上浮淡入 / CRT 开关机 / 水波纹 / 无动画 | 上浮淡入 | 浮层出现与收起时的动效。见 §3.2.5 |
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

**出现动画四选一**，**挂在每张卡片上**（`.ddp-card` 带 `ddp-ease-<id> ddp-anim--in|out`）：

| id | 设置项 | 效果 |
| --- | --- | --- |
| `float` | 上浮淡入（默认） | 淡入 + 上移 10px + 轻微缩放 |
| `crt` | CRT 开关机 | 出现：从一条过曝的细亮线（`scaleY(.004)` + `brightness(2.6)`）纵向展开，过冲 6% 再回落；收起：反向压成亮线后消失 |
| `ripple` | 水波纹 | 出现：卡片从 `scale(.94)` 弹性涨到 1，同时 `::after` 圆形波光从中心 `scale(.12)` 扩散到 2.2 并淡出；收起：缩到 `.96` 淡出 |
| `none` | 无动画 | 直接出现 / 直接消失 |

**水波纹怎么做的**：`::after` 是一个 `width:200%; aspect-ratio:1` 的圆，`radial-gradient(circle,
var(--ddp-ripple) 0%, transparent 62%)`，平时 `opacity:0`，只有 `.ddp-ease-ripple::after` 播
`ddp-ripple-wave` 关键帧。因为卡片 `overflow:hidden`，波光被圆角裁住，看起来是**光从玻璃内部涌上来**，
而不是外面飘一圈光晕（后者会盖到相邻卡片）。关键帧里缩放和居中位移写在同一个 `transform` 上，
所以每帧都要写全 `translate(-50%,-50%) scale(…)`。

`--ddp-ripple` 是波纹颜色（亮色偏蓝 `rgba(90,140,255,.24)`，暗色 `rgba(120,170,255,.22)`），主题可换。

已知小瑕疵：CRT 用的 `filter` 会创建新的 backdrop root，动画那 300ms 内毛玻璃模糊会失效（卡片退化成
纯半透明色）。时长极短，暂不处理。

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

### 5.7 压测与实测抓出的五个真 bug（都是上架前后才暴露的）

用户要求「先把 bug 都测完，避免上架后还有 bug」，于是先写两个压力脚本
（`stress-host.mjs` / `stress-client.mjs`）再上真机 10 并发。下面前四条是
压测时实测复现的，第五条是上线后真机下载才撞到的，都不是假想问题。

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

`smoke.mjs` 在假的 `window` 里加载 `client.js`，用极简 React 替身把两个槽位各渲染一次，
断言：5 种任务形态的文案、只有已知总大小才出百分比、`--ddp-rows` 来自设置、
设置页有 7 个配置项（3 个复选框 + 4 个下拉 + 1 个重置按钮）、调试模式默认关，
以及浮层状态机：**调试模式关 + 无任务 = 什么都不渲染**、**调试模式开 + 无任务 = 只有把手**、
**悬停把手展开 5 张示例卡**、**180ms 宽限期内回到卡片不收起**、**离开并等过宽限期才收起**、
**有真实任务时只显示真实卡片且把手隐藏**、**拖把手 40px 只移动 40px（不额外上跳 12px）**，
以及主题：**「跟随系统」不覆盖任何 `--ddp-*`**、**亮色/暗色设上对应 token**、
**切回「跟随系统」把所有覆盖清掉**、**主题 token 不会盖掉 `top` 定位**、
**localStorage 里的第三方主题会出现在下拉里、与内置重名的被丢弃、`--ddp-rows` 与非法值被过滤**，
以及出现动画：**默认 `float`**、**下拉切到 `crt` / `ripple` / `none` 时每张卡片的 `ddp-ease-*` 类跟着变**、**动画类只在卡片上，容器不带**、**入场按 55ms 错峰**。
改完 UI 跑一次就知道有没有改崩。

`smoke-host.mjs` 则直接 import 三个 Host 模块（`utils.js` / `detect.js` / `state.js`，都不依赖宿主），
用假 `fs` 喂时间序列来断言：分类规则、命令行路径解析（引号 / `cwd` / `-O` / 变量不可解析）、
速度滑动窗口、收尾回收时机、以及 `/download-progress/state` 的 JSON 字段契约。
它不需要启动 DSH，所以改 Host 逻辑也能离线回归。

---

## 7. 文件清单

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包声明；`dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 声明 Web 客户端半 |
| `cordis.patch.yml` | bundle 挂载：`insert` 一行 `id: dsh-download-progress` |
| `index.js` | Host 半入口：只做接线（订阅事件、起采样定时器、注册路由） |
| `detect.js` | 工具分类：哪些工具算下载/搜索/抓取/安装，以及命令行里解析目标路径与 URL |
| `state.js` | 任务状态机：建任务、每秒采样文件大小、算速度、收尾回收 |
| `utils.js` | 无副作用的纯函数（截断、取行、去重、URL 提取） |
| `client.js` | Client 半：`CSS` + `describe()` + `Card` + `Overlay` + 设置页 |
| `smoke.mjs` | 离线冒烟测试（假 window + 假 React，不需要浏览器） |
| `smoke-host.mjs` | Host 半离线测试（假 `fs`，不需要启动 DSH） |
| `NOTES-FOR-AI.md` | 本文档：实现笔记。刻意不叫 `AGENTS.md`，避免被 DSH 当项目指令每轮自动注入（约 11K token） |
| `locale/en.json` / `locale/zh.json` | 插件元数据标题（插件列表里显示的名字） |
| `icon.svg` | 插件图标 |
| `LICENSE` | MIT 许可证 |
| `.gitignore` | 忽略 `node_modules/`、测试下载残留（`*.bin`、`*.log`） |

拆成四个 Host 文件的理由：`index.js` 曾是 340 行、混着正则、状态机和接线，改一处要通读全部。
现在分类规则改 `detect.js`、采样逻辑改 `state.js`、纯函数改 `utils.js`，`index.js` 只负责把三者接到宿主上。
四个文件都是同目录下的相对 `import`，由 Node ESM 原生解析，不需要打包器，也不增加依赖。

---

## 8. 优势与已知短板

写给评估这个插件的人：它能做什么、靠什么做到、以及在什么情况下会让你失望。

### 8.1 优势

| 优势 | 具体表现 |
| --- | --- |
| **零核心改动** | 不 patch 宿主、不改 `cordis.yml`、不碰 `agent-loop`。用的是官方公开的 4 个扩展点：`tools/execute` 瀑布钩子、`plugin-manager/install-log` 事件、`webServer.register` 路由、`shell.overlay` / `settings.section` 插槽。宿主升级时这些名字变了才会坏，见 §5.1 |
| **零第三方依赖** | Host 半只用 `node:fs` / `node:path`；Client 半只用宿主已提供的 `react`。没有 npm 依赖，没有构建步骤，`git clone` 下来就能装 |
| **不绑会话、跟着文件走** | 用户把 `curl` 丢进后台（`run_in_background`）后工具会提前返回，插件不看工具何时结束，而是看**文件是否还在变大**——最后 3 秒没长才收起。这是唯一能覆盖后台下载的信号 |
| **UI 与逻辑彻底分离** | 全部样式集中在 `client.js` 顶部的 `CSS` 常量和一个 `<style>` 注入点，所有颜色走 `--ddp-*` / `--dsw-alias-*` 变量。改外观不动一行逻辑，换主题只加一个 token 对象 |
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
