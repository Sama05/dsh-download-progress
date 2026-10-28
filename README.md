# dsh-download-progress

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![AI-assisted](https://img.shields.io/badge/AI--assisted-DeepSeek-6e6ef7.svg)](#ai-开发声明)

在 DeepSeek Harness（DSH）里跑任务时，agent 一开始下载或加载东西，窗口上方自动浮出一条进度条，带**已下载 / 总大小**、**实时速度**、**百分比**，空闲时每秒刷新、有任务在跑时 0.4 秒刷新一次。

---

## 它解决什么问题

agent 常在后台默默执行 `curl -L -o xxx.zip`、`pnpm add`、网页抓取等耗时动作，而 DSH 原生只在工具**开始**和**结束**时给两个瞬间，中间是黑盒。插件把「文件正在变大」翻译成一条能看的进度条。

---

## 效果

浮层挂在窗口顶部居中，平时不显示，不遮挡内容、不推挤布局。

| 场景 | 显示内容 |
| --- | --- |
| 文件下载 | 文件名 + 进度条 + `12.4 MB / 28.3 MB` + `3.2 MB/s`，悬停进度条显示百分比 |
| 插件安装 | 「插件安装中...下载中...」+ 已用秒数，下方一行 pnpm 最新日志 |
| 网页抓取 | 「正在抓取网页中...N s」，秒数实时递增 |
| 功能搜索 | 「正在搜索「查询摘要」中...请稍后」 |
| 其他加载 | 「载入中...」不确定态进度条 |
| 后台任务 | 「后台运行中 · npm run build · 42s」，没有进度条 |

**后台任务**指的是没有进度可画、但在继续跑的工作：bash 后台 job、子代理、workflow。它们画成一行文字而不是卡片——卡片承诺一条会动的轨道，后台任务给不了，画了反而像卡死。当 agent 正阻塞在等它（`job_wait`、`job_output(wait:true)`、等子代理或 workflow 返回）时，同一行改说「等待中」，简易条则显示「等待后台任务」。**前台的 shell 调用不会出现在这里**：它已经在对话里了，再报一次就是重复。

多条任务竖向堆叠，超过设定条数可滚动；卡片支持拖动，出现动画 10 种 + 无动画，在设置里切换。

**多会话并发下载**：多个会话同时下载时，浮层按会话分块，块头是会话标题；只有一个会话时不套块；新会话标题未生成时显示 `会话 <id 末段>`。打开「只看当前会话的下载」后只显示当前会话的进度，切会话跟着换（默认关闭）。

### 简易条（嵌在对话框里）

嫌浮层吵，可在设置里把「显示方式」切成 **对话框简易条**。它长在输入框上面那一行（「完全权限」所在行），**形态由数据决定**：

- **长条**：能算出比例（下载且知道总大小）→ 细进度条 + 流光扫过 + 当前速度，鼠标移上去才浮出百分比。
- **圆环**：拿不到比例（搜索 / 抓取 / 插件安装 / 总大小未知的下载）→ 一个一直转的弧，不显示文字，悬停才给出详情（`搜索中 · 12s`、`下载中 · 2.86 MB · 512 KB/s`）。
- **三个点**：本会话没有任务，或连任务类型都拿不到 → 三个点依次呼吸，悬停显示 `空闲` / `处理中`。

空闲时也保留这个胶囊（三点常驻），不想要可切回「浮层」。它只显示**当前会话**的下载；同会话多任务时跟最早那条走，右侧 `+2` 表示还排着几个。主题、亮/暗色、`--ddp-*` 与浮层共用一套。

想两个都要就选「两者都显示」。默认仍是**浮层**，升级后界面不变。

---

## 支持的版本

| 项 | 要求 | 说明 |
| --- | --- | --- |
| **DSH** | `>= 0.2.0-rc.1` | 已写入 `package.json` 的 `engines.dsh`。**完整验证于 `0.2.1-rc.2`** |
| Node.js | `>= 18` | 插件跑在 DSH 内置的 Electron 里 |
| Chromium | `>= 111` | 毛玻璃与 `color-mix` 需要，DSH 0.2.x 自带 |
| 操作系统 | Windows / macOS / Linux | **只在 Windows 实测过**；其余平台理论可用但未验证 |
| 第三方依赖 | 无 | 不需要 `npm install`；`client.js` 已是构建产物，装包的人不跑构建 |

版本不满足时插件管理器会以 `incompatible-version` 拒绝并指出缺什么，**不会静默坏掉**，也不影响 DSH 本体。上界不封死，最坏只是浮层不出现。

---

## 安装

DSH 插件以 bundle 形式安装，两种方式任选：

**从 GitHub 装**（不需要 clone）：

```bash
dsh plugin --profile web add github:Sama05/dsh-download-progress
```

> 把 `web` 换成你的 profile 名；desktop profile 因 CLI 限制需走下面的 link: 方式。

**从本地目录装**（改代码时用，改完即时生效）：

```text
plugin_manager action=install_bundle target="<本仓库的绝对路径>"
```

**手工 link: 安装**：在 profile 的 `package.json` 里加
`"@local/dsh-download-progress": "link:<本仓库绝对路径>"`，并把包名加进 `dsh.profile.bundles`。

装完后重启 DSH 或在插件管理器里启用，浮层即生效。卸载：

```text
plugin_manager action=remove_bundle target="@local/dsh-download-progress"
```

**不需要 `npm install`**，发布包里带的就是拼好的 `client.js`，安装方不跑构建。

装好后确认：①「设置 → 插件」里能看到「下载进度条」这一页；② 让 agent 执行一次 `curl -o <文件> <某个大文件 URL>`，浮层会出现在窗口上方。

配置在「设置 → 插件 → 下载进度条」里，无需改任何文件。

---

## 支持哪些下载

判据是**能不能拿到落盘路径**——先看命令行，命令行里没有就去看它指定的脚本。

**有真实进度（字节 + 速度 + 百分比）**

| 命令 | 说明 |
| --- | --- |
| `curl -o <文件>` / `--output` / `--output-document` | 最常见；`--output=X` 等号写法同样识别 |
| `curl -O` / `--remote-name` | 目标文件由 URL 推断 |
| `wget -O <文件>` | 支持 `--output-document=X` |
| `Invoke-WebRequest -OutFile <文件>` | 必须带 `-OutFile`；`-OutFile:D:\x` 冒号写法也认 |
| `git clone <url> <目录>` | 采样目录总体积（目标是目录，`stat` 恒为 0，单独走目录树累加） |
| `powershell -File <脚本>` / `pwsh -File <脚本>` | 读脚本里的 `-OutFile` / `-Destination` / `-o` |
| `certutil -urlcache -split -f <url> <文件>` | 目标按普通文件采样 |

`-File` 那一行值得单独说：命令本身不含任何路径，插件的做法是**打开脚本静态解析**
（只读一次，约 0.3 ms），把 `$iso = "D:\…\x.iso"` 这类单层字面量赋值、
`param([string]$Out = '…')` 默认值、`$env:USERPROFILE` 展开、`Join-Path` 都算出来。
脚本里的 URL 也一并读出来，用来做 `Content-Length` 探测，所以百分比照样有。
脚本用子进程下载（`& curl.exe -o $Out $Url`）同样能跟——采样的是**文件大小**，
跟谁把字节写进去无关。

**只有「进行中」（无字节数，宿主不提供中间事件）**

插件安装（`pnpm` / `npm` / `yarn`）、网页抓取、`research` / `web_search` 类搜索工具、其他包管理器命令（`pip` / `uv` / `docker pull` / `ollama pull`）、`Start-BitsTransfer`。

> **「启用深度进度」开关**（设置页，默认关，**改完需重启应用生效**）：打开后，网页抓取与搜索这类**不落盘**的 HTTP 请求也能拿到字节数与百分比。
>
> **两层并列，不是二选一**——Node 里有两种互不相通的 HTTP 实现：
>
> | 层 | 覆盖 | 装法 |
> | --- | --- | --- |
> | `sensor/stream.js` | 宿主内置 `web_fetch`（走 undici 时）、`fetch()` | `Module.registerHooks` 改写 undici 源码 |
> | `sensor/https.js` | **`dsh-free-search` 的 `fs-quality-fetch`、`node-fetch` v2、`axios`、`got`、`request`、手写 `https.get`** | 换 `http`/`https` 模块的 `request` 与 `get` 导出 |
>
> 本机就是活例子：装了 `dsh-free-search` 之后，`web_fetch` 被它的 `fs-quality-fetch` 接管，实际用 `node:https` 直连（`lib/fetch_provider.js:201` 调 `transport.request`）。只包 undici 的话一个字节都拿不到——诊断字段里 `loaded` 恒为 `false` 就是证据。第二层比第一层稳得多：`http.request` 是 Node 公开 API，装在任何时刻都立即生效，没有缓存时序陷阱。
>
> **为什么仍要重启**：第一层（undici）只能在模块第一次被加载时注入，而 undici 是 CJS 包——缓存命中时 `load` 钩子根本不触发。所以钩子在插件启动时就装上、常驻，开关只决定「要不要记字节」。关着时包装函数原样透传：不建流、不 `getReader`、一个字节都不多读。
>
> 卡片会明确说清自己是哪一种状态，不让用户去拨一个没用的开关：关着 → 「打开『深度进度』可显示百分比」；开着且任一层生效 → 不显示提示，直接出百分比；两层都装不上 → 「当前环境不支持深度进度」；装了但没测到 → 「深度进度开启失败，已降级为仅计时」。
>
> 快照里另有 `stream` 字段把判断依据摊开，排查时不必挂调试器：
>
> ```json
> "stream": { "active": true, "sawEvent": false, "wrapped": false, "loaded": false, "http": true }
> ```
>
> `wrapped` / `loaded` 说 undici 那层，`http` 说 http/https 那层，`sawEvent` 是最硬的证据（收到过字节）。

`Start-BitsTransfer` 单独说明：它先把字节写进同目录的 `BITxxxx.tmp`，跑完才改名成 `-Destination`。所以目标文件在整个传输期间**根本不存在**，任何盯着 `-Destination` 的进度条都只能是 0%。插件把它标成「分段写入」，只显示已耗时和文件名，不画百分比——这是被测出来的写盘形状，不是猜的。

**拿不到进度的情况**

- 下载不落盘（`curl ... | tar -x`、输出到 stdout）；
- 命令里用变量拼路径（`-o $dst`）——插件只能读命令文本，无法求值；
- `Start-BitsTransfer <url>` 只给一个 URL、不给 `-Destination`：文件名由 BITS 自己决定，插件不猜路径；
- 脚本里的路径要跑起来才知道（`Get-Content cfg.json` 取值、`+` 拼接、here-string、`$(...)` 子表达式）——这类一律**不猜**，不出卡片；
- 服务端不返回 `Content-Length`（降级为不确定进度条 + 已下载体积 + 速度，无百分比）；
- 上传（`curl -T` / `--upload-file`）：本端不落文件，不可能有进度，直接不出卡片；
- 纯内存下载、纯 API 调用。

---

## 优点

- **触发准确**：工具开始执行即起表；不绑会话，下载丢到后台后只要文件还在长就继续显示。
- **零侵入**：只用官方公开扩展点，没改 DSH 核心、没 monkey-patch；卸载不留痕迹。
- **零依赖**：没有第三方包，不会因上游升级而断，也不需要联网安装。
- **不抖**：渲染在布局流之外，出现、收起、悬停展开都不会让窗口元素位移。
- **可扩展主题**：内置跟随系统 / 亮色 / 暗色，也能加载自定义 `--ddp-*` 主题。

---

## 缺点与限制

- **显示的是磁盘增长量，不是网卡流量**：DSH 只在工具开始/结束时通知，中间字节流不对外暴露，所以不落盘的下载看不到进度。（打开「深度进度」可解这一条，代价见下一条。）
- **「深度进度」依赖宿主内部实现**：它按路径后缀 `/undici/index.js` 匹配宿主加载的模块，靠 `Module.registerHooks` 的 `load` 钩子在**那个模块自己的作用域里**替换它导出的 `fetch`。宿主换打包方式、换 HTTP 客户端、或 Node 低于 22.15，这一层就装不上——届时快照里的 `capabilities.stream` 报 `unavailable` 或 `degraded`，卡片照常工作，只是回到「仅计时」。
- **不落盘的下载在开关关着时看不到进度**：默认关。要百分比得自己去设置页打开。
- **变量路径无法解析**：`-o $dst`、`-o "$(pwd)/file"` 这类写法只能读到字面量。
- **总大小依赖 HEAD 探测**：对方不给 `Content-Length`、或 HEAD 被拒（403/405，Cloudflare 常见）时没有百分比，只有不确定进度条。深度进度开着时改用响应头的 `content-length`，这一条同时被绕过。
- **搜索与抓取默认只有计时器**：响应是一次性返回的，这是宿主能力边界；打开「深度进度」后可拿到字节数。
- **轮询而非推送**：Client 空闲期每秒拉一次状态，有任务在跑时 0.4 秒补一拍——最坏延迟就是那个间隔。
- **命令解析是启发式的**：curl/wget 参数组合极多，未覆盖的写法会退化成「不触发」或「载入中」。
- **脚本只读一次、只看字面量**：`-File` 里的路径必须是能静态算出来的（字面量、`param` 默认值、`$env:`、`Join-Path`）；要 `Get-Content` 读配置、字符串拼接、或 `$(...)` 才能定的，插件不猜、不出卡片。脚本改写后需要等下一次工具调用才重新读。
- **会话重名无法区分**：两个会话同名时，分块块头显示同一个标题。
- **后台任务只知道「在跑」**：没有百分比、也不能取消，宿主只广播生命周期事件。归属会话靠「父会话此刻阻塞在哪个工具」推断，推断不出来时该行的会话名为空。

---

## 设置项

「设置 → 插件 → 下载进度条」：

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| 显示下载进度浮层 | 开 | 关掉后不轮询、不渲染 |
| 显示方式 | 浮层 | 浮层（悬浮卡片）/ 对话框简易条 / 两者都显示。选「简易条」后上方浮层不再出现 |
| 显示下载速度 | 开 | 关掉后只留「已下载 / 总大小」；简易条则只留条（圆环/三点本来就没字） |
| 启用深度进度（需重启应用生效） | 关 | 打开后在宿主进程里包住 undici 的 `fetch`，让网页抓取 / 搜索这类不落盘的请求也有字节数与百分比。**改完要重启应用**：包装必须在模块首次加载时注入，宿主启动早期已加载过 undici。宿主不支持时不会崩，状态会退回「仅计时」并在卡片上说明 |
| 调试模式（显示模拟数据） | 关 | 打开后无真实任务时展示 5 张模拟卡片，用来调 UI |
| 只看当前会话的下载 | 关 | 关：所有会话的下载按会话分块堆叠；开：只显示当前打开的会话的下载，切会话跟着换（当前会话没下载时浮层不出现） |
| 新任务的排列位置 | 最新在前 | 多条任务时新的排顶部还是底部 |
| 最多同时显示条数 | 3 | 1–6，超出滚动 |
| 主题 | 跟随系统 | 跟随系统 / 亮色 / 暗色 |
| 出现动画 | 上浮淡入 | 上浮淡入 / CRT 开关机 / 水波纹 / 横向滑入 / 下落弹入 / 弹性放大 / 横扫揭示 / 翻折展开 / 旋转入位 / 模糊聚焦 / 无动画 |
| 浮层位置 | 顶部居中 | 直接拖动浮层定位，「重置位置」恢复 |

配置保存在浏览器 `localStorage`，不写 Host 配置文件，所以升级重装不会丢。

### 自定义主题（`--ddp-*`）

主题就是一组 `--ddp-*` CSS 变量。在浏览器控制台写一次即可（与内置 id 重名的丢弃，`--ddp-rows` 等布局变量被拒绝）：

```js
localStorage['dsh-download-progress:themes'] = JSON.stringify([
  { id: 'solarized', label: 'Solarized', tokens: {
      '--ddp-accent': '#b58900', '--ddp-fg': '#657b83', '--ddp-card-bg': 'rgba(253,246,227,.97)' } },
])
```

刷新页面后「主题」下拉会多出 `Solarized`。只写一两个变量也能用，没写的回落到宿主 `--dsw-alias-*`；主题只覆盖颜色，不影响布局。

---

## 开发与测试

改完跑 `npm test` 即可（八步全离线，不需要浏览器或 DSH 进程）：`scripts/build-client.mjs --check` → `contract.mjs` → `script.test.mjs` → `smoke.mjs` → `smoke-host.mjs` → `stress-host.mjs` → `stress-round2.mjs` → `stress-client.mjs`。`contract.mjs` 会拦住「视图直接读 wire 字段」和「文档与实现不一致」两类退化——Host 与 UI 之间的字段契约见 [CONTRACT.md](CONTRACT.md)，其余实现细节见 [NOTES-FOR-AI.md](NOTES-FOR-AI.md)。

手工实验的脚手架（限速服务器、命令分类矩阵、真机观察器）在 `lab/`，见 [lab/README.md](lab/README.md)；它不随插件发布。

性能基准：`npm run bench`（中位数 + p95，`--json` 出机器可读结果，`--save` 更新 `bench/baseline.json`；`--after` 存到 `bench/after.json` 便于前后对比）。

**改了 UI 之后要重新拼一次**：`client.js` 是 `src/client/**` 的构建产物（宿主只下发一个 bundle，源码里不能写 `import`），改完跑 `npm run build`；`npm test` 的第一步 `build-client --check` 会在产物过期时直接失败并指出第一处差异。

---

## AI 开发声明

本插件是 **AI 辅助开发** 的产物：需求由人提出，实现与验证由 DeepSeek 模型在 DSH 会话中完成，视觉与交互效果由人目视验收。代码以 MIT 授权，可自由使用、修改与分发，仅请求保留出处与本节说明。

---

## License

[MIT](LICENSE)
