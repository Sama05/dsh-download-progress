# lab — 手工实验区

这个目录**不随插件发布**（`package.json` 的 `files` 白名单不含 `lab/`），只保留还能再用的工具。

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
