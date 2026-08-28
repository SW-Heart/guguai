(() => {
  const $ = selector => document.querySelector(selector);
  const state = {
    csrf: '',
    admin: null,
    view: '',
    usersCursors: [''],
    invitesCursors: [''],
    logCursors: [''],
    logCategory: 'generations',
  };
  const routeModelLabels = { 'seedance-2.0': 'Seedance 2.0', 'seedance-2.0-fast': 'Seedance 2.0 Fast', 'seedance-2.5': 'Seedance 2.5' };
  const logLabels = { generations: '生成任务', credits: '积分流水', llm: 'LLM 用量', audit: '管理员审计', system: '系统异常' };
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const money = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
  const dateInput = value => value ? new Date(value).toISOString().slice(0, 16) : '';
  const status = value => ({ active: '正常', disabled: '已禁用', completed: '完成', failed: '失败', queued: '排队', running: '运行中', exhausted: '已用尽', expired: '已过期', enabled: '启用', available: '可用', missing: '目录缺失', unknown: '待检查', probe_error: '检查异常', credential_error: '密钥异常', draft: '草稿', published: '已发布', archived: '已归档', error: '错误', warning: '警告', info: '信息', success: '成功' }[value] || value || '—');
  const badge = (value, kind = '') => `<span class="badge ${kind || (['active', 'completed', 'enabled', 'available', 'success'].includes(value) ? 'ok' : ['failed', 'disabled', 'error', 'critical'].includes(value) ? 'bad' : 'warn')}">${esc(status(value))}</span>`;
  const loadingMarkup = text => `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
  const emptyMarkup = (title, detail = '') => `<div class="empty"><strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</div>`;
  const errorMarkup = (message, retry = '') => `<div class="error-state"><span>${esc(message || '请求失败，请稍后重试。')}</span>${retry ? `<button class="small-button" data-retry="${esc(retry)}" type="button">重新加载</button>` : ''}</div>`;
  const toast = (message, kind = '') => { const el = $('#toast'); el.textContent = message; el.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = 'toast'; }, 2800); };

  function setButtonBusy(button, busy, label = '处理中…') {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = label;
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalLabel || button.textContent;
      delete button.dataset.originalLabel;
    }
  }

  function resetPager(key) { state[`${key}Cursors`] = ['']; }
  function currentCursor(key) { return state[`${key}Cursors`].at(-1) || ''; }
  function pageControls(key, total, nextCursor, count) {
    const cursors = state[`${key}Cursors`];
    if (!nextCursor && cursors.length === 1) return `<div class="pagination"><span>显示 ${money(count)} 条${total !== undefined ? ` · 共 ${money(total)} 条` : ''}</span></div>`;
    return `<div class="pagination"><span>当前页 ${money(count)} 条${total !== undefined ? ` · 共 ${money(total)} 条` : ''}</span><div class="pagination-actions">${cursors.length > 1 ? `<button class="small-button" data-page-prev="${key}" type="button">上一页</button>` : ''}${nextCursor ? `<button class="small-button" data-page-next="${key}" type="button">下一页</button>` : ''}</div></div>`;
  }
  function bindPageControls(key, fetcher, nextCursor) {
    $(`[data-page-prev="${key}"]`)?.addEventListener('click', () => { state[`${key}Cursors`].pop(); fetcher(); });
    $(`[data-page-next="${key}"]`)?.addEventListener('click', () => { state[`${key}Cursors`].push(nextCursor); fetcher(); });
  }

  let adminDialogResolver = null;
  let adminDialogRestoreFocus = null;
  let adminDialogValidate = null;
  let adminDialogSubmitHandler = null;
  let adminDialogSubmitLabel = '保存';

  function adminDialogFieldMarkup(field) {
    const id = `adminDialogField-${field.name}`;
    if (field.type === 'checkbox') return `<label class="admin-dialog-check" for="${esc(id)}"><input id="${esc(id)}" data-admin-dialog-field="${esc(field.name)}" type="checkbox" ${field.checked ? 'checked' : ''}><span><b>${esc(field.label)}</b>${field.help ? `<small>${esc(field.help)}</small>` : ''}</span></label>`;
    const common = `id="${esc(id)}" data-admin-dialog-field="${esc(field.name)}" ${field.required ? 'required' : ''} ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''} ${field.maxLength !== undefined ? `maxlength="${esc(field.maxLength)}"` : ''} ${field.min !== undefined ? `min="${esc(field.min)}"` : ''} ${field.max !== undefined ? `max="${esc(field.max)}"` : ''} ${field.step !== undefined ? `step="${esc(field.step)}"` : ''} ${field.inputmode ? `inputmode="${esc(field.inputmode)}"` : ''}`;
    const control = field.type === 'select' ? `<select ${common}>${field.options.map(option => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>` : field.type === 'textarea' ? `<textarea ${common}>${esc(field.value || '')}</textarea>` : `<input ${common} type="${esc(field.type || 'text')}" value="${esc(field.value || '')}" autocomplete="off">`;
    return `<label class="admin-dialog-field" for="${esc(id)}"><span>${esc(field.label)}</span>${control}${field.help ? `<small>${esc(field.help)}</small>` : ''}</label>`;
  }

  function setAdminDialogBusy(busy) {
    const dialog = $('#adminDialog');
    dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    dialog.querySelectorAll('input,select,textarea,#adminDialogClose,#adminDialogCancel').forEach(control => { control.disabled = busy; });
    const submit = $('#adminDialogSubmit');
    if (busy) { submit.disabled = true; submit.textContent = '保存中…'; } else { submit.disabled = false; submit.textContent = adminDialogSubmitLabel; }
  }

  function finishAdminDialog(result = null) {
    const dialog = $('#adminDialog');
    const resolver = adminDialogResolver;
    const restore = adminDialogRestoreFocus;
    adminDialogResolver = null;
    adminDialogRestoreFocus = null;
    adminDialogValidate = null;
    adminDialogSubmitHandler = null;
    setAdminDialogBusy(false);
    if (dialog.open) dialog.close();
    resolver?.(result);
    requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); });
  }

  function showAdminDialog({ kicker = '编辑操作', title, description = '', fields = [], html = '', submit = '保存', danger = false, validate = null, onSubmit = null }) {
    if (adminDialogResolver) finishAdminDialog(null);
    const dialog = $('#adminDialog');
    $('#adminDialogKicker').textContent = kicker;
    $('#adminDialogTitle').textContent = title;
    $('#adminDialogDescription').textContent = description;
    $('#adminDialogBody').innerHTML = html || fields.map(adminDialogFieldMarkup).join('');
    $('#adminDialogError').textContent = '';
    $('#adminDialogSubmit').classList.toggle('danger-action', danger);
    adminDialogSubmitLabel = submit;
    $('#adminDialogSubmit').textContent = submit;
    adminDialogValidate = validate;
    adminDialogSubmitHandler = onSubmit;
    adminDialogRestoreFocus = document.activeElement;
    return new Promise(resolve => {
      adminDialogResolver = resolve;
      dialog.showModal();
      requestAnimationFrame(() => dialog.querySelector('input,select,textarea')?.focus() || $('#adminDialogSubmit').focus());
    });
  }

  function adminDialogValues() {
    return Object.fromEntries([...$('#adminDialogForm').querySelectorAll('[data-admin-dialog-field]')].map(field => [field.dataset.adminDialogField, field.type === 'checkbox' ? field.checked : field.value]));
  }

  $('#adminDialogForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const values = adminDialogValues();
    const error = adminDialogValidate?.(values);
    if (error) { $('#adminDialogError').textContent = error; return; }
    if (!adminDialogSubmitHandler) { finishAdminDialog(values); return; }
    setAdminDialogBusy(true);
    try { const result = await adminDialogSubmitHandler(values); finishAdminDialog(result === undefined ? values : result); }
    catch (requestError) { $('#adminDialogError').textContent = requestError.message || '保存失败，请重试。'; setAdminDialogBusy(false); }
  });
  $('#adminDialogClose').onclick = $('#adminDialogCancel').onclick = () => finishAdminDialog(null);
  $('#adminDialog').addEventListener('cancel', event => { event.preventDefault(); if (!$('#adminDialog').getAttribute('aria-busy') || $('#adminDialog').getAttribute('aria-busy') === 'false') finishAdminDialog(null); });
  $('#adminDialog').addEventListener('close', () => { if (adminDialogResolver) finishAdminDialog(null); });

  function showLogin(message = '') {
    if (adminDialogResolver) finishAdminDialog(null);
    state.csrf = '';
    state.admin = null;
    $('#adminApp').classList.add('hidden');
    $('#adminLogin').classList.remove('hidden');
    $('#loginError').textContent = message;
    $('#loginPassword').value = '';
    requestAnimationFrame(() => $('#loginUsername').focus());
  }

  async function api(path, options = {}) {
    const { timeout = 20000, skipAuthRedirect = false, ...requestOptions } = options;
    const method = String(requestOptions.method || 'GET').toUpperCase();
    const headers = { ...(requestOptions.headers || {}) };
    if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(path, { credentials: 'same-origin', ...requestOptions, method, headers, signal: requestOptions.signal || controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw new Error('网络连接失败，请稍后重试');
    } finally { clearTimeout(timer); }
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 401 && !skipAuthRedirect && path !== '/api/admin/auth/login') showLogin('管理员会话已过期，请重新登录。');
      const error = new Error(data.error || (response.status === 401 ? '请先登录管理员账号' : '请求失败'));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  const loaders = { overview: loadOverview, users: loadUsers, models: loadModels, invites: loadInvites, announcements: loadAnnouncements, logs: loadLogs };
  function showView(name) {
    if (!loaders[name]) return;
    if (state.view !== name) {
      if (name === 'users') resetPager('users');
      if (name === 'invites') resetPager('invites');
      if (name === 'logs') resetPager('log');
    }
    state.view = name;
    document.querySelectorAll('.nav').forEach(button => {
      const active = button.dataset.view === name;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== `view-${name}`));
    loaders[name]();
  }

  async function loadOverview() {
    const root = $('#view-overview');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Dashboard / Overview</div><h2 id="overviewTitle">总览</h2><p class="subtitle">平台运行与账务概况</p></div><div class="view-heading-actions"><button class="small-button" data-refresh="overview" type="button">刷新数据</button></div></div>${loadingMarkup('正在读取平台数据…')}`;
    try {
      const data = await api('/api/admin/overview');
      root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Dashboard / Overview</div><h2 id="overviewTitle">总览</h2><p class="subtitle">平台运行与账务概况 · ${esc(new Date().toLocaleString('zh-CN'))}</p></div><div class="view-heading-actions"><button class="small-button" data-refresh="overview" type="button">刷新数据</button></div></div>
        <div class="cards">
          <div class="stat"><small>用户总数</small><strong>${money(data.users.total)}</strong><span class="muted">活跃 ${money(data.users.active)} · 禁用 ${money(data.users.disabled)}</span></div>
          <div class="stat"><small>当前积分余额</small><strong>${money(data.credits.balance)}</strong><span class="muted">冻结 ${money(data.credits.held)}</span></div>
          <div class="stat"><small>生成任务</small><strong>${money(data.generations.total)}</strong><span class="muted">完成 ${money(data.generations.completed)} · 失败 ${money(data.generations.failed)}</span></div>
          <div class="stat ${data.exceptions.reconcile + data.exceptions.refundFailed ? 'warning' : ''}"><small>异常事项</small><strong>${money(data.exceptions.reconcile + data.exceptions.refundFailed)}</strong><span class="muted">待核账 ${money(data.exceptions.reconcile)} · 退款失败 ${money(data.exceptions.refundFailed)}</span></div>
        </div>
        <div class="overview-grid">
          <section class="overview-card"><h3>运行摘要</h3><p>快速了解当前任务、积分与系统错误情况。</p><div class="overview-list"><div class="overview-row"><span>累计消耗</span><strong>${money(data.credits.spent)} 积分</strong></div><div class="overview-row"><span>待处理任务</span><strong>${money(data.generations.pending)}</strong></div><div class="overview-row"><span>系统错误</span>${data.exceptions.systemErrors ? badge('error') : badge('success')}</div></div></section>
          <section class="overview-card"><h3>快捷入口</h3><p>从高频操作开始处理平台事项。</p><div class="overview-list"><div class="overview-row"><span>查看用户账号</span><button class="small-button" data-view-jump="users" type="button">打开用户管理</button></div><div class="overview-row"><span>检查模型线路</span><button class="small-button" data-view-jump="models" type="button">打开模型配置</button></div><div class="overview-row"><span>查看异常日志</span><button class="small-button" data-view-jump="logs" type="button">打开日志中心</button></div></div></section>
        </div>`;
      root.querySelector('[data-refresh="overview"]').onclick = loadOverview;
      root.querySelectorAll('[data-view-jump]').forEach(button => button.onclick = () => showView(button.dataset.viewJump));
    } catch (error) { root.innerHTML = `${errorMarkup(error.message, 'overview')}<div class="panel"><p class="detail">如果问题持续存在，请检查服务端状态或网络连接。</p></div>`; root.querySelector('[data-retry="overview"]')?.addEventListener('click', loadOverview); }
  }

  async function loadUsers() {
    const root = $('#view-users');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Users</div><h2 id="usersTitle">用户管理</h2><p class="subtitle">查询账号、余额、累计消耗和用户状态</p></div></div><div class="panel"><form id="userFilters" class="toolbar"><label class="control">搜索<input id="userQuery" placeholder="用户名或用户 ID" autocomplete="off"></label><label class="control">状态<select id="userStatus"><option value="">全部状态</option><option value="active">正常</option><option value="disabled">已禁用</option></select></label><button class="small-button" type="submit">查询用户</button></form><div id="userTable">${loadingMarkup('正在加载用户列表…')}</div></div>`;
    $('#userFilters').onsubmit = event => { event.preventDefault(); resetPager('users'); fetchUsers(); };
    await fetchUsers();
  }

  async function fetchUsers() {
    const table = $('#userTable'); if (!table) return;
    const params = new URLSearchParams({ limit: '50' });
    if ($('#userQuery')?.value.trim()) params.set('query', $('#userQuery').value.trim());
    if ($('#userStatus')?.value) params.set('status', $('#userStatus').value);
    if (currentCursor('users')) params.set('cursor', currentCursor('users'));
    table.innerHTML = loadingMarkup('正在加载用户列表…');
    try {
      const data = await api(`/api/admin/users?${params}`);
      table.innerHTML = data.items.length ? `<div class="table-wrap"><table aria-label="用户列表"><thead><tr><th>用户</th><th>状态</th><th>余额</th><th>可用</th><th>累计消耗</th><th>冻结</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${data.items.map(user => `<tr><td><b>${esc(user.username)}</b><div class="detail">${esc(user.id)}</div></td><td>${badge(user.status)}</td><td>${money(user.credits)}</td><td>${money(user.available)}</td><td>${money(user.totalSpent)}</td><td>${money(user.held)}</td><td>${date(user.createdAt)}</td><td class="actions"><button class="small-button" data-user-detail="${esc(user.id)}" type="button">查看详情</button><button class="small-button" data-user-adjust="${esc(user.id)}" type="button">调账</button>${user.status === 'active' ? `<button class="small-button" data-user-disable="${esc(user.id)}" type="button">禁用</button>` : `<button class="small-button" data-user-enable="${esc(user.id)}" type="button">启用</button>`}</td></tr>`).join('')}</tbody></table></div>${pageControls('users', data.total, data.nextCursor, data.items.length)}` : emptyMarkup('没有符合条件的用户', '尝试修改搜索关键词或状态筛选。');
      table.querySelectorAll('[data-user-detail]').forEach(button => button.onclick = () => showUser(button.dataset.userDetail));
      table.querySelectorAll('[data-user-adjust]').forEach(button => button.onclick = () => showCreditAdjustment(button.dataset.userAdjust));
      table.querySelectorAll('[data-user-disable]').forEach(button => button.onclick = () => changeUser(button.dataset.userDisable, 'disable'));
      table.querySelectorAll('[data-user-enable]').forEach(button => button.onclick = () => changeUser(button.dataset.userEnable, 'enable'));
      bindPageControls('users', fetchUsers, data.nextCursor);
    } catch (error) { table.innerHTML = errorMarkup(error.message, 'users'); table.querySelector('[data-retry="users"]')?.addEventListener('click', fetchUsers); }
  }

  function userDetailHtml(user) {
    const credits = (user.recentCredits || []).slice(0, 6).map(entry => `<div class="user-recent-item"><span>${esc(entry.note || entry.reasonCode || entry.type || '积分流水')}</span><span>${entry.amount !== undefined ? `${Number(entry.amount) >= 0 ? '+' : ''}${money(entry.amount)}` : date(entry.createdAt || entry.created_at)}</span></div>`).join('');
    const generations = (user.recentGenerations || []).slice(0, 6).map(item => `<div class="user-recent-item"><span>${esc(item.modelId || item.type || item.id)} · ${badge(item.status)}</span><span>${date(item.createdAt)}</span></div>`).join('');
    return `<div class="user-detail-grid"><div class="user-detail-metric"><small>当前余额</small><strong>${money(user.credits)}</strong></div><div class="user-detail-metric"><small>可用余额</small><strong>${money(user.available)}</strong></div><div class="user-detail-metric"><small>累计消耗</small><strong>${money(user.totalSpent)}</strong></div><div class="user-detail-metric"><small>冻结积分</small><strong>${money(user.held)}</strong></div><div class="user-detail-metric"><small>生成任务</small><strong>${money(user.generations)}</strong></div><div class="user-detail-metric"><small>积分流水</small><strong>${money(user.creditEntries)}</strong></div><div class="user-detail-metric"><small>LLM 用量</small><strong>${money(user.llmUsage)}</strong></div><div class="user-detail-metric"><small>邀请码</small><strong>${esc(user.inviteCode || '—')}</strong></div></div><div class="user-recent"><h3>最近生成记录</h3><div class="user-recent-list">${generations || emptyMarkup('暂无生成记录')}</div></div><div class="user-recent"><h3>最近积分流水</h3><div class="user-recent-list">${credits || emptyMarkup('暂无积分流水')}</div></div>`;
  }

  async function showUser(id) {
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(id)}`);
      const user = data.user;
      const result = await showAdminDialog({ kicker: '用户档案', title: user.username, description: `用户 ID：${user.id} · 注册于 ${date(user.createdAt)}`, html: userDetailHtml(user), submit: '进入积分调账' });
      if (result) showCreditAdjustment(id, user);
    } catch (error) { if (error.status !== 404) toast(error.message); }
  }

  async function showCreditAdjustment(id, existingUser = null) {
    let user = existingUser;
    if (!user) {
      try { user = (await api(`/api/admin/users/${encodeURIComponent(id)}`)).user; } catch (error) { toast(error.message); return; }
    }
    await showAdminDialog({
      kicker: '积分管理',
      title: `调整 ${user.username} 的积分`,
      description: `当前余额 ${money(user.credits)}。增加请输入正数，减少请输入负数；操作会写入账本和审计日志。`,
      submit: '提交调账',
      fields: [
        { name: 'amount', label: '调整金额', type: 'text', value: '', placeholder: '例如 10 或 -10', inputmode: 'decimal', required: true, help: '支持最多 6 位小数，不能为 0。' },
        { name: 'reasonCode', label: '调整原因', type: 'select', value: 'customer_service', options: [{ value: 'customer_service', label: '客服补偿' }, { value: 'promotion', label: '运营赠送' }, { value: 'correction', label: '账务修正' }, { value: 'refund', label: '退款补发' }, { value: 'other', label: '其他' }] },
        { name: 'note', label: '备注', type: 'textarea', value: '', placeholder: '补充本次调账的业务原因。', help: '备注会进入积分流水和审计记录。' },
      ],
      validate: values => /^-?\d+(?:\.\d{1,6})?$/.test(String(values.amount).trim()) && Number(values.amount) !== 0 ? null : '调整金额必须是非零数字，最多 6 位小数。',
      onSubmit: async values => {
        const result = await api(`/api/admin/users/${encodeURIComponent(id)}/credit-adjustments`, { method: 'POST', body: JSON.stringify({ amount: String(values.amount).trim(), note: values.note, reasonCode: values.reasonCode, idempotencyKey: crypto.randomUUID() }) });
        toast(`调账完成，当前余额 ${money(result.balance)}`);
        await fetchUsers();
      },
    });
  }

  async function changeUser(id, action) {
    const disabling = action === 'disable';
    await showAdminDialog({ kicker: disabling ? '危险操作' : '用户管理', title: disabling ? '禁用用户' : '启用用户', description: disabling ? '禁用后该用户现有会话会被撤销，无法继续使用用户端。' : '启用后该用户可以重新登录并使用用户端。', submit: disabling ? '确认禁用' : '确认启用', danger: disabling, onSubmit: async () => { await api(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' }); toast(disabling ? '用户已禁用' : '用户已启用'); await fetchUsers(); } });
  }

  async function loadModels() {
    const root = $('#view-models');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Models</div><h2 id="modelsTitle">模型与价格</h2><p class="subtitle">管理用户展示、接单状态、调用线路和平台价格</p></div></div><div id="routePanel" class="panel">${loadingMarkup('正在读取模型线路…')}</div><div id="modelPanel" class="panel">${loadingMarkup('正在读取模型配置…')}</div><div id="pricingPanel" class="panel">${loadingMarkup('正在读取价格版本…')}</div>`;
    try {
      const [models, pricing, routes] = await Promise.all([api('/api/admin/models'), api('/api/admin/pricing'), api('/api/admin/model-routes')]);
      renderRoutePanel(routes);
      const modelItems = models.items || [];
      $('#modelPanel').innerHTML = `<div class="panel-head"><div><h3>模型控制</h3><p class="detail">用户可见控制前端展示，接单状态控制服务端是否接受新任务。</p></div></div>${modelItems.length ? `<div class="table-wrap"><table aria-label="模型控制列表"><thead><tr><th>模型</th><th>类型</th><th>用户可见</th><th>接受新任务</th><th>排序</th><th>操作</th></tr></thead><tbody>${modelItems.map(model => `<tr><td><b>${esc(model.modelId)}</b></td><td>${esc(model.kind)}</td><td>${model.userVisible ? badge('active') : badge('disabled')}</td><td>${model.enabled ? badge('active') : badge('disabled')}</td><td>${money(model.sortOrder)}</td><td><button class="small-button" data-model="${esc(model.modelId)}" type="button">编辑</button></td></tr>`).join('')}</tbody></table></div>` : emptyMarkup('暂无模型配置')}`;
      $('#modelPanel').querySelectorAll('[data-model]').forEach(button => button.onclick = () => editModel(modelItems.find(item => item.modelId === button.dataset.model)));
      const current = pricing.current || {};
      const history = (pricing.history || []).slice(0, 6);
      $('#pricingPanel').innerHTML = `<div class="panel-head"><div><h3>全局价格 <span class="detail">· 当前版本 ${esc(current.version)}</span></h3><p class="detail">新价格仅影响新提交的任务，历史版本只读保留。</p></div></div><form id="pricingForm" class="price-form"><label class="control">图片积分 / 次<input name="imagePerRequest" value="${esc(current.imagePerRequest)}" inputmode="decimal" required></label><label class="control">视频积分 / 秒<input name="videoPerSecond" value="${esc(current.videoPerSecond)}" inputmode="decimal" required></label><button class="primary" type="submit">发布新价格</button></form>${history.length ? `<div class="user-recent"><h3>最近价格版本</h3><div class="table-wrap"><table><thead><tr><th>版本</th><th>图片 / 次</th><th>视频 / 秒</th><th>创建时间</th></tr></thead><tbody>${history.map(item => `<tr><td>${esc(item.version)}</td><td>${money(item.imagePerRequest)}</td><td>${money(item.videoPerSecond)}</td><td>${date(item.createdAt)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
      $('#pricingForm').onsubmit = async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const button = event.currentTarget.querySelector('button[type="submit"]');
        setButtonBusy(button, true, '发布中…');
        try { await api('/api/admin/pricing', { method: 'POST', body: JSON.stringify({ imagePerRequest: form.get('imagePerRequest'), videoPerSecond: form.get('videoPerSecond'), expectedVersion: current.version }) }); toast('价格已发布'); await loadModels(); }
        catch (error) { toast(error.message); setButtonBusy(button, false); }
      };
    } catch (error) { root.innerHTML = `${errorMarkup(error.message, 'models')}`; root.querySelector('[data-retry="models"]')?.addEventListener('click', loadModels); }
  }

  function routeStatusBadge(route) {
    if (!route.adminEnabled) return badge('disabled');
    const kind = route.catalogStatus === 'available' ? 'ok' : ['missing', 'credential_error'].includes(route.catalogStatus) ? 'bad' : 'warn';
    return badge(route.catalogStatus, kind);
  }

  function renderRoutePanel(data) {
    const root = $('#routePanel'); if (!root) return;
    const items = data.items || [];
    const groups = [...new Set(items.map(item => `${item.logicalModelId}:${item.quality}`))];
    root.innerHTML = `<div class="panel-head"><div><h3>Seedance 调用线路</h3><p class="detail">状态来自渠道目录，每 10 分钟自动检查；自动模式按优先级选择可用线路。</p></div><button class="small-button" id="checkAllRoutes" type="button">立即检查全部</button></div>${groups.length ? `<div class="route-groups">${groups.map(key => {
      const [modelId, quality] = key.split(':');
      const routes = items.filter(item => item.logicalModelId === modelId && item.quality === quality);
      const policy = (data.policies || []).find(item => item.logicalModelId === modelId && item.quality === quality);
      const price = (data.prices || []).find(item => item.modelId === modelId && item.quality === quality);
      const label = routeModelLabels[modelId] || modelId;
      return `<section class="route-group"><header><div><h4>${esc(label)} · ${esc(quality)}</h4><span>${price?.available ? `当前 ¥${Number(price.yuan).toFixed(2)} / ${money(price.credits)} 积分` : '当前无可用线路'}</span>${modelId === 'seedance-2.0-fast' ? '<p class="detail">固定 15 秒 · 9 图 / 3 视频 / 3 音频</p>' : ''}</div><div class="route-header-actions"><button class="route-add-button" data-add-route="${esc(key)}" type="button">新增模型</button><label>选择策略<select data-route-policy="${esc(key)}" data-version="${policy?.version || 1}"><option value="">自动按优先级</option>${routes.map(route => `<option value="${esc(route.id)}" ${policy?.forcedRouteId === route.id ? 'selected' : ''}>手动 · ${esc(route.displayName)}</option>`).join('')}</select></label></div></header><div class="table-wrap"><table class="route-table" aria-label="${esc(label)} ${esc(quality)} 调用线路"><thead><tr><th>优先级</th><th>线路 / 上游模型 ID</th><th>状态</th><th>成本</th><th>用户价</th><th>检查时间</th><th>操作</th></tr></thead><tbody>${routes.map(route => `<tr class="${price?.selectedRouteId === route.id ? 'is-selected' : ''}"><td><b>${route.priority}</b></td><td><b>${esc(route.displayName)}</b><div class="detail">${esc(route.upstreamModelId)}</div></td><td>${routeStatusBadge(route)}${route.catalogMessage ? `<div class="route-message" title="${esc(route.catalogMessage)}">${esc(route.catalogMessage)}</div>` : ''}</td><td>¥${Number(route.costYuan).toFixed(2)}</td><td>¥${Number(route.salePriceYuan).toFixed(2)}<div class="detail">${money(route.salePriceCredits)} 积分${route.salePriceConfigured ? '' : ' · 自动价'}</div></td><td>${date(route.catalogCheckedAt)}</td><td class="actions"><button class="small-button" data-edit-route="${esc(route.id)}" type="button">编辑</button><button class="small-button" data-check-route="${esc(route.id)}" type="button">检查</button></td></tr>`).join('')}</tbody></table></div></section>`;
    }).join('')}</div>` : emptyMarkup('暂无调用线路', '请先新增渠道模型，平台才会有可用的上游线路。')}`;
    $('#checkAllRoutes')?.addEventListener('click', () => checkRoutes());
    root.querySelectorAll('[data-add-route]').forEach(button => button.onclick = () => { const [modelId, quality] = button.dataset.addRoute.split(':'); addModelRoute(modelId, quality, data); });
    root.querySelectorAll('[data-check-route]').forEach(button => button.onclick = () => checkRoutes([button.dataset.checkRoute]));
    root.querySelectorAll('[data-edit-route]').forEach(button => button.onclick = () => editRoute(items.find(item => item.id === button.dataset.editRoute), data.channels));
    root.querySelectorAll('[data-route-policy]').forEach(select => select.onchange = () => changeRoutePolicy(select));
  }

  async function checkRoutes(routeIds = null) {
    const button = routeIds ? document.querySelector(`[data-check-route="${CSS.escape(routeIds[0])}"]`) : $('#checkAllRoutes');
    setButtonBusy(button, true, '检查中…');
    try { await api('/api/admin/model-routes/check', { method: 'POST', body: JSON.stringify(routeIds ? { routeIds } : {}) }); toast('模型目录检查完成'); await loadModels(); }
    catch (error) { toast(error.message); setButtonBusy(button, false); }
  }

  async function changeRoutePolicy(select) {
    const [logicalModelId, quality] = select.dataset.routePolicy.split(':');
    select.disabled = true;
    try { await api('/api/admin/model-route-policy', { method: 'PATCH', body: JSON.stringify({ logicalModelId, quality, forcedRouteId: select.value, expectedVersion: Number(select.dataset.version) }) }); toast(select.value ? '已切换为手动优先线路' : '已恢复自动优先级'); await loadModels(); }
    catch (error) { toast(error.message); select.disabled = false; }
  }

  function channelDialogOptions(channels, selected) { return (channels || []).map(channel => ({ value: channel.id, label: `${channel.label} · ${channel.envKey}${channel.configured ? '' : '（未配置）'}` })).filter(option => option.value).map(option => ({ ...option, selected: option.value === selected })); }
  function routeDialogFields({ route = null, channels = [], nextPriority = 1 }) {
    const selectedChannel = route?.credentialId || channels.find(channel => channel.configured)?.id || channels[0]?.id || '';
    return [
      { name: 'credentialId', label: '渠道 / API Key', type: 'select', value: selectedChannel, options: channelDialogOptions(channels, selectedChannel), required: true, help: '只显示已有渠道；未配置 Key 的渠道保存后会显示密钥异常。' },
      { name: 'upstreamModelId', label: '上游模型 ID', type: 'text', value: route?.upstreamModelId || '', placeholder: '例如 seedance2.0-select-full-720p', required: true, help: '必须与该渠道 /v1/models 返回的模型 ID 完全一致。' },
      { name: 'priority', label: '优先级', type: 'number', value: String(route?.priority || nextPriority), min: 1, max: 1000, step: 1, inputmode: 'numeric', required: true, help: '数字越小越优先。' },
      { name: 'costYuan', label: '成本（人民币 / 次）', type: 'number', value: route ? Number(route.costYuan).toFixed(2) : '', placeholder: '例如 2.50', min: 0, max: 100000, step: .01, inputmode: 'decimal', required: true },
      { name: 'salePriceYuan', label: '用户价格（人民币 / 次）', type: 'number', value: route ? Number(route.salePriceYuan).toFixed(2) : '', placeholder: '例如 3.00', min: 0, max: 100000, step: .01, inputmode: 'decimal', required: true, help: '用户价格独立于成本配置，1 元 = 10 积分。' },
      { name: 'adminEnabled', type: 'checkbox', label: '启用线路', checked: route ? route.adminEnabled : true, help: '关闭后自动和手动选路都会跳过该线路。' },
    ];
  }
  function validateRouteDialog(input) {
    const priority = Number(input.priority); const cost = Number(input.costYuan); const sale = Number(input.salePriceYuan);
    return String(input.credentialId || '').trim() && String(input.upstreamModelId || '').trim() && Number.isSafeInteger(priority) && priority >= 1 && priority <= 1000 && Number.isFinite(cost) && cost >= 0 && Number.isFinite(sale) && sale >= 0 ? null : '请填写渠道、上游模型 ID、优先级、成本和用户价格。';
  }
  async function addModelRoute(logicalModelId, quality, data) {
    const routes = (data.items || []).filter(item => item.logicalModelId === logicalModelId && item.quality === quality);
    const nextPriority = Math.min(1000, Math.max(0, ...routes.map(item => Number(item.priority) || 0)) + 1);
    await showAdminDialog({ kicker: '新增调用线路', title: `新增 ${routeModelLabels[logicalModelId] || logicalModelId} · ${quality}`, description: '选择已有渠道，填写该渠道实际可调用的上游模型 ID 和本平台价格。新增线路会先标记为待检查。', submit: '新增模型', fields: routeDialogFields({ channels: data.channels, nextPriority }), validate: validateRouteDialog, onSubmit: async values => { const result = await api('/api/admin/model-routes', { method: 'POST', body: JSON.stringify({ logicalModelId, quality, credentialId: values.credentialId, upstreamModelId: values.upstreamModelId.trim(), priority: Number(values.priority), costYuan: Number(values.costYuan), salePriceYuan: Number(values.salePriceYuan), adminEnabled: values.adminEnabled }) }); toast(`模型已新增：${result.route.displayName}`); await loadModels(); } });
  }
  async function editRoute(route, channels = []) {
    if (!route) return;
    await showAdminDialog({ kicker: '调用线路', title: `编辑 ${route.displayName}`, description: '可修改渠道、上游模型 ID、价格、状态和优先级；修改渠道或上游 ID 后需要重新检查目录。', submit: '保存线路', fields: routeDialogFields({ route, channels }), validate: validateRouteDialog, onSubmit: async values => { await api(`/api/admin/model-routes/${encodeURIComponent(route.id)}`, { method: 'PATCH', body: JSON.stringify({ credentialId: values.credentialId, upstreamModelId: values.upstreamModelId.trim(), adminEnabled: values.adminEnabled, priority: Number(values.priority), costYuan: Number(values.costYuan), salePriceYuan: Number(values.salePriceYuan), expectedVersion: route.version }) }); toast('线路配置已更新'); await loadModels(); } });
  }
  async function editModel(model) {
    if (!model) return;
    await showAdminDialog({ kicker: '模型控制', title: `编辑 ${model.modelId}`, description: '用户可见控制前端展示，接单状态控制服务端是否接受新任务。', submit: '保存模型配置', fields: [{ name: 'userVisible', type: 'checkbox', label: '用户可见', checked: model.userVisible, help: '关闭后不会出现在用户端模型列表。' }, { name: 'enabled', type: 'checkbox', label: '接受新任务', checked: model.enabled, help: '关闭后服务端会拒绝该模型的新生成请求。' }, { name: 'sortOrder', label: '排序值', type: 'number', value: String(model.sortOrder), min: 0, max: 100000, step: 1, inputmode: 'numeric', required: true, help: '请输入 0–100000 的整数，数字越小越靠前。' }], validate: values => { const order = Number(values.sortOrder); return Number.isSafeInteger(order) && order >= 0 && order <= 100000 ? null : '排序值必须是 0–100000 的整数。'; }, onSubmit: async values => { await api(`/api/admin/models/${encodeURIComponent(model.modelId)}`, { method: 'PATCH', body: JSON.stringify({ userVisible: values.userVisible, enabled: values.enabled, sortOrder: Number(values.sortOrder), expectedVersion: model.version }) }); toast('模型配置已更新'); await loadModels(); } });
  }

  async function loadInvites() {
    const root = $('#view-invites');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Access</div><h2 id="invitesTitle">邀请码</h2><p class="subtitle">管理注册名额、有效期和注册送积分</p></div></div><div class="panel"><form id="inviteForm" class="toolbar"><label class="control">邀请码（留空自动生成）<input name="code" placeholder="GUGU-XXXX-XXXX" autocomplete="off"></label><label class="control">最大次数<input name="maxUses" type="number" min="1" value="1"></label><label class="control">注册送积分<input name="signupBonus" value="50" inputmode="decimal"></label><label class="control">有效期<input name="expiresAt" type="datetime-local"></label><label class="control">备注<input name="note" maxlength="500"></label><button class="primary" type="submit">创建邀请码</button></form></div><div id="inviteTable" class="panel">${loadingMarkup('正在加载邀请码…')}</div>`;
    $('#inviteForm').onsubmit = async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget); const expires = form.get('expiresAt'); const button = event.currentTarget.querySelector('button[type="submit"]');
      setButtonBusy(button, true, '创建中…');
      try { const data = await api('/api/admin/invite-codes', { method: 'POST', body: JSON.stringify({ code: form.get('code'), maxUses: Number(form.get('maxUses')), signupBonus: form.get('signupBonus'), expiresAt: expires ? new Date(expires).toISOString() : null, note: form.get('note') }) }); toast(`邀请码 ${data.invite.code} 已创建`); await loadInvites(); }
      catch (error) { toast(error.message); setButtonBusy(button, false); }
    };
    await fetchInvites();
  }

  async function fetchInvites() {
    const table = $('#inviteTable'); if (!table) return;
    const params = new URLSearchParams({ limit: '50' }); if (currentCursor('invites')) params.set('cursor', currentCursor('invites'));
    table.innerHTML = loadingMarkup('正在加载邀请码…');
    try {
      const data = await api(`/api/admin/invite-codes?${params}`);
      table.innerHTML = data.items.length ? `<div class="table-wrap"><table aria-label="邀请码列表"><thead><tr><th>邀请码</th><th>状态</th><th>使用次数</th><th>注册送积分</th><th>有效期</th><th>备注</th><th>操作</th></tr></thead><tbody>${data.items.map(invite => `<tr><td><b>${esc(invite.code)}</b><button class="small-button copy-button" data-copy-invite="${esc(invite.code)}" type="button">复制</button></td><td>${badge(invite.status)}</td><td>${invite.usedCount} / ${invite.maxUses}</td><td>${money(invite.signupBonus)}</td><td>${date(invite.expiresAt)}</td><td>${esc(invite.note || '—')}</td><td class="actions"><button class="small-button" data-invite-uses="${esc(invite.code)}" type="button">使用记录</button><button class="small-button" data-invite-code="${esc(invite.code)}" data-invite-enabled="${invite.enabled}" type="button">${invite.enabled ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table></div>${pageControls('invites', data.total, data.nextCursor, data.items.length)}` : emptyMarkup('暂无邀请码', '使用上方表单创建第一个邀请码。');
      table.querySelectorAll('[data-copy-invite]').forEach(button => button.onclick = async () => { try { await navigator.clipboard.writeText(button.dataset.copyInvite); toast('邀请码已复制'); } catch { toast('复制失败，请手动复制邀请码'); } });
      table.querySelectorAll('[data-invite-uses]').forEach(button => button.onclick = () => showInviteUses(button.dataset.inviteUses));
      table.querySelectorAll('[data-invite-code]').forEach(button => button.onclick = () => toggleInvite(button.dataset.inviteCode, button.dataset.inviteEnabled === 'true'));
      bindPageControls('invites', fetchInvites, data.nextCursor);
    } catch (error) { table.innerHTML = errorMarkup(error.message, 'invites'); table.querySelector('[data-retry="invites"]')?.addEventListener('click', fetchInvites); }
  }

  async function toggleInvite(code, enabled) {
    const nextEnabled = !enabled;
    await showAdminDialog({ kicker: enabled ? '访问控制' : '访问控制', title: `${nextEnabled ? '启用' : '停用'}邀请码`, description: nextEnabled ? `启用后邀请码 ${code} 可以继续用于注册。` : `停用后邀请码 ${code} 将不能再用于注册，已有用户不受影响。`, submit: nextEnabled ? '确认启用' : '确认停用', danger: !nextEnabled, onSubmit: async () => { await api(`/api/admin/invite-codes/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: nextEnabled }) }); toast(`邀请码已${nextEnabled ? '启用' : '停用'}`); await fetchInvites(); } });
  }

  async function showInviteUses(code) {
    try {
      const data = await api(`/api/admin/invite-codes/${encodeURIComponent(code)}/uses`);
      const items = data.items || [];
      await showAdminDialog({ kicker: '邀请码记录', title: `${code} · 使用记录`, description: `共 ${items.length} 次使用。`, submit: '关闭', html: items.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>赠送积分</th><th>使用时间</th></tr></thead><tbody>${items.map(item => `<tr><td><b>${esc(item.username || '—')}</b><div class="detail">${esc(item.userId)}</div></td><td>${money(item.bonus)}</td><td>${date(item.usedAt)}</td></tr>`).join('')}</tbody></table></div>` : emptyMarkup('暂无使用记录') });
    } catch (error) { toast(error.message); }
  }

  function announcementStatusKind(value) { return value === 'published' ? 'ok' : value === 'archived' ? 'bad' : 'warn'; }
  async function editAnnouncement(announcement = null) {
    const editing = Boolean(announcement);
    await showAdminDialog({ kicker: editing ? '消息通知' : '新建内容', title: editing ? '编辑公告' : '新增公告', description: editing ? '更新后会立即同步到用户端；已读状态会保留。' : '发布后会出现在所有用户的消息通知中，并进入历史记录。', submit: editing ? '保存公告' : '创建公告', fields: [{ name: 'title', label: '公告标题', type: 'text', value: announcement?.title || '', maxLength: 120, placeholder: '例如：视频模型维护通知', required: true }, { name: 'content', label: '公告内容', type: 'textarea', value: announcement?.content || '', maxLength: 10000, placeholder: '输入用户需要了解的内容，支持换行。', required: true, help: '最多 10,000 个字符，按纯文本展示。' }, { name: 'status', label: '发布状态', type: 'select', value: announcement?.status || 'draft', options: [{ value: 'draft', label: '草稿（用户不可见）' }, { value: 'published', label: '已发布（用户可见）' }, { value: 'archived', label: '已归档（用户不可见）' }] }], onSubmit: async values => { const body = { title: values.title, content: values.content, status: values.status }; if (editing) await api(`/api/admin/announcements/${encodeURIComponent(announcement.id)}`, { method: 'PATCH', body: JSON.stringify({ ...body, expectedVersion: announcement.version }) }); else await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify(body) }); toast(editing ? '公告已更新' : `公告已创建${values.status === 'published' ? '并发布' : ''}`); await fetchAnnouncements(); } });
  }

  async function loadAnnouncements() {
    const root = $('#view-announcements');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Communication</div><h2 id="announcementsTitle">消息通知</h2><p class="subtitle">编辑公告、管理发布状态，用户端会在头像菜单中看到已发布内容。</p></div><div class="view-heading-actions"><button class="primary announcement-add" id="addAnnouncement" type="button">新增公告</button></div></div><div class="panel"><div class="panel-head"><div><h3>公告历史</h3><p class="detail">草稿和已归档内容仅管理员可见，已发布内容会计入用户历史消息。</p></div></div><div id="announcementTable">${loadingMarkup('正在加载公告…')}</div></div>`;
    $('#addAnnouncement').onclick = () => editAnnouncement();
    await fetchAnnouncements();
  }

  async function fetchAnnouncements() {
    const table = $('#announcementTable'); if (!table) return;
    table.innerHTML = loadingMarkup('正在加载公告…');
    try {
      const data = await api('/api/admin/announcements'); const items = data.items || [];
      table.innerHTML = items.length ? `<div class="table-wrap"><table aria-label="公告列表"><thead><tr><th>公告</th><th>状态</th><th>发布时间</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><b>${esc(item.title)}</b><div class="announcement-preview">${esc(item.content)}</div></td><td>${badge(item.status, announcementStatusKind(item.status))}</td><td>${date(item.publishedAt)}</td><td>${date(item.updatedAt)}</td><td><button class="small-button" data-edit-announcement="${esc(item.id)}" type="button">编辑</button></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>共 ${money(items.length)} 条公告</span></div>` : emptyMarkup('暂无公告', '点击右上角新增一条消息。');
      table.querySelectorAll('[data-edit-announcement]').forEach(button => button.onclick = () => editAnnouncement(items.find(item => item.id === button.dataset.editAnnouncement)));
    } catch (error) { table.innerHTML = errorMarkup(error.message, 'announcements'); table.querySelector('[data-retry="announcements"]')?.addEventListener('click', fetchAnnouncements); }
  }

  function logDetails(item, category) {
    if (category === 'audit') return JSON.stringify(item.after || item.before || item.metadata || {});
    if (category === 'system') return item.message || JSON.stringify(item.details || {});
    if (category === 'credits') return item.note || item.reasonCode || JSON.stringify(item.details || {});
    return JSON.stringify(item.details || {});
  }
  function renderLogRows(category, items) {
    if (category === 'generations') return `<table aria-label="生成任务日志"><thead><tr><th>时间</th><th>任务</th><th>状态</th><th>用户</th><th>模型</th><th>成本</th><th>详情</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td>${esc(item.id)}</td><td>${badge(item.status)}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.modelId || '—')}</td><td>${item.creditCost === null ? '—' : money(item.creditCost)}</td><td class="log-json" title="${esc(logDetails(item, category))}">${esc(logDetails(item, category))}</td></tr>`).join('')}</tbody></table>`;
    if (category === 'credits') return `<table aria-label="积分流水日志"><thead><tr><th>时间</th><th>流水</th><th>类型</th><th>用户</th><th>变动</th><th>余额</th><th>备注</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td>${esc(item.id)}</td><td>${esc(item.type || item.reasonCode || '—')}</td><td>${esc(item.userId || '—')}</td><td class="${Number(item.amount) < 0 ? 'danger-text' : 'accent-text'}">${Number(item.amount) >= 0 ? '+' : ''}${money(item.amount)}</td><td>${money(item.balanceAfter)}</td><td class="log-json">${esc(logDetails(item, category))}</td></tr>`).join('')}</tbody></table>`;
    if (category === 'llm') return `<table aria-label="LLM 用量日志"><thead><tr><th>时间</th><th>请求</th><th>状态</th><th>用户</th><th>模型</th><th>Tokens</th><th>计费</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td>${esc(item.id)}</td><td>${badge(item.status)}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.modelId || '—')}</td><td>${money((item.inputTokens || 0) + (item.outputTokens || 0))}</td><td>${item.charged === null ? '—' : money(item.charged)}</td></tr>`).join('')}</tbody></table>`;
    if (category === 'audit') return `<table aria-label="管理员审计日志"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>管理员</th><th>状态</th><th>详情</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td><b>${esc(item.action)}</b></td><td>${esc(item.targetType || '—')}<div class="detail">${esc(item.targetId || '—')}</div></td><td>${esc(item.actorUserId || '—')}</td><td>${badge(item.status)}</td><td class="log-json" title="${esc(logDetails(item, category))}">${esc(logDetails(item, category))}</td></tr>`).join('')}</tbody></table>`;
    return `<table aria-label="系统异常日志"><thead><tr><th>时间</th><th>级别</th><th>分类</th><th>用户</th><th>模型</th><th>消息</th><th>详情</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td>${badge(item.level, item.level === 'error' || item.level === 'critical' ? 'bad' : 'warn')}</td><td>${esc(item.category || '—')}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.modelId || '—')}</td><td>${esc(item.message || '—')}</td><td class="log-json">${esc(logDetails(item, category))}</td></tr>`).join('')}</tbody></table>`;
  }

  async function loadLogs() {
    const root = $('#view-logs');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Observability</div><h2 id="logsTitle">日志中心</h2><p class="subtitle">按日志类型、用户、模型、状态和时间范围定位运营记录</p></div></div><div class="panel"><form id="logFilters" class="toolbar"><label class="control">日志类型<select id="logCategory"><option value="generations" ${state.logCategory === 'generations' ? 'selected' : ''}>生成任务</option><option value="credits" ${state.logCategory === 'credits' ? 'selected' : ''}>积分流水</option><option value="llm" ${state.logCategory === 'llm' ? 'selected' : ''}>LLM 用量</option><option value="audit" ${state.logCategory === 'audit' ? 'selected' : ''}>管理员审计</option><option value="system" ${state.logCategory === 'system' ? 'selected' : ''}>系统异常</option></select></label><label class="control">用户 ID<input id="logUserId" autocomplete="off"></label><label class="control">模型 ID<input id="logModelId" autocomplete="off"></label><label class="control">状态 / 级别 / 操作<input id="logStatus" placeholder="可选"></label><label class="control">开始时间<input id="logFrom" type="datetime-local"></label><label class="control">结束时间<input id="logTo" type="datetime-local"></label><button class="small-button" type="submit">查询日志</button></form><div id="logTable">${loadingMarkup('正在加载日志…')}</div></div>`;
    $('#logFilters').onsubmit = event => { event.preventDefault(); state.logCategory = $('#logCategory').value; resetPager('log'); fetchLogs(); };
    $('#logCategory').onchange = () => { state.logCategory = $('#logCategory').value; resetPager('log'); fetchLogs(); };
    await fetchLogs();
  }

  async function fetchLogs() {
    const table = $('#logTable'); if (!table) return;
    const category = state.logCategory;
    const params = new URLSearchParams({ limit: '50' });
    if (currentCursor('log')) params.set('cursor', currentCursor('log'));
    if ($('#logUserId')?.value.trim()) params.set('userId', $('#logUserId').value.trim());
    if ($('#logModelId')?.value.trim()) params.set('modelId', $('#logModelId').value.trim());
    const filter = $('#logStatus')?.value.trim();
    if (filter) params.set(category === 'system' ? 'level' : category === 'audit' ? 'action' : category === 'credits' ? 'type' : 'status', filter);
    if ($('#logFrom')?.value) params.set('from', new Date($('#logFrom').value).toISOString());
    if ($('#logTo')?.value) params.set('to', new Date($('#logTo').value).toISOString());
    table.innerHTML = loadingMarkup(`正在加载${logLabels[category]}…`);
    try {
      const data = await api(`/api/admin/logs/${category}?${params}`); const items = data.items || [];
      table.innerHTML = items.length ? `<div class="table-wrap">${renderLogRows(category, items)}</div>${pageControls('log', data.total, data.nextCursor, items.length)}` : emptyMarkup('暂无日志', '尝试放宽筛选条件或调整时间范围。');
      bindPageControls('log', fetchLogs, data.nextCursor);
    } catch (error) { table.innerHTML = errorMarkup(error.message, 'logs'); table.querySelector('[data-retry="logs"]')?.addEventListener('click', fetchLogs); }
  }

  async function login(event) {
    event.preventDefault();
    const errorEl = $('#loginError'); const button = event.currentTarget.querySelector('button[type="submit"]');
    errorEl.textContent = ''; setButtonBusy(button, true, '登录中…');
    try {
      const result = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#loginUsername').value, password: $('#loginPassword').value }) });
      state.csrf = result.csrfToken; state.admin = result.admin; $('#adminName').textContent = result.admin.username; $('#adminLogin').classList.add('hidden'); $('#adminApp').classList.remove('hidden'); showView('overview');
    } catch (error) { errorEl.textContent = error.message; setButtonBusy(button, false); }
  }

  $('#loginForm').addEventListener('submit', login);
  $('#logoutButton').addEventListener('click', async event => { const button = event.currentTarget; setButtonBusy(button, true, '退出中…'); try { await api('/api/admin/auth/logout', { method: 'POST', body: '{}' }); } finally { location.reload(); } });
  document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  api('/api/admin/auth/session', { skipAuthRedirect: true }).then(result => { state.csrf = result.csrfToken; state.admin = result.admin; $('#adminName').textContent = result.admin.username; $('#adminLogin').classList.add('hidden'); $('#adminApp').classList.remove('hidden'); showView('overview'); }).catch(() => {});
})();
