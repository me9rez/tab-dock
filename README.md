# TabDock

标签页的码头。两条主线：

1. **标签页桥**：浏览器扩展收集标签页快照，本机桥出 HTTP 接口——本地 agent 一条 `curl` 就能读取/控制浏览器标签页；
2. **GitHub 批次收藏**：打开的 GitHub 仓库/子页可成批「停靠」（保存原始 URL），之后一键整批「启航」（恢复成标签页）、看完一键关闭，收后还可自动清空工作区。

```
┌─────────────┐   WebSocket    ┌──────────────────┐   HTTP    ┌──────────────┐
│  浏览器扩展  │ ─────────────▶ │   本地桥 (Node)  │ ◀──────── │  agent / CLI │
│  (Chrome/   │  推送 JSON 快照 │ 127.0.0.1:17890  │  GET/POST │  curl / 程序 │
│   Edge)     │ ◀───────────── │                  │           │              │
└─────────────┘   下发命令      └──────────────────┘           └──────────────┘
```

**为什么需要桥？** 浏览器扩展本身不能监听端口，任何方案（native messaging、
CDP 调试端口）都要有一个本地进程。桥做这一层，同时让浏览器侧零配置：
不用带 `--remote-debugging-port` 重启浏览器，不用改启动参数。

---

## 安装（一次就好）

### 1. 装扩展

Chrome：打开 `chrome://extensions`
Edge：打开 `edge://extensions`

1. 打开右上角 **开发者模式**
2. 点 **加载已解压的扩展程序**
3. 选这个目录：`<本仓库>/extension`
4. 装好后工具栏会出现紫色图标

### 2. 启动桥

```bash
node bridge/server.mjs
```

看到 `TabDock 桥已启动 http://127.0.0.1:17890` 就算成功。扩展会自动连上来
（图标点开可以看到「已连接」）。

想让它开机自启：以管理员 PowerShell 跑

```powershell
pwsh -File scripts/install-bridge-task.ps1
```

几个行为要知道：

- **无窗口**：任务不直接跑 `node.exe`，而是用 `wscript.exe` 调 `scripts/start-bridge-hidden.vbs`。
  node 是控制台子系统程序，计划任务直接启动它必然弹一个黑窗口。wscript 是 GUI 子系统，
  `sh.Run(cmd, 0, True)` 隐藏启动并同步等待，所以任务状态仍是 Running、进程树也归任务管
  （停止任务能整树结束）。
- **任务在任务计划程序里正常可见**：不要加 `New-ScheduledTaskSettingsSet -Hidden`。
  那个参数会把任务归入"隐藏任务"（默认列表看不见，要勾"显示隐藏的任务"），而它**并不能**
  隐藏 node 的控制台窗口——窗口问题是靠上面的 wscript 解决的，两件事互不相关。
  任务路径 `\`、名称 `TabBridge`（**沿用历史部署标识，未随产品改名**，避免与已有任务冲突），直接搜名字就能找到。
- 触发器是 **AtLogOn（登录时）+ 每 5 分钟兜底重复**：桥常驻时重复触发被
  `MultipleInstances=IgnoreNew` 忽略；万一 node 崩了且失败重启（3 次）用尽，
  最多 5 分钟内被重新拉起，不用等下次登录
- 脚本会**解析到真实的 node.exe**（不用 mise 的 shim，因为本机火绒曾反复终止 mise.exe 导致 shim 静默失效）
- node 升级到新的版本目录后，**重跑一次脚本**刷新任务里的路径
- 重装是幂等的：会自动清理占用端口的旧桥进程，不会出现"端口被占 → 返回码 1"
- 卸载：`pwsh -File scripts/install-bridge-task.ps1 -Uninstall`

验证任务状态与「确实没窗口」：

```powershell
Get-ScheduledTask -TaskName TabBridge | Select-Object State
Get-ScheduledTaskInfo -TaskName TabBridge | Select-Object LastTaskResult   # 267009 = 正在运行
# 进程树应为 wscript.exe → node.exe；node 的 MainWindowHandle 应为 0
Get-Process node | Where-Object { $_.Id -eq (Get-NetTCPConnection -State Listen -LocalPort 17890).OwningProcess } |
    Select-Object Id, MainWindowHandle, MainWindowTitle
```

---

## agent 怎么用

最省事的就是 curl：

```bash
# 所有标签页
curl -s 127.0.0.1:17890/tabs | jq -r '.tabs[] | "\(.id)\t\(.title)\t\(.url)"'

# 每个窗口当前活动的那一个
curl -s 127.0.0.1:17890/active | jq -r '.active[] | .title + " → " + .url'

# 找开着 GitHub 的标签
curl -s "127.0.0.1:17890/tabs?url=github" | jq -r '.tabs[].title'
```

给人看的封装：

```bash
node bridge/cli.mjs tabs          # 对齐的表格
node bridge/cli.mjs tabs --url github --active
node bridge/cli.mjs active
node bridge/cli.mjs watch         # 订阅变化，实时打印
node bridge/cli.mjs activate 12345
```

在 Hermes / 任何 agent 里，等同一条命令或多个 HTTP 请求即可。

---

## HTTP API

基地址 `http://127.0.0.1:17890`（只绑回环，外部机器访问不到）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 桥与扩展状态、快照年龄 |
| GET | `/tabs` | 全部标签页（支持过滤；`?cached=1` 直接读缓存不催刷新，高频轮询用） |
| GET | `/windows` | 窗口列表，每个窗口内嵌自己的标签 |
| GET | `/active` | 每个窗口当前活动的标签 |
| GET | `/events` | SSE 事件流（连接/断开/快照变化） |
| POST | `/refresh` | 强制扩展立刻重推快照 |
| POST | `/tabs/:id/activate` | 切到该标签并聚焦其窗口 |
| POST | `/tabs/:id/close` | 关闭标签 |
| POST | `/tabs/:id/mute?muted=1` | 静音 / 取消静音 |
| POST | `/tabs/:id/pin?pinned=1` | 固定 / 取消固定 |
| POST | `/tabs/:id/reload` | 刷新页面 |

### `/tabs` 过滤参数

| 参数 | 例 | 说明 |
|---|---|---|
| `active=1` | | 只要活动标签 |
| `pinned=1` / `pinned=0` | | 按固定状态筛选 |
| `audible=1` | | 只要正在发声的（能找到谁在放音频） |
| `windowId=123` | | 指定窗口 |
| `url=github` | | URL 子串，不区分大小写 |
| `urlRe=github\.com/[^/]+$` | | URL 正则 |
| `title=水晶` | | 标题子串（中文可用） |
| `limit=10` | | 截断 |
| `fields=id,title,url` | | 只要这几个字段，减小载荷 |

### 单个标签的字段

```json
{
  "id": 1354890537,
  "windowId": 1354890536,
  "index": 2,
  "title": "Example Domains",
  "url": "https://www.iana.org/help/example-domains",
  "active": true,
  "highlighted": true,
  "pinned": false,
  "audible": false,
  "muted": false,
  "groupId": -1,
  "status": "complete",
  "discarded": false,
  "incognito": false,
  "favIconUrl": "https://www.iana.org/_img/bookmark_icon-32.png",
  "lastAccessed": 1792813691000,
  "openerTabId": 1354890535
}
```

### `/health` 的两个状态字段

- `connected`：WebSocket 通不通
- `extensionAlive`：最近 60 秒有没有心跳。MV3 的 service worker 会被浏览器回收，
  这个字段能区分「扩展还活着」和「进程在但扩展卡住」
- `stale`：等于 `!extensionAlive`，表示数据不可信

`/tabs` 每次请求会顺手催扩展刷新一次（最多等 600ms），所以直接读就是最新的；
扩展掉线时退化为返回缓存。

---

## 安全

- 桥只绑 `127.0.0.1`，不监听外部网卡
- **不返回 CORS 头**：网页里的 JS 读不到响应（防恶意页面偷标签页），
  但 curl / 本机程序（agent）不受 CORS 限制
- **写请求有 CSRF 防护**：CORS 头拦不住"读"，但拦得住"读不到响应"——拦不住的
  是恶意网页用 `<form method=POST>` 盲打写接口。所以桥对非 GET 请求校验
  `Sec-Fetch-Site`（cross-site / same-site 拒绝）和 `Origin`（必须为空或本服务
  自身），curl / agent / 地址栏导航不带这些标记，不受影响。自测里有 4 条钉住这个行为
- 需要额外一层保护就启用 token：

```bash
TABBRIDGE_TOKEN=mysecret node bridge/server.mjs
curl -H "X-TabBridge-Token: mysecret" 127.0.0.1:17890/tabs
```

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 扩展图标点开显示「未连接」 | 桥没起，或端口不是 17890。先 `node bridge/server.mjs` |
| `curl` 返回 `connected: false` | 扩展没装/被禁用；到扩展页看有没有报错 |
| `stale: true` 但 `connected: true` | 扩展的 service worker 被回收了，点一下扩展图标或等 1 分钟自动恢复 |
| 端口被占 | `node bridge/server.mjs --port 17891`，同时改 `extension/background.js` 里的 `DEFAULT_WS` |
| 扩展装不上，提示 manifest 错误 | 确认选的是 `extension` 目录本身（不是它的父目录） |

### 已知坑：自动化加载扩展

Chromium 137+（实测 Edge 155 / Chrome 156）**已禁用命令行 `--load-extension`**，
传了也静默忽略，扩展不会加载。两个办法：

- 正常安装：走 `chrome://extensions` / `edge://extensions` 的「加载已解压」；
- 自动化（CI/测试）：`--enable-unsafe-extension-debugging` + 通过 CDP 调
  `Extensions.loadUnpacked`。headless 模式下扩展的 service worker 不会启动，
  要验证必须用有头模式（可以把窗口用 `--window-position=-2400,-2400` 挪到屏幕外）。

---

## 开发

```bash
node test/selftest.mjs      # 30 项端到端自测（用假扩展，不需要真浏览器；含 4 条 CSRF 用例）
python tools/make-icons.py  # 重新生成图标
```

桥零依赖，只用 `node:http` / `node:crypto`，WebSocket 服务端是内置实现
（握手、掩码、分片、ping/pong 都已覆盖）。扩展是 MV3，无构建步骤，改完在扩展页点刷新即可。

## 目录

```
extension/          MV3 扩展（manifest + service worker + popup + 图标）
bridge/server.mjs   本地桥（HTTP API + WebSocket 服务端）
bridge/cli.mjs      命令行封装
scripts/            开机自启的安装/卸载脚本
test/selftest.mjs   端到端自测
tools/make-icons.py 图标生成
```
