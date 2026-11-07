/* TabBridge popup */
function $(id) {
  return document.getElementById(id);
}

function render(st) {
  const connected = !!(st && st.connected);
  $('dot').className = 'dot' + (connected ? ' on' : '');
  const conn = $('conn');
  conn.textContent = connected ? '已连接' : '未连接';
  conn.className = connected ? 'on' : 'off';
  $('counts').textContent = st && st.tabCount != null
    ? st.tabCount + ' / ' + st.windowCount
    : '—';
  $('browser').textContent = (st && st.browser) || '—';
  $('wsurl').textContent = (st && st.wsUrl) || '—';
  const err = $('err');
  if (st && st.lastError) {
    err.textContent = '错误：' + st.lastError;
    err.classList.add('show');
  } else {
    err.classList.remove('show');
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (st) => {
    if (chrome.runtime.lastError) {
      render({ connected: false, lastError: chrome.runtime.lastError.message });
      return;
    }
    render(st || {});
  });
}

$('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    setTimeout(refresh, 400);
  });
});

// ---- GitHub 项目一键复制 ----
// 提示词想换就改这一行（只影响复制出去的第一句）
const REPO_PROMPT = '帮我总结这些仓库的最新版本与更新日志：';

// github.com 上不是「owner/repo 仓库」的两段路径（orgs/x、features/x、collections/x 等）
const GH_NON_REPO_OWNER = new Set([
  'orgs', 'features', 'topics', 'collections', 'marketplace', 'sponsors',
  'settings', 'notifications', 'explore', 'pricing', 'security', 'customer-stories',
  'readme', 'about', 'site', 'enterprises', 'team', 'enterprise', 'industries'
]);
// owner/repo 里第二段其实是用户主页子页（github.com/<user>/repositories 等）
const GH_USER_SUBPAGE = new Set([
  'repositories', 'tab', 'followers', 'following', 'stars', 'packages',
  'projects', 'hooks', 'deploy', 'achievements'
]);

function extractGithubRepos(tabs) {
  const seen = new Map(); // owner/repo(小写) -> 规范化 URL，同仓库多标签去重
  for (const t of tabs || []) {
    let u;
    try { u = new URL(t.url); } catch { continue; }
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') continue;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) continue;                    // /feed /trending /settings 等单段页
    const [owner, repo] = seg;
    if (GH_NON_REPO_OWNER.has(owner.toLowerCase())) continue;
    if (GH_USER_SUBPAGE.has(repo.toLowerCase())) continue;   // <user>/repositories 这类用户页
    const key = owner.toLowerCase() + '/' + repo.toLowerCase();
    if (!seen.has(key)) seen.set(key, 'https://github.com/' + owner + '/' + repo);
  }
  return [...seen.values()];
}

// 批次收藏用：保留原始 URL（issue/PR/子页一起还原），只去掉 hash、归一域名。
// 与 extractGithubRepos 的区别：不做仓库级归一去重，恢复 = 还原当时的标签集合
function extractGithubPages(tabs) {
  const seen = new Set();
  const out = [];
  for (const t of tabs || []) {
    let u;
    try { u = new URL(t.url); } catch { continue; }
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') continue;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) continue;
    const [owner, repo] = seg;
    if (GH_NON_REPO_OWNER.has(owner.toLowerCase())) continue;
    if (GH_USER_SUBPAGE.has(repo.toLowerCase())) continue;
    const key = 'https://github.com' + u.pathname + (u.search || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

let lastRepos = [];   // 归一化仓库列表（给「GitHub 项目」复制行用）
let lastPages = [];   // 原始页面 URL（给批次收藏用）
function refreshRepoCount() {
  chrome.tabs.query({}, (tabs) => {
    lastRepos = extractGithubRepos(tabs);
    lastPages = extractGithubPages(tabs);
    $('repoCount').textContent = lastRepos.length + ' 个';
  });
}

$('copyrepos').addEventListener('click', async () => {
  refreshRepoCount(); // 点的时候现查一遍，保证新鲜
  const repos = lastRepos;
  if (!repos.length) return;
  const text = REPO_PROMPT + '\n' + repos.map((u) => '- ' + u).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    const row = $('copyrepos');
    row.classList.add('copied');
    setTimeout(() => row.classList.remove('copied'), 1500);
  } catch { /* 无剪贴板权限时静默 */ }
});

// ---- 批次收藏：把当前打开的 GitHub 页面按原始 URL 存一批，之后整批原样恢复 ----
const BATCH_KEY = 'batches';
const MAX_BATCHES = 50;

function batchName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function loadBatches() {
  const o = await chrome.storage.local.get(BATCH_KEY);
  return Array.isArray(o[BATCH_KEY]) ? o[BATCH_KEY] : [];
}
async function saveBatches(list) {
  await chrome.storage.local.set({ [BATCH_KEY]: list.slice(0, MAX_BATCHES) });
}

function renderBatches(batches) {
  const list = $('batchList');
  const empty = $('batchEmpty');
  list.textContent = '';
  empty.style.display = batches.length ? 'none' : 'block';

  for (const b of batches) {
    const row = document.createElement('div');
    row.className = 'batch-row' + (expandedIds.has(b.id) ? ' open' : '');

    // ---- 行头：展开/收起 + 打开 + 删除 ----
    const head = document.createElement('div');
    head.className = 'b-head';
    head.title = '点开展开这批的页面清单';

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▸';

    const main = document.createElement('div');
    main.className = 'b-main';
    const name = document.createElement('div');
    name.className = 'b-name';
    name.textContent = b.name;
    const meta = document.createElement('div');
    meta.className = 'b-meta';
    meta.textContent = b.repos.length + ' 个页面';
    main.append(name, meta);

    const openBtn = document.createElement('button');
    openBtn.className = 'mini-btn';
    openBtn.textContent = '打开';
    openBtn.title = '整批恢复（后台标签，已开的自动跳过）';
    openBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 按 URL 精确比对：已经开着的页面跳过，不堆重复标签
      const tabs = await chrome.tabs.query({});
      const opened = new Set(extractGithubPages(tabs));
      const fresh = b.repos.filter((u) => !opened.has(u));
      for (const url of fresh) chrome.tabs.create({ url, active: false });
      meta.textContent = !fresh.length
        ? '全部已开着，没有新开'
        : fresh.length === b.repos.length
          ? '已打开 ' + fresh.length + ' 个'
          : '已打开 ' + fresh.length + ' 个（跳过已开 ' + (b.repos.length - fresh.length) + '）';
      setTimeout(() => { meta.textContent = b.repos.length + ' 个页面'; }, 2000);
    });

    const del = document.createElement('button');
    del.className = 'mini-btn del';
    del.textContent = '×';
    del.title = '删除这批';
    let armed = false, armTimer = null;
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!armed) {           // 第一次点：进入待确认态，3 秒内再点才真删
        armed = true;
        del.textContent = '确认删除';
        del.classList.add('danger');
        armTimer = setTimeout(() => {
          armed = false;
          del.textContent = '×';
          del.classList.remove('danger');
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      await saveBatches((await loadBatches()).filter((x) => x.id !== b.id));
      renderBatches(await loadBatches());
    });

    head.addEventListener('click', () => {
      if (expandedIds.has(b.id)) expandedIds.delete(b.id);
      else expandedIds.add(b.id);
      row.classList.toggle('open');
    });
    head.append(caret, main, openBtn, del);

    // ---- 展开的页面清单：每条可单独打开 ----
    const pages = document.createElement('div');
    pages.className = 'page-list';
    for (const url of b.repos) {
      const item = document.createElement('div');
      item.className = 'page-item';
      item.title = url + '（点击打开）';
      const repo = document.createElement('span');
      repo.className = 'pi-repo';
      const rest = url.replace('https://github.com/', '');
      const slash = rest.indexOf('/');
      repo.textContent = slash > 0 ? rest.slice(0, slash) : rest;
      item.appendChild(repo);
      item.appendChild(document.createTextNode(slash > 0 ? rest.slice(slash) : ''));
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url, active: false });
      });
      pages.appendChild(item);
    }

    row.append(head, pages);
    list.appendChild(row);
  }
}

const expandedIds = new Set();   // 展开状态只在 popup 打开期间记忆

const CLOSE_KEY = 'closeAfterSave';
chrome.storage.local.get(CLOSE_KEY).then((o) => { $('closeAfterSave').checked = !!o[CLOSE_KEY]; });
$('closeAfterSave').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ [CLOSE_KEY]: e.target.checked });
});

// 收藏后关闭刚收藏的那些标签页（按原始 URL 匹配，同一 URL 的多个标签都关）
async function closeCollectedTabs(repos) {
  const keep = new Set(repos);
  const tabs = await chrome.tabs.query({});
  const ids = [];
  for (const t of tabs) {
    let u;
    try { u = new URL(t.url); } catch { continue; }
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') continue;
    if (keep.has('https://github.com' + u.pathname + (u.search || ''))) ids.push(t.id);
  }
  if (ids.length) await chrome.tabs.remove(ids);
  return ids.length;
}

$('saveBatch').addEventListener('click', async () => {
  refreshRepoCount();          // 点的时候现查，保证新鲜
  const repos = lastPages;     // 存原始 URL，恢复时连子页一起还原
  if (!repos.length) return;
  const all = await loadBatches();
  // 和最近一批完全相同就不重复收藏
  if (all[0] && all[0].repos.length === repos.length && all[0].repos.join() === repos.join()) return;
  all.unshift({ id: Date.now(), name: batchName(), repos, at: Date.now() });
  await saveBatches(all);
  renderBatches(await loadBatches());
  if ($('closeAfterSave').checked) await closeCollectedTabs(repos);
  refreshRepoCount();          // 关完刷新计数（开了开关的话会归零）
  const btn = $('saveBatch');
  btn.textContent = '已收藏 ✓';
  setTimeout(() => { btn.textContent = '＋ 收藏当前'; }, 1200);
});

// 点击 curl 行复制命令（按桥地址自动推导端口）
$('copyline').addEventListener('click', async () => {
  const ws = $('wsurl').textContent || '';
  let base = 'http://127.0.0.1:17890';
  try { base = 'http://' + new URL(ws).host; } catch { /* 保持默认 */ }
  const cmd = 'curl ' + base + '/tabs';
  $('cmd').textContent = cmd;
  try {
    await navigator.clipboard.writeText(cmd);
    const line = $('copyline');
    line.classList.add('copied');
    setTimeout(() => line.classList.remove('copied'), 1500);
  } catch { /* 无剪贴板权限时静默 */ }
});

refresh();
refreshRepoCount();
setInterval(refresh, 1500);
loadBatches().then(renderBatches);
