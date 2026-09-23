(() => {
  const $ = (id) => document.getElementById(id);
  const state = { page: null, targets: [], current: '', connType: 'tcp', busy: new Set(), editingTargetId: null };

  function toast(message, error = false) {
    const el = $('toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.className = 'toast'; }, 2800);
  }

  async function req(url, opts = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts });
    let d; try { d = await r.json(); } catch {}
    if (!r.ok) throw new Error(d?.error || `请求失败 (${r.status})`);
    return d;
  }

  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  function setSwitch(id, on, disabled) { const b = $(id); b.classList.toggle('on', on); b.disabled = disabled; }

  function renderStatus() {
    const p = state.page; if (!p) return;
    $('rdpCard').hidden = !p.isWindows;
    const rdpOn = p.rdpEnableDisabled === 'none';
    const wlOn = p.whiteListRemoveDisabled === 'block';
    const proxyOn = p.proxyCloseDisabled === 'block';
    $('statRdp').textContent = rdpOn ? '已启用' : '已关闭';
    $('statWhitelist').textContent = wlOn ? '已加入白名单' : '临时白名单';
    $('statClientIp').textContent = p.IP || '未知 IP';
    $('statProxy').textContent = proxyOn ? '已连接' : (p.proxyStatus ? '已停止' : '未安装');
    $('statPorts').textContent = (p.publicPorts || []).length ? p.publicPorts.map((e) => `:${e.port}`).join(' ') : '未配置';
    $('accessDetail').textContent = p.whiteListStatus || '暂无有效访问窗口';
    setSwitch('rdpToggle', rdpOn, !p.isWindows);
    setSwitch('whitelistToggle', wlOn, false);
    setSwitch('proxyToggle', proxyOn, !p.isFrpcInstalled && p.proxyStatus === '未安装');
    const dot = $('sidebarStatusDot');
    dot.className = 'status-dot ' + (proxyOn ? 'online' : 'offline');
    $('sidebarStatusText').textContent = proxyOn ? '隧道已连接' : '隧道已断开';
  }

  function renderTargets() {
    const cur = state.targets.find((t) => t.id === state.current);
    $('currentTargetName').textContent = cur?.name || '未配置';
    const list = $('targetsList'); list.innerHTML = '';
    $('emptyTargets').hidden = state.targets.length > 0;
    state.targets.forEach((t) => {
      const tr = document.createElement('tr');
      tr.draggable = true; tr.dataset.id = t.id;
      if (t.id === state.current) tr.className = 'current-row';
      const isSelf = t.id === 'self';
      tr.innerHTML = `<td><button class="drag-handle" aria-label="拖动排序">&#8942;&#8942;</button></td><td><span class="table-name">${esc(t.name)}</span></td><td><span class="table-addr">${esc(t.host)}:${t.port}</span></td><td>${t.access === 'public' ? '<span class="tag tag-amber">公开</span>' : '<span class="tag tag-blue">保护</span>'}</td><td><span class="table-desc">${esc(t.description || '--')}</span></td><td><div class="row-actions">${t.id === state.current ? '' : `<button class="row-btn is-primary" data-action="select" data-id="${esc(t.id)}">设为当前</button>`}<button class="row-btn" data-action="edit" data-id="${esc(t.id)}">编辑</button>${isSelf ? '' : `<button class="row-btn is-danger" data-action="delete" data-id="${esc(t.id)}">删除</button>`}</div></td>`;
      tr.addEventListener('dragstart', () => { state.drag = t.id; tr.classList.add('dragging'); });
      tr.addEventListener('dragend', () => { state.drag = null; tr.classList.remove('dragging'); });
      tr.addEventListener('dragover', (e) => e.preventDefault());
      tr.addEventListener('drop', async (e) => {
        e.preventDefault(); if (!state.drag || state.drag === t.id) return;
        const from = state.targets.findIndex((x) => x.id === state.drag);
        const to = state.targets.findIndex((x) => x.id === t.id);
        const [moved] = state.targets.splice(from, 1); state.targets.splice(to, 0, moved);
        renderTargets();
        try { await req('/api/proxy-targets/reorder', { method: 'POST', body: JSON.stringify({ ids: state.targets.map((x) => x.id) }) }); toast('排序已保存'); } catch (e2) { toast(e2.message, true); load(); }
      });
      list.appendChild(tr);
    });
  }

  const ACTIONS = { login:'登录', auth_challenge:'认证挑战', add_target:'添加目标', update_target:'编辑目标', reorder_targets:'排序目标', delete_target:'删除目标', switch_target:'切换目标', rdp_enable:'RDP 开启', rdp_disable:'RDP 关闭', whitelist_add:'加入白名单', whitelist_remove:'移出白名单', proxy_open:'代理开启', proxy_close:'代理关闭', change_password:'修改密码', create_access_link:'生成访问链接', access_link_redeem:'消费访问链接' };

  function renderAudit(data) {
    const entries = data.entries || [];
    $('logSummary').textContent = `最近 ${entries.length} 条操作记录`;
    const list = $('logList'); list.innerHTML = '';
    $('emptyLogs').hidden = entries.length > 0;
    $('logHead').innerHTML = '<th>时间</th><th>来源 IP</th><th>操作</th><th>详情</th>';
    entries.forEach((e) => {
      const tr = document.createElement('tr');
      const label = ACTIONS[e.action] || e.action;
      const detail = Object.entries(e.details || {}).map(([k, v]) => `${k}=${v}`).join('  ');
      const isFailed = e.details?.result === 'failed' || e.details?.result === 'expired_or_used';
      if (isFailed) tr.className = 'refused-row';
      tr.innerHTML = `<td><span class="table-time">${esc(e.time)}</span></td><td><span class="table-addr">${esc(e.ip || '--')}</span></td><td><span class="tag ${isFailed ? 'tag-red' : 'tag-blue'}">${esc(label)}</span></td><td><span class="table-desc">${esc(detail || '--')}</span></td>`;
      list.appendChild(tr);
    });
  }

  function renderConnSummary(data) {
    const s = data.summary || {};
    $('logSummary').textContent = `${data.label || ''} · ${s.uniqueIps || 0} 个独立 IP · ${s.totalConnections || 0} 次连接 · 拒绝 ${s.refused || 0} 次`;
    const list = $('logList'); list.innerHTML = '';
    const ips = data.ips || [];
    $('emptyLogs').hidden = ips.length > 0;
    $('logHead').innerHTML = '<th>来源 IP</th><th>连接次数</th><th>被拒次数</th><th>最后活跃</th><th></th>';
    ips.forEach((g) => {
      const tr = document.createElement('tr');
      if (g.refused > 0) tr.className = 'refused-row';
      tr.innerHTML = `<td><span class="table-addr">${esc(g.ip)}</span></td><td><strong>${g.total}</strong></td><td>${g.refused > 0 ? `<span class="tag tag-red">${g.refused}</span>` : '<span style="color:var(--text-3)">0</span>'}</td><td><span class="table-time">${esc(g.lastTime)}</span></td><td><button class="row-btn is-primary" data-ip="${esc(g.ip)}">详情</button></td>`;
      list.appendChild(tr);
    });
  }

  async function load() {
    const isAudit = state.connType === 'audit';
    const [page, targets, logData] = await Promise.all([
      req('/api/page-data'), req('/api/proxy-targets'),
      isAudit ? req('/api/audit-log?limit=100') : req(`/api/connections/summary?type=${state.connType}`),
    ]);
    state.page = page; state.targets = targets.targets || []; state.current = targets.currentTarget || '';
    renderStatus(); renderTargets();
    if (isAudit) renderAudit(logData); else renderConnSummary(logData);
    $('lastUpdated').textContent = `同步于 ${new Date().toLocaleTimeString()}`;
  }

  async function act(key, url, msg) {
    if (state.busy.has(key)) return; state.busy.add(key);
    try { await req(url, { method: 'POST' }); toast(msg); await load(); } catch (e) { toast(e.message, true); } finally { state.busy.delete(key); }
  }

  // Navigation
  const VIEW_TITLES = { dashboard: '概览', targets: '代理目标', logs: '日志审计' };
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      $(`view-${view}`).classList.add('active');
      $('viewTitle').textContent = VIEW_TITLES[view] || view;
    });
  });

  $('refreshBtn').addEventListener('click', async () => { $('refreshBtn').disabled = true; try { await load(); toast('已刷新'); } catch (e) { toast(e.message, true); } finally { $('refreshBtn').disabled = false; } });
  $('rdpToggle').addEventListener('click', () => act('rdp', $('rdpToggle').classList.contains('on') ? '/api/disable' : '/api/enable', 'RDP 状态已更新'));
  $('whitelistToggle').addEventListener('click', () => act('wl', $('whitelistToggle').classList.contains('on') ? '/api/removewhitelist' : '/api/joinwhitelist', '访问权限已更新'));
  $('proxyToggle').addEventListener('click', () => act('proxy', $('proxyToggle').classList.contains('on') ? '/api/closeproxy' : '/api/openproxy', 'FRP 隧道状态已更新'));

  $('targetsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]'); if (!btn) return;
    const id = encodeURIComponent(btn.dataset.id);
    if (btn.dataset.action === 'edit') return openTargetDialog(state.targets.find((t) => t.id === btn.dataset.id));
    try {
      if (btn.dataset.action === 'delete' && !confirm('确定删除这个代理目标吗？')) return;
      await req(`/api/proxy-targets/${id}${btn.dataset.action === 'select' ? '/set-current' : ''}`, { method: btn.dataset.action === 'select' ? 'POST' : 'DELETE' });
      toast(btn.dataset.action === 'select' ? '当前目标已更新' : '目标已删除'); await load();
    } catch (e2) { toast(e2.message, true); }
  });

  function openTargetDialog(t = null) {
    const f = $('targetForm'); state.editing = t?.id || null;
    f.reset();
    if (t) { f.elements.name.value = t.name; f.elements.host.value = t.host; f.elements.port.value = t.port; f.elements.access.value = t.access || 'protected'; f.elements.description.value = t.description || ''; }
    $('targetDialogTitle').textContent = t ? '编辑代理目标' : '添加代理目标';
    $('targetSubmit').textContent = t ? '保存' : '添加';
    $('targetDialog').showModal();
  }
  $('addTargetBtn').addEventListener('click', () => openTargetDialog());
  $('passwordBtn').addEventListener('click', () => { $('userName').value = state.page?.userName || ''; $('passwordDialog').showModal(); });
  $('accessLinkBtn').addEventListener('click', () => { $('accessLinkResult').hidden = true; $('accessLinkDialog').showModal(); });
  $('accessLinkGenerate').addEventListener('click', async () => {
    try { const d = await req('/api/access-link', { method: 'POST', body: JSON.stringify({ ttlMinutes: 15 }) }); $('accessLinkUrl').value = d.url; $('accessLinkResult').hidden = false; toast('链接已生成'); } catch (e) { toast(e.message, true); }
  });
  $('accessLinkCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('accessLinkUrl').value); toast('已复制'); } catch { $('accessLinkUrl').select(); document.execCommand('copy'); toast('已复制'); }
  });

  document.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => $(b.dataset.closeDialog).close()));
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (state.connType === btn.dataset.type) return;
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.connType = btn.dataset.type;
      try {
        if (state.connType === 'audit') { renderAudit(await req('/api/audit-log?limit=100')); }
        else { renderConnSummary(await req(`/api/connections/summary?type=${state.connType}`)); }
      } catch (e) { toast(e.message, true); }
    });
  });

  $('logList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-ip]'); if (!btn) return;
    const ip = btn.dataset.ip;
    try {
      const d = await req(`/api/connections/detail?ip=${encodeURIComponent(ip)}&type=${state.connType}&limit=100`);
      $('ipDetailTitle').textContent = ip;
      const refused = d.summary.refused > 0 ? `<span class="chip is-refused">被拒绝 ${d.summary.refused} 次</span>` : '<span class="chip">未被拒绝</span>';
      $('ipDetailMeta').innerHTML = `<span class="chip">共 ${d.summary.total} 次连接</span>${refused}`;
      const isHttps = state.connType === 'https';
      $('ipDetailHead').innerHTML = `<th>时间</th>${isHttps ? '<th>域名</th>' : ''}<th>目标</th><th>状态</th>`;
      const list = $('ipDetailList'); list.innerHTML = '';
      d.connections.forEach((c) => {
        const tr = document.createElement('tr');
        if (c.refused) tr.className = 'refused-row';
        const tag = c.refused ? '<span class="tag tag-red">拒绝</span>' : c.routed ? '<span class="tag tag-green">转发</span>' : '<span class="tag tag-blue">连接</span>';
        tr.innerHTML = `<td><span class="table-time">${esc(c.time)}</span></td>${isHttps ? `<td><span class="table-addr">${esc(c.domain || '--')}</span></td>` : ''}<td><span class="table-desc">${esc(c.target || '未记录')}</span></td><td>${tag}</td>`;
        list.appendChild(tr);
      });
      $('ipDetailDialog').showModal();
    } catch (e) { toast(e.message, true); }
  });

  $('targetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget).entries()); d.port = Number(d.port);
    if (!d.name || !d.host || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535) return toast('请填写有效的名称、地址和端口', true);
    try {
      const editing = state.editing;
      await req(editing ? `/api/proxy-targets/${encodeURIComponent(editing)}` : '/api/proxy-targets', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(d) });
      e.currentTarget.reset(); $('targetDialog').close(); toast(editing ? '目标已更新' : '目标已添加'); await load();
    } catch (e2) { toast(e2.message, true); }
  });

  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget).entries());
    if (!d.userName || !d.newPassword || d.newPassword.length < 12) return toast('用户名不能为空，密码至少 12 位', true);
    if (d.newPassword !== d.confirmPassword) return toast('两次输入的密码不一致', true);
    try { await req('/api/change-password', { method: 'POST', body: JSON.stringify(d) }); $('passwordDialog').close(); toast('凭据已更新，请重新登录'); } catch (e2) { toast(e2.message, true); }
  });

  load().then(() => { $('loading').hidden = true; $('app').hidden = false; }).catch((e) => { $('loading').innerHTML = `<strong>控制台加载失败</strong><span>${esc(e.message)}</span><button class="btn btn-primary" onclick="location.reload()">重试</button>`; });
  setInterval(() => load().catch(() => {}), 30000);
})();
