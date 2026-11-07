#!/usr/bin/env node
/**
 * TabDock 本地桥
 * =================
 * 浏览器扩展作为 WebSocket 客户端连进来推送标签页快照；外部 agent 用普通
 * HTTP 读出去。零依赖（只用 node:http / node:crypto）。
 *
 *   node server.mjs
 *   node server.mjs --port 17890 --host 127.0.0.1
 *
 * 注：对外契约（TABBRIDGE_* 环境变量、X-TabBridge-Token 请求头）沿用历史命名，保持兼容。
 *
 * HTTP API
 * --------
 *   GET  /health                    桥与扩展的连接状态
 *   GET  /tabs                      全部标签页（可过滤）
 *        ?active=1                   只留活动标签
 *        &windowId=123               指定窗口
 *        &url=bilibili                URL 子串（不区分大小写）
 *        &urlRe=github\\.com%2F        URL 正则
 *        &title=水晶                 标题子串
 *        &limit=20
 *        &fields=id,title,url        精简字段
 *   GET  /windows                   窗口 + 各自标签
 *   GET  /active                    每个窗口当前活动标签
 *   GET  /events                    SSE 变化推送（snapshot 事件）
 *   POST /refresh                   让扩展立即重推快照
 *   POST /tabs/:id/activate         切到该标签（并聚焦窗口）
 *   POST /tabs/:id/close            关闭标签
 *   POST /tabs/:id/mute             静音切换（?muted=1|0）
 *   POST /tabs/:id/pin              固定切换（?pinned=1|0）
 *
 * 安全：默认只绑 127.0.0.1，且**不发 CORS 头**——网页 JS 读不到，只有本机
 * 进程（curl / agent / CLI）能取。需要额外一层保护就设 TABBRIDGE_TOKEN，
 * 请求带 X-TabBridge-Token 头或 ?token= 参数。
 */

import http from 'node:http';
import crypto from 'node:crypto';

// ---------------- 配置 ----------------

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PORT = Number(argOf('port', process.env.TABBRIDGE_PORT || 17890));
const HOST = argOf('host', process.env.TABBRIDGE_HOST || '127.0.0.1');
const TOKEN = argOf('token', process.env.TABBRIDGE_TOKEN || '');
const WS_PATH = '/ws';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEARTBEAT_STALE_MS = 60000; // 扩展心跳（每 20s 一次）超过这个时长视为失联
const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 单帧上限，防异常帧撑爆内存（快照通常几 KB）

// ---------------- 状态 ----------------

const state = {
  connected: false,
  browser: '',
  extVersion: '',
  windows: [],
  tabs: [],
  lastSnapshotAt: 0,
  lastExtPingAt: 0,
  connectedSince: 0,
  lastError: ''
};

let extSocket = null;          // 当前扩展的 WS 连接
let cmdSeq = 0;
const pendingCmds = new Map(); // id -> resolve
const sseClients = new Set();  // http.ServerResponse

// ---------------- WebSocket（服务端最小实现） ----------------

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsEncode(payload, opcode = 0x1) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, buf]);
}

function wsSend(socket, obj) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(wsEncode(JSON.stringify(obj), 0x1));
    return true;
  } catch {
    return false;
  }
}

function wsParseLoop(socket, initial) {
  let buf = initial || Buffer.alloc(0);
  let fragParts = [];

  const onData = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }

      // RFC 6455：客户端→服务端的帧必须掩码；超大帧直接断开防内存被撑爆
      if (!masked || len > MAX_FRAME_BYTES) {
        try { socket.destroy(); } catch { /* noop */ }
        return;
      }

      const maskLen = 4;
      if (buf.length < off + maskLen + len) return;

      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 0x8) {           // close
        try { socket.end(wsEncode(payload, 0x8)); } catch { /* noop */ }
        return;
      }
      if (opcode === 0x9) {           // ping → pong
        try { socket.write(wsEncode(Buffer.concat([payload]), 0xa)); } catch { /* noop */ }
        continue;
      }
      if (opcode === 0xa) continue;   // pong

      if (opcode === 0x0) {           // continuation
        fragParts.push(payload);
        if (fin) {
          const full = Buffer.concat(fragParts);
          fragParts = [];
          handleMessage(full);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          fragParts = [payload];
        } else {
          handleMessage(payload);
        }
      }
      // 其它 opcode 忽略
    }
  };

  socket.on('data', onData);
  socket.on('error', () => { /* 交给 close 处理 */ });
  socket.on('close', () => {
    if (extSocket === socket) {
      extSocket = null;
      state.connected = false;
      state.connectedSince = 0;
      broadcastSse({ type: 'disconnected', at: Date.now() });
      log('扩展已断开');
    }
  });
}

function handleMessage(buf) {
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'hello': {
      state.browser = msg.browser || '';
      state.extVersion = msg.extVersion || '';
      state.connected = true;
      state.connectedSince = Date.now();
      state.lastExtPingAt = Date.now();
      log(`扩展已连接（${state.browser || 'unknown'} v${state.extVersion || '?'}）`);
      broadcastSse({ type: 'connected', browser: state.browser, at: Date.now() });
      break;
    }
    case 'snapshot': {
      const d = msg.data || {};
      state.windows = Array.isArray(d.windows) ? d.windows : [];
      state.tabs = Array.isArray(d.tabs) ? d.tabs : [];
      state.lastSnapshotAt = Date.now();
      state.lastExtPingAt = state.lastSnapshotAt;
      if (d.browser) state.browser = d.browser;
      if (d.extVersion) state.extVersion = d.extVersion;
      state.connected = true;
      broadcastSse({
        type: 'snapshot',
        at: state.lastSnapshotAt,
        tabCount: state.tabs.length,
        windowCount: state.windows.length
      });
      break;
    }
    case 'cmdResult': {
      const fn = pendingCmds.get(msg.id);
      if (fn) {
        pendingCmds.delete(msg.id);
        fn({ ok: !!msg.ok, error: msg.error || null });
      }
      break;
    }
    case 'ping': {
      state.lastExtPingAt = Date.now();
      wsSend(extSocket, { type: 'pong', at: Date.now() });
      break;
    }
    default:
      break;
  }
}

// ---------------- 命令下发 ----------------

function runCommand(payload, timeoutMs = 4000) {
  if (!extSocket || !state.connected) {
    return Promise.resolve({ ok: false, error: 'extension-not-connected' });
  }
  const id = ++cmdSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCmds.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);

    pendingCmds.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    if (!wsSend(extSocket, { type: 'cmd', id, ...payload })) {
      pendingCmds.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: 'send-failed' });
    }
  });
}

/** 让扩展重推快照，并等它到达（最多 maxWaitMs） */
function requestRefresh(maxWaitMs = 700) {
  if (!extSocket || !state.connected) return Promise.resolve(false);
  const before = state.lastSnapshotAt;
  const started = Date.now();
  wsSend(extSocket, { type: 'refresh' });
  return new Promise((resolve) => {
    const tick = () => {
      if (state.lastSnapshotAt > before) return resolve(true);
      if (Date.now() - started > maxWaitMs) return resolve(false);
      setTimeout(tick, 60);
    };
    tick();
  });
}

// ---------------- SSE ----------------

function broadcastSse(obj) {
  if (sseClients.size === 0) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

// ---------------- HTTP helpers ----------------

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function meta() {
  const now = Date.now();
  const lastBeat = state.lastExtPingAt || state.connectedSince || 0;
  const alive = state.connected && lastBeat > 0 && (now - lastBeat) < HEARTBEAT_STALE_MS;
  return {
    connected: state.connected,
    extensionAlive: alive,
    // stale 表示"数据不可信"：没连上，或扩展连上但长时间无心跳（SW 卡死/被回收）
    stale: !alive,
    browser: state.browser,
    extVersion: state.extVersion,
    lastSnapshotAt: state.lastSnapshotAt,
    lastSnapshotAgeMs: state.lastSnapshotAt ? now - state.lastSnapshotAt : null,
    connectedForMs: state.connectedSince ? now - state.connectedSince : null
  };
}

function pickFields(tab, fields) {
  if (!fields || !fields.length) return tab;
  const out = {};
  for (const f of fields) {
    if (f in tab) out[f] = tab[f];
  }
  return out;
}

function filterTabs(params) {
  let tabs = state.tabs.slice();

  const active = params.get('active');
  if (active === '1' || active === 'true') tabs = tabs.filter((t) => t.active);

  const pinned = params.get('pinned');
  if (pinned === '1' || pinned === 'true') tabs = tabs.filter((t) => t.pinned);
  if (pinned === '0' || pinned === 'false') tabs = tabs.filter((t) => !t.pinned);

  const audible = params.get('audible');
  if (audible === '1' || audible === 'true') tabs = tabs.filter((t) => t.audible);

  const windowId = params.get('windowId');
  if (windowId != null && windowId !== '') tabs = tabs.filter((t) => String(t.windowId) === String(windowId));

  const url = params.get('url');
  if (url) {
    const needle = url.toLowerCase();
    tabs = tabs.filter((t) => (t.url || '').toLowerCase().includes(needle));
  }

  const title = params.get('title');
  if (title) {
    const needle = title.toLowerCase();
    tabs = tabs.filter((t) => (t.title || '').toLowerCase().includes(needle));
  }

  const urlRe = params.get('urlRe');
  if (urlRe) {
    let re = null;
    try { re = new RegExp(urlRe, 'i'); } catch { re = null; }
    if (re) tabs = tabs.filter((t) => re.test(t.url || ''));
  }

  const limit = Number(params.get('limit') || 0);
  if (limit > 0) tabs = tabs.slice(0, limit);

  return tabs;
}

// ---------------- 路由 ----------------

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();
  const params = url.searchParams;

  // 可选 token 校验
  if (TOKEN) {
    const got = req.headers['x-tabbridge-token'] || params.get('token');
    if (got !== TOKEN) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  // 防 CSRF：恶意网页可以用 <form method=POST> 盲打写接口（CORS 拦不住副作用）。
  // 浏览器跨站请求必带 Sec-Fetch-Site / Origin；curl、agent、地址栏导航不会带
  // cross-site 标记，所以这里只对写请求（非 GET/HEAD）做校验，合法用法不受影响。
  if (method !== 'GET' && method !== 'HEAD') {
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers['origin'];
    if (site === 'cross-site' || site === 'same-site') {
      return sendJson(res, 403, { ok: false, error: 'cross-site-request-blocked' });
    }
    if (origin) {
      try {
        if (new URL(origin).host !== `${HOST}:${PORT}`) {
          return sendJson(res, 403, { ok: false, error: 'cross-origin-request-blocked', origin });
        }
      } catch {
        return sendJson(res, 403, { ok: false, error: 'bad-origin', origin });
      }
    }
  }

  if (path === '/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...meta() });
  }

  if (path === '/tabs' && method === 'GET') {
    // 顺手催一次刷新，让返回尽可能新鲜（扩展掉线时直接返回缓存）；
    // 高频轮询的场景传 ?cached=1 跳过刷新、直接读缓存
    if (!params.get('cached')) await requestRefresh(600);
    const tabs = filterTabs(params);
    const fields = (params.get('fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return sendJson(res, 200, {
      ok: true,
      ...meta(),
      count: tabs.length,
      tabs: tabs.map((t) => pickFields(t, fields))
    });
  }

  if (path === '/windows' && method === 'GET') {
    if (!params.get('cached')) await requestRefresh(600);
    const windows = state.windows.map((w) => ({
      ...w,
      tabs: filterTabs(new URLSearchParams({ windowId: String(w.id) }))
    }));
    return sendJson(res, 200, {
      ok: true,
      ...meta(),
      count: windows.length,
      windows
    });
  }

  if (path === '/active' && method === 'GET') {
    if (!params.get('cached')) await requestRefresh(600);
    const actives = state.tabs
      .filter((t) => t.active)
      .map((t) => ({ windowId: t.windowId, id: t.id, index: t.index, title: t.title, url: t.url, audible: t.audible }));
    return sendJson(res, 200, { ok: true, ...meta(), count: actives.length, active: actives });
  }

  if (path === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', ...meta() })}\n\n`);
    sseClients.add(res);
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* noop */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
    return undefined;
  }

  if (path === '/refresh' && method === 'POST') {
    const ok = await requestRefresh(1500);
    return sendJson(res, ok ? 200 : 503, { ok, ...meta() });
  }

  // /tabs/:id/(activate|close|mute|pin|reload)
  const m = path.match(/^\/tabs\/(\d+)\/([a-z]+)$/);
  if (m && method === 'POST') {
    const tabId = Number(m[1]);
    const action = m[2];
    if (!state.connected) {
      return sendJson(res, 503, { ok: false, error: 'extension-not-connected' });
    }
    const exists = state.tabs.some((t) => t.id === tabId);
    if (!exists) return sendJson(res, 404, { ok: false, error: 'tab-not-found', tabId });

    let payload = { action, tabId };
    if (action === 'mute') payload = { action, tabId, muted: params.get('muted') !== '0' };
    if (action === 'pin') payload = { action, tabId, pinned: params.get('pinned') !== '0' };
    if (!['activate', 'close', 'mute', 'pin', 'reload'].includes(action)) {
      return sendJson(res, 400, { ok: false, error: 'unsupported-action', action });
    }

    const result = await runCommand(payload);
    if (result.ok) await requestRefresh(500);
    return sendJson(res, result.ok ? 200 : 502, { ...result, action, tabId });
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'not-found',
    hint: 'GET /health /tabs /windows /active /events, POST /refresh, POST /tabs/:id/{activate,close,mute,pin,reload}'
  });
}

// ---------------- 启动 ----------------

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    state.lastError = String((e && e.stack) || e);
    try { sendJson(res, 500, { ok: false, error: 'internal', detail: String((e && e.message) || e) }); } catch { /* noop */ }
  });
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (url.pathname !== WS_PATH) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const ver = req.headers['sec-websocket-version'];
  if (!key || ver !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept(key)}`
  ];
  socket.write(headers.join('\r\n') + '\r\n\r\n');
  socket.setNoDelay(true);

  // 只保留一个扩展连接：旧连接先踢掉
  if (extSocket && extSocket !== socket) {
    try { wsSend(extSocket, { type: 'bye' }); extSocket.destroy(); } catch { /* noop */ }
  }
  extSocket = socket;
  wsParseLoop(socket, Buffer.alloc(0));
  log('扩展 WS 握手完成');
});

function log(...args) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}]`, ...args);
}

server.listen(PORT, HOST, () => {
  log(`TabDock 桥已启动  http://${HOST}:${PORT}`);
  log(`  扩展连接地址: ws://${HOST}:${PORT}${WS_PATH}`);
  log(`  对外接口:     GET http://${HOST}:${PORT}/tabs`);
  if (TOKEN) log('  已启用 token 校验');
});

function shutdown() {
  log('正在关闭…');
  for (const res of sseClients) {
    try { res.end(); } catch { /* noop */ }
  }
  sseClients.clear();
  if (extSocket) { try { extSocket.destroy(); } catch { /* noop */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, state };
