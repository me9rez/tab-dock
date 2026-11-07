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

let lastRepos = [];
function refreshRepoCount() {
  chrome.tabs.query({}, (tabs) => {
    lastRepos = extractGithubRepos(tabs);
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

// ---- 批次收藏：把当前打开的 GitHub 仓库存一批，之后可整批恢复 ----
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
    row.className = 'batch-row';
    row.title = '点击恢复这批（后台标签打开）';

    const main = document.createElement('div');
    main.className = 'b-main';
    const name = document.createElement('div');
    name.className = 'b-name';
    name.textContent = b.name;
    const meta = document.createElement('div');
    meta.className = 'b-meta';
    meta.textContent = b.repos.length + ' 个仓库';
    main.append(name, meta);

    const del = document.createElement('button');
    del.className = 'mini-btn del';
    del.textContent = '×';
    del.title = '删除这批';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await saveBatches((await loadBatches()).filter((x) => x.id !== b.id));
      renderBatches(await loadBatches());
    });

    row.append(main, del);
    row.addEventListener('click', async () => {
      // 已经开着的仓库跳过，不堆重复标签
      const tabs = await chrome.tabs.query({});
      const opened = new Set(extractGithubRepos(tabs));
      const fresh = b.repos.filter((u) => !opened.has(u));
      for (const url of fresh) chrome.tabs.create({ url, active: false });
      meta.textContent = !fresh.length
        ? '全部已开着，没有新开'
        : fresh.length === b.repos.length
          ? '已打开 ' + fresh.length + ' 个'
          : '已打开 ' + fresh.length + ' 个（跳过已开 ' + (b.repos.length - fresh.length) + '）';
      setTimeout(() => { meta.textContent = b.repos.length + ' 个仓库'; }, 2000);
    });

    list.appendChild(row);
  }
}

$('saveBatch').addEventListener('click', async () => {
  refreshRepoCount();          // 点的时候现查，保证新鲜
  const repos = lastRepos;
  if (!repos.length) return;
  const all = await loadBatches();
  // 和最近一批完全相同就不重复收藏
  if (all[0] && all[0].repos.length === repos.length && all[0].repos.join() === repos.join()) return;
  all.unshift({ id: Date.now(), name: batchName(), repos, at: Date.now() });
  await saveBatches(all);
  renderBatches(await loadBatches());
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
