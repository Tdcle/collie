<p align="center"><img src="web/icon.svg" width="72" alt="Collie"></p>

<h1 align="center">Collie</h1>

<p align="center"><b>在手机上，放牧一群 agent</b><br>
Claude Code · Codex · Antigravity — 一个 hub，多台电脑，一个会自己推进的 super-agent</p>

<p align="center">
<a href="https://lihuanyu0w0.github.io/collie/demo/"><b>▶ 在线体验</b></a> ·
<a href="#安装">安装</a> ·
<a href="https://github.com/Tdcle/collie/releases">下载</a>
</p>

<p align="center"><img src="docs/img/demo.gif" alt="给 Collie 发一句话：它派出 worker，worker 回报，Collie 汇总；决策卡片一点就回" width="900"></p>

电脑上开着的 Claude Code、Codex、Antigravity 会话，手机上直接接着聊：看对话、发消息、处理确认框，需要你的时候叫你一声。活多了就交给 **Collie** 这个 super agent：它把活派给各台电脑并行去做，盯进度、处理卡点，只在需要你拍板时出声。

> Collie 是一只边牧（border collie）：[herdr](https://herdr.dev) 管终端，Collie 把 agent 赶到一处干活。

## 为什么用 Collie

- **一个入口，派一群 agent** — 把事情告诉 Collie，它理解上下文、选 agent 和模型、拆活并行去做，结果回到同一个对话
- **确认框变成卡片** — agent 停在「允许运行吗？」时，问题和选项变成一张卡片，手机上点一下就回
- **所有电脑合在一处** — Mac、Windows、Linux 开发机、云电脑连到一个 hub；电脑主动连出去，不开端口、不配 SSH，在 NAT 后面也行
- **读真正的对话** — 直接读 agent 自己的会话记录，终端变成清晰的对话；也能切到原样的屏幕和日志
- **自己往前推** — worker 失败了重试、换模型、换思路；只有花钱、删东西、发布这类事才停下来问你
- **越用越会派活** — 记住你的偏好和每次干活的经验：数据在哪、怎么做的、踩过的坑、哪个 agent 在哪台电脑上好用，下次派活直接带上
- **一个二进制，数据在你手里** — 单个 Go 程序 + SQLite，前端内嵌；每台设备一个令牌，随时移除；不经过第三方服务

<table>
<tr>
<td width="62%"><img src="docs/img/hero-light.png" alt="和 Collie 对话"><br><sub><b>和 Collie 对话</b>：派出两个 worker，一个已回报；卡住的 agent 直接在对话里处理</sub></td>
<td width="19%"><img src="docs/img/phone-list.png" alt="手机上的列表"><br><sub><b>手机</b>：需要你的置顶</sub></td>
<td width="19%"><img src="docs/img/phone-ask.png" alt="手机上的决策卡片"><br><sub><b>决策卡片</b>：一点就回</sub></td>
</tr>
<tr>
<td colspan="3"><img src="docs/img/agent.png" alt="agent 的对话视图"><br><sub><b>直接管 agent</b>：对话视图里看它的计划和每一步工具调用，标题栏写着它用的模型</sub></td>
</tr>
</table>

更多截图：[屏幕视图](docs/img/screen.png) · [自动化 · 记忆](docs/img/memory.png) · [设备](docs/img/devices.png) · [深色主题](docs/img/hero-dark.png)

## 架构

<p align="center"><img src="docs/img/architecture.svg" alt="Collie 架构" width="900"></p>

一个 **hub** 放在常开的开发机上；其他电脑运行 `collie node` 主动连上 hub；手机、平板、浏览器只连 hub。互不相通的网络各跑一个 hub，浏览器把它们的会话合进同一个侧栏。

## 安装

每台电脑上都要先有 herdr 服务端在跑，并装好 agent 集成（`herdr integration install claude`、`codex`、`antigravity-cli`）。没装集成时，herdr 认不出 agent 在干什么，Collie 也就没法给它发消息。

安装脚本下载对应平台的二进制（校验 SHA-256），装到 `~/.local/bin/collie`（Windows 上是 `%USERPROFILE%\.local\bin\collie.exe`），并装成后台服务（macOS 用 launchd，Linux 用 `systemd --user`，Windows 用 `collie daemon` + 登录自启）。以后重跑同一条命令就是升级。

**1. 开发机：起 hub**

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s -- hub
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1))) hub"
```

启动时打印本机内网地址和手机配对二维码；地址认不准时加 `--url http://<开发机 IP>:7788`。日志：Linux `journalctl --user -u collie-hub -f`，Windows `Get-Content -Wait $HOME\.collie\hub.log`。Linux 要在退出登录后继续跑，运行一次 `loginctl enable-linger`。

**2. 手机：扫码**

扫终端里的二维码，或者在「设备 → 连接手机或平板」里扫。二维码里是 `http://<内网 IP>:7788/?pair=<配对码>`，10 分钟内有效、只能用一次；打开后这台手机拿到自己的令牌，之后「添加到主屏幕」即可。也可以在登录页直接输入 8 位配对码。

**3. 其他电脑：加入（macOS / Linux / Windows）**

在 hub 的「设备 → 连接一台电脑」里拿连接命令（或在 hub 上运行 `collie pair --computer`），然后在那台电脑上：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s -- node --hub http://<hub>:7788 --code <配对码>
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1))) node --hub http://<hub>:7788 --code <配对码>"
```

它会配对、把 hub 地址和令牌存进 `~/.collie/node.json`，自动检测/安装 herdr 并启动 `herdr server`，再装成后台常驻服务。之后重跑不带配对码的 `… node` 就是升级。

**4. 在桌面装成 app（可选）**

加入了 hub 的电脑会在本机 `http://127.0.0.1:17788` 提供同一个界面（转发到 hub）。浏览器把 127.0.0.1 当作安全来源，所以用 Chrome / Edge 打开它、登录一次（「设备 → 连接手机或平板」里的 8 位配对码），地址栏右侧点「安装 Collie」，就会得到一个独立的桌面 app，浏览器通知也能用了。换端口：`collie node --ui 127.0.0.1:端口`；不要：`--ui off`。

- node 出站连接、长连接复用（yamux），笔记本在 NAT 后面也能用，**不用开端口、不用 SSH**；断线后自动重连
- hub 把所有电脑的 herdr 合成一个：远端的 pane id 带后缀，例如 `w1:p1@mac`；列表、对话、启动 agent、Collie 派 worker 都可以指定电脑
- 每台设备一个令牌，可以在「设备」页随时移除；电脑的令牌只能连隧道和调用 `collie` CLI，打不开 Web 控制台
- 在加入了 hub 的电脑上，`collie` CLI 会自动用 `node.json` 里的地址和令牌，所以跑在那里的 worker 也能 `collie report`

> 内网里是明文 HTTP。跨网络使用请放在 VPN / Tailscale 或 HTTPS 反向代理后面（这时用 `--url https://…` 让二维码指向它）。

### 更新

hub 每隔几小时看一次 GitHub 上的最新版本。有电脑落后时，侧栏底部会出现「有新版」，「设备」页会列出是哪台。点「更新到 vX」，那台电脑会自己下载新版、校验后原地重启（里面的 agent 不受影响）；也可以在那台电脑上手动运行：

- 电脑（node）：macOS / Linux 运行 `curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s -- node`；Windows 运行 `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1))) node"`（不用再配对）
- hub：把末尾的 `node` 换成 `hub`，当初加过 `--url` 等参数的话照样带上

从源码编译的（版本是 `dev`）和 v0.2.5 以前的电脑不会被提示。

### 多个 hub

几台电脑在互不相通的网络里（开发机、云电脑、家里的 Mac mini）时，每个网络各跑一个 hub，再在其中一个 hub 的「设备 → 其他 hub」里粘贴另一个 hub「连接手机或平板」下的链接。之后它的会话会并进同一个侧栏（标着来自哪个 hub），对话、发消息、停止都直接发给那个 hub。

- hub 之间不需要互通，只要浏览器能打开每一个；列表存在当前这个 hub 上，用它的手机和电脑浏览器看到的是同一组
- 每个 hub 的 Collie 只调度自己网络里的电脑
- 对方 hub 要是 v0.2.4 及以后（允许跨站访问，只认令牌、不认 Cookie）；https 的页面连不了 http 的 hub

**从源码安装**（需要 Go 1.25+ 和 git）：clone 下来在仓库里运行同一个脚本，它用本地源码编译、不下载，参数和上面一样：

```bash
# macOS / Linux
git clone https://github.com/Tdcle/collie.git ~/collie && cd ~/collie
sh docs/install.sh hub                                          # 做 hub
sh docs/install.sh node --hub http://<hub>:7788 --code <配对码>   # 加入电脑
```

```powershell
# Windows (PowerShell)
git clone https://github.com/Tdcle/collie.git $HOME\collie; cd $HOME\collie
powershell -ExecutionPolicy Bypass -File docs\install.ps1 node --hub http://<hub>:7788 --code <配对码>
```

以后 `git pull` 再跑一次就是升级。

只想装命令、不装服务：macOS / Linux `curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh`，Windows `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1)))"`。指定版本或目录：`COLLIE_VERSION=v0.3.0`、`COLLIE_BIN_DIR=…`。脚本在 [docs/install.sh](docs/install.sh) 和 [docs/install.ps1](docs/install.ps1)。

## 两种用法

**直接管 agent**：新建、查看、接管任意一台电脑上的 agent 或终端。终端被包装成对话视图；agent 停在确认框时，会变成一张决策卡片。

**和 Collie 对话（super-agent）**：你只和一个入口说话。Collie 的 Router 理解上下文，把活拆给 worker（Claude / Codex / Antigravity，各自在独立的 herdr 工作区里）并行去做，结果以事件的形式回到对话里，只在需要你决定或验收时出声。

侧栏按电脑分组列出**你自己的** agent；Collie 派出的 worker 和 Router 收在单独的「Collie 的 worker」组里（默认折叠），两者互不干扰。桌面端打开时回到上次的页面，手机端首页是列表。

## Super-agent 设计

参考 DeepSeek 的 Super-agent 架构和 Anthropic 的 *Building always-on agents*：

```
          ┌──────── 你（Web 对话 / 飞书 / GitHub / 定时器 …）
          ▼
   Trigger 收件箱 ── 快路径：来源策略 respond / candidate / ignore
          │
          ├── 订阅了线程的 worker ◀── 直达，不经过 Router
          ▼
   Router（常驻 session，只理解、分派、回复）
          │  collie spawn / send / reply / timer …
          ▼
   Worker × N（隔离的 herdr 工作区，干活，collie report 汇报）
```

- **Router / Worker 分层**：Router 只和人说话、分派任务，不亲自干活；回复限制在 100 词以内（可调）。Router 用轻量模型就够，worker 才需要最强的模型
- **Trigger**：聊天、webhook、定时器、worker 状态变化都是 Trigger。程序先按来源策略过滤（快路径），再交给 Router 判断（慢路径）。未经请求的外部事件默认是 `candidate`：只有 Router 的记忆或你的规则覆盖到时才行动
- **线程订阅**：worker 订阅某个线程（Issue、群聊话题）后，后续事件直达它
- **批量投递**：session 忙或停在确认框时事件会积压，空闲后合并成一批投递
- **Inline & Spill**：超过 700 字的事件只内联开头，其余用 `collie show <id>` 按需取回；所有东西都有 ID，可以顺着链条回溯
- **异步启动**：`collie spawn` 立即返回，worker 的汇报、完成、阻塞都作为事件回来
- **Watchdog**：worker 长时间屏幕无变化会被标记为卡住并通知 Router；Router 自己出错（凭证、地区限制、额度）会直接显示在对话里
- **状态与计算分离**：所有状态存在 SQLite，Router 可以随时重启，读 `memory.md` 恢复上下文，排队的事件不会丢
- **Outbox**：可选的飞书 / Slack 机器人通知，20 秒合并一次，安静模式只在需要你时推送

## CLI

Router 和 worker 通过同一个二进制和 Collie 通信（你也可以用）：

```bash
collie reply "…"                                   # Router → 你（≤100 词）
collie spawn [-kind claude] [-machine mac] [-cwd ~/x] [-name n] [-thread t] [-subscribe] "任务"
collie send <worker> "追加指令"
collie report "结果或需要你决定的问题"              # worker → Router（按 HERDR_PANE_ID 识别自己）
collie subscribe [--off] <worker> <thread>
collie stop <worker>
collie show <trigger | thread | worker>            # 取回被截断的内容
collie list
collie timer add [--thread T] [--to worker] "daily 09:00 | every 2h | in 30m | at 2026-11-18 09:00" "内容"
collie timer ls | rm <id>
collie say "…"                                     # 以你的身份发给 Router
collie hook <source> "…"                           # 模拟一个外部事件
collie pair [--computer]                           # 打印手机配对二维码 / 电脑加入命令
collie node [--hub URL --code CODE] [--name pc]    # 把这台电脑接到 hub
collie daemon <start|stop|restart|status> <hub|node> # 后台常驻管理（Windows 默认使用）
```

## 接入外部事件

在「自动化 → 接入」里复制地址：

- GitHub：`/hooks/github?key=…`（Content type 选 application/json）
- 飞书 / Lark 事件订阅：`/hooks/feishu?key=…`（已处理 url_verification）
- 通用：`POST /hooks/<source>?key=…`，JSON `{"text","thread","from","id"}`，`X-Idempotency-Key` 去重

Webhook 立即返回 202，过滤和路由在收件箱里异步完成。

## 直接管 agent

- **新建 Agent**：选类型、名字、目录，可以顺手给它第一个任务
- **对话视图**：消息来自 agent 自己的会话记录——Claude `~/.claude/projects/*/<id>.jsonl`、Codex `~/.codex/sessions/**/rollout-*.jsonl`、Antigravity `~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl`（桌面版在 `~/.gemini/antigravity`）。Antigravity 不向 herdr 报告会话 id，Collie 用它自己的会话索引按工作目录精确配对，配不上时宁可显示终端输出，也不会串到别的会话
- **决策卡片**：agent 停在确认框时，把问题用一句话讲清楚，选项变成列表；编号菜单发数字，光标菜单发方向键 + 回车。「查看终端」可以展开原始屏幕
- **屏幕 / 日志视图**：xterm.js 原样呈现，或自动换行的滚动日志（适合窄屏）
- **需要你**：blocked 的 agent 置顶，标签页标题带计数，后台时弹浏览器通知
- PWA

## 其他终端里的会话

在 iTerm、VS Code、tmux、SSH 里直接跑的 claude / codex / agy 不归 herdr 管，Collie 也会把它们列在侧栏「其他终端里的会话」，hub 和每台连上的电脑都会列出：

- **看**：按进程找到它正在写的会话记录（Claude 用 `~/.claude/sessions/<pid>.json`，Codex 按工作目录匹配 rollout，agy 用它自己的索引），以只读对话的形式实时显示
- **接管**：Collie 没法往别的终端里打字，所以「在 herdr 里接管」会先结束原来的进程（相当于 Ctrl-C），再在 herdr 里用同一个会话继续（`claude --resume`、`codex resume`、`agy --conversation`）。之后它就是普通 agent，可以在手机上对话、处理确认

## 偏好设置

侧栏底部的齿轮。只影响当前浏览器：主题（跟随系统 / 浅色 / 深色）、对话文字大小、打开 agent 时默认显示对话还是屏幕、Enter 还是 ⌘Enter 发送、是否折叠连续的工具步骤、浏览器通知。

## herdr 版本差异

Collie 同时支持 herdr 0.8 和 0.9：

- 0.8 只能按 pane id 找 agent，而且 agent 一启动完就忘了名字。Collie 自己记着它启动的每个 agent 叫什么（存在 `herd.db`），调用前换成 pane id
- 0.8 有时一直停在 `launch_pending`，不接受 `agent.prompt`。这时 Collie 确认 agent 空闲、屏幕上没有选择框以后，直接把消息贴进终端
- 0.8 会把 Claude 的「是否信任此文件夹」报告成空闲。Collie 会看一眼屏幕，有选择框就当作「等你确认」处理

## 参数与文件

`collie`（等同 `collie serve`）启动 hub，打印带主令牌的地址和手机配对二维码。前端（含 xterm.js）全部内嵌在二进制里，内网不需要访问 CDN。

| 参数 | 环境变量 | 默认值 |
|---|---|---|
| `-addr` | `COLLIE_ADDR` | `0.0.0.0:7788` |
| `-socket` | `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` |
| `-token` | `COLLIE_TOKEN` | 自动生成（主令牌） |
| `-url` | `COLLIE_URL` | 自动探测内网地址；二维码和配对命令用它 |
| | `COLLIE_HOME` | `~/.collie` |

> 拿到令牌的人就能控制你的终端。主令牌只给自己用；其他设备都通过配对拿各自的令牌。

### `~/.collie`

| 路径 | 内容 |
|---|---|
| `herd.db` | SQLite（WAL）：Trigger 收件箱、线程、worker、对话、定时器、设置、已配对设备（只存令牌哈希） |
| `node.json` | 仅 node：hub 地址、本机 id 和令牌 |
| `token` | 访问令牌 |
| `addr` | 当前监听地址，供 CLI 使用 |
| `router/` | Router 的工作目录：`ROUTER.md`（操作手册，同时写成 CLAUDE.md / AGENTS.md / GEMINI.md）、`memory/`（长期记忆：你的偏好、进行中的任务、按项目整理的笔记） |
| `bin/collie` | 用 `go run` 启动时复制出的稳定 CLI 路径 |

## 从源码构建

需要 Go 1.25+。

```bash
go build -o bin/collie .
./bin/collie                       # 监听 0.0.0.0:7788
go test ./...
scripts/release.sh v0.1.0 --dry    # 交叉编译四个平台到 dist/
```

## 代码结构

```
浏览器 ──HTTP + SSE──▶ collie hub（单个 Go 二进制，前端 embed）──NDJSON──▶ herdr.sock
                         ├─ 会话记录增量解析（JSONL）
                         ├─ Super：收件箱 → 路由 → 投递（SQLite）
                         └─ yamux 隧道 ◀── collie node（herdr 流 + 本机 pane API）
```

```
main.go              入口：只有版本号和 collie.Main
internal/collie/     hub、node 和 CLI（一个包）
web/                 前端：原生 HTML/CSS/JS，无构建步骤；embed.go 用 go:embed 打进二进制
docs/                install.sh、主页和截图（docs/img/）
scripts/release.sh   交叉编译和发布
scripts/demo.sh      构建在线体验（docs/demo/）：真实前端 + scripts/demo/demo.js 里的虚构数据
```

`internal/collie/` 里：

- `herdr.go`：herdr socket API 客户端
- `fleet.go`：多台电脑的 herdr 路由（id 后缀、列表合并）
- `hub.go` / `node.go`：设备配对与令牌、二维码、内网地址、隧道、请求转发
- `external.go` / `desktop.go`：其他终端和桌面 app 里的 agent 进程、会话记录定位、只读对话流、接管
- `server.go`：鉴权、状态 SSE、pane 屏幕/日志 SSE、输入、启动 agent
- `chat.go` / `agy.go`：会话记录解析（Claude / Codex / Antigravity）、决策卡片识别、对话 SSE
- `store.go` / `db.go`：super-agent 的数据模型和 SQLite 持久化
- `super.go` / `superapi.go` / `cli.go`：Router 与 worker 的调度循环、HTTP API、webhook、CLI 与 Router 手册
