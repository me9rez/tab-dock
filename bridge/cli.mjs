#!/usr/bin/env node
/**
 * TabBridge CLI — 给人快速看一眼用的极薄封装（agent 直接用 curl 也行）
 *
 *   node cli.mjs health
 *   node cli.mjs tabs            # 表格
 *   node cli.mjs tabs --json     # 原始 JSON
 *   node cli.mjs tabs --url github --active
 *   node cli.mjs active
 *   node cli.mjs activate 12345
 *   node cli.mjs close 12345
 *   node cli.mjs watch           # 跟随 SSE 打印变化
 */

const HOST = process.env.TABBRIDGE_HOST || '127.0.0.1';
const PORT = process.env.TABBRIDGE_PORT || '17890';
const TOKEN = process.env.TABBRIDGE_TOKEN || '';
const BASE = `http://${HOST}:${PORT}`;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'health';
const json = argv.includes('--json');

function qs(flags) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(flags)) {
    if (v === true) p.set(k, '1');
    else if (v != null) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

function flag(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

async function api(path, method = 'GET') {
  const headers = {};
  if (TOKEN) headers['X-TabBridge-Token'] = TOKEN;
  const res = await fetch(BASE + path, { method, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

function pad(s, n) {
  // 中文字符按 2 列宽补齐
  const width = (str) => [...String(str)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  let out = String(s);
  let w = width(out);
  if (w > n) {
    let acc = '';
    let cw = 0;
    for (const ch of String(s)) {
      const cwid = ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
      if (cw + cwid > n - 1) { acc += '…'; break; }
      acc += ch;
      cw += cwid;
    }
    return acc; // 截断后由调用处的固定空格分隔
  }
  return out + ' '.repeat(Math.max(1, n - w));
}

function printTabs(body) {
  if (!body.tabs || body.tabs.length === 0) {
    console.log('（没有匹配的标签页）');
    return;
  }
  const staleMark = body.stale ? '  ⚠ 快照可能过期' : '';
  console.log(`共 ${body.count} 个标签页 · 浏览器 ${body.browser || '?'}${staleMark}\n`);
  console.log(' ' + pad('ID', 12) + pad('WIN', 12) + pad('标题', 44) + 'URL');
  console.log('-'.repeat(112));
  for (const t of body.tabs) {
    const mark = t.active ? '▶' : ' ';
    console.log(
      mark +
      pad(t.id, 12) +
      pad(t.windowId, 12) +
      pad(t.title || '(无标题)', 44) +
      ' ' +
      (t.url || '')
    );
  }
}

async function main() {
  switch (cmd) {
    case 'health': {
      const { status, body } = await api('/health');
      if (json) return console.log(JSON.stringify(body, null, 2));
      console.log(`桥: ${status === 200 ? '在跑' : '异常(' + status + ')'}`);
      console.log(`扩展: ${body.connected ? '已连接' : '未连接'}${body.stale ? '（快照过期）' : ''}`);
      console.log(`浏览器: ${body.browser || '-'}  v${body.extVersion || '-'}`);
      if (body.lastSnapshotAgeMs != null) console.log(`上次快照: ${body.lastSnapshotAgeMs} ms 前`);
      break;
    }

    case 'tabs': {
      const query = qs({
        url: flag('url'),
        urlRe: flag('urlRe'),
        title: flag('title'),
        active: !!flag('active'),
        audible: !!flag('audible'),
        pinned: flag('pinned'),
        windowId: flag('windowId'),
        limit: flag('limit'),
        fields: flag('fields')
      });
      const { body } = await api('/tabs' + query);
      if (json) return console.log(JSON.stringify(body, null, 2));
      printTabs(body);
      break;
    }

    case 'active': {
      const { body } = await api('/active');
      if (json) return console.log(JSON.stringify(body, null, 2));
      for (const t of body.active || []) {
        console.log(`[窗口 ${t.windowId}] ${t.title}\n   ${t.url}`);
      }
      break;
    }

    case 'windows': {
      const { body } = await api('/windows');
      if (json) return console.log(JSON.stringify(body, null, 2));
      for (const w of body.windows || []) {
        console.log(`窗口 ${w.id} (${w.state}${w.focused ? ', 前台' : ''}) — ${w.tabCount} 个标签`);
        for (const t of w.tabs) console.log(`  ${t.active ? '▶' : ' '} ${pad(t.id, 8)} ${t.title}`);
        console.log('');
      }
      break;
    }

    case 'activate':
    case 'close':
    case 'mute':
    case 'pin':
    case 'reload': {
      const id = argv[1];
      if (!id) {
        console.error(`用法: node cli.mjs ${cmd} <tabId>`);
        process.exit(1);
      }
      const { status, body } = await api(`/tabs/${id}/${cmd}`, 'POST');
      console.log(JSON.stringify({ status, ...body }, null, 2));
      break;
    }

    case 'watch': {
      const headers = TOKEN ? { 'X-TabBridge-Token': TOKEN } : {};
      const res = await fetch(BASE + '/events', { headers });
      console.log('订阅变化中（Ctrl+C 退出）…');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            try {
              const ev = JSON.parse(payload);
              const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
              console.log(`[${t}] ${ev.type}${ev.tabCount != null ? ` tabs=${ev.tabCount}` : ''}`);
            } catch {
              console.log(line);
            }
          }
        }
      }
      break;
    }

    default:
      console.log('用法: node cli.mjs <health|tabs|active|windows|watch|activate|close|mute|pin|reload> [参数]');
  }
}

main().catch((e) => {
  console.error('请求失败:', e.message);
  console.error(`桥是否在跑？ node bridge/server.mjs  (${BASE})`);
  process.exit(1);
});
