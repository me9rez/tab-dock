#!/usr/bin/env node
/**
 * 端到端自测：不启动真实浏览器，用本进程模拟扩展的 WebSocket 客户端，
 * 验证桥的 WS 握手 / 快照 / HTTP 查询 / 命令下发 / SSE 全链路。
 *
 *   node test/selftest.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 17899;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? '  → ' + JSON.stringify(extra) : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(pathname, method = 'GET', headers = {}) {
  const res = await fetch(BASE + pathname, { method, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

// ---- 假快照 ----
const snapshot = {
  type: 'snapshot',
  data: {
    browser: 'edge',
    extVersion: '1.0.0',
    at: Date.now(),
    windows: [
      { id: 100, focused: true, state: 'normal', type: 'normal', tabCount: 3 },
      { id: 200, focused: false, state: 'minimized', type: 'normal', tabCount: 2 }
    ],
    tabs: [
      { id: 1, windowId: 100, index: 0, title: '水晶哥-哔哩哔哩_bilibili', url: 'https://www.bilibili.com/video/BV1Lbna6KEcG', active: false, pinned: false, audible: false },
      { id: 2, windowId: 100, index: 1, title: '10月24日-【kRYST4L】-弹幕版', url: 'https://www.bilibili.com/video/BV1Lbna6KEcG?p=4', active: true, pinned: false, audible: true },
      { id: 3, windowId: 100, index: 2, title: '新标签页', url: 'edge://newtab/', active: false, pinned: false, audible: false },
      { id: 4, windowId: 200, index: 0, title: 'Niko1221/Strata', url: 'https://github.com/Niko1221/Strata', active: true, pinned: true, audible: false },
      { id: 5, windowId: 200, index: 1, title: 'vercel-labs/json-render', url: 'https://github.com/vercel-labs/json-render', active: false, pinned: false, audible: false }
    ]
  }
};

const main = async () => {
  console.log('▶ 启动桥（端口 ' + PORT + '）');
  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d.toString(); });
  bridge.stderr.on('data', (d) => { bridgeOut += d.toString(); });

  const cleanup = () => { try { bridge.kill(); } catch {} };
  process.on('exit', cleanup);

  // 等桥监听
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await http('/health');
      if (r.status === 200) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  check('桥启动并监听', up, bridgeOut.slice(-300));

  // ---- 扩展未连接时的行为 ----
  const h0 = await http('/health');
  check('未连接时 connected=false', h0.body.connected === false, h0.body);
  const t0 = await http('/tabs');
  check('未连接时 /tabs 返回空', t0.body.count === 0, t0.body);
  const cmd0 = await http('/tabs/1/activate', 'POST');
  check('未连接时命令被拒', cmd0.body.ok === false && cmd0.body.error === 'extension-not-connected', cmd0.body);

  // ---- CSRF 防护 ----
  const csrf1 = await http('/refresh', 'POST', { 'Sec-Fetch-Site': 'cross-site' });
  check('跨站写请求被拒（Sec-Fetch-Site: cross-site）', csrf1.status === 403, csrf1.body);
  const csrf2 = await http('/refresh', 'POST', { 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.example' });
  check('跨站写请求被拒（same-site 也拦）', csrf2.status === 403, csrf2.body);
  const csrf3 = await http('/refresh', 'POST', { Origin: 'https://evil.example' });
  check('外域 Origin 的写请求被拒', csrf3.status === 403, csrf3.body);
  const csrf4 = await http('/refresh', 'POST', { Origin: BASE });
  check('同源 Origin 的写请求放行', csrf4.status === 200 || csrf4.status === 503, csrf4.body);

  // ---- 模拟扩展连上来 ----
  console.log('▶ 模拟扩展连接 WebSocket');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  let opened = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 握手超时')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      opened = true;
      resolve();
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('WS error')); });
  });
  check('WS 握手成功', opened);

  // mock 维护"当前真实状态"，refresh 时回最新那份（模拟扩展的真实行为）
  let latest = snapshot;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    inbox.push(msg);
    if (msg.type === 'cmd') {
      // 回执：记录被下发的命令
      ws.send(JSON.stringify({ type: 'cmdResult', id: msg.id, ok: true }));
      ws.send(JSON.stringify(latest));
    }
    if (msg.type === 'refresh') {
      ws.send(JSON.stringify(latest));
    }
  });

  ws.send(JSON.stringify({ type: 'hello', browser: 'edge', extVersion: '1.0.0' }));
  ws.send(JSON.stringify(snapshot));
  await sleep(300);

  const h1 = await http('/health');
  check('连接后 connected=true', h1.body.connected === true, h1.body);
  check('浏览器标识被记录', h1.body.browser === 'edge', h1.body);

  // ---- 查询 ----
  console.log('▶ 查询接口');
  const t1 = await http('/tabs');
  check('GET /tabs 返回 5 条', t1.body.count === 5, t1.body.count);
  check('快照未过期', t1.body.stale === false, t1.body);

  const t2 = await http('/tabs?active=1');
  check('?active=1 过滤出 2 条（每窗口一个）', t2.body.count === 2, t2.body.count);

  const t3 = await http('/tabs?url=github');
  check('?url=github 过滤出 2 条', t3.body.count === 2, t3.body.count);

  const t4 = await http('/tabs?windowId=200');
  check('?windowId=200 过滤出 2 条', t4.body.count === 2, t4.body.count);

  const t5 = await http('/tabs?title=' + encodeURIComponent('水晶'));
  check('?title=水晶 过滤出 1 条（中文）', t5.body.count === 1, t5.body);

  const t6 = await http('/tabs?urlRe=' + encodeURIComponent('bilibili\\.com/video'));
  check('?urlRe 正则过滤出 2 条', t6.body.count === 2, t6.body.count);

  const t7 = await http('/tabs?fields=id,title&limit=2');
  check('?fields + ?limit 生效', t7.body.count === 2 && Object.keys(t7.body.tabs[0]).length === 2, t7.body);

  const w1 = await http('/windows');
  check('GET /windows 返回 2 个窗口', w1.body.count === 2, w1.body.count);
  check('窗口内嵌各自标签', w1.body.windows[0].tabs.length === 3 && w1.body.windows[1].tabs.length === 2,
    w1.body.windows.map((w) => w.tabs.length));

  const a1 = await http('/active');
  check('GET /active 返回 2 个活动标签', a1.body.count === 2, a1.body.count);

  // ---- 命令下发 ----
  console.log('▶ 命令下发（activate / close）');
  inbox.length = 0;
  const act = await http('/tabs/1/activate', 'POST');
  check('POST activate 返回 ok', act.body.ok === true, act.body);
  const gotCmd = inbox.find((m) => m.type === 'cmd');
  check('扩展收到 activate 命令', !!gotCmd && gotCmd.action === 'activate' && gotCmd.tabId === 1, gotCmd);

  const miss = await http('/tabs/9999/activate', 'POST');
  check('不存在的 tabId 返回 404', miss.status === 404, miss.body);

  const bad = await http('/tabs/1/explode', 'POST');
  check('未知动作被拒', bad.status === 400 || bad.status === 404, bad.body);

  // ---- SSE ----
  console.log('▶ SSE 事件流');
  const sseEvents = [];
  const ctrl = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(BASE + '/events', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value, { stream: true }).split('\n')) {
          if (line.startsWith('data: ')) sseEvents.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
  })();
  await sleep(200);

  // 触发一次变化
  latest = { ...snapshot, data: { ...snapshot.data, tabs: snapshot.data.tabs.slice(0, 3) } };
  ws.send(JSON.stringify(latest));
  await sleep(300);
  ctrl.abort();
  await ssePromise.catch(() => {});
  check('SSE 收到 hello', sseEvents.some((e) => e.type === 'hello'), sseEvents.map((e) => e.type));
  check('SSE 收到 snapshot 且带 tabCount', sseEvents.some((e) => e.type === 'snapshot' && e.tabCount === 3),
    sseEvents);

  const t8 = await http('/tabs');
  check('快照更新后 /tabs 变 3 条', t8.body.count === 3, t8.body.count);

  // ---- 断开 ----
  ws.close();
  await sleep(400);
  const h2 = await http('/health');
  check('断开后 connected=false', h2.body.connected === false, h2.body);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('自测异常:', e);
  process.exit(1);
});
