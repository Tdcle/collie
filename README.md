<p align="center"><img src="web/icon.svg" width="72" alt="Collie"></p>

<h1 align="center">Collie</h1>

<p align="center"><b>跨设备的多机编码 Agent 编排与协作总控台</b><br>
Claude Code · Codex · Antigravity · Gemini CLI — 一个云端/内网 Hub，串联你的 Mac、Windows 与 Linux，一个会自主推进与记忆的 Super-Agent</p>

<p align="center">
<a href="#安装"><b>快速安装</b></a> ·
<a href="https://github.com/Tdcle/collie/releases">下载二进制</a> ·
<a href="#架构与核心能力">架构与核心能力</a> ·
<a href="#cli-参考">CLI 参考</a>
</p>

<p align="center"><img src="docs/img/demo.gif" alt="给 Collie 发一句话：它派出 worker，worker 回报，Collie 汇总；决策卡片一点就回" width="900"></p>

电脑上开着的 **Codex App / CLI**、**Claude Code**、**Antigravity** 或 **Gemini CLI** 会话，在手机或任意浏览器里打开就能直接接着聊：实时看结构化对话、中途插话（Steer）、一键中止、回答提问卡片、在线预览或下载跨机生成的 PDF / CSV / Office 产物。

活多了就直接交给 **Collie** 主脑：它理解全局项目地图与各电脑模型剩余额度，把任务拆给合适的电脑并行执行，盯进度、处理卡点，并在任务完成、待确认提问或额度预警时通过飞书交互卡片第一时间通知你。

> Collie 是一只边牧（Border Collie）：[herdr](https://herdr.dev) 负责跨平台终端守护，Collie 把分散在多台电脑上的 Agent 聚成一支井然有序的协作团队。

---

## 核心亮点

- **全平台多机互联（macOS · Windows · Linux）** — 云端服务器跑一个轻量 **Hub**（甚至无需安装任何 Agent，纯做路由中枢），家里的 Windows 台式机、随身的 MacBook、实验室 Linux 机器运行 `collie node` 主动加密外连（yamux 多路复用长连接）。无需公网 IP、无需端口转发、无需配 SSH，合盖休眠唤醒后自动重连，离线期间项目与历史会话快照依然完整保留。
- **项目工作区（Project Mode）与双向同步** — 侧边栏原生支持「项目 → 会话」层级管理，内置交互式远程目录树浏览器，支持与宿主机桌面端（如 Codex App）双向同步常用项目目录。
- **四级智能派活 + 配额感知调度 + 休眠自动容灾** — 底部输入框默认**「自动派活」**（也可点击单次指定本次执行的电脑与模型，发送后自动复位）：
  1. 显式指定（单次手动指定或你在消息中点名电脑）
  2. 项目绑定（提及已绑定的项目时自动路由至其所在电脑与目录）
  3. 实时在线与**配额健康度**（自动避开离线电脑、欠费网关如负余额 API、或配额耗尽的 Agent，同机自动改派给额度充裕的 Agent）
  4. 全局默认偏好兜底；当承载 Collie 主脑的笔记本合盖休眠时，自动漂移至其他在线电脑接管对话，唤醒归来后平滑回切并同步记忆。
- **原生级桌面端无锁共聊体验** — 与 macOS / Windows 上的 Codex App 等桌面端共享同一对话线程，**不复制会话、不触发文件锁冲突**：支持运行中实时**插话（`turn/steer`）**、原地**发送/中止合一按钮**、**推理与工具过程自动折叠抽屉**（执行中实时展开、完成后自动收起只留清爽结论），并在网页端读完后自动清除桌面端未读完成角标。
- **跨机模型剩余用量总览与飞书低额预警** — 右上角「**用量**」面板按电脑和 Agent 实时展示剩余配额百分比、重置倒计时、免费重置次数及第三方网关（DeepSeek / Moonshot / SiliconFlow / OpenRouter）账户余额；当某台电脑配额低于 `15%` 或欠费时，飞书主动推送预警卡片。
- **跨机产物卡片预览与下载 + `⌘K` 全文检索** — 消息中提到的本地图表、`.pdf`、`.csv`/`.tsv`、`.docx`/`.xlsx`/`.pptx`、`.zip`、`.md` 自动渲染为产物卡片，支持图片居中放大灯箱、PDF 内嵌阅读、CSV 数据表渲染及一键跨机下载；按 `⌘K` / `Ctrl+K` 不仅搜标题，还能跨所有在线电脑毫秒级检索历史对话正文并高亮命中片段。
- **结构化长期记忆与夜间「做梦」整理** — 记忆分为核心指令（`ROUTER.md`）、常驻记忆（`memory.md`）、按项目经验笔记与归档日志；支持笔记本休眠唤醒后的清晨补梦、失败指数退避防刷屏，确保记忆库长期精炼不膨胀。
- **零外部依赖单二进制** — 单个 Go 二进制 + 纯净无构建前端（无外部 CDN 依赖）+ SQLite（WAL），数据与令牌 100% 掌握在你自己手里。

---

## 架构与核心能力

<p align="center"><img src="docs/img/architecture.svg" alt="Collie 架构" width="900"></p>

```
          ┌──────── 你（Web 控制台 / 手机 PWA / 飞书卡片直达 / GitHub Webhook / 定时器）
          ▼
   Trigger 收件箱 ── 快路径：来源策略过滤（respond / candidate / ignore）
          │
          ├── 已订阅该线程的 Worker ◀── 直达投递，免唤醒 Router
          ▼
   Collie Router（常驻协调中枢：理解意图、查阅项目地图与实时配额、拆解派活、汇总回复）
          │  collie spawn / send / reply / timer / exec …
          ▼
   跨机 Worker × N（Mac / Windows / Linux 隔离工作区并行执行，collie report 汇报）
```

---

## 安装

安装脚本会自动识别架构、校验 SHA-256（若节点已配对 Hub，优先走 Hub `/dl/` 镜像极速拉取，国内网络无需代理即可秒装与自更新），安装到 `~/.local/bin/collie`（Windows 为 `%USERPROFILE%\.local\bin\collie.exe`），并自动注册系统级后台守护与开机/登录自启（macOS `launchd`、Linux `systemd`、Windows 隐藏守护进程 + Scheduled Task / Startup 自启）。

### 1. 部署 Hub（云服务器或常开开发机）

```bash
# macOS / Linux（若挂在反向代理后，加上 --url https://你的域名或IP）
curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s -- hub
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1))) hub"
```

启动后终端会打印访问地址与手机扫码登录二维码。

### 2. 接入你的 Mac / Windows / Linux 电脑（Node）

打开 Hub 网页控制台右上角进入 **「设备与节点 → 接入一台新电脑」**，点击生成一次性配对命令（若 Hub 已启用 HTTPS/公网访问，命令会自动使用 Hub 自身的安装脚本与镜像源）：

```bash
# macOS / Linux
curl -fsSL https://<你的Hub地址>/install.sh | sh -s -- node --hub https://<你的Hub地址> --code <配对码>
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://<你的Hub地址>/install.ps1))) node --hub https://<你的Hub地址> --code <配对码>"
```

- 同一台电脑重新配对时会自动按主机指纹去重复用原设备 ID，不会产生重复节点。
- 移除设备时会级联清理关联项目、会话元数据与离线快照，保持侧栏干净。

### 3. 手机访问与飞书通知（可选）

- **手机端**：用相机扫描「设备与节点 → 连接手机或平板」中的二维码即可免输密码登录，添加到主屏幕即可作为全屏 PWA 使用。
- **飞书通知**：支持两种方式（在「设置 → Collie 全局配置」中开启并可点击「**发送测试通知**」一键验证）：
  1. 在 Hub 上安装并登录 `@larksuite/cli`（`lark-cli auth login`），机器人会向你发送带深链按钮的飞书 JSON 2.0 交互卡片（完成绿卡 / 待确认橙卡 / 报错与低配额红卡，点击按钮直达对应会话或用量面板）。
  2. 直接填写飞书自定义群机器人 Webhook 地址（或 Slack 兼容 Webhook）。

### 4. 一键在线升级

当有新版本发布时，右上角设备状态旁会提示「有新版」；在「设备与节点」页面点击对应电脑的 **「更新到 vX.Y.Z」**，Hub 或各端电脑会自动拉取新版（优先走 Hub 镜像，macOS 自动完成 Apple Silicon Ad-hoc 重签名）并平滑原地重启，正在运行的会话不受影响。

---

## CLI 参考

Collie 的主脑、Worker 以及你本人都可以通过同一个 `collie` 命令交互：

```bash
collie reply [--re ID] "…"                         # Router 向用户发送正式回复
collie spawn [-kind codex] [-machine win] [-cwd D:\proj] [-name n] [-thread t] [-subscribe] "任务描述"
collie send <worker> "追加指令"                     # Hub 优先匹配活跃助手名
collie send [--id ID] <侧栏会话ID> "续派内容"      # 发送前在 stderr 打印回执号
collie receipt ID                                 # 查询本次续派
collie exec [-machine win] [-cwd D:\proj] "命令"    # 在指定电脑直接执行维护命令并返回输出
collie report "完成总结或 BLOCKED: 待决策问题"       # Worker 向 Router 汇报结果
collie answer <worker> <choice>                    # 回答 Worker 终端里的确认选项
collie subscribe [--off] <worker> <thread>
collie stop <worker>
collie show <trigger | thread | worker>            # 查看完整详情或被折叠的长输出
collie list                                        # 查看所有电脑（含实时配额摘要）、绑定项目地图、Worker、线程与定时器
collie timer add [--thread T] [--to worker] "daily 09:00 | every 2h | in 30m | at 2026-11-24 09:00" "提醒或巡检内容"
collie timer ls | rm <id>
collie say "…"                                     # 以用户身份向 Collie 发消息
collie pair [--computer]                           # 生成手机扫码二维码或电脑接入配对码
collie node [--hub URL --code CODE] [--name pc]    # 将当前电脑作为节点连入 Hub
collie daemon <start|stop|restart|status> <hub|node> # 后台守护进程生命周期管理
```

侧栏续派超时后，运行 `collie receipt ID`。需要重试时，使用 `collie send --id ID` 加上原目标和原文。即使正文相同，新号也代表新的派发。

`accepted` 表示目标端已确认提交，执行结果仍看会话回复。`rejected` 表示发送前已被拒绝。`unconfirmed` 表示结果待确认。节点在提交和记录结果之间崩溃时，该状态可能一直保留，按原号重试不会再次向终端输入。回执保存在 Hub 和节点各自的 `herd.db`，去重依赖这些记录。

新旧节点可以共用新版 Hub，普通 `send` 命令相同。对于旧节点，Hub 在第一次转发前持久记录回执号。旧节点应答丢失后，查询会显示 `unconfirmed`，重启 Hub 或升级节点后同号重试也只读取记录。新版节点的回执可以在重连后查询。连接旧版 Hub 时，普通 `send` 会在发前提示此次发送无法查询回执。显式指定 `--id` 需要新版 Hub。

---

## 参数与数据目录

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `-addr` | `COLLIE_ADDR` | `0.0.0.0:7788` | Hub HTTP 监听地址 |
| `-socket` | `HERDR_SOCKET_PATH` | Unix `~/.config/herdr/herdr.sock` / Win Named Pipe | 本机 herdr 通信地址 |
| `-token` | `COLLIE_TOKEN` | 自动生成并持久化 | Hub 主访问令牌 |
| `-url` | `COLLIE_URL` | 自动探测局域网地址 | 生成配对二维码、镜像下载与飞书深链的外部基础 URL |
| — | `COLLIE_HOME` | `~/.collie` | 状态数据库、记忆与配置根目录 |

### `~/.collie` 目录结构

| 路径 | 说明 |
|---|---|
| `herd.db` | SQLite（WAL）：收件箱事件、线程、Worker、主对话、项目与会话元数据、定时器、设备令牌哈希、配额预警去重状态 |
| `node.json` | Node 专属：已绑定的 Hub 地址、节点设备令牌与名称 |
| `releases/` | Hub 可选本地发布镜像目录（供 `/dl/<asset>` 与 `/dl/latest` 分发跨平台二进制） |
| `router/` | Collie 主脑工作目录：自动生成 `ROUTER.md`（同步写入 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`）与 `memory/` 长期记忆库 |

---

## 从源码构建与验证

环境要求：**Go 1.25+**。

```bash
# 编译当前平台二进制
go build -ldflags "-s -w -X main.version=v0.2.52" -o bin/collie .

# 运行全部单元测试
go test ./...

# 构建静态演示站（docs/demo/）并检查前端脚本语法
sh scripts/demo.sh

# 交叉编译全平台发布包（darwin/linux/windows × amd64/arm64）到 dist/
sh scripts/release.sh v0.2.52 --dry
```

## 代码结构

```
main.go                         入口与注入版本号
internal/collie/
  server.go / hub.go / node.go  HTTP/SSE 路由、设备配对、yamux 加密隧道与跨机转发
  herdr.go / fleet.go           herdr Unix Socket / Windows Named Pipe 客户端与多机聚合
  super.go                      Super-Agent 核心状态机、事件循环与 `collie list` 全局视图
  super_router.go               Collie 主脑生命周期、唤醒/重启、休眠自动容灾漂移与无感回切
  super_dispatch.go             四级派活路由、配额健康度校验、Worker 启动与汇报接收
  super_notify.go / lark.go     Watchdog 巡检、独立会话监控与飞书交互卡片（含深链）推送
  quotas.go                     多机多 Agent（Codex / Claude / Agy / Gemini / API 网关）剩余用量采集与低额预警
  search.go                     跨电脑历史对话正文毫秒级全文检索（GET /api/search）
  files.go                      跨机文件安全读取、图片/PDF/CSV/Markdown 预览与大文件下载
  external.go / external_send.go 外部终端与 Codex/Claude 桌面端会话发现、ETag 增量轮询、无锁直发与打断
  desktop.go / projects.go      宿主机桌面端会话索引解析、项目双向同步与已读状态同步
  chat.go / agy.go              多格式 JSONL 会话增量解析、提问卡片提取与推理过程分组
  memory.go / dream.go          长期记忆管理、上下文交接（Handover）与夜间做梦（含休眠补梦与退避）
  platform_unix.go / platform_windows.go / daemon.go / updates.go  跨平台进程管理、Apple Silicon 重签名与镜像自更新
web/
  index.html / app.css          响应式无构建控制台界面与浅色/深色设计系统
  app.js                        主视图路由、项目管理、实时对话流与 ⌘K 命令面板
  quota.js                      右上角多机模型剩余用量弹窗模块
  artifacts.js                  跨机产物卡片提取、PDF/CSV/Office 预览与一键下载模块
docs/
  install.sh / install.ps1      macOS / Linux / Windows 一键安装与守护服务注册脚本
  index.html / demo/            产品主页与纯浏览器离线交互演示
```
