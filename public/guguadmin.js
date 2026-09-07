import { createApiClient } from './api-client.js?v=3';

(() => {
  const $ = selector => document.querySelector(selector);
  const state = {
    csrf: '',
    admin: null,
    view: '',
    usersCursors: [''],
    ordersCursors: [''],
    invitesCursors: [''],
    logCursors: [''],
    logCategory: 'generations',
    modelItems: [],
    routeData: null,
  };
  const { request: requestApi } = createApiClient({ scopeHeaders: () => state.csrf ? { 'X-CSRF-Token': state.csrf } : {}, responseShapeFor: () => 'object' });
  const routeModelLabels = {
    'seedance-2.0': 'Seedance 2.0 · 兼容线路',
    'seedance-2.0-text': 'Seedance 2.0 · 文生视频',
    'seedance-2.0-img': 'Seedance 2.0 · 图生视频',
    'seedance-2.0-fast': 'Seedance 2.0 Fast',
    'seedance-2.5': 'Seedance 2.5',
  };
  const logLabels = { generations: '生成任务', credits: '积分流水', llm: 'LLM 用量', audit: '管理员审计', system: '系统异常', client: '客户端日志' };
  const taskFilterCategories = new Set(['generations', 'credits', 'system']);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const money = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  const perSecondPrice = (value, seconds) => {
    const amount = Number(value);
    const duration = Number(seconds);
    return Number.isFinite(amount) && Number.isFinite(duration) && duration > 0 ? `¥${money(amount / duration)} / 秒 · 按 ${money(duration)} 秒换算` : '—';
  };
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }) : '—';
  const dateInput = value => value ? new Date(value).toISOString().slice(0, 16) : '';
  const status = value => ({ active: '正常', disabled: '已禁用', completed: '完成', failed: '失败', queued: '排队', running: '运行中', exhausted: '已用尽', expired: '已过期', enabled: '启用', available: '可用', missing: '目录缺失', unknown: '待检查', probe_error: '检查异常', credential_error: '密钥异常', draft: '草稿', published: '已发布', archived: '已归档', error: '错误', warning: '警告', info: '信息', success: '成功', PAID: '已支付', PARTIALLY_REFUNDED: '部分退款', REFUNDED: '已退款' }[value] || value || '—');
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
    dialog.querySelectorAll('input,select,textarea,button[data-rich-command],button[data-rich-image],#adminDialogClose,#adminDialogCancel').forEach(control => { control.disabled = busy; });
    dialog.querySelectorAll('[contenteditable]').forEach(editor => { editor.contentEditable = busy ? 'false' : 'true'; });
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
    return Object.fromEntries([...$('#adminDialogForm').querySelectorAll('[data-admin-dialog-field]')].map(field => [field.dataset.adminDialogField, field.type === 'checkbox' ? field.checked : field.isContentEditable ? field.innerHTML : field.value]));
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
    try {
      return await requestApi(path, { ...requestOptions, timeoutMs:timeout });
    } catch (error) {
      if (error.status === 401 && !skipAuthRedirect && path !== '/api/admin/auth/login') showLogin('管理员会话已过期，请重新登录。');
      throw error;
    }
  }

  const loaders = { overview: loadOverview, users: loadUsers, orders: loadOrders, models: loadModels, credentials: loadCredentials, invites: loadInvites, announcements: loadAnnouncements, logs: loadLogs };
  function showView(name) {
    if (!loaders[name]) return;
    if (state.view === name) return;
    if (state.view !== name) {
      if (name === 'users') resetPager('users');
      if (name === 'orders') resetPager('orders');
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

  const yuan = value => Number(value || 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function loadOrders() {
    const root = $('#view-orders');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Payments</div><h2 id="ordersTitle">付费订单</h2><p class="subtitle">查看支付成功的用户、金额、支付时间与订单号</p></div><div class="view-heading-actions"><button class="small-button" data-refresh="orders" type="button">刷新数据</button></div></div><div class="panel"><form id="orderFilters" class="toolbar"><label class="control">搜索<input id="orderQuery" placeholder="用户名、用户 ID 或订单号" autocomplete="off"></label><label class="control">支付开始时间<input id="orderFrom" type="datetime-local"></label><label class="control">支付结束时间<input id="orderTo" type="datetime-local"></label><button class="small-button" type="submit">查询订单</button></form><div id="orderTable">${loadingMarkup('正在加载付费订单…')}</div></div>`;
    $('#orderFilters').onsubmit = event => { event.preventDefault(); resetPager('orders'); fetchOrders(); };
    root.querySelector('[data-refresh="orders"]').onclick = () => { resetPager('orders'); fetchOrders(); };
    await fetchOrders();
  }

  async function fetchOrders() {
    const table = $('#orderTable'); if (!table) return;
    const params = new URLSearchParams({ limit: '50' });
    if ($('#orderQuery')?.value.trim()) params.set('query', $('#orderQuery').value.trim());
    if ($('#orderFrom')?.value) params.set('from', new Date($('#orderFrom').value).toISOString());
    if ($('#orderTo')?.value) params.set('to', new Date($('#orderTo').value).toISOString());
    if (currentCursor('orders')) params.set('cursor', currentCursor('orders'));
    table.innerHTML = loadingMarkup('正在加载付费订单…');
    try {
      const data = await api(`/api/admin/payment-orders?${params}`);
      const items = data.items || [];
      const summary = data.summary || {};
      const summaryMarkup = `<div class="cards order-summary"><div class="stat"><small>成功订单</small><strong>${money(data.total)}</strong><span class="muted">付费用户 ${money(summary.payingUsers)} 人</span></div><div class="stat"><small>支付总额</small><strong>${yuan(summary.totalAmount)}</strong><span class="muted">订单原始支付金额</span></div><div class="stat"><small>退款金额</small><strong>${yuan(summary.refundedAmount)}</strong><span class="muted">含部分与全额退款</span></div><div class="stat"><small>净收款</small><strong>${yuan(summary.netAmount)}</strong><span class="muted">支付总额扣除退款</span></div></div>`;
      table.innerHTML = summaryMarkup + (items.length ? `<div class="table-wrap"><table class="payment-table" aria-label="付费订单列表"><thead><tr><th>用户</th><th>支付金额</th><th>购买积分</th><th>支付状态</th><th>支付时间</th><th>商户订单号</th><th>支付宝交易号</th></tr></thead><tbody>${items.map(order => `<tr><td><b>${esc(order.username)}</b><div class="detail">${esc(order.userId)}</div></td><td><b>${yuan(order.amount)}</b>${order.refundedAmount ? `<div class="detail">已退 ${yuan(order.refundedAmount)} · 净额 ${yuan(order.netAmount)}</div>` : ''}</td><td>${money(order.credits)}</td><td>${badge(order.status, order.status === 'PAID' ? 'ok' : 'warn')}</td><td>${date(order.paidAt)}</td><td><span class="order-number">${esc(order.orderNo)}</span></td><td><span class="order-number">${esc(order.tradeNo || '—')}</span></td></tr>`).join('')}</tbody></table></div>${pageControls('orders', data.total, data.nextCursor, items.length)}` : emptyMarkup('暂无成功支付订单', '尝试修改搜索条件或支付时间范围。'));
      bindPageControls('orders', fetchOrders, data.nextCursor);
    } catch (error) { table.innerHTML = errorMarkup(error.message, 'orders'); table.querySelector('[data-retry="orders"]')?.addEventListener('click', fetchOrders); }
  }

  function credentialDialogFields(credential = null) {
    return [
      { name: 'channelName', label: '渠道名称', type: 'text', value: credential?.channelName || '', placeholder: '例如 WJ', required: true, maxLength: 100, help: '同一渠道可以添加多个不同权限的 Key。' },
      { name: 'label', label: 'Key 名称', type: 'text', value: credential?.label || '', placeholder: '例如 Seedance 2.5 专用 Key', required: true, maxLength: 100 },
      { name: 'provider', label: 'Provider 标识', type: 'text', value: credential?.provider || 'wj', placeholder: '例如 wj', required: true, maxLength: 80 },
      { name: 'adapterType', label: '接口适配类型', type: 'select', value: credential?.adapterType || 'wj-video', options: [{ value: 'wj-video', label: 'WJ 视频协议' }, { value: 'diw-video', label: 'DIW 视频协议' }, { value: 'cntcn-video', label: 'CNTCN 视频协议' }], required: true },
      { name: 'baseUrl', label: 'API Base URL', type: 'url', value: credential?.baseUrl || '', placeholder: 'https://example.com', required: true, maxLength: 500 },
      { name: 'apiKey', label: credential ? '更换 API Key（留空保持不变）' : 'API Key', type: 'password', value: '', placeholder: credential ? '留空保持当前 Key' : '请输入 API Key', required: !credential, maxLength: 2000 },
      { name: 'enabled', type: 'checkbox', label: '启用该 Key', checked: credential ? credential.enabled : true, help: '停用后绑定该 Key 的线路不会参与自动或手动选路。' },
    ];
  }

  function validateCredentialDialog(input, editing = false) {
    const required = ['channelName', 'label', 'provider', 'adapterType', 'baseUrl'].every(name => String(input[name] || '').trim());
    let validUrl = false;
    try { validUrl = ['http:', 'https:'].includes(new URL(input.baseUrl).protocol); } catch {}
    if (!required || !validUrl || (!editing && !String(input.apiKey || '').trim())) return '请完整填写渠道、Key 名称、适配类型、URL 和 API Key。';
    return null;
  }

  async function editCredential(credential) {
    await showAdminDialog({ kicker: '渠道 Key', title: `编辑 ${credential.channelName} · ${credential.label}`, description: 'API Key 只写入服务端并以加密形式保存，页面不会回显明文。', submit: '保存 Key', fields: credentialDialogFields(credential), validate: values => validateCredentialDialog(values, true), onSubmit: async values => { await api(`/api/admin/model-route-credentials/${encodeURIComponent(credential.id)}`, { method: 'PATCH', body: JSON.stringify({ ...values, expectedVersion: credential.version }) }); toast('渠道 Key 已更新'); await loadCredentials(); await loadModels(); } });
  }

  async function addCredential() {
    await showAdminDialog({ kicker: '新增渠道 Key', title: '添加渠道凭证', description: '同一渠道可以添加多个权限不同的 Key；保存后可在模型线路中选择具体 Key。', submit: '添加 Key', fields: credentialDialogFields(), validate: values => validateCredentialDialog(values, false), onSubmit: async values => { await api('/api/admin/model-route-credentials', { method: 'POST', body: JSON.stringify(values) }); toast('渠道 Key 已添加'); await loadCredentials(); } });
  }

  async function checkCredential(id) {
    const button = document.querySelector(`[data-check-credential="${CSS.escape(id)}"]`);
    setButtonBusy(button, true, '检查中…');
    try {
      const result = await api('/api/admin/model-route-credentials/check', { method: 'POST', body: JSON.stringify({ credentialId: id }) });
      mergeCheckedRoutes(result.items, result.prices);
      setButtonBusy(button, false);
      toast(`已检查 ${result.items?.length || 0} 条线路`);
    }
    catch (error) { toast(error.message); setButtonBusy(button, false); }
  }

  async function loadCredentials() {
    const root = $('#view-credentials');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Credentials</div><h2 id="credentialsTitle">渠道与 Key</h2><p class="subtitle">管理上游渠道和不同权限的 API Key；每个 Key 独立检查模型目录</p></div><div class="view-heading-actions"><button class="primary" id="addCredential" type="button">新增渠道 Key</button></div></div><div class="panel">${loadingMarkup('正在读取渠道 Key…')}</div>`;
    try {
      const data = await api('/api/admin/model-route-credentials');
      const items = data.items || [];
      root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Credentials</div><h2 id="credentialsTitle">渠道与 Key</h2><p class="subtitle">同一个 WJ 渠道可以维护多个模型权限不同的 Key</p></div><div class="view-heading-actions"><button class="primary" id="addCredential" type="button">新增渠道 Key</button></div></div><div class="panel"><div class="panel-head"><div><h3>渠道凭证</h3><p class="detail">Key 仅显示掩码；停用凭证后关联线路会自动跳过。</p></div></div>${items.length ? `<div class="table-wrap"><table aria-label="渠道 Key 列表"><thead><tr><th>渠道</th><th>Key</th><th>接口</th><th>API Base URL</th><th>状态</th><th>线路数</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><b>${esc(item.channelName)}</b><div class="detail">${esc(item.provider)}</div></td><td><b>${esc(item.label)}</b><div class="detail">${esc(item.keyHint || (item.configured ? '已配置' : '未配置'))}</div></td><td>${esc(item.adapterType)}</td><td class="detail">${esc(item.baseUrl)}</td><td>${item.enabled ? badge(item.configured ? 'configured' : 'credential_error', item.configured ? 'ok' : 'bad') : badge('disabled')}</td><td>${money(item.routeCount)}</td><td class="actions"><button class="small-button" data-edit-credential="${esc(item.id)}" type="button">编辑</button><button class="small-button" data-check-credential="${esc(item.id)}" type="button">检查模型</button></td></tr>`).join('')}</tbody></table></div>` : emptyMarkup('暂无渠道 Key', '添加第一个渠道凭证后，就可以在模型线路中选择它。')}</div>`;
      $('#addCredential').onclick = addCredential;
      root.querySelectorAll('[data-edit-credential]').forEach(button => button.onclick = () => editCredential(items.find(item => item.id === button.dataset.editCredential)));
      root.querySelectorAll('[data-check-credential]').forEach(button => button.onclick = () => checkCredential(button.dataset.checkCredential));
    } catch (error) { root.innerHTML = `${errorMarkup(error.message, 'credentials')}`; root.querySelector('[data-retry="credentials"]')?.addEventListener('click', loadCredentials); }
  }

  function userDetailHtml(user) {
    const credits = (user.recentCredits || []).slice(0, 6).map(entry => `<div class="user-recent-item"><span>${esc(entry.note || entry.reasonCode || entry.type || '积分流水')}</span><span>${entry.amount !== undefined ? `${Number(entry.amount) >= 0 ? '+' : ''}${money(entry.amount)}` : date(entry.createdAt || entry.created_at)}</span></div>`).join('');
    const generations = (user.recentGenerations || []).slice(0, 6).map(item => `<div class="user-recent-item"><span>${esc(item.modelId || item.type || item.id)} · ${badge(item.status)}</span><span>${date(item.createdAt)}</span></div>`).join('');
    const username = String(user.username || 'U');
    return `<div class="user-detail-identity"><div class="user-avatar" aria-hidden="true">${esc(username.slice(0, 1).toUpperCase())}</div><div class="user-detail-identity-main"><strong>${esc(username)}</strong><span class="user-detail-status">${badge(user.status)}<em>注册于 ${date(user.createdAt)}</em></span></div><div class="user-detail-identity-meta"><small>邀请码</small><b>${esc(user.inviteCode || '—')}</b></div></div><div class="user-detail-grid"><div class="user-detail-metric"><small>当前余额</small><strong>${money(user.credits)}</strong></div><div class="user-detail-metric"><small>可用余额</small><strong>${money(user.available)}</strong></div><div class="user-detail-metric"><small>累计消耗</small><strong>${money(user.totalSpent)}</strong></div><div class="user-detail-metric"><small>冻结积分</small><strong>${money(user.held)}</strong></div><div class="user-detail-metric"><small>生成任务</small><strong>${money(user.generations)}</strong></div><div class="user-detail-metric"><small>积分流水</small><strong>${money(user.creditEntries)}</strong></div><div class="user-detail-metric"><small>LLM 用量</small><strong>${money(user.llmUsage)}</strong></div><div class="user-detail-metric"><small>邀请码</small><strong>${esc(user.inviteCode || '—')}</strong></div></div><div class="user-recent"><h3>最近生成记录</h3><div class="user-recent-list">${generations || emptyMarkup('暂无生成记录')}</div></div><div class="user-recent"><h3>最近积分流水</h3><div class="user-recent-list">${credits || emptyMarkup('暂无积分流水')}</div></div>`;
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

  function routeIdsForModel(modelId, routeData = state.routeData) {
    const legacySeedanceIds = new Set(['seedance-2.0', 'seedance-2.0-text', 'seedance-2.0-img']);
    return (routeData?.items || [])
      .filter(route => route.logicalModelId === modelId || (modelId === 'seedance-2.0' && legacySeedanceIds.has(route.logicalModelId)))
      .map(route => route.id);
  }

  function modelCheckStatus(modelId, routeData = state.routeData) {
    const routes = (routeData?.items || []).filter(route => routeIdsForModel(modelId, routeData).includes(route.id));
    if (!routes.length) return { value: 'unknown', label: '暂无线路', kind: 'muted' };
    const bad = routes.find(route => ['missing', 'credential_error', 'probe_error'].includes(route.catalogStatus));
    if (bad) return { value: bad.catalogStatus, label: status(bad.catalogStatus), kind: 'bad' };
    if (routes.every(route => route.catalogStatus === 'available')) return { value: 'available', label: '全部可用', kind: 'ok' };
    return { value: 'unknown', label: '待检查', kind: 'warn' };
  }

  function modelCheckMarkup(model, routeData = state.routeData) {
    const result = modelCheckStatus(model.modelId, routeData);
    return result.kind === 'muted' ? `<span class="detail">${result.label}</span>` : badge(result.value, result.kind);
  }

  function renderModelPanel(modelItems = state.modelItems, routeData = state.routeData) {
    const root = $('#modelPanel');
    if (!root) return;
    root.innerHTML = `<div class="panel-head"><div><h3>模型控制</h3><p class="detail">用户可见控制前端展示，接单状态控制服务端是否接受新任务；检查线路只更新当前模型状态。</p></div></div>${modelItems.length ? `<div class="table-wrap"><table aria-label="模型控制列表"><thead><tr><th>模型</th><th>类型</th><th>用户可见</th><th>接受新任务</th><th>线路检查</th><th>排序</th><th>操作</th></tr></thead><tbody>${modelItems.map(model => { const routeIds = routeIdsForModel(model.modelId, routeData); return `<tr><td><b>${esc(model.modelId)}</b></td><td>${esc(model.kind)}</td><td>${model.userVisible ? badge('active') : badge('disabled')}</td><td>${model.enabled ? badge('active') : badge('disabled')}</td><td>${modelCheckMarkup(model, routeData)}</td><td>${money(model.sortOrder)}</td><td class="actions"><button class="small-button" data-model="${esc(model.modelId)}" type="button">编辑</button>${routeIds.length ? `<button class="small-button" data-check-model="${esc(model.modelId)}" type="button">检查线路</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : emptyMarkup('暂无模型配置')}`;
    root.querySelectorAll('[data-model]').forEach(button => button.onclick = () => editModel(modelItems.find(item => item.modelId === button.dataset.model)));
    root.querySelectorAll('[data-check-model]').forEach(button => button.onclick = () => checkRoutes(routeIdsForModel(button.dataset.checkModel, routeData), button));
  }

  function mergeCheckedRoutes(items = [], prices = null) {
    if (!state.routeData || !Array.isArray(items)) return;
    const updates = new Map(items.map(item => [item.id, item]));
    state.routeData = {
      ...state.routeData,
      items: state.routeData.items.map(item => updates.get(item.id) || item),
      prices: prices || state.routeData.prices,
    };
    renderRoutePanel(state.routeData);
    renderModelPanel(state.modelItems, state.routeData);
  }

  async function loadModels() {
    const root = $('#view-models');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Models</div><h2 id="modelsTitle">模型与价格</h2><p class="subtitle">管理用户展示、接单状态、调用线路和平台价格</p></div><div class="view-heading-actions"><button class="small-button" data-refresh="models" type="button">刷新全部</button></div></div><div id="routePanel" class="panel">${loadingMarkup('正在读取模型线路…')}</div><div id="modelPanel" class="panel">${loadingMarkup('正在读取模型配置…')}</div><div id="pricingPanel" class="panel">${loadingMarkup('正在读取价格版本…')}</div>`;
    root.querySelector('[data-refresh="models"]').onclick = loadModels;
    try {
      const [models, pricing, routes] = await Promise.all([api('/api/admin/models'), api('/api/admin/pricing'), api('/api/admin/model-routes')]);
      const modelItems = models.items || [];
      state.modelItems = modelItems;
      state.routeData = routes;
      renderRoutePanel(routes);
      renderModelPanel(modelItems, routes);
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
    const seedance20Pools = ['seedance-2.0-text', 'seedance-2.0-img'];
    const configuredGroups = items.map(item => `${item.logicalModelId}:${item.quality}`);
    const emptyPoolGroups = seedance20Pools.flatMap(modelId => ['480p', '720p'].map(quality => `${modelId}:${quality}`));
    const groups = [...new Set([...emptyPoolGroups, ...configuredGroups])];
    root.innerHTML = `<div class="panel-head"><div><h3>Seedance 调用线路</h3><p class="detail">状态来自渠道目录，每 10 分钟自动检查；自动模式按优先级选择可用线路。</p></div><button class="small-button" id="checkAllRoutes" type="button">立即检查全部</button></div>${groups.length ? `<div class="route-groups">${groups.map(key => {
      const [modelId, quality] = key.split(':');
      const routes = items.filter(item => item.logicalModelId === modelId && item.quality === quality);
      const policy = (data.policies || []).find(item => item.logicalModelId === modelId && item.quality === quality);
      const publicPriceModelId = modelId === 'seedance-2.0-text' || modelId === 'seedance-2.0-img' ? 'seedance-2.0' : modelId;
      const price = (data.prices || []).find(item => item.modelId === publicPriceModelId && item.quality === quality);
      const label = routeModelLabels[modelId] || modelId;
      return `<section class="route-group"><header><div><h4>${esc(label)} · ${esc(quality)}</h4><span>${price?.available ? `当前 ¥${Number(price.yuan).toFixed(2)} / ${money(price.credits)} 积分` : '当前无可用线路'}</span>${modelId === 'seedance-2.0-fast' ? '<p class="detail">固定 15 秒 · 9 图 / 3 视频 / 3 音频</p>' : modelId === 'seedance-2.0-text' ? '<p class="detail">无图片时自动进入此线路池</p>' : modelId === 'seedance-2.0-img' ? '<p class="detail">上传 1～9 张图片时自动进入此线路池</p>' : ''}</div><div class="route-header-actions"><button class="route-add-button" data-add-route="${esc(key)}" type="button">新增模型</button><label>选择策略<select data-route-policy="${esc(key)}" data-version="${policy?.version || 1}"><option value="">自动按优先级</option>${routes.map(route => `<option value="${esc(route.id)}" ${policy?.forcedRouteId === route.id ? 'selected' : ''}>手动 · ${esc(route.displayName)}</option>`).join('')}</select></label></div></header><div class="table-wrap"><table class="route-table" aria-label="${esc(label)} ${esc(quality)} 调用线路"><thead><tr><th>优先级</th><th>线路 / 上游模型 ID</th><th>状态</th><th>成本</th><th>用户价</th><th>检查时间</th><th>操作</th></tr></thead><tbody>${routes.map(route => `<tr class="${(policy?.forcedRouteId === route.id || (modelId !== 'seedance-2.0-text' && modelId !== 'seedance-2.0-img' && price?.selectedRouteId === route.id)) ? 'is-selected' : ''}"><td><b>${route.priority}</b></td><td><b>${esc(route.displayName)}</b><div class="detail">${esc(route.upstreamModelId)}</div></td><td>${routeStatusBadge(route)}${route.catalogMessage ? `<div class="route-message" title="${esc(route.catalogMessage)}">${esc(route.catalogMessage)}</div>` : ''}</td><td><b>¥${Number(route.costYuan).toFixed(2)}</b><div class="detail">${perSecondPrice(route.costYuan, route.durationSeconds)}</div></td><td><b>¥${Number(route.salePriceYuan).toFixed(2)}</b><div class="detail">${perSecondPrice(route.salePriceYuan, route.durationSeconds)}${route.salePriceConfigured ? '' : ' · 自动价'}</div></td><td>${date(route.catalogCheckedAt)}</td><td class="actions"><button class="small-button" data-edit-route="${esc(route.id)}" type="button">编辑</button><button class="small-button" data-check-route="${esc(route.id)}" type="button">检查</button></td></tr>`).join('')}</tbody></table></div></section>`;
    }).join('')}</div>` : emptyMarkup('暂无调用线路', '请先新增渠道模型，平台才会有可用的上游线路。')}`;
    $('#checkAllRoutes')?.addEventListener('click', () => checkRoutes());
    root.querySelectorAll('[data-add-route]').forEach(button => button.onclick = () => { const [modelId, quality] = button.dataset.addRoute.split(':'); addModelRoute(modelId, quality, data); });
    root.querySelectorAll('[data-check-route]').forEach(button => button.onclick = () => checkRoutes([button.dataset.checkRoute]));
    root.querySelectorAll('[data-edit-route]').forEach(button => button.onclick = () => editRoute(items.find(item => item.id === button.dataset.editRoute), data.channels));
    root.querySelectorAll('[data-route-policy]').forEach(select => select.onchange = () => changeRoutePolicy(select));
  }

  async function checkRoutes(routeIds = null, sourceButton = null) {
    const button = sourceButton || (routeIds ? document.querySelector(`[data-check-route="${CSS.escape(routeIds[0])}"]`) : $('#checkAllRoutes'));
    setButtonBusy(button, true, '检查中…');
    try {
      const result = await api('/api/admin/model-routes/check', { method: 'POST', body: JSON.stringify(routeIds ? { routeIds } : {}) });
      mergeCheckedRoutes(result.items, result.prices);
      if (!state.routeData) setButtonBusy(button, false);
      toast(`模型目录检查完成 · 已更新 ${result.items?.length || 0} 条线路`);
    }
    catch (error) { toast(error.message); setButtonBusy(button, false); }
  }

  async function changeRoutePolicy(select) {
    const [logicalModelId, quality] = select.dataset.routePolicy.split(':');
    select.disabled = true;
    try {
      const result = await api('/api/admin/model-route-policy', { method: 'PATCH', body: JSON.stringify({ logicalModelId, quality, forcedRouteId: select.value, expectedVersion: Number(select.dataset.version) }) });
      if (state.routeData) {
        state.routeData = { ...state.routeData, policies: state.routeData.policies.map(policy => policy.logicalModelId === logicalModelId && policy.quality === quality ? result.policy : policy), prices: result.prices || state.routeData.prices };
        renderRoutePanel(state.routeData);
        renderModelPanel(state.modelItems, state.routeData);
      }
      toast(select.value ? '已切换为手动优先线路' : '已恢复自动优先级');
    }
    catch (error) { toast(error.message); select.disabled = false; }
  }

  function channelDialogOptions(channels, selected) { return (channels || []).map(channel => ({ value: channel.id, label: `${channel.label}${channel.envKey ? ` · ${channel.envKey}` : ''}${channel.configured ? '' : '（未配置）'}${channel.enabled === false ? '（已停用）' : ''}` })).filter(option => option.value).map(option => ({ ...option, selected: option.value === selected })); }
  function routeDialogFields({ route = null, channels = [], nextPriority = 1, logicalModelId = '' }) {
    const selectedChannel = route?.credentialId || channels.find(channel => channel.configured)?.id || channels[0]?.id || '';
    const selectedModelId = route?.logicalModelId || logicalModelId;
    const selectedInputMode = selectedModelId === 'seedance-2.0-img' || (selectedModelId === 'seedance-2.0' && Number(route?.capabilities?.minImage || 0) > 0) ? 'seedance-2.0-img' : 'seedance-2.0-text';
    const modelField = ['seedance-2.0', 'seedance-2.0-text', 'seedance-2.0-img'].includes(selectedModelId)
      ? [{ name: 'logicalModelId', label: '创作类型', type: 'select', value: selectedInputMode, options: [{ value: 'seedance-2.0-text', label: '文生视频（无图片）' }, { value: 'seedance-2.0-img', label: '图生视频（1～9 张图片）' }], required: true, help: '用户不上传图片时自动使用文生池，上传图片时自动使用图生池。' }]
      : [];
    return [...modelField,
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
    await showAdminDialog({ kicker: '新增调用线路', title: `新增 ${routeModelLabels[logicalModelId] || logicalModelId} · ${quality}`, description: '选择已有渠道，填写该渠道实际可调用的上游模型 ID 和本平台价格。新增线路会先标记为待检查。', submit: '新增模型', fields: routeDialogFields({ channels: data.channels, nextPriority, logicalModelId }), validate: validateRouteDialog, onSubmit: async values => { const result = await api('/api/admin/model-routes', { method: 'POST', body: JSON.stringify({ logicalModelId: values.logicalModelId || logicalModelId, quality, credentialId: values.credentialId, upstreamModelId: values.upstreamModelId.trim(), priority: Number(values.priority), costYuan: Number(values.costYuan), salePriceYuan: Number(values.salePriceYuan), adminEnabled: values.adminEnabled }) }); toast(`模型已新增：${result.route.displayName}`); await loadModels(); } });
  }
  async function editRoute(route, channels = []) {
    if (!route) return;
    await showAdminDialog({ kicker: '调用线路', title: `编辑 ${route.displayName}`, description: '可修改创作类型、渠道、上游模型 ID、价格、状态和优先级；修改创作类型、渠道或上游 ID 后需要重新检查目录。', submit: '保存线路', fields: routeDialogFields({ route, channels }), validate: validateRouteDialog, onSubmit: async values => { await api(`/api/admin/model-routes/${encodeURIComponent(route.id)}`, { method: 'PATCH', body: JSON.stringify({ ...(values.logicalModelId ? { logicalModelId: values.logicalModelId } : {}), credentialId: values.credentialId, upstreamModelId: values.upstreamModelId.trim(), adminEnabled: values.adminEnabled, priority: Number(values.priority), costYuan: Number(values.costYuan), salePriceYuan: Number(values.salePriceYuan), expectedVersion: route.version }) }); toast('线路配置已更新'); await loadModels(); } });
  }
  async function editModel(model) {
    if (!model) return;
    await showAdminDialog({ kicker: '模型控制', title: `编辑 ${model.modelId}`, description: '用户可见控制前端展示，接单状态控制服务端是否接受新任务。', submit: '保存模型配置', fields: [{ name: 'userVisible', type: 'checkbox', label: '用户可见', checked: model.userVisible, help: '关闭后不会出现在用户端模型列表。' }, { name: 'enabled', type: 'checkbox', label: '接受新任务', checked: model.enabled, help: '关闭后服务端会拒绝该模型的新生成请求。' }, { name: 'sortOrder', label: '排序值', type: 'number', value: String(model.sortOrder), min: 0, max: 100000, step: 1, inputmode: 'numeric', required: true, help: '请输入 0–100000 的整数，数字越小越靠前。' }], validate: values => { const order = Number(values.sortOrder); return Number.isSafeInteger(order) && order >= 0 && order <= 100000 ? null : '排序值必须是 0–100000 的整数。'; }, onSubmit: async values => { const result = await api(`/api/admin/models/${encodeURIComponent(model.modelId)}`, { method: 'PATCH', body: JSON.stringify({ userVisible: values.userVisible, enabled: values.enabled, sortOrder: Number(values.sortOrder), expectedVersion: model.version }) }); state.modelItems = state.modelItems.map(item => item.modelId === model.modelId ? { ...item, ...result.model } : item); renderModelPanel(state.modelItems, state.routeData); toast('模型配置已更新'); } });
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
  function richTextPlainText(html) {
    const node = document.createElement('div');
    node.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
    return String(node.textContent || '').replace(/\u00a0/g, ' ').trim();
  }
  function announcementEditorMarkup() {
    return `<div class="announcement-editor-field"><label class="admin-dialog-field" for="adminAnnouncementTitle"><span>公告标题</span><input id="adminAnnouncementTitle" data-admin-dialog-field="title" maxlength="120" placeholder="例如：视频模型维护通知" required autocomplete="off"><small>标题会显示在通知列表和弹窗顶部。</small></label><div class="admin-dialog-field announcement-rich-field"><span>公告内容</span><div class="announcement-editor" data-announcement-editor><div class="announcement-editor-toolbar" role="toolbar" aria-label="公告格式工具"><button type="button" data-rich-command="bold" title="加粗"><b>B</b></button><button type="button" data-rich-command="italic" title="斜体"><i>I</i></button><button type="button" data-rich-command="underline" title="下划线"><u>U</u></button><span class="announcement-editor-divider" aria-hidden="true"></span><button type="button" data-rich-command="insertUnorderedList" title="无序列表">•</button><button type="button" data-rich-command="insertOrderedList" title="有序列表">1.</button><button type="button" data-rich-command="formatBlock" data-rich-value="blockquote" title="引用">❝</button><button type="button" data-rich-command="removeFormat" title="清除格式">Tx</button><span class="announcement-editor-divider" aria-hidden="true"></span><button type="button" data-rich-image title="插入图片">▧ 图片</button><input data-rich-image-input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><div id="adminAnnouncementEditor" class="announcement-editor-input" data-admin-dialog-field="content" contenteditable="true" role="textbox" aria-multiline="true" aria-required="true" data-placeholder="输入通知内容，支持格式化和图片。"></div></div><div class="announcement-editor-meta"><small>支持加粗、斜体、下划线、列表、引用和图片；图片会自动压缩后插入。</small><small><b data-rich-count>0</b> / 500,000</small></div></div></div><label class="admin-dialog-field announcement-status-field" for="adminAnnouncementStatus"><span>发布状态</span><select id="adminAnnouncementStatus" data-admin-dialog-field="status"><option value="draft">草稿（用户不可见）</option><option value="published">已发布（用户可见）</option><option value="archived">已归档（用户不可见）</option></select></label></div>`;
  }
  function announcementPlainToHtml(value) {
    return esc(String(value || '')).replace(/\n/g, '<br>');
  }
  function rememberAnnouncementSelection(editor) {
    const selection = editor?.ownerDocument?.getSelection?.();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return;
    editor._announcementRange = selection.getRangeAt(0).cloneRange();
  }
  function restoreAnnouncementSelection(editor) {
    editor.focus({ preventScroll:true });
    const selection = editor.ownerDocument.getSelection();
    selection.removeAllRanges();
    if (editor._announcementRange && editor.contains(editor._announcementRange.commonAncestorContainer)) selection.addRange(editor._announcementRange);
    else { const range = editor.ownerDocument.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.addRange(range); }
  }
  function insertAnnouncementHtml(editor, html) {
    restoreAnnouncementSelection(editor);
    editor.ownerDocument.execCommand('insertHTML', false, html);
    rememberAnnouncementSelection(editor);
    editor.dispatchEvent(new Event('input', { bubbles:true }));
  }
  function readAnnouncementImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败，请重试'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('图片格式暂不支持'));
        image.onload = () => {
          const maxEdge = 1600;
          const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
          canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => {
            if (!blob) { resolve(String(reader.result)); return; }
            const compressed = new FileReader();
            compressed.onload = () => resolve(String(compressed.result));
            compressed.onerror = () => reject(new Error('图片压缩失败，请重试'));
            compressed.readAsDataURL(blob);
          }, 'image/webp', .82);
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }
  function bindAnnouncementEditor(initialContent = '') {
    const editor = $('#adminAnnouncementEditor');
    if (!editor) return;
    editor.innerHTML = /<\/?[a-z][^>]*>/i.test(String(initialContent || '')) ? String(initialContent) : announcementPlainToHtml(initialContent);
    const updateCount = () => { const counter = editor.closest('[data-announcement-editor]')?.querySelector('[data-rich-count]'); if (counter) counter.textContent = richTextPlainText(editor.innerHTML).length.toLocaleString('zh-CN'); };
    editor.addEventListener('keyup', () => rememberAnnouncementSelection(editor));
    editor.addEventListener('mouseup', () => rememberAnnouncementSelection(editor));
    editor.addEventListener('input', updateCount);
    editor.closest('[data-announcement-editor]')?.querySelectorAll('[data-rich-command]').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => { restoreAnnouncementSelection(editor); editor.ownerDocument.execCommand(button.dataset.richCommand, false, button.dataset.richValue || null); rememberAnnouncementSelection(editor); updateCount(); });
    });
    const imageInput = editor.closest('[data-announcement-editor]')?.querySelector('[data-rich-image-input]');
    editor.closest('[data-announcement-editor]')?.querySelector('[data-rich-image]')?.addEventListener('mousedown', event => event.preventDefault());
    editor.closest('[data-announcement-editor]')?.querySelector('[data-rich-image]')?.addEventListener('click', () => { rememberAnnouncementSelection(editor); imageInput?.click(); });
    imageInput?.addEventListener('change', async () => {
      const file = imageInput.files?.[0];
      imageInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
      try {
        const src = await readAnnouncementImage(file);
        if (src.length > 420_000) throw new Error('图片压缩后仍然过大，请选择尺寸更小的图片');
        insertAnnouncementHtml(editor, `<img src="${src}" alt="${esc(file.name.replace(/\.[^.]+$/, ''))}"><br>`);
        toast('图片已插入');
      } catch (error) { toast(error.message || '图片插入失败'); }
    });
    updateCount();
    rememberAnnouncementSelection(editor);
  }
  async function editAnnouncement(announcement = null) {
    const editing = Boolean(announcement);
    const dialog = showAdminDialog({ kicker: editing ? '消息通知' : '新建内容', title: editing ? '编辑公告' : '新增公告', description: editing ? '更新后会立即同步到用户端；已读状态会保留。发布时间精确到秒。' : '发布后会出现在所有用户的消息通知中，并进入历史记录。支持富文本和图片。', submit: editing ? '保存公告' : '创建公告', html: announcementEditorMarkup(), validate: values => values.title.trim() ? (richTextPlainText(values.content) ? null : '公告内容不能为空') : '公告标题不能为空', onSubmit: async values => { const body = { title: values.title, content: values.content, status: values.status }; if (editing) await api(`/api/admin/announcements/${encodeURIComponent(announcement.id)}`, { method: 'PATCH', body: JSON.stringify({ ...body, expectedVersion: announcement.version }) }); else await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify(body) }); toast(editing ? '公告已更新' : `公告已创建${values.status === 'published' ? '并发布' : ''}`); await fetchAnnouncements(); } });
    $('#adminAnnouncementTitle').value = announcement?.title || '';
    $('#adminAnnouncementStatus').value = announcement?.status || 'draft';
    bindAnnouncementEditor(announcement?.contentHtml || announcement?.content || '');
    await dialog;
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
      table.innerHTML = items.length ? `<div class="table-wrap"><table aria-label="公告列表"><thead><tr><th>公告</th><th>状态</th><th>发布时间（精确到秒）</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${items.map(item => `<tr><td><b>${esc(item.title)}</b><div class="announcement-preview">${esc(item.contentText || item.content)}</div></td><td>${badge(item.status, announcementStatusKind(item.status))}</td><td>${date(item.publishedAt)}</td><td>${date(item.updatedAt)}</td><td><button class="small-button" data-edit-announcement="${esc(item.id)}" type="button">编辑</button></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>共 ${money(items.length)} 条公告</span></div>` : emptyMarkup('暂无公告', '点击右上角新增一条消息。');
      table.querySelectorAll('[data-edit-announcement]').forEach(button => button.onclick = () => editAnnouncement(items.find(item => item.id === button.dataset.editAnnouncement)));
    } catch (error) { table.innerHTML = errorMarkup(error.message, 'announcements'); table.querySelector('[data-retry="announcements"]')?.addEventListener('click', fetchAnnouncements); }
  }

  function logDetailData(item, category) {
    const common = { id: item.id, createdAt: item.createdAt };
    if (category === 'generations') return { ...common, userId: item.userId, userNickname: item.userNickname, type: item.type, status: item.status, creditCost: item.creditCost, creditStatus: item.creditStatus, pricingVersion: item.pricingVersion, modelId: item.modelId, provider: item.provider, assetId: item.assetId, updatedAt: item.updatedAt, details: item.details };
    if (category === 'credits') return { ...common, userId: item.userId, userNickname: item.userNickname, actorUserId: item.actorUserId, type: item.type, reasonCode: item.reasonCode, note: item.note, amount: item.amount, balanceAfter: item.balanceAfter, generationId: item.generationId, requestId: item.requestId, details: item.details };
    if (category === 'llm') return { ...common, userId: item.userId, userNickname: item.userNickname, status: item.status, modelId: item.modelId, inputTokens: item.inputTokens, outputTokens: item.outputTokens, charged: item.charged, details: item.details };
    if (category === 'audit') return { ...common, actorUserId: item.actorUserId, actorNickname: item.actorNickname, action: item.action, targetType: item.targetType, targetId: item.targetId, requestId: item.requestId, status: item.status, before: item.before, after: item.after, metadata: item.metadata };
    return { ...common, level: item.level, category: item.category, requestId: item.requestId, userId: item.userId, userNickname: item.userNickname, modelId: item.modelId, generationId: item.generationId, message: item.message, details: item.details };
  }
  function compactLogDetailData(data) { return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== '')); }
  function stringifyLogDetails(value, pretty = false) {
    try { return JSON.stringify(value, null, pretty ? 2 : 0) || '暂无详情'; } catch { return String(value); }
  }
  function logDetails(item, category) {
    const data = logDetailData(item, category);
    if (category === 'system') return item.message || stringifyLogDetails(item.details || {});
    if (category === 'credits') return item.note || item.reasonCode || stringifyLogDetails(item.details || {});
    if (category === 'audit') return stringifyLogDetails(item.after || item.before || item.metadata || {});
    return stringifyLogDetails(data.details || {});
  }
  function logDetailMarkup(item, category, index, colspan) {
    const detailId = `log-detail-${category}-${index}`;
    const preview = logDetails(item, category);
    const fullDetails = stringifyLogDetails(compactLogDetailData(logDetailData(item, category)), true);
    return `<td class="log-details-cell"><button class="log-expand-button" data-log-expand type="button" aria-expanded="false" aria-controls="${detailId}"><span class="log-json" title="${esc(preview)}">${esc(preview)}</span><span class="log-expand-label">查看详情</span><svg class="log-expand-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></td></tr><tr id="${detailId}" class="log-detail-row" hidden><td colspan="${colspan}"><div class="log-detail-panel"><div class="log-detail-head"><strong>完整日志详情</strong><span>${date(item.createdAt)}</span></div><pre>${esc(fullDetails)}</pre></div></td></tr>`;
  }
  function logRowMarkup(item, category, index, cells, colspan) {
    return `<tr class="log-row">${cells}${logDetailMarkup(item, category, index, colspan)}`;
  }
  function renderLogRows(category, items) {
    if (category === 'generations') return `<table aria-label="生成任务日志"><thead><tr><th>时间</th><th>任务 ID</th><th>状态</th><th>用户 ID</th><th>用户昵称</th><th>模型</th><th>成本</th><th>详情</th></tr></thead><tbody>${items.map((item, index) => logRowMarkup(item, category, index, `<td>${date(item.createdAt)}</td><td>${esc(item.id)}</td><td>${badge(item.status)}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.userNickname || '—')}</td><td>${esc(item.modelId || '—')}</td><td>${item.creditCost === null ? '—' : money(item.creditCost)}</td>`, 8)).join('')}</tbody></table>`;
    if (category === 'credits') return `<table aria-label="积分流水日志"><thead><tr><th>时间</th><th>流水</th><th>任务 ID</th><th>类型</th><th>用户 ID</th><th>用户昵称</th><th>变动</th><th>余额</th><th>详情</th></tr></thead><tbody>${items.map((item, index) => logRowMarkup(item, category, index, `<td>${date(item.createdAt)}</td><td>${esc(item.id)}</td><td>${esc(item.generationId || '—')}</td><td>${esc(item.type || item.reasonCode || '—')}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.userNickname || '—')}</td><td class="${Number(item.amount) < 0 ? 'danger-text' : 'accent-text'}">${Number(item.amount) >= 0 ? '+' : ''}${money(item.amount)}</td><td>${money(item.balanceAfter)}</td>`, 9)).join('')}</tbody></table>`;
    if (category === 'llm') return `<table aria-label="LLM 用量日志"><thead><tr><th>时间</th><th>请求</th><th>状态</th><th>用户 ID</th><th>用户昵称</th><th>模型</th><th>Tokens</th><th>计费</th><th>详情</th></tr></thead><tbody>${items.map((item, index) => logRowMarkup(item, category, index, `<td>${date(item.createdAt)}</td><td>${esc(item.id)}</td><td>${badge(item.status)}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.userNickname || '—')}</td><td>${esc(item.modelId || '—')}</td><td>${money((item.inputTokens || 0) + (item.outputTokens || 0))}</td><td>${item.charged === null ? '—' : money(item.charged)}`, 9)).join('')}</tbody></table>`;
    if (category === 'audit') return `<table aria-label="管理员审计日志"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>管理员 ID</th><th>管理员昵称</th><th>状态</th><th>详情</th></tr></thead><tbody>${items.map((item, index) => logRowMarkup(item, category, index, `<td>${date(item.createdAt)}</td><td><b>${esc(item.action)}</b></td><td>${esc(item.targetType || '—')}<div class="detail">${esc(item.targetId || '—')}</div></td><td>${esc(item.actorUserId || '—')}</td><td>${esc(item.actorNickname || '—')}</td><td>${badge(item.status)}`, 7)).join('')}</tbody></table>`;
    // 客户端日志包存在对象存储里，这一列给的是后端签名跳转，点开即下载 .log.gz。
    if (category === 'client') return `<table aria-label="客户端诊断日志"><thead><tr><th>时间</th><th>编号</th><th>用户 ID</th><th>用户昵称</th><th>版本 / 平台</th><th>问题描述</th><th>日志包</th><th>详情</th></tr></thead><tbody>${items.map((item, index) => logRowMarkup(item, category, index, `<td>${date(item.createdAt)}</td><td>${esc(item.reference)}</td><td>${esc(item.userId || '—')}<div class="detail">${esc(item.username || '')}</div></td><td>${esc(item.userNickname || '—')}</td><td>${esc(item.appVersion || '—')}<div class="detail">${esc(item.platform || '—')}</div></td><td>${esc(item.note || '—')}<div class="detail">${money(Math.max(1, Math.round((item.size || 0) / 1024)))} KB</div></td><td>${item.downloadable ? `<a class="small-button" href="/api/admin/logs/client/${encodeURIComponent(item.id)}/download">下载</a>` : '—'}</td>`, 8)).join('')}</tbody></table>`;
    return `<table aria-label="系统异常日志"><thead><tr><th>时间</th><th>级别</th><th>分类</th><th>任务 ID</th><th>用户 ID</th><th>用户昵称</th><th>模型</th><th>消息</th><th>详情</th></tr></thead><tbody>${items.map((item, index) => logRowMarkup(item, category, index, `<td>${date(item.createdAt)}</td><td>${badge(item.level, item.level === 'error' || item.level === 'critical' ? 'bad' : 'warn')}</td><td>${esc(item.category || '—')}</td><td>${esc(item.generationId || '—')}</td><td>${esc(item.userId || '—')}</td><td>${esc(item.userNickname || '—')}</td><td>${esc(item.modelId || '—')}</td><td>${esc(item.message || '—')}`, 9)).join('')}</tbody></table>`;
  }
  function bindLogDetails(root) {
    root.querySelectorAll('[data-log-expand]').forEach(button => button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') === 'true';
      const detailRow = document.getElementById(button.getAttribute('aria-controls'));
      button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      detailRow.hidden = expanded;
      button.closest('.log-row')?.classList.toggle('is-expanded', !expanded);
    }));
  }

  function syncTaskFilter(category = state.logCategory) {
    const input = $('#logTaskId');
    if (!input) return;
    const supported = taskFilterCategories.has(category);
    input.disabled = !supported;
  }

  async function loadLogs() {
    const root = $('#view-logs');
    root.innerHTML = `<div class="view-heading"><div><div class="view-kicker">Workspace / Observability</div><h2 id="logsTitle">日志中心</h2><p class="subtitle">按日志类型、任务 ID、用户、模型、状态和时间范围定位运营记录 · 点击“查看详情”展开完整内容</p></div></div><div class="panel"><form id="logFilters" class="toolbar"><label class="control">日志类型<select id="logCategory"><option value="generations" ${state.logCategory === 'generations' ? 'selected' : ''}>生成任务</option><option value="credits" ${state.logCategory === 'credits' ? 'selected' : ''}>积分流水</option><option value="llm" ${state.logCategory === 'llm' ? 'selected' : ''}>LLM 用量</option><option value="audit" ${state.logCategory === 'audit' ? 'selected' : ''}>管理员审计</option><option value="system" ${state.logCategory === 'system' ? 'selected' : ''}>系统异常</option><option value="client" ${state.logCategory === 'client' ? 'selected' : ''}>客户端日志</option></select></label><label class="control task-filter-control">任务 ID<input id="logTaskId" autocomplete="off" placeholder="精确匹配"></label><label class="control">用户 ID<input id="logUserId" autocomplete="off"></label><label class="control">模型 ID<input id="logModelId" autocomplete="off"></label><label class="control">状态 / 级别 / 操作<input id="logStatus" placeholder="可选"></label><label class="control">开始时间<input id="logFrom" type="datetime-local"></label><label class="control">结束时间<input id="logTo" type="datetime-local"></label><button class="small-button" type="submit">查询日志</button></form><div id="logTable">${loadingMarkup('正在加载日志…')}</div></div>`;
    syncTaskFilter();
    $('#logFilters').onsubmit = event => { event.preventDefault(); state.logCategory = $('#logCategory').value; resetPager('log'); fetchLogs(); };
    $('#logCategory').onchange = () => { state.logCategory = $('#logCategory').value; syncTaskFilter(); resetPager('log'); fetchLogs(); };
    await fetchLogs();
  }

  async function fetchLogs() {
    const table = $('#logTable'); if (!table) return;
    const category = state.logCategory;
    const params = new URLSearchParams({ limit: '50' });
    if (currentCursor('log')) params.set('cursor', currentCursor('log'));
    if (taskFilterCategories.has(category) && $('#logTaskId')?.value.trim()) params.set('taskId', $('#logTaskId').value.trim());
    if ($('#logUserId')?.value.trim()) params.set('userId', $('#logUserId').value.trim());
    if ($('#logModelId')?.value.trim()) params.set('modelId', $('#logModelId').value.trim());
    const filter = $('#logStatus')?.value.trim();
    if (filter && category !== 'client') params.set(category === 'system' ? 'level' : category === 'audit' ? 'action' : category === 'credits' ? 'type' : 'status', filter);
    if ($('#logFrom')?.value) params.set('from', new Date($('#logFrom').value).toISOString());
    if ($('#logTo')?.value) params.set('to', new Date($('#logTo').value).toISOString());
    table.innerHTML = loadingMarkup(`正在加载${logLabels[category]}…`);
    try {
      const data = await api(`/api/admin/logs/${category}?${params}`); const items = data.items || [];
      table.innerHTML = items.length ? `<div class="table-wrap">${renderLogRows(category, items)}</div>${pageControls('log', data.total, data.nextCursor, items.length)}` : emptyMarkup('暂无日志', '尝试放宽筛选条件或调整时间范围。');
      bindLogDetails(table);
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
  $('#logoutButton').addEventListener('click', async event => {
    const confirmed = await showAdminDialog({ kicker:'会话操作', title:'确认退出登录', description:'退出后需要重新登录才能继续访问管理后台。', html:'<p class="admin-dialog-confirmation">当前管理员会话会立即结束。</p>', submit:'确认退出', danger:true });
    if (confirmed === null) return;
    const button = event.currentTarget;
    setButtonBusy(button, true, '退出中…');
    try { await api('/api/admin/auth/logout', { method: 'POST', body: '{}' }); } finally { location.reload(); }
  });
  document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  api('/api/admin/auth/session', { skipAuthRedirect: true }).then(result => { state.csrf = result.csrfToken; state.admin = result.admin; $('#adminName').textContent = result.admin.username; $('#adminLogin').classList.add('hidden'); $('#adminApp').classList.remove('hidden'); showView('overview'); }).catch(() => {});
})();
