# TabDock

[![CI](https://github.com/me9rez/tab-dock/actions/workflows/ci.yml/badge.svg)](https://github.com/me9rez/tab-dock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge-lightgrey)

**标签页的码头。** 一个浏览器扩展 + 本地桥的组合，做两件事：

1. **标签页桥** —— 把浏览器标签页实时暴露给本地 agent：扩展负责收集，本机桥负责出 HTTP 接口，agent 一条 `curl` 就能读取/控制标签页；
2. **GitHub 批次收藏** —— 看不完的 GitHub 仓库/子页成批「停靠」保存，之后一键整批「启航」恢复、看完一键关闭。

> English: a browser extension + zero-dependency Node bridge that exposes your open tabs to local agents over plain HTTP, plus batch bookmarking for GitHub repos you don't have time to read right now — dock them, restore them later, close them in one click.

```
┌─────────────┐   WebSocket    ┌──────────────────┐   HTTP    ┌──────────────┐
│  浏览器扩展  │ ─────────────▶ │   本地桥 (Node)  │ ◀──────── │  agent / CLI │
│  (Chrome/   │  推送 JSON 快照 │  127.0.0.1:17890 │  GET/POST │  curl / 程序 │
│   Edge)     │ ◀───────────── │                  │           │              │
└─────────────┘   下发命令      └──────────────────┘           └──────────────┘
```

**为什么需要桥？** 浏览器扩展本身不能监听端口，任何方案（native messaging、
CDP 调试端口）都要有一个本地进程。桥做这一层，同时让浏览器侧零配置：
不用带 `--remote-debugging-port` 重启浏览器，不用改启动参数。

---

## 功能

### 标签页桥

- 扩展（MV3）主动连桥推送全量快照，节流 120ms，浏览器侧**零配置**
- `GET /tabs` 一条 curl 读全部标签页，支持 URL / 标题 / 正则 / 窗口 / 活动状态等过滤
- 反向控制：`activate` / `close` / `mute` / `pin` / `reload`
- SSE 实时事件流（`/events`），`watch` 子命令实时打印变化
- `/health` 带心跳判定：能区分「桥活着」和「扩展活着」（MV3 service worker 会被浏览器回收）

### GitHub 批次收藏（扩展 popup）

- 一键把当前打开的 GitHub 页面按**原始 URL** 存成一批——issue、PR、子页原样保留
- 整批恢复：后台标签打开，**自动跳过已开着的页面**，不堆重复标签
- 整批关闭：看完一批一键清掉（严格按 URL 匹配，不碰批次外的标签）
- 「收后关闭」开关：收藏完自动清空工作区
- 每批可展开页面清单、单条打开；删除有二次确认
- 数据存 `chrome.storage.local`（最多 50 批），重启浏览器都在；popup 不依赖桥，桥挂了收藏照常可用

### 安全模型

- 桥只绑 `127.0.0.1`，不监听外部网卡
- **不返回 CORS 头**：网页 JS 读不到响应（防恶意页面偷标签页）
- **写请求 CSRF 防护**：CORS 拦不住副作用，所以非 GET 请求校验 `Sec-Fetch-Site` / `Origin`，
  恶意网页用 `<form method=POST>` 盲打会被 403（自测里有 4 条钉住这个行为）
- 需要额外一层就启用 token：`TABBRIDGE_TOKEN=mysecret node bridge/server.mjs`

---

## 安装

### 1. 装扩展

Chrome：打开 `chrome://extensions` · Edge：打开 `edge://extensions`

1. 打开右上角 **开发者模式**
2. 点 **加载已解压的扩展程序**
3. 选本仓库的 `extension/` 目录（或从 Release 下载 zip 解压后选它）
4. 装好后工具栏会出现图标，点开可看连接状态

### 2. 启动桥

```bash
node bridge/server.mjs
```

看到 `TabDock 桥已启动 http://127.0.0.1:17890` 就算成功，扩展会自动连上来。

### 3.（可选，Windows）开机自启

```powershell
pwsh -File scripts/install-bridge-task.ps1
```

- 计划任务 `TabBridge`：AtLogOn 触发 + **每 5 分钟兜底重复**（桥常驻时被
  `MultipleInstances=IgnoreNew` 忽略；万一 node 崩了且失败重启用尽，最多 5 分钟拉起）
- 经 `wscript.exe` 调 VBS 隐藏启动，无黑窗口，任务在任务计划程序里正常可见
- 会解析到真实的 `node.exe`（不用 mise shim），node 升级后重跑一次即可
- 卸载：`pwsh -File scripts/install-bridge-task.ps1 -Uninstall`

### 4.（可选）token

```bash
TABBRIDGE_TOKEN=mysecret node bridge/server.mjs
curl -H "X-TabBridge-Token: mysecret" 127.0.0.1:17890/tabs
```

> 注：`TABBRIDGE_*` 环境变量与 `X-TabBridge-Token` 头沿用历史命名，保持兼容。

---

## agent 怎么用

最省事就是 curl：

```bash
# 所有标签页
curl -s 127.0.0.1:17890/tabs | jq -r '.tabs[] | "\(.id)\t\(.title)\t\(.url)"'

# 每个窗口当前活动的那一个
curl -s 127.0.0.1:17890/active

# 找开着 GitHub 的标签（高频轮询加 &cached=1 直读缓存，~9ms）
curl -s "127.0.0.1:17890/tabs?url=github&cached=1"

# 控制标签页
curl -s -X POST 127.0.0.1:17890/tabs/<id>/activate
curl -s -X POST 127.0.0.1:17890/tabs/<id>/close
```

给人看的封装：

```bash
node bridge/cli.mjs health
node bridge/cli.mjs tabs --url github --active
node bridge/cli.mjs watch        # 订阅变化，实时打印
node bridge/cli.mjs activate 12345
```

---

## HTTP API

基地址 `http://127.0.0.1:17890`（只绑回环）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 桥与扩展状态、快照年龄 |
| GET | `/tabs` | 全部标签页（可过滤；`?cached=1` 直读缓存） |
| GET | `/windows` | 窗口列表，每个窗口内嵌自己的标签 |
| GET | `/active` | 每个窗口当前活动的标签 |
| GET | `/events` | SSE 事件流（连接/断开/快照变化） |
| POST | `/refresh` | 强制扩展立刻重推快照 |
| POST | `/tabs/:id/activate` | 切到该标签并聚焦其窗口 |
| POST | `/tabs/:id/close` | 关闭标签 |
| POST | `/tabs/:id/mute?muted=1` | 静音 / 取消静音 |
| POST | `/tabs/:id/pin?pinned=1` | 固定 / 取消固定 |
| POST | `/tabs/:id/reload` | 刷新页面 |

`/tabs` 过滤参数：`active` `pinned` `audible` `windowId` `url`（子串）`urlRe`（正则）`title` `limit` `fields`（精简字段）`cached`。

---

## 项目结构

```
extension/              MV3 扩展（manifest + service worker + popup + 图标）
bridge/server.mjs       本地桥（HTTP API + WebSocket 服务端，零依赖）
bridge/cli.mjs          命令行封装
scripts/                Windows 开机自启的安装/卸载脚本
test/selftest.mjs       30 项端到端自测（用假扩展模拟 WS 客户端，不需要真浏览器）
tools/make-icons.py     图标生成（纯标准库写 PNG）
.github/workflows/      CI（自测）与 Release（tag 自动打包）
```

---

## 开发

```bash
node test/selftest.mjs      # 30 项端到端自测（含 4 条 CSRF 用例）
python tools/make-icons.py  # 重新生成图标
```

桥零依赖，只用 `node:http` / `node:crypto`，WebSocket 服务端是内置实现
（握手、掩码、分片、ping/pong 已覆盖；强制客户端掩码、单帧 8MB 上限）。
扩展是 MV3，无构建步骤，改完在扩展页点刷新即可。

### 发版

```bash
# 1. bump extension/manifest.json 的 version
# 2. 提交并推 main
git push origin main
# 3. 单独推 tag（Release workflow 校验 tag 必须等于 manifest 版本）
git tag v1.x.y && git push origin v1.x.y
```

Release 会自动附带 `tab-dock-extension-v*.zip`（manifest 在 zip 根，解压即可加载）与 `SHA256SUMS.txt`。

### 已知坑：自动化加载扩展

Chromium 137+（实测 Edge 155 / Chrome 156）**已禁用命令行 `--load-extension`**，传了也静默忽略。两个办法：

- 正常安装：走 `chrome://extensions` / `edge://extensions` 的「加载已解压」；
- 自动化（CI/测试）：`--enable-unsafe-extension-debugging` + 通过 CDP 调 `Extensions.loadUnpacked`。
  headless 模式下扩展的 service worker 不会启动，要验证必须用有头模式
  （可以把窗口用 `--window-position=-2400,-2400` 挪到屏幕外）。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 扩展图标点开显示「未连接」 | 桥没起，或端口不是 17890。先 `node bridge/server.mjs` |
| `curl` 返回 `connected: false` | 扩展没装/被禁用；到扩展页看有没有报错 |
| `stale: true` 但 `connected: true` | 扩展的 service worker 被回收了，点一下扩展图标或等 1 分钟自动恢复 |
| 端口被占 | `node bridge/server.mjs --port 17891`，同时改 `extension/background.js` 里的 `DEFAULT_WS` |
| 扩展装不上，提示 manifest 错误 | 确认选的是 `extension` 目录本身（不是它的父目录） |
| 扩展错误页有 `ERR_CONNECTION_REFUSED` | 桥重启窗口期的正常现象，指数退避会自动重连；只有 `connected: false` 持续数分钟才算真挂 |

## License

[MIT](LICENSE)
