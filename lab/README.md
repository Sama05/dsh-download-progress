# lab — 手工实验区

这个目录**不随插件发布**（`package.json` 的 `files` 白名单不含 `lab/`），只保留两类东西：

## `lab/` 根目录 = 还能再用的工具

| 文件 | 用途 |
| --- | --- |
| `http-slow.mjs` | 确定性限速 HTTP 服务器，`GET /file?mb=N` 按固定速率发 N MiB，**带 `content-length`** → 用来验证「长条」形态。`LAB_PORT`（默认 45777）/ `LAB_RATE`（默认 4 MiB/s） |
| `chunkless-slow.mjs` | 同上但**故意不发 `content-length`**（chunked）→ 永远拿不到百分比，用来验证「圆环」形态。默认端口 45790 / 120 KB/s |
| `matrix.mjs` | 命令分类矩阵：23 个真实命令写法一次性过 `classify()` + `extractTargets()`，确认哪些该触发、哪些该拒绝 |
| `e2e-script.mjs` | `-File` 脚本链路的端到端断言（分类 → 读脚本 → 取目标 → 建卡） |
| `watch-state.ps1` | 轮询状态路由并逐行打印，真机观察插件时用 |
| `REPORT-2026-10-23.md` | 那一轮全面回归测试的报告（结论与剩余缺口） |

`lab/work/` = 测试夹具（脚本 + 轮询器），被 `.gitignore` 忽略。
下载出来的 `.bin` 一律不保留，需要时按下面的命令现生成。

## `lab/archive/` = 一次性实验，已收口

`archive/` 里是**做完就结束**的探针脚本，留着只为「当初怎么得出这个结论」可追溯：

| 文件 | 当时验证/否定了什么 |
| --- | --- |
| `exp1-io.mjs` + `io-helper.ps1` | **否定**：Windows 的 `Win32_Process` IO 计数器只统计文件/设备读写，**不统计 socket** ⇒ 靠进程 IO 猜下载量行不通 |
| `exp2-tcp.mjs` + `tcp-helper.ps1` | **否定**：`GetPerTcpConnectionEStats` 需要每条连接单独启用且开销大，无法在宿主主线程每秒跑一次 |
| `exp3-tree.mjs` + `proc-helper.ps1` | 验证宿主 `pwsh` 的进程链与命令行形态（决定了「读脚本」路线可行） |
| `exp4-script.mjs` | 验证静态解析脚本能拿到落盘路径（`-File` 支持的技术基础） |
| `exp5-safety.mjs` | 验证在 `tools/execute` 钩子里读文件的安全性开销（0.4 ms/call 级） |
| `gen-*-split.mjs` | 一次性代码拆分生成器（按行区间切片，保证 body 字节不变）。**已执行完毕，源码现已手工维护，不要再跑** |
| `probe-*.mjs` / `dl-*.ps1` / `get-iso-*.ps1` / `probe-install.mjs` | 各轮排查用的临时探针与夹具 |

## 复现一次下载

```powershell
# 长条（有总大小）
node lab\http-slow.mjs                                  # 另开一个终端
curl.exe -s -o lab\work\a.bin "http://127.0.0.1:45777/file?mb=20"

# 圆环（无总大小）
$env:LAB_PORT='45790'; $env:LAB_RATE='120000'; node lab\chunkless-slow.mjs
curl.exe -s -o lab\work\b.bin "http://127.0.0.1:45790/file?mb=40"

# 观察
powershell -File lab\work\get-artifact-slow.ps1         # -File 脚本下载
node lab\work\poll-timeline.mjs 500 60                  # 打印卡片时间线
```
