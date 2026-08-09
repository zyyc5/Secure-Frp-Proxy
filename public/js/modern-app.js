(() => {
  const $ = (id) => document.getElementById(id);
  const state = { page: null, targets: [], current: '', busy: new Set() };
  const loading = $('loading');
  const app = $('app');

  function toast(message, error = false) {
    const el = $('toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
    window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => { el.className = 'toast'; }, 2800);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    let body = null; try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body;
  }

  function setSwitch(id, on, disabled) {
    const button = $(id); button.classList.toggle('on', on); button.disabled = disabled;
  }

  function renderStatus() {
    const p = state.page; if (!p) return;
    $('rdpCard').hidden = !p.isWindows;
    const rdpOn = p.rdpEnableDisabled === 'none';
    const whitelistOn = p.whiteListRemoveDisabled === 'block';
    const proxyOn = p.proxyCloseDisabled === 'block';
    $('rdpStatus').textContent = rdpOn ? '已启用' : '已关闭';
    $('whitelistStatus').textContent = whitelistOn ? '已加入白名单' : '临时访问';
    $('clientIp').textContent = p.IP || 'Unknown IP';
    $('publicPorts').textContent = (p.publicPorts || []).length
      ? p.publicPorts.map((entry) => `${entry.channel} ${entry.name}:${entry.port}`).join('，')
      : '未配置';
    $('proxyStatus').textContent = proxyOn ? '已连接' : (p.proxyStatus ? '已停止' : '未安装');
    $('accessDetail').textContent = p.whiteListStatus || 'No active access window';
    setSwitch('rdpToggle', rdpOn, p.rdpEnableDisabled === 'none' && p.rdpDisableDisabled === 'none');
    setSwitch('whitelistToggle', whitelistOn, p.whiteListJoinDisabled === 'none' && p.whiteListRemoveDisabled === 'none');
    setSwitch('proxyToggle', proxyOn, p.proxyOpenDisabled === 'none' && p.proxyCloseDisabled === 'none');
    const active = (p.isWindows && rdpOn) || whitelistOn || proxyOn;
    $('overallBadge').innerHTML = `<span class="pulse"></span><span>${active ? '网关运行正常' : '网关待机中'}</span>`;
  }

  function renderTargets() {
    const current = state.targets.find((target) => target.id === state.current);
    $('currentTarget').innerHTML = `<span class="muted">当前路由</span><strong>${escapeHtml(current?.name || '未配置')}</strong>`;
    const list = $('targetsList'); list.innerHTML = ''; $('emptyTargets').hidden = state.targets.length > 0;
    state.targets.forEach((target) => {
      const item = document.createElement('tr'); item.draggable = true; item.dataset.id = target.id; item.className = target.id === state.current ? 'current-row' : '';
      item.innerHTML = `<td><button class="drag-handle" aria-label="拖动排序" title="拖动排序">&#8942;&#8942;</button></td><td><span class="table-name">${escapeHtml(target.name)}</span></td><td><span class="table-address">${escapeHtml(target.host)}:${target.port}</span></td><td><span class="table-description">${escapeHtml(target.description || '暂无描述')}</span></td><td>${target.id === state.current ? '<span class="eyebrow">当前</span>' : '<span class="muted">可用</span>'}</td><td><div class="table-actions">${target.id === state.current ? '<button class="btn btn-outline" disabled>当前</button>' : `<button class="btn btn-primary" data-action="select" data-id="${escapeHtml(target.id)}">设为当前</button>`}<button class="btn btn-outline" data-action="delete" data-id="${escapeHtml(target.id)}">删除</button></div></td>`;
      item.addEventListener('dragstart', () => { state.dragged = target.id; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { state.dragged = null; item.classList.remove('dragging'); });
      item.addEventListener('dragover', (event) => event.preventDefault());
      item.addEventListener('drop', async (event) => { event.preventDefault(); if (!state.dragged || state.dragged === target.id) return; const from = state.targets.findIndex((entry) => entry.id === state.dragged); const to = state.targets.findIndex((entry) => entry.id === target.id); const [moved] = state.targets.splice(from, 1); state.targets.splice(to, 0, moved); renderTargets(); try { await request('/api/proxy-targets/reorder', { method: 'POST', body: JSON.stringify({ ids: state.targets.map((entry) => entry.id) }) }); toast('排序已保存'); } catch (error) { toast(error.message, true); await load(); } });
      list.appendChild(item);
    });
  }

  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

  async function load() {
    const [page, targets] = await Promise.all([request('/api/page-data'), request('/api/proxy-targets')]);
    state.page = page; state.targets = targets.targets || []; state.current = targets.currentTarget || '';
    renderStatus(); renderTargets(); $('lastUpdated').textContent = `同步于 ${new Date().toLocaleTimeString()}`;
  }

  async function action(key, url, success) {
    if (state.busy.has(key)) return; state.busy.add(key);
    try { await request(url, { method: 'POST' }); toast(success); await load(); } catch (error) { toast(error.message, true); } finally { state.busy.delete(key); }
  }

  $('refreshBtn').addEventListener('click', async () => { $('refreshBtn').disabled = true; try { await load(); toast('状态已刷新'); } catch (e) { toast(e.message, true); } finally { $('refreshBtn').disabled = false; } });
  $('rdpToggle').addEventListener('click', () => action('rdp', $('rdpToggle').classList.contains('on') ? '/api/disable' : '/api/enable', 'RDP 状态已更新'));
  $('whitelistToggle').addEventListener('click', () => action('whitelist', $('whitelistToggle').classList.contains('on') ? '/api/removewhitelist' : '/api/joinwhitelist', '访问权限已更新'));
  $('proxyToggle').addEventListener('click', () => action('proxy', $('proxyToggle').classList.contains('on') ? '/api/closeproxy' : '/api/openproxy', 'FRP 隧道状态已更新'));
  $('targetsList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const id = encodeURIComponent(button.dataset.id);
    try { if (button.dataset.action === 'delete' && !window.confirm('确定删除这个代理目标吗？')) return; await request(`/api/proxy-targets/${id}${button.dataset.action === 'select' ? '/set-current' : ''}`, { method: button.dataset.action === 'select' ? 'POST' : 'DELETE' }); toast(button.dataset.action === 'select' ? '当前目标已更新' : '目标已删除'); await load(); } catch (error) { toast(error.message, true); }
  });
  $('addTargetBtn').addEventListener('click', () => $('targetDialog').showModal());
  $('passwordBtn').addEventListener('click', () => { $('userName').value = state.page?.userName || ''; $('passwordDialog').showModal(); });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => $(button.dataset.closeDialog).close());
  });
  $('targetForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const data = Object.fromEntries(form.entries()); data.port = Number(data.port);
    if (!data.name || !data.host || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) return toast('请填写有效的名称、主机地址和端口', true);
    try { await request('/api/proxy-targets', { method: 'POST', body: JSON.stringify(data) }); event.currentTarget.reset(); $('targetDialog').close(); toast('目标已添加'); await load(); } catch (error) { toast(error.message, true); }
  });
  $('passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!data.userName || !data.newPassword || data.newPassword.length < 12) return toast('用户名不能为空，密码至少需要 12 位', true);
    if (data.newPassword !== data.confirmPassword) return toast('Passwords do not match', true);
    try { await request('/api/change-password', { method: 'POST', body: JSON.stringify(data) }); $('passwordDialog').close(); toast('凭据已更新，请重新登录。'); } catch (error) { toast(error.message, true); }
  });

  load().then(() => { loading.hidden = true; app.hidden = false; }).catch((error) => { loading.innerHTML = `<strong>Unable to load workspace</strong><span>${escapeHtml(error.message)}</span><button class="btn btn-primary" onclick="location.reload()">Retry</button>`; });
  window.setInterval(() => load().catch(() => {}), 30000);
})();
