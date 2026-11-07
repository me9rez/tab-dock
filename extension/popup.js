/* TabBridge popup */
function $(id) {
  return document.getElementById(id);
}

function render(st) {
  const connected = !!(st && st.connected);
  $('dot').className = 'dot' + (connected ? ' on' : '');
  $('conn').textContent = connected ? '已连接' : '未连接';
  $('counts').textContent = st && st.tabCount != null
    ? st.tabCount + ' / ' + st.windowCount
    : '—';
  $('browser').textContent = (st && st.browser) || '—';
  $('wsurl').textContent = (st && st.wsUrl) || '—';
  $('err').textContent = (st && st.lastError) ? ('错误：' + st.lastError) : '';
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

refresh();
setInterval(refresh, 1500);
