(() => {
  const $ = selector => document.querySelector(selector);
  const state = { csrf: '', admin: null, view: 'overview', usersCursor: '', invitesCursor: '', logCursor: '', logCategory: 'generations' };
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
  const money = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
  const status = value => ({ active:'正常', disabled:'已禁用', completed:'完成', failed:'失败', queued:'排队', running:'运行中', exhausted:'已用尽', expired:'已过期', enabled:'启用', disabled:'停用' }[value] || value || '—');
  const badge = (value, kind = '') => `<span class="badge ${kind || (['active','completed','enabled'].includes(value) ? 'ok' : ['failed','disabled'].includes(value) ? 'bad' : 'warn')}">${esc(status(value))}</span>`;
  const toast = message => { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600); };

  let adminDialogResolver = null;
  let adminDialogRestoreFocus = null;
  let adminDialogValidate = null;
  function adminDialogFieldMarkup(field) {
    const id = `adminDialogField-${field.name}`;
    if (field.type === 'checkbox') return `<label class="admin-dialog-check" for="${esc(id)}"><input id="${esc(id)}" data-admin-dialog-field="${esc(field.name)}" type="checkbox" ${field.checked ? 'checked' : ''}><span><b>${esc(field.label)}</b>${field.help ? `<small>${esc(field.help)}</small>` : ''}</span></label>`;
    const common = `id="${esc(id)}" data-admin-dialog-field="${esc(field.name)}" ${field.required ? 'required' : ''} ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''} ${field.min !== undefined ? `min="${esc(field.min)}"` : ''} ${field.max !== undefined ? `max="${esc(field.max)}"` : ''} ${field.step !== undefined ? `step="${esc(field.step)}"` : ''} ${field.inputmode ? `inputmode="${esc(field.inputmode)}"` : ''}`;
    const control = field.type === 'select' ? `<select ${common}>${field.options.map(option => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>` : field.type === 'textarea' ? `<textarea ${common}>${esc(field.value || '')}</textarea>` : `<input ${common} type="${esc(field.type || 'text')}" value="${esc(field.value || '')}" autocomplete="off">`;
    return `<label class="admin-dialog-field" for="${esc(id)}"><span>${esc(field.label)}</span>${control}${field.help ? `<small>${esc(field.help)}</small>` : ''}</label>`;
  }
  function finishAdminDialog(result = null) {
    const dialog = $('#adminDialog');
    const resolver = adminDialogResolver;
    const restore = adminDialogRestoreFocus;
    adminDialogResolver = null;
    adminDialogRestoreFocus = null;
    adminDialogValidate = null;
    if (dialog.open) dialog.close();
    resolver?.(result);
    requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); });
  }
  function showAdminDialog({ kicker = '编辑操作', title, description = '', fields = [], submit = '保存', danger = false, validate = null }) {
    if (adminDialogResolver) finishAdminDialog(null);
    const dialog = $('#adminDialog');
    $('#adminDialogKicker').textContent = kicker;
    $('#adminDialogTitle').textContent = title;
    $('#adminDialogDescription').textContent = description;
    $('#adminDialogBody').innerHTML = fields.map(adminDialogFieldMarkup).join('');
    $('#adminDialogError').textContent = '';
    $('#adminDialogSubmit').textContent = submit;
    $('#adminDialogSubmit').classList.toggle('danger-action', danger);
    adminDialogValidate = validate;
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
  $('#adminDialogForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const values = adminDialogValues();
    const error = adminDialogValidate?.(values);
    if (error) { $('#adminDialogError').textContent = error; return; }
    finishAdminDialog(values);
  });
  $('#adminDialogClose').onclick = $('#adminDialogCancel').onclick = () => finishAdminDialog(null);
  $('#adminDialog').addEventListener('cancel', event => { event.preventDefault(); finishAdminDialog(null); });
  $('#adminDialog').addEventListener('close', () => { if (adminDialogResolver) finishAdminDialog(null); });

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) { const error = new Error(data.error || '请求失败'); error.status = response.status; error.data = data; throw error; }
    return data;
  }

  function showView(name) {
    state.view = name;
    document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === name));
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== `view-${name}`));
    ({ overview: loadOverview, users: loadUsers, models: loadModels, invites: loadInvites, logs: loadLogs }[name])();
  }

  async function loadOverview() {
    const root = $('#view-overview');
    root.innerHTML = '<h2>总览</h2><p class="subtitle">平台运行与账务概况</p><div class="empty">加载中…</div>';
    try {
      const data = await api('/api/admin/overview');
      root.innerHTML = `<h2>总览</h2><p class="subtitle">当前平台关键数据</p>
        <div class="cards">
          <div class="stat"><small>用户总数</small><strong>${money(data.users.total)}</strong><span class="muted">活跃 ${money(data.users.active)} · 禁用 ${money(data.users.disabled)}</span></div>
          <div class="stat"><small>当前积分余额</small><strong>${money(data.credits.balance)}</strong><span class="muted">冻结 ${money(data.credits.held)}</span></div>
          <div class="stat"><small>生成任务</small><strong>${money(data.generations.total)}</strong><span class="muted">完成 ${money(data.generations.completed)} · 失败 ${money(data.generations.failed)}</span></div>
          <div class="stat"><small>异常事项</small><strong>${money(data.exceptions.reconcile + data.exceptions.refundFailed)}</strong><span class="muted">待核账 ${money(data.exceptions.reconcile)} · 退款失败 ${money(data.exceptions.refundFailed)}</span></div>
        </div>
        <div class="panel"><div class="panel-head"><h3>运行提示</h3><button class="small-button" data-refresh="overview">刷新</button></div><p class="detail">累计消耗 ${money(data.credits.spent)} 积分，待处理任务 ${money(data.generations.pending)}，系统错误 ${money(data.exceptions.systemErrors)}。</p></div>`;
      root.querySelector('[data-refresh="overview"]').onclick = loadOverview;
    } catch (error) { root.innerHTML = `<div class="panel error">${esc(error.message)}</div>`; }
  }

  async function loadUsers() {
    const root = $('#view-users');
    root.innerHTML = `<h2>用户管理</h2><p class="subtitle">查询账号、余额和用户状态</p><div class="panel"><div class="toolbar"><label class="control">搜索<input id="userQuery" placeholder="用户名或用户 ID"></label><label class="control">状态<select id="userStatus"><option value="">全部</option><option value="active">正常</option><option value="disabled">已禁用</option></select></label><button class="small-button" id="userSearch">查询</button></div><div id="userTable" class="table-wrap">加载中…</div></div>`;
    $('#userSearch').onclick = () => { state.usersCursor = ''; fetchUsers(); };
    await fetchUsers();
  }

  async function fetchUsers() {
    const table = $('#userTable'); if (!table) return;
    const params = new URLSearchParams({ limit: '50' });
    if ($('#userQuery')?.value) params.set('query', $('#userQuery').value.trim());
    if ($('#userStatus')?.value) params.set('status', $('#userStatus').value);
    if (state.usersCursor) params.set('cursor', state.usersCursor);
    try {
      const data = await api(`/api/admin/users?${params}`);
      table.innerHTML = data.items.length ? `<table><thead><tr><th>用户名</th><th>状态</th><th>余额</th><th>冻结</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${data.items.map(user => `<tr><td><b>${esc(user.username)}</b><div class="detail">${esc(user.id)}</div></td><td>${badge(user.status)}</td><td>${money(user.credits)}</td><td>${money(user.held)}</td><td>${date(user.createdAt)}</td><td class="actions"><button class="small-button" data-user-detail="${esc(user.id)}">详情</button>${user.status === 'active' ? `<button class="small-button" data-user-disable="${esc(user.id)}">禁用</button>` : `<button class="small-button" data-user-enable="${esc(user.id)}">启用</button>`}</td></tr>`).join('')}</tbody></table><div class="panel-head"><span class="detail">共 ${money(data.total)} 个用户</span>${data.nextCursor ? '<button class="small-button" id="usersNext">下一页</button>' : ''}</div>` : '<div class="empty">没有符合条件的用户</div>';
      table.querySelectorAll('[data-user-detail]').forEach(button => button.onclick = () => showUser(button.dataset.userDetail));
      table.querySelectorAll('[data-user-disable]').forEach(button => button.onclick = () => changeUser(button.dataset.userDisable, 'disable'));
      table.querySelectorAll('[data-user-enable]').forEach(button => button.onclick = () => changeUser(button.dataset.userEnable, 'enable'));
      $('#usersNext')?.addEventListener('click', () => { state.usersCursor = data.nextCursor; fetchUsers(); });
    } catch (error) { table.innerHTML = `<div class="error">${esc(error.message)}</div>`; }
  }

  async function showUser(id) {
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(id)}`);
      const user = data.user;
      const values = await showAdminDialog({
        kicker: '积分管理',
        title: `调整 ${user.username} 的积分`,
        description: '增加请输入正数，减少请输入负数。调账会写入账本并记录审计日志。',
        submit: '提交调账',
        fields: [
          { name:'amount', label:'调整金额', type:'text', value:'', placeholder:'例如 10 或 -10', inputmode:'decimal', required:true, help:'支持最多 6 位小数，不能为 0。' },
          { name:'reasonCode', label:'调整原因', type:'select', value:'customer_service', options:[{ value:'customer_service', label:'客服补偿' }, { value:'promotion', label:'运营赠送' }, { value:'correction', label:'账务修正' }, { value:'refund', label:'退款补发' }, { value:'other', label:'其他' }] },
          { name:'note', label:'备注', type:'textarea', value:'', placeholder:'补充本次调账的业务原因。', help:'备注会进入积分流水和审计记录。' },
        ],
        validate: values => /^-?\d+(?:\.\d{1,6})?$/.test(String(values.amount).trim()) && Number(values.amount) !== 0 ? null : '调整金额必须是非零数字，最多 6 位小数。',
      });
      if (!values) return;
      const result = await api(`/api/admin/users/${encodeURIComponent(id)}/credit-adjustments`, { method:'POST', body: JSON.stringify({ amount:String(values.amount).trim(), note:values.note, reasonCode:values.reasonCode, idempotencyKey:crypto.randomUUID() }) });
      toast(`调账完成，当前余额 ${money(result.balance)}`);
      fetchUsers();
    } catch (error) { if (error.status !== 404) toast(error.message); }
  }

  async function changeUser(id, action) {
    const disabling = action === 'disable';
    const confirmed = await showAdminDialog({
      kicker: disabling ? '危险操作' : '用户管理',
      title: disabling ? '禁用用户' : '启用用户',
      description: disabling ? '禁用后该用户现有会话会被撤销，无法继续使用用户端。' : '启用后该用户可以重新登录并使用用户端。',
      submit: disabling ? '确认禁用' : '确认启用',
      danger: disabling,
    });
    if (!confirmed) return;
    try { await api(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method:'POST', body:'{}' }); toast(disabling ? '用户已禁用' : '用户已启用'); fetchUsers(); }
    catch (error) { toast(error.message); }
  }

  async function loadModels() {
    const root = $('#view-models');
    root.innerHTML = '<h2>模型与价格</h2><p class="subtitle">管理用户展示、接单状态和平台统一价格</p><div id="modelPanel" class="panel">加载中…</div><div id="pricingPanel" class="panel">加载中…</div>';
    try {
      const [models, pricing] = await Promise.all([api('/api/admin/models'), api('/api/admin/pricing')]);
      $('#modelPanel').innerHTML = `<div class="panel-head"><h3>模型控制</h3></div><div class="table-wrap"><table><thead><tr><th>模型</th><th>类型</th><th>用户可见</th><th>接受新任务</th><th>排序</th><th>操作</th></tr></thead><tbody>${models.items.map(model => `<tr><td><b>${esc(model.modelId)}</b></td><td>${esc(model.kind)}</td><td>${model.userVisible ? badge('active') : badge('disabled')}</td><td>${model.enabled ? badge('active') : badge('disabled')}</td><td>${model.sortOrder}</td><td><button class="small-button" data-model="${esc(model.modelId)}">编辑</button></td></tr>`).join('')}</tbody></table></div>`;
      $('#modelPanel').querySelectorAll('[data-model]').forEach(button => button.onclick = () => editModel(models.items.find(item => item.modelId === button.dataset.model)));
      const current = pricing.current;
      $('#pricingPanel').innerHTML = `<div class="panel-head"><h3>全局价格 · 版本 ${current.version}</h3></div><form id="pricingForm" class="price-form"><label class="control">图片积分/次<input name="imagePerRequest" value="${esc(current.imagePerRequest)}" inputmode="decimal" required></label><label class="control">视频积分/秒<input name="videoPerSecond" value="${esc(current.videoPerSecond)}" inputmode="decimal" required></label><button class="primary" type="submit">发布新价格</button></form><p class="detail">历史价格只读；新价格仅影响新提交的任务。</p>`;
      $('#pricingForm').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api('/api/admin/pricing', { method:'POST', body:JSON.stringify({ imagePerRequest:form.get('imagePerRequest'), videoPerSecond:form.get('videoPerSecond'), expectedVersion:current.version }) }); toast('价格已发布'); loadModels(); } catch (error) { toast(error.message); } };
    } catch (error) { root.innerHTML = `<div class="panel error">${esc(error.message)}</div>`; }
  }

  async function editModel(model) {
    const values = await showAdminDialog({
      kicker: '模型控制',
      title: `编辑 ${model.modelId}`,
      description: '用户可见控制前端展示，接单状态控制服务端是否接受新任务。',
      submit: '保存模型配置',
      fields: [
        { name:'userVisible', type:'checkbox', label:'用户可见', checked:model.userVisible, help:'关闭后不会出现在用户端模型列表。' },
        { name:'enabled', type:'checkbox', label:'接受新任务', checked:model.enabled, help:'关闭后服务端会拒绝该模型的新生成请求。' },
        { name:'sortOrder', label:'排序值', type:'number', value:String(model.sortOrder), min:0, max:100000, step:1, inputmode:'numeric', required:true, help:'请输入 0–100000 的整数，数字越小越靠前。' },
      ],
      validate: values => { const order = Number(values.sortOrder); return Number.isSafeInteger(order) && order >= 0 && order <= 100000 ? null : '排序值必须是 0–100000 的整数。'; },
    });
    if (!values) return;
    try { await api(`/api/admin/models/${encodeURIComponent(model.modelId)}`, { method:'PATCH', body:JSON.stringify({ userVisible:values.userVisible, enabled:values.enabled, sortOrder:Number(values.sortOrder), expectedVersion:model.version }) }); toast('模型配置已更新'); loadModels(); }
    catch (error) { toast(error.message); }
  }

  async function loadInvites() {
    const root = $('#view-invites');
    root.innerHTML = `<h2>邀请码</h2><p class="subtitle">管理注册名额、有效期和注册送积分</p><div class="panel"><form id="inviteForm" class="toolbar"><label class="control">邀请码（留空自动生成）<input name="code" placeholder="GUGU-XXXX-XXXX"></label><label class="control">最大次数<input name="maxUses" type="number" min="1" value="1"></label><label class="control">注册送积分<input name="signupBonus" value="50" inputmode="decimal"></label><label class="control">有效期<input name="expiresAt" type="datetime-local"></label><label class="control">备注<input name="note"></label><button class="primary" type="submit">创建邀请码</button></form></div><div id="inviteTable" class="panel">加载中…</div>`;
    $('#inviteForm').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const expires = form.get('expiresAt'); try { const data = await api('/api/admin/invite-codes', { method:'POST', body:JSON.stringify({ code:form.get('code'), maxUses:Number(form.get('maxUses')), signupBonus:form.get('signupBonus'), expiresAt:expires ? new Date(expires).toISOString() : null, note:form.get('note') }) }); toast(`邀请码 ${data.invite.code} 已创建`); event.currentTarget.reset(); loadInvites(); } catch (error) { toast(error.message); } };
    await fetchInvites();
  }

  async function fetchInvites() {
    const table = $('#inviteTable'); if (!table) return;
    const params = new URLSearchParams({ limit:'50' }); if (state.invitesCursor) params.set('cursor', state.invitesCursor);
    try { const data = await api(`/api/admin/invite-codes?${params}`); table.innerHTML = data.items.length ? `<div class="table-wrap"><table><thead><tr><th>邀请码</th><th>状态</th><th>使用次数</th><th>注册送积分</th><th>有效期</th><th>备注</th><th>操作</th></tr></thead><tbody>${data.items.map(invite => `<tr><td><b>${esc(invite.code)}</b></td><td>${badge(invite.status)}</td><td>${invite.usedCount} / ${invite.maxUses}</td><td>${money(invite.signupBonus)}</td><td>${date(invite.expiresAt)}</td><td>${esc(invite.note)}</td><td><button class="small-button" data-invite-code="${esc(invite.code)}" data-invite-enabled="${invite.enabled}">${invite.enabled ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table></div>${data.nextCursor ? '<button class="small-button" id="invitesNext">下一页</button>' : ''}` : '<div class="empty">暂无邀请码</div>';
      table.querySelectorAll('[data-invite-code]').forEach(button => button.onclick = async () => { try { await api(`/api/admin/invite-codes/${encodeURIComponent(button.dataset.inviteCode)}`, { method:'PATCH', body:JSON.stringify({ enabled:button.dataset.inviteEnabled !== 'true' }) }); toast('邀请码状态已更新'); fetchInvites(); } catch (error) { toast(error.message); } });
      $('#invitesNext')?.addEventListener('click', () => { state.invitesCursor = data.nextCursor; fetchInvites(); });
    } catch (error) { table.innerHTML = `<div class="error">${esc(error.message)}</div>`; }
  }

  async function loadLogs() {
    const root = $('#view-logs');
    root.innerHTML = `<h2>日志中心</h2><p class="subtitle">按用户、模型和状态查询运营记录</p><div class="panel"><div class="toolbar"><label class="control">日志类型<select id="logCategory"><option value="generations">生成任务</option><option value="credits">积分流水</option><option value="llm">LLM 用量</option><option value="audit">管理员审计</option><option value="system">系统异常</option></select></label><label class="control">用户 ID<input id="logUserId"></label><label class="control">模型 ID<input id="logModelId"></label><button class="small-button" id="logSearch">查询</button></div><div id="logTable">加载中…</div></div>`;
    $('#logSearch').onclick = () => { state.logCategory = $('#logCategory').value; state.logCursor = ''; fetchLogs(); };
    await fetchLogs();
  }

  async function fetchLogs() {
    const table = $('#logTable'); if (!table) return;
    const params = new URLSearchParams({ limit:'50' }); if (state.logCursor) params.set('cursor', state.logCursor); if ($('#logUserId')?.value) params.set('userId', $('#logUserId').value.trim()); if ($('#logModelId')?.value) params.set('modelId', $('#logModelId').value.trim());
    try { const data = await api(`/api/admin/logs/${state.logCategory}?${params}`); const items = data.items || []; table.innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>对象</th><th>状态/类型</th><th>用户</th><th>模型</th><th>详情</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td>${esc(item.id || item.targetId || '—')}</td><td>${badge(item.status || item.type || item.level || item.action || '')}</td><td>${esc(item.userId || item.targetId || item.actorUserId || '—')}</td><td>${esc(item.modelId || '—')}</td><td class="log-json" title="${esc(JSON.stringify(item.details || item.after || item.message || ''))}">${esc(item.message || item.note || JSON.stringify(item.details || item.after || ''))}</td></tr>`).join('')}</tbody></table></div>${data.nextCursor ? '<button class="small-button" id="logsNext">下一页</button>' : ''}` : '<div class="empty">暂无日志</div>';
      $('#logsNext')?.addEventListener('click', () => { state.logCursor = data.nextCursor; fetchLogs(); });
    } catch (error) { table.innerHTML = `<div class="error">${esc(error.message)}</div>`; }
  }

  async function login(event) {
    event.preventDefault();
    const errorEl = $('#loginError'); errorEl.textContent = '';
    try {
      const result = await api('/api/admin/auth/login', { method:'POST', body:JSON.stringify({ username:$('#loginUsername').value, password:$('#loginPassword').value }) });
      state.csrf = result.csrfToken; state.admin = result.admin; $('#adminName').textContent = result.admin.username; $('#adminLogin').classList.add('hidden'); $('#adminApp').classList.remove('hidden'); showView('overview');
    } catch (error) { errorEl.textContent = error.message; }
  }

  $('#loginForm').addEventListener('submit', login);
  $('#logoutButton').addEventListener('click', async () => { try { await api('/api/admin/auth/logout', { method:'POST', body:'{}' }); } finally { location.reload(); } });
  document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  api('/api/admin/auth/session').then(result => { state.admin = result.admin; $('#adminName').textContent = result.admin.username; showView('overview'); $('#adminLogin').classList.add('hidden'); $('#adminApp').classList.remove('hidden'); }).catch(() => {});
})();
