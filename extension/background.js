/**
 * TabBridge — MV3 service worker
 *
 * 职责：
 *  1. 作为 WebSocket 客户端连到本机桥（ws://127.0.0.1:17890/ws）
 *  2. 首次连接 / 任何标签变化时推送全量快照
 *  3. 接收桥下发的命令（activate / close / mute / pin）并回执
 *  4. 断线指数退避重连；被 SW 回收后靠 alarms + 事件唤醒
 *
 * 设计取舍：变化用「节流后的全量快照」而不是增量事件。
 * 标签页数量通常 < 200，单次快照几 KB，全量最不容易出错（无需处理
 * 乱序、丢事件、SW 重启后的状态缝合）。节流窗口 120ms。
 */

const DEFAULT_WS = 'ws://127.0.0.1:17890/ws';

let ws = null;
let connected = false;
let retryDelay = 1000;
let retryTimer = null;
let pushTimer = null;
let keepAliveTimer = null;
let wsUrl = DEFAULT_WS;
let lastError = '';

// ---------------- 工具 ----------------

function detectBrowser() {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'unknown';
}

function truncateUrl(url) {
  return typeof url === 'string' ? url : '';
}

async function collectSnapshot() {
  const wins = await chrome.windows.getAll({ populate: true });
  const windows = [];
  const tabs = [];

  for (const w of wins) {
    const list = w.tabs || [];
    windows.push({
      id: w.id,
      focused: !!w.focused,
      state: w.state,          // normal | minimized | maximized | fullscreen
      type: w.type,            // normal | popup | panel | app | devtools
      incognito: !!w.incognito,
      tabCount: list.length,
      bounds: { left: w.left, top: w.top, width: w.width, height: w.height }
    });

    for (const t of list) {
      tabs.push({
        id: t.id,
        windowId: t.windowId,
        index: t.index,
        title: t.title || '',
        url: truncateUrl(t.url),
        active: !!t.active,
        highlighted: !!t.highlighted,
        pinned: !!t.pinned,
        audible: !!t.audible,
        muted: !!(t.mutedInfo && t.mutedInfo.muted),
        groupId: typeof t.groupId === 'number' ? t.groupId : -1,
        status: t.status || '',  // loading | complete | unloaded
        discarded: !!t.discarded,
        incognito: !!t.incognito,
        favIconUrl: t.favIconUrl || '',
        lastAccessed: t.lastAccessed || null,
        openerTabId: t.openerTabId || null
      });
    }
  }

  tabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));

  return {
    browser: detectBrowser(),
    extVersion: chrome.runtime.getManifest().version,
    at: Date.now(),
    windows,
    tabs
  };
}

// ---------------- WebSocket ----------------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

async function pushNow() {
  if (!connected) return;
  try {
    const snap = await collectSnapshot();
    if (send({ type: 'snapshot', data: snap })) lastError = '';
  } catch (e) {
    lastError = String((e && e.message) || e);
  }
}

function schedulePush(delay = 120) {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushNow();
  }, delay);
}

function startKeepAlive() {
  stopKeepAlive();
  // 应用层 ping：既探活也给 SW 续命（Chrome 116+ WebSocket 活动计入 idle 计时）
  keepAliveTimer = setInterval(() => {
    if (!connected) return;
    if (!send({ type: 'ping', at: Date.now() })) stopKeepAlive();
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  const wait = Math.min(retryDelay, 15000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 1.6, 15000);
    connect();
  }, wait);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    lastError = String((e && e.message) || e);
    scheduleRetry();
    return;
  }
  ws = socket;

  socket.onopen = async () => {
    connected = true;
    retryDelay = 1000;
    lastError = '';
    send({
      type: 'hello',
      browser: detectBrowser(),
      extVersion: chrome.runtime.getManifest().version,
      pid: 'sw'
    });
    await pushNow();
    startKeepAlive();
  };

  socket.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping':
        send({ type: 'pong', at: Date.now() });
        break;
      case 'refresh':
        await pushNow();
        break;
      case 'cmd':
        await handleCommand(msg);
        break;
      case 'bye':
        try { socket.close(); } catch (e) { /* noop */ }
        break;
      default:
        break;
    }
  };

  socket.onclose = () => {
    if (ws === socket) {
      connected = false;
      ws = null;
    }
    stopKeepAlive();
    scheduleRetry();
  };

  socket.onerror = () => {
    lastError = 'websocket-error';
    try { socket.close(); } catch (e) { /* noop */ }
  };
}

// ---------------- 命令执行 ----------------

async function handleCommand(msg) {
  const id = msg.id;
  const action = msg.action;
  let result;

  try {
    if (action === 'activate') {
      if (msg.tabId != null) {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        if (tab && msg.focusWindow !== false) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } else if (msg.windowId != null) {
        await chrome.windows.update(msg.windowId, { focused: true });
      } else {
        throw new Error('tabId or windowId required');
      }
      result = { ok: true };
    } else if (action === 'close') {
      if (msg.tabId == null) throw new Error('tabId required');
      await chrome.tabs.remove(msg.tabId);
      result = { ok: true };
    } else if (action === 'mute') {
      if (msg.tabId == null) throw new Error('tabId required');
      await chrome.tabs.update(msg.tabId, { muted: !!msg.muted });
      result = { ok: true };
    } else if (action === 'pin') {
      if (msg.tabId == null) throw new Error('tabId required');
      await chrome.tabs.update(msg.tabId, { pinned: !!msg.pinned });
      result = { ok: true };
    } else if (action === 'reload') {
      if (msg.tabId == null) throw new Error('tabId required');
      await chrome.tabs.reload(msg.tabId);
      result = { ok: true };
    } else {
      result = { ok: false, error: 'unknown-action:' + String(action) };
    }
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) };
  }

  if (id != null) send({ type: 'cmdResult', id, ...result });
  schedulePush(40);
}

// ---------------- 事件绑定（顶层注册，SW 每次唤醒都会重新注册） ----------------

const push = () => schedulePush(120);

chrome.tabs.onCreated.addListener(push);
chrome.tabs.onUpdated.addListener(push);
chrome.tabs.onRemoved.addListener(push);
chrome.tabs.onMoved.addListener(push);
chrome.tabs.onActivated.addListener(push);
chrome.tabs.onHighlighted.addListener(push);
chrome.tabs.onAttached.addListener(push);
chrome.tabs.onDetached.addListener(push);
chrome.tabs.onReplaced.addListener(push);

if (chrome.windows && chrome.windows.onCreated) chrome.windows.onCreated.addListener(push);
if (chrome.windows && chrome.windows.onRemoved) chrome.windows.onRemoved.addListener(push);
if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener(push);

chrome.runtime.onStartup.addListener(() => { connect(); pushNow(); });
chrome.runtime.onInstalled.addListener(() => { connect(); pushNow(); });

// 兜底：每分钟检查一次连接（SW 被回收后不会自动重连）
if (chrome.alarms) {
  chrome.alarms.create('tabbridge-keepalive', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'tabbridge-keepalive') return;
    if (!connected) connect();
    else schedulePush(0);
  });
}

// popup 查询状态
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    collectSnapshot()
      .then((snap) => {
        sendResponse({
          connected,
          wsUrl,
          lastError,
          browser: snap.browser,
          tabCount: snap.tabs.length,
          windowCount: snap.windows.length,
          extVersion: snap.extVersion
        });
      })
      .catch((e) => sendResponse({ connected, wsUrl, lastError: String(e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === 'reconnect') {
    try { if (ws) ws.close(); } catch (e) { /* noop */ }
    ws = null;
    connected = false;
    retryDelay = 500;
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ---------------- 启动 ----------------
connect();
schedulePush(300);
