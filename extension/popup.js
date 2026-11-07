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
