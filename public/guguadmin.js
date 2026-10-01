import { createApiClient } from './api-client.js?v=4';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
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
    modelsTab: 'routes',
    overviewRange: 'all',
    requestSeq: {},
    filters: {
      users: { query: '', status: '', role: '' },
      orders: { query: '', from: '', to: '' },
      invites: { query: '', enabled: '' },
      announcements: { status: '' },
      logs: { taskId: '', userId: '', modelId: '', status: '', from: '', to: '' },
    },
  };
  const { request: requestApi } = createApiClient({ scopeHeaders: () => state.csrf ? { 'X-CSRF-Token': state.csrf } : {}, responseShapeFor: () => 'object' });

  const viewTitles = { overview: '总览', users: '用户管理', orders: '付费订单', invites: '邀请码', announcements: '消息通知', models: '模型与价格', credentials: '渠道与 Key', logs: '日志中心' };
  const routeModelLabels = {
    'seedance-2.0': 'Seedance 2.0 · 兼容线路',
    'seedance-2.0-text': 'Seedance 2.0 · 文生视频',
    'seedance-2.0-img': 'Seedance 2.0 · 图生视频',
    'seedance-2.0-fast': 'Seedance 2.0 Fast',
    'seedance-2.5': 'Seedance 2.5',
  };
  const logLabels = { generations: '生成任务', credits: '积分流水', llm: 'LLM 用量', audit: '管理员审计', system: '系统异常', client: '客户端日志' };
  // 每类日志后端实际支持的筛选项；不支持的字段不展示，避免“填了却不生效”。
  const logFilterSpec = {
    generations: { taskId: true, modelId: true, userLabel: '用户 ID', status: { param: 'status', label: '任务状态', options: [['', '全部状态'], ['completed', '完成'], ['failed', '失败'], ['running', '运行中'], ['queued', '排队'], ['pending', '等待中']] } },
    credits: { taskId: true, modelId: true, userLabel: '用户 ID', status: { param: 'type', label: '流水类型', placeholder: '例如 admin_credit_adjustment' } },
    llm: { modelId: true, userLabel: '用户 ID' },
    audit: { userLabel: '管理员或目标 ID', status: { param: 'action', label: '操作', placeholder: '例如 user.disable' } },
    system: { taskId: true, modelId: true, userLabel: '用户 ID', status: { param: 'level', label: '级别', options: [['', '全部级别'], ['critical', '严重'], ['error', '错误'], ['warning', '警告'], ['info', '信息']] } },
    client: { userLabel: '用户 ID' },
  };
  const taskFilterCategories = new Set(Object.entries(logFilterSpec).filter(([, spec]) => spec.taskId).map(([key]) => key));
  const adapterLabels = { 'wj-video': 'WJ 视频协议', 'diw-video': 'DIW 视频协议', 'cntcn-video': 'CNTCN 视频协议' };
  const kindLabels = { image: '图片', video: '视频', text: '文本', llm: '文本', audio: '音频' };

  const ICONS = {
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    triangle: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    checkMark: '<path d="M20 6 9 17l-5-5"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    card: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
    italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
    list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    listOrdered: '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
    clearFormat: '<path d="M4 7V4h16v3"/><path d="M5 20h6"/><path d="M13 4 8 20"/><path d="m15 15 5 5"/><path d="m20 15-5 5"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  };
  const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const money = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  const yuan = value => Number(value || 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = value => {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return esc(value);
    return parsed.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };
  const pad = value => String(value).padStart(2, '0');
  const localInputValue = value => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
  const inputToIso = value => value ? new Date(value).toISOString() : '';
  // 快捷时间范围：返回 datetime-local 可直接使用的开始时间，结束时间留空表示“至今”。
  function rangeStart(range) {
    const now = new Date();
    if (range === 'today') { now.setHours(0, 0, 0, 0); return localInputValue(now); }
    if (range === '7d') return localInputValue(new Date(Date.now() - 7 * 86400000));
    if (range === '30d') return localInputValue(new Date(Date.now() - 30 * 86400000));
    return '';
  }
  const quickRanges = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天']];
  const activeQuickRange = filters => filters.to ? '' : (quickRanges.find(([key]) => filters.from && Math.abs(new Date(filters.from) - new Date(rangeStart(key))) < 120000)?.[0] || '');

  const statusLabels = { active: '正常', disabled: '已停用', auto_disabled: '已自动停用', completed: '完成', failed: '失败', queued: '排队', running: '运行中', pending: '等待中', exhausted: '已用尽', expired: '已过期', enabled: '启用', available: '可用', missing: '目录缺失', unknown: '待检查', probe_error: '检查异常', credential_error: '密钥异常', configured: '已配置', draft: '草稿', published: '已发布', archived: '已归档', critical: '严重', error: '错误', warning: '警告', info: '信息', success: '成功', PAID: '已支付', PARTIALLY_REFUNDED: '部分退款', REFUNDED: '已退款' };
  const status = value => statusLabels[value] || value || '—';
  const toneFor = value => ['active', 'completed', 'enabled', 'available', 'success', 'configured', 'published', 'PAID'].includes(value) ? 'ok'
    : ['failed', 'error', 'critical', 'credential_error', 'missing', 'auto_disabled'].includes(value) ? 'bad'
      : ['disabled', 'archived', 'expired', 'exhausted', 'draft'].includes(value) ? 'muted'
        : ['running', 'queued', 'pending', 'info'].includes(value) ? 'info' : 'warn';
  const badge = (value, kind = '') => `<span class="badge ${kind || toneFor(value)}">${esc(status(value))}</span>`;
  const pill = (label, kind = 'muted') => `<span class="badge ${kind}">${esc(label)}</span>`;
  const userIdentity = user => {
    const nickname = String(user?.nickname || '').trim();
    const phoneNumber = String(user?.phoneNumber || '').trim();
    return nickname && phoneNumber ? `${esc(nickname)}（${esc(phoneNumber)}）` : esc(user?.username || nickname || phoneNumber || '—');
  };
  const initial = value => esc((String(value || '').trim().slice(0, 1) || 'U').toUpperCase());
  const copyButton = (value, label = '内容') => `<button class="icon-button is-xs" type="button" data-copy="${esc(value)}" data-copy-label="${esc(label)}" aria-label="复制${esc(label)}" title="复制${esc(label)}">${icon('copy')}</button>`;
  const idText = (value, label = 'ID', strong = false) => value ? `<span class="id-text${strong ? ' is-strong' : ''}"><code title="${esc(value)}">${esc(value)}</code>${copyButton(value, label)}</span>` : '<span class="muted">—</span>';
  const plain = value => value === null || value === undefined || value === '' ? '<span class="muted">—</span>' : esc(value);

  const loadingMarkup = text => `<div class="state-block" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
  const skeletonMarkup = (rows = 6) => `<div class="skeleton" role="status" aria-label="正在加载">${'<span></span>'.repeat(rows)}</div>`;
  const emptyMarkup = (title, detail = '', action = '') => `<div class="empty">${icon('inbox', 'empty-icon')}<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}${action}</div>`;
  const errorMarkup = (message, retry = '') => `<div class="error-state" role="alert">${icon('alert')}<div><strong>加载失败</strong><span>${esc(message || '请求失败，请稍后重试。')}</span></div>${retry ? `<button class="btn btn-sm" data-retry="${esc(retry)}" type="button">${icon('refresh')}重新加载</button>` : ''}</div>`;
  const pageHead = (id, title, subtitle = '', actions = '') => `<header class="page-head"><div><h2 id="${id}">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
  const refreshButton = key => `<button class="btn" data-refresh="${key}" type="button">${icon('refresh')}刷新</button>`;
  const segmented = (name, options, current, label) => `<div class="segmented" role="group" aria-label="${esc(label)}">${options.map(([value, text]) => `<button type="button" data-seg="${esc(name)}" data-value="${esc(value)}" aria-pressed="${String(value === current)}">${esc(text)}</button>`).join('')}</div>`;

  function toast(message, kind = 'success') {
    const el = $('#toast');
    clearTimeout(el.timer);
    clearTimeout(el.closeTimer);
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'check')}<span>${esc(message)}</span>`;
    el.className = `toast show ${kind}`;
    if (typeof el.showPopover === 'function') {
      if (el.matches(':popover-open')) el.hidePopover();
      el.showPopover();
    }
    el.timer = setTimeout(() => {
      el.classList.remove('show');
      el.closeTimer = setTimeout(() => { if (el.matches(':popover-open')) el.hidePopover(); }, 180);
    }, kind === 'error' ? 5200 : 2800);
  }
  const toastError = error => toast(error?.message || '操作失败，请稍后重试', 'error');

  function setButtonBusy(button, busy, label = '处理中…') {
    if (!button) return;
    if (busy) {
      if (button.dataset.busy) return;
      button.dataset.busy = '1';
      button._idleHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(label)}</span>`;
    } else if (button.dataset.busy) {
      delete button.dataset.busy;
      button.disabled = false;
      button.innerHTML = button._idleHtml ?? button.innerHTML;
    }
  }

  async function copyText(value, label = '内容') {
    try { await navigator.clipboard.writeText(value); toast(`${label}已复制`); }
    catch { toast(`复制失败，请手动复制${label}`, 'error'); }
  }

  // 每个列表只接受最后一次请求的结果，避免快速切换筛选时旧数据覆盖新数据。
  const nextRequest = key => { state.requestSeq[key] = (state.requestSeq[key] || 0) + 1; return state.requestSeq[key]; };
  const isStale = (key, token) => state.requestSeq[key] !== token;
  function markLoading(container, text) {
    if (container.querySelector('.table-wrap, .cards')) { container.classList.add('is-refreshing'); container.setAttribute('aria-busy', 'true'); return; }
    container.innerHTML = text ? loadingMarkup(text) : skeletonMarkup();
  }
  function doneLoading(container) { container.classList.remove('is-refreshing'); container.removeAttribute('aria-busy'); }
  const debounce = (fn, wait = 350) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; };

  function resetPager(key) { state[`${key}Cursors`] = ['']; }
  function currentCursor(key) { return state[`${key}Cursors`].at(-1) || ''; }
  function pageControls(key, total, nextCursor, count) {
    const cursors = state[`${key}Cursors`];
    const page = cursors.length;
    const summary = `${page > 1 || nextCursor ? `第 ${page} 页 · 本页 ${money(count)} 条` : `共 ${money(count)} 条`}${total !== undefined && total !== null && (page > 1 || nextCursor) ? ` · 总计 ${money(total)} 条` : ''}`;
    const nav = page > 1 || nextCursor ? `<div class="pagination-actions"><button class="btn btn-sm" data-page-prev="${key}" type="button" ${page > 1 ? '' : 'disabled'}>上一页</button><button class="btn btn-sm" data-page-next="${key}" type="button" ${nextCursor ? '' : 'disabled'}>下一页</button></div>` : '';
    return `<div class="pagination"><span>${summary}</span>${nav}</div>`;
  }
  function bindPageControls(root, key, fetcher, nextCursor) {
    const scrollToPanel = () => { const panel = root.closest('.panel'); if (panel && panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: 'start' }); };
    $(`[data-page-prev="${key}"]`, root)?.addEventListener('click', () => { if (state[`${key}Cursors`].length > 1) state[`${key}Cursors`].pop(); scrollToPanel(); fetcher(); });
    $(`[data-page-next="${key}"]`, root)?.addEventListener('click', () => { if (nextCursor) state[`${key}Cursors`].push(nextCursor); scrollToPanel(); fetcher(); });
  }
  function bindRetry(root, key, fn) { $(`[data-retry="${key}"]`, root)?.addEventListener('click', fn); }

  /* ---------- 通用弹窗 ---------- */
  let adminDialogResolver = null;
  let adminDialogRestoreFocus = null;
  let adminDialogValidate = null;
  let adminDialogSubmitHandler = null;
  let adminDialogSubmitLabel = '保存';
  let adminDialogBusyLabel = '保存中…';

  function adminDialogFieldMarkup(field) {
    const id = `adminDialogField-${field.name}`;
    const help = field.help ? `<small id="${esc(id)}-help">${esc(field.help)}</small>` : '';
    if (field.type === 'checkbox') return `<label class="admin-dialog-check" for="${esc(id)}"><input id="${esc(id)}" data-admin-dialog-field="${esc(field.name)}" type="checkbox" ${field.checked ? 'checked' : ''}><span><b>${esc(field.label)}</b>${field.help ? `<small>${esc(field.help)}</small>` : ''}</span></label>`;
    const attrs = [
      `id="${esc(id)}"`, `data-admin-dialog-field="${esc(field.name)}"`, `name="${esc(field.name)}"`,
      field.required ? 'required' : '', field.placeholder ? `placeholder="${esc(field.placeholder)}"` : '',
      field.maxLength !== undefined ? `maxlength="${esc(field.maxLength)}"` : '', field.min !== undefined ? `min="${esc(field.min)}"` : '',
      field.max !== undefined ? `max="${esc(field.max)}"` : '', field.step !== undefined ? `step="${esc(field.step)}"` : '',
      field.inputmode ? `inputmode="${esc(field.inputmode)}"` : '', field.autocapitalize ? `autocapitalize="${esc(field.autocapitalize)}"` : '',
      field.help ? `aria-describedby="${esc(id)}-help"` : '',
    ].filter(Boolean).join(' ');
    const control = field.type === 'select'
      ? `<select ${attrs}>${field.options.map(option => `<option value="${esc(option.value)}"${option.hint ? ` data-hint="${esc(option.hint)}"` : ''}${option.disabled ? ' disabled' : ''} ${String(option.value) === String(field.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
      : field.type === 'textarea' ? `<textarea ${attrs}>${esc(field.value || '')}</textarea>`
        : `<input ${attrs} type="${esc(field.type || 'text')}" value="${esc(field.value ?? '')}" autocomplete="off" spellcheck="false">`;
    return `<label class="admin-dialog-field${field.span === 'full' ? ' span-full' : ''}" for="${esc(id)}"><span>${esc(field.label)}${field.required ? '<span class="required" aria-hidden="true">*</span>' : ''}</span>${control}${help}</label>`;
  }

  function setAdminDialogBusy(busy) {
    const dialog = $('#adminDialog');
    dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    $$('input,select,textarea,button[data-rich-command],button[data-rich-image],button[data-quick-amount],#adminDialogClose,#adminDialogCancel', dialog).forEach(control => { control.disabled = busy; });
    $$('[contenteditable]', dialog).forEach(editor => { editor.contentEditable = busy ? 'false' : 'true'; });
    const submit = $('#adminDialogSubmit');
    submit.disabled = busy;
    submit.innerHTML = busy ? `<span class="spinner" aria-hidden="true"></span><span>${esc(adminDialogBusyLabel)}</span>` : esc(adminDialogSubmitLabel);
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
    requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus({ preventScroll: true }); });
  }

  function showAdminDialog({ kicker = '', title, description = '', fields = [], html = '', submit = '保存', busyLabel = '保存中…', cancel = '取消', hideCancel = false, danger = false, tone = '', size = '', validate = null, onSubmit = null, onRender = null }) {
    if (adminDialogResolver) finishAdminDialog(null);
    const dialog = $('#adminDialog');
    dialog.classList.toggle('is-wide', size === 'wide');
    dialog.classList.toggle('is-narrow', size === 'narrow');
    const iconName = danger ? 'triangle' : tone === 'success' ? 'check' : tone === 'info' ? 'info' : '';
    const iconEl = $('#adminDialogIcon');
    iconEl.hidden = !iconName;
    iconEl.className = `admin-dialog-icon${danger ? ' is-danger' : ''}`;
    iconEl.innerHTML = iconName ? icon(iconName) : '';
    $('#adminDialogKicker').textContent = kicker;
    $('#adminDialogTitle').textContent = title;
    $('#adminDialogDescription').textContent = description;
    $('#adminDialogBody').innerHTML = html || fields.map(adminDialogFieldMarkup).join('');
    $('#adminDialogError').textContent = '';
    const submitButton = $('#adminDialogSubmit');
    submitButton.classList.toggle('btn-danger', danger);
    submitButton.classList.toggle('btn-primary', !danger);
    adminDialogSubmitLabel = submit;
    adminDialogBusyLabel = busyLabel;
    submitButton.textContent = submit;
    const cancelButton = $('#adminDialogCancel');
    cancelButton.textContent = cancel;
    cancelButton.hidden = hideCancel;
    adminDialogValidate = validate;
    adminDialogSubmitHandler = onSubmit;
    adminDialogRestoreFocus = document.activeElement;
    return new Promise(resolve => {
      adminDialogResolver = resolve;
      dialog.showModal();
      onRender?.($('#adminDialogBody'));
      requestAnimationFrame(() => {
        const firstField = $('#adminDialogBody input:not([type="checkbox"]):not([hidden]),#adminDialogBody select,#adminDialogBody textarea,#adminDialogBody [contenteditable="true"]', dialog);
        (firstField || (danger ? cancelButton : submitButton)).focus();
      });
    });
  }

  function adminDialogValues() {
    return Object.fromEntries($$('[data-admin-dialog-field]', $('#adminDialogForm')).map(field => [field.dataset.adminDialogField, field.type === 'checkbox' ? field.checked : field.isContentEditable || field.hasAttribute('contenteditable') ? field.innerHTML : field.value]));
  }

  $('#adminDialogForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const values = adminDialogValues();
    const error = adminDialogValidate?.(values);
    if (error) { $('#adminDialogError').textContent = error; return; }
    if (!adminDialogSubmitHandler) { finishAdminDialog(values); return; }
    $('#adminDialogError').textContent = '';
    setAdminDialogBusy(true);
    try { const result = await adminDialogSubmitHandler(values); finishAdminDialog(result === undefined ? values : result); }
    catch (requestError) { setAdminDialogBusy(false); $('#adminDialogError').textContent = requestError.message || '保存失败，请重试。'; }
  });
  const dialogIsBusy = () => $('#adminDialog').getAttribute('aria-busy') === 'true';
  $('#adminDialogClose').onclick = $('#adminDialogCancel').onclick = () => { if (!dialogIsBusy()) finishAdminDialog(null); };
  $('#adminDialog').addEventListener('cancel', event => {
    event.preventDefault();
    // Esc 先关闭展开的下拉列表，再次按 Esc 才关闭弹窗。
    if (closeSelectPopup(true) || performance.now() < selectEscapeGuardUntil) return;
    if (!dialogIsBusy()) finishAdminDialog(null);
  });
  $('#adminDialog').addEventListener('close', () => { if (adminDialogResolver) finishAdminDialog(null); });
  $('#adminDialog').addEventListener('input', () => { if ($('#adminDialogError').textContent) $('#adminDialogError').textContent = ''; });

  /* ---------- 下拉选择 ---------- */
  // 原生 <select> 继续作为数据源（value、change 事件、表单取值都不变），只替换展示层和弹出列表。
  const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const nativeSelectIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let selectSeq = 0;
  let openSelect = null;
  let selectEscapeGuardUntil = 0;

  function selectLabelText(select) {
    const label = select.closest('label') || (select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null);
    if (!label) return select.getAttribute('aria-label') || '';
    const span = label.querySelector('.field-label') || [...label.children].find(child => child.tagName === 'SPAN' && !child.classList.contains('select-value'));
    const text = span ? span.textContent : [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
    return text.replace(/\*/g, '').trim();
  }

  function syncSelect(select) {
    const ui = select._ui; if (!ui) return;
    const option = select.options[nativeSelectIndex.get.call(select)];
    const text = option?.textContent.trim() || '请选择';
    ui.value.textContent = text;
    ui.value.title = text;
    ui.trigger.disabled = select.disabled;
    ui.trigger.setAttribute('aria-label', ui.label ? `${ui.label}：${text}` : text);
    if (openSelect?.select === select && select.disabled) closeSelectPopup();
  }

  function enhanceSelect(select) {
    if (select._ui || select.multiple || 'native' in select.dataset) return;
    const id = `adminSelect${++selectSeq}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${id}-list`);
    trigger.innerHTML = `<span class="select-value"></span>${icon('chevronDown', 'select-chevron')}`;
    select.classList.add('select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(trigger);
    select._ui = { id, trigger, value: trigger.firstElementChild, label: selectLabelText(select) };
    // 代码里直接改 select.value（重置筛选、回滚失败操作等）时，同步更新展示文字。
    Object.defineProperty(select, 'value', { configurable: true, get() { return nativeSelectValue.get.call(this); }, set(value) { nativeSelectValue.set.call(this, value); syncSelect(this); } });
    Object.defineProperty(select, 'selectedIndex', { configurable: true, get() { return nativeSelectIndex.get.call(this); }, set(value) { nativeSelectIndex.set.call(this, value); syncSelect(this); } });
    new MutationObserver(() => syncSelect(select)).observe(select, { attributes: true, attributeFilter: ['disabled'], childList: true, subtree: true });
    select.addEventListener('change', () => syncSelect(select));
    select.addEventListener('focus', () => trigger.focus());
    trigger.addEventListener('click', () => { if (openSelect?.select === select) closeSelectPopup(true); else openSelectPopup(select); });
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openSelectPopup(select); }
    });
    syncSelect(select);
  }

  function selectItems(select) {
    const items = [];
    [...select.children].forEach(node => {
      if (node.tagName === 'OPTGROUP') { items.push({ group: node.label }); [...node.children].forEach(option => items.push({ option })); }
      else if (node.tagName === 'OPTION') items.push({ option: node });
    });
    return items;
  }

  function renderSelectOptions(query = '') {
    const current = openSelect; if (!current) return;
    const needle = query.trim().toLowerCase();
    let html = '';
    let pendingGroup = '';
    current.visible = [];
    current.items.forEach(item => {
      if (item.group !== undefined) { pendingGroup = item.group; return; }
      const option = item.option;
      const text = option.textContent.trim();
      const hint = option.dataset.hint || '';
      if (needle && !`${text} ${hint} ${option.value}`.toLowerCase().includes(needle)) return;
      if (pendingGroup) { html += `<div class="select-group" role="presentation">${esc(pendingGroup)}</div>`; pendingGroup = ''; }
      const index = current.visible.push(option) - 1;
      const selected = option.selected;
      html += `<div class="select-option${selected ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}" role="option" id="${current.id}-opt-${index}" data-index="${index}" aria-selected="${String(selected)}"${option.disabled ? ' aria-disabled="true"' : ''}><span class="select-option-text"><span>${esc(text)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</span>${selected ? icon('checkMark') : ''}</div>`;
    });
    current.list.innerHTML = html || '<div class="select-empty">没有匹配的选项</div>';
    const selectedIndex = current.visible.findIndex(option => option.selected);
    setSelectActive(needle || selectedIndex < 0 ? nextEnabledIndex(-1, 1) : selectedIndex);
  }

  function nextEnabledIndex(from, step) {
    const options = openSelect?.visible || [];
    for (let index = from + step; index >= 0 && index < options.length; index += step) if (!options[index].disabled) return index;
    return from;
  }

  function setSelectActive(index) {
    const current = openSelect; if (!current) return;
    current.active = index;
    $$('.select-option', current.list).forEach(node => node.classList.toggle('is-active', Number(node.dataset.index) === index));
    const activeNode = $(`#${current.id}-opt-${index}`, current.list);
    const owner = current.search || current.list;
    if (activeNode) { owner.setAttribute('aria-activedescendant', activeNode.id); activeNode.scrollIntoView({ block: 'nearest' }); }
    else owner.removeAttribute('aria-activedescendant');
  }

  function commitSelectOption(index) {
    const current = openSelect; if (!current) return;
    const option = current.visible[index];
    if (!option || option.disabled) return;
    const { select } = current;
    const changed = nativeSelectValue.get.call(select) !== option.value;
    closeSelectPopup(true);
    if (!changed) return;
    nativeSelectValue.set.call(select, option.value);
    syncSelect(select);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function positionSelectPopup() {
    const current = openSelect; if (!current) return;
    const { select, popup } = current;
    if (!select.isConnected) { closeSelectPopup(); return; }
    const rect = select._ui.trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) { closeSelectPopup(); return; }
    const gap = 6;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8;
    const top = (viewport?.offsetTop || 0) + 8;
    const right = left + (viewport?.width || innerWidth) - 16;
    const bottom = top + (viewport?.height || innerHeight) - 16;
    const width = Math.min(Math.max(rect.width, 200), right - left);
    popup.style.minWidth = `${width}px`;
    popup.style.maxWidth = `${Math.min(right - left, Math.max(width, 420))}px`;
    const below = bottom - rect.bottom - gap;
    const above = rect.top - gap - top;
    const openUp = below < 240 && above > below;
    popup.style.maxHeight = `${Math.max(0, Math.min(340, bottom - top, Math.max(140, openUp ? above : below)))}px`;
    popup.classList.toggle('is-up', openUp);
    popup.style.left = `${Math.max(left, Math.min(rect.left, right - popup.offsetWidth))}px`;
    popup.style.top = `${Math.max(top, Math.min(openUp ? rect.top - gap - popup.offsetHeight : rect.bottom + gap, bottom - popup.offsetHeight))}px`;
  }

  function openSelectPopup(select) {
    if (select.disabled || !select._ui) return;
    closeSelectPopup();
    const ui = select._ui;
    const items = selectItems(select);
    const searchable = items.filter(item => item.option).length > 8;
    const popup = document.createElement('div');
    popup.className = 'select-popup';
    popup.setAttribute('popover', 'manual');
    popup.innerHTML = `${searchable ? `<div class="select-search">${icon('search')}<input type="text" placeholder="搜索选项" aria-label="搜索选项" aria-controls="${ui.id}-list" autocomplete="off" spellcheck="false"></div>` : ''}<div class="select-list" role="listbox" id="${ui.id}-list" tabindex="-1" aria-label="${esc(ui.label || '选项')}"></div>`;
    // 在弹窗内时挂到 dialog 里，避免被模态层遮挡；popover 进入顶层后不会被表格或面板裁切。
    (select.closest('dialog') || document.body).append(popup);
    openSelect = { select, popup, items, id: ui.id, list: $('.select-list', popup), search: $('.select-search input', popup), visible: [], active: -1, typed: '', typedAt: 0 };
    renderSelectOptions();
    popup.classList.add('is-open');
    try { popup.showPopover?.(); } catch {}
    positionSelectPopup();
    ui.trigger.setAttribute('aria-expanded', 'true');
    ui.trigger.classList.add('is-open');
    // 触屏先浏览选项，点击搜索框后再弹出键盘。
    (openSelect.search && !window.matchMedia('(pointer: coarse)').matches ? openSelect.search : openSelect.list).focus({ preventScroll: true });
    if (openSelect.active >= 0) $(`#${ui.id}-opt-${openSelect.active}`, openSelect.list)?.scrollIntoView({ block: 'nearest' });

    popup.addEventListener('mousedown', event => { if (event.target !== openSelect?.search) event.preventDefault(); });
    popup.addEventListener('mousemove', event => { const node = event.target.closest('.select-option:not(.is-disabled)'); if (node && Number(node.dataset.index) !== openSelect?.active) setSelectActive(Number(node.dataset.index)); });
    popup.addEventListener('click', event => { const node = event.target.closest('.select-option'); if (node) commitSelectOption(Number(node.dataset.index)); });
    openSelect.search?.addEventListener('input', event => renderSelectOptions(event.target.value));
    popup.addEventListener('keydown', event => {
      const current = openSelect; if (!current) return;
      const last = current.visible.length - 1;
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelectActive(nextEnabledIndex(current.active, 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectActive(nextEnabledIndex(current.active, -1)); }
      else if (event.key === 'Home' && !current.search) { event.preventDefault(); setSelectActive(nextEnabledIndex(-1, 1)); }
      else if (event.key === 'End' && !current.search) { event.preventDefault(); setSelectActive(nextEnabledIndex(last + 1, -1)); }
      else if (event.key === 'PageDown') { event.preventDefault(); setSelectActive(Math.min(last, current.active + 6)); }
      else if (event.key === 'PageUp') { event.preventDefault(); setSelectActive(Math.max(0, current.active - 6)); }
      else if (event.key === 'Enter' || (event.key === ' ' && !current.search)) { event.preventDefault(); commitSelectOption(current.active); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); selectEscapeGuardUntil = performance.now() + 150; closeSelectPopup(true); }
      else if (event.key === 'Tab') { event.preventDefault(); closeSelectPopup(true); }
      else if (!current.search && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        // 未显示搜索框时支持键入首字母快速定位。
        const now = performance.now();
        current.typed = (now - current.typedAt < 600 ? current.typed : '') + event.key.toLowerCase();
        current.typedAt = now;
        const match = current.visible.findIndex(option => !option.disabled && option.textContent.trim().toLowerCase().startsWith(current.typed));
        if (match >= 0) setSelectActive(match);
      }
    });
  }

  function closeSelectPopup(focusTrigger = false) {
    const current = openSelect;
    if (!current) return false;
    openSelect = null;
    try { if (current.popup.matches(':popover-open')) current.popup.hidePopover(); } catch {}
    current.popup.remove();
    const trigger = current.select._ui?.trigger;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.classList.remove('is-open');
    if (focusTrigger && trigger?.isConnected) trigger.focus({ preventScroll: true });
    return true;
  }

  function enhanceSelects(root = document) { root.querySelectorAll?.('select:not(.select-native)').forEach(enhanceSelect); }
  new MutationObserver(records => {
    if (openSelect && !openSelect.select.isConnected) closeSelectPopup();
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.tagName === 'SELECT') enhanceSelect(node); else enhanceSelects(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', event => {
    if (!openSelect) return;
    if (openSelect.popup.contains(event.target) || openSelect.select._ui.trigger.contains(event.target)) return;
    closeSelectPopup();
  }, true);
  document.addEventListener('scroll', event => { if (openSelect && !openSelect.popup.contains(event.target)) positionSelectPopup(); }, true);
  window.addEventListener('resize', () => positionSelectPopup());
  window.visualViewport?.addEventListener('resize', positionSelectPopup);
  window.visualViewport?.addEventListener('scroll', positionSelectPopup);
  window.addEventListener('blur', () => closeSelectPopup());
  enhanceSelects();

  /* ---------- 会话、导航 ---------- */
  function showLogin(message = '') {
    if (adminDialogResolver) finishAdminDialog(null);
    state.csrf = '';
    state.admin = null;
    state.view = '';
    $('#adminApp').classList.add('hidden');
    $('#adminLogin').classList.remove('hidden');
    $('#loginError').textContent = message;
    $('#loginPassword').value = '';
    document.title = 'GuGu 管理后台';
    requestAnimationFrame(() => ($('#loginUsername').value ? $('#loginPassword') : $('#loginUsername')).focus());
  }

  async function api(path, options = {}) {
    const { timeout = 20000, skipAuthRedirect = false, ...requestOptions } = options;
    try {
      return await requestApi(path, { ...requestOptions, timeoutMs: timeout });
    } catch (error) {
      if (error.status === 401 && !skipAuthRedirect && path !== '/api/admin/auth/login') showLogin('登录已过期，请重新登录。');
      throw error;
    }
  }

  const loaders = { overview: loadOverview, users: loadUsers, orders: loadOrders, invites: loadInvites, announcements: loadAnnouncements, models: loadModels, credentials: loadCredentials, logs: loadLogs };
  const viewFromHash = () => { const name = location.hash.replace(/^#\/?/, ''); return loaders[name] ? name : 'overview'; };
  function scrollAdminToTop() {
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }
  function navigate(name) {
    if (!loaders[name]) return;
    if (location.hash !== `#/${name}`) history.pushState(null, '', `#/${name}`);
    showView(name);
  }
  function showView(name, { force = false } = {}) {
    if (!loaders[name]) return;
    if (state.view === name && !force) return;
    if (name === 'users') resetPager('users');
    if (name === 'orders') resetPager('orders');
    if (name === 'invites') resetPager('invites');
    if (name === 'logs') resetPager('log');
    state.view = name;
    scrollAdminToTop();
    document.title = `${viewTitles[name]} · GuGu 管理后台`;
    $$('.nav').forEach(button => {
      const active = button.dataset.view === name;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $$('.view').forEach(view => view.classList.toggle('hidden', view.id !== `view-${name}`));
    loaders[name]();
  }
  function enterApp(result) {
    state.csrf = result.csrfToken;
    state.admin = result.admin;
    const name = result.admin?.username || '管理员';
    $('#adminName').textContent = name;
    $('#adminAvatar').textContent = String(name).trim().slice(0, 1).toUpperCase() || 'A';
    $('#adminLogin').classList.add('hidden');
    $('#adminApp').classList.remove('hidden');
    showView(viewFromHash(), { force: true });
  }

  // 全局委托：复制、页面跳转。
  document.addEventListener('click', event => {
    const copy = event.target.closest('[data-copy]');
    if (copy) { event.preventDefault(); copyText(copy.dataset.copy, copy.dataset.copyLabel || '内容'); return; }
    const jump = event.target.closest('[data-jump]');
    if (jump) {
      if (jump.dataset.logCategory) { state.logCategory = jump.dataset.logCategory; state.filters.logs.status = jump.dataset.logStatus || ''; }
      if (jump.dataset.modelsTab) state.modelsTab = jump.dataset.modelsTab;
      state.view = '';
      navigate(jump.dataset.jump);
    }
  });
  // 按 “/” 快速聚焦当前页面的搜索框。
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || $('#adminDialog').open) return;
    const target = event.target;
    if (target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    const search = $(`#view-${state.view} [data-search]`);
    if (search) { event.preventDefault(); search.focus(); search.select?.(); }
  });
  window.addEventListener('popstate', () => { if (state.admin) showView(viewFromHash()); });

  /* ---------- 总览 ---------- */
  const overviewRanges = [['all', '全部'], ['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天']];
  async function loadOverview() {
    const root = $('#view-overview');
    root.innerHTML = pageHead('overviewTitle', '总览', '平台用户、积分、生成任务与待处理事项', `${segmented('overviewRange', overviewRanges, state.overviewRange, '统计时间范围')}${refreshButton('overview')}`) + `<div id="overviewBody">${skeletonMarkup(8)}</div>`;
    $('[data-refresh="overview"]', root).onclick = fetchOverview;
    $$('[data-seg="overviewRange"]', root).forEach(button => button.onclick = () => {
      state.overviewRange = button.dataset.value;
      $$('[data-seg="overviewRange"]', root).forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      fetchOverview();
    });
    await fetchOverview();
  }

  async function fetchOverview() {
    const body = $('#overviewBody'); if (!body) return;
    const token = nextRequest('overview');
    const refresh = $('[data-refresh="overview"]');
    setButtonBusy(refresh, true, '刷新中…');
    markLoading(body);
    const params = new URLSearchParams();
    const from = rangeStart(state.overviewRange);
    if (from) { params.set('from', inputToIso(from)); params.set('to', new Date().toISOString()); }
    const rangeLabel = overviewRanges.find(([key]) => key === state.overviewRange)?.[1] || '全部';
    try {
      const data = await api(`/api/admin/overview${params.toString() ? `?${params}` : ''}`);
      if (isStale('overview', token)) return;
      const exceptions = Number(data.exceptions.reconcile || 0) + Number(data.exceptions.refundFailed || 0);
      const finished = Number(data.generations.completed || 0) + Number(data.generations.failed || 0);
      const successRate = finished ? Math.round((Number(data.generations.completed || 0) / finished) * 1000) / 10 : null;
      const availableRate = Number(data.credits.balance) > 0 ? Math.max(0, Math.min(100, (1 - Number(data.credits.held || 0) / Number(data.credits.balance)) * 100)) : 100;
      body.innerHTML = `
        <div class="cards">
          <button class="stat" type="button" data-jump="users"><span class="stat-head">用户总数<span class="stat-icon">${icon('users')}</span></span><strong>${money(data.users.total)}</strong><span class="stat-sub">正常 ${money(data.users.active)} · 已停用 ${money(data.users.disabled)}</span></button>
          <button class="stat tone-info" type="button" data-jump="logs" data-log-category="credits"><span class="stat-head">积分余额<span class="stat-icon">${icon('wallet')}</span></span><strong>${money(data.credits.balance)}</strong><span class="stat-sub">冻结 ${money(data.credits.held)} · 消耗（${esc(rangeLabel)}）${money(data.credits.spent)}</span></button>
          <button class="stat tone-success" type="button" data-jump="logs" data-log-category="generations"><span class="stat-head">生成任务（${esc(rangeLabel)}）<span class="stat-icon">${icon('activity')}</span></span><strong>${money(data.generations.total)}</strong><span class="stat-sub">完成 ${money(data.generations.completed)} · 失败 ${money(data.generations.failed)} · 进行中 ${money(data.generations.pending)}</span></button>
          <button class="stat ${exceptions ? 'tone-danger' : 'tone-warn'}" type="button" data-jump="logs" data-log-category="system"><span class="stat-head">待处理异常<span class="stat-icon">${icon('triangle')}</span></span><strong>${money(exceptions)}</strong><span class="stat-sub">待核账 ${money(data.exceptions.reconcile)} · 退款失败 ${money(data.exceptions.refundFailed)}</span></button>
        </div>
        <div class="overview-grid">
          <section class="overview-card"><h3>任务质量</h3><p>${esc(rangeLabel)}内已结束任务的成功率</p>
            <div class="meter-caption"><span>成功率</span><b>${successRate === null ? '暂无数据' : `${successRate}%`}</b></div>
            <div class="meter${successRate !== null && successRate < 90 ? ' is-warn' : ''}"><span style="width:${successRate ?? 0}%"></span></div>
            <div class="kv-list" style="margin-top:10px"><div class="kv-row"><span>已完成</span><strong>${money(data.generations.completed)}</strong></div><div class="kv-row"><span>失败</span><strong>${money(data.generations.failed)}</strong></div><div class="kv-row"><span>排队 / 运行中</span><strong>${money(data.generations.pending)}</strong></div></div>
          </section>
          <section class="overview-card"><h3>账务与系统</h3><p>需要人工关注的事项</p>
            <div class="meter-caption"><span>可用积分占比</span><b>${Math.round(availableRate)}%</b></div>
            <div class="meter is-brand"><span style="width:${availableRate}%"></span></div>
            <div class="kv-list" style="margin-top:10px"><div class="kv-row"><span>待核账</span>${Number(data.exceptions.reconcile) ? pill(`${money(data.exceptions.reconcile)} 项`, 'warn') : pill('无', 'ok')}</div><div class="kv-row"><span>退款失败</span>${Number(data.exceptions.refundFailed) ? pill(`${money(data.exceptions.refundFailed)} 项`, 'bad') : pill('无', 'ok')}</div><div class="kv-row"><span>系统错误日志</span>${Number(data.exceptions.systemErrors) ? `<button class="btn btn-sm" type="button" data-jump="logs" data-log-category="system" data-log-status="error">查看 ${money(data.exceptions.systemErrors)} 条</button>` : pill('无', 'ok')}</div></div>
          </section>
          <section class="overview-card"><h3>常用操作</h3><p>快速进入高频管理页面</p>
            <div class="shortcut-list">
              <button class="shortcut" type="button" data-jump="users">${icon('users')}查找用户或调整积分</button>
              <button class="shortcut" type="button" data-jump="orders">${icon('card')}查看付费订单</button>
              <button class="shortcut" type="button" data-jump="models" data-models-tab="routes">${icon('box')}检查模型线路</button>
              <button class="shortcut" type="button" data-jump="invites">${icon('ticket')}创建邀请码</button>
              <button class="shortcut" type="button" data-jump="announcements">${icon('megaphone')}发布消息通知</button>
            </div>
          </section>
        </div>
        <p class="muted" style="margin:14px 2px 0">数据更新于 ${esc(new Date().toLocaleTimeString('zh-CN', { hour12: false }))}；用户数与积分余额为当前值，任务与消耗按所选时间范围统计。</p>`;
      doneLoading(body);
    } catch (error) {
      if (isStale('overview', token)) return;
      doneLoading(body);
      body.innerHTML = errorMarkup(error.message, 'overview');
      bindRetry(body, 'overview', fetchOverview);
    } finally {
      if (!isStale('overview', token)) setButtonBusy(refresh, false);
    }
  }

  /* ---------- 用户 ---------- */
  async function loadUsers() {
    const root = $('#view-users');
    const filters = state.filters.users;
    root.innerHTML = pageHead('usersTitle', '用户管理', '查询账号、余额与消耗，处理积分调账和账号状态', refreshButton('users')) + `
      <div class="panel">
        <form id="userFilters" class="toolbar" role="search">
          <label class="field is-wide"><span class="field-label">搜索</span><span class="search-input">${icon('search')}<input id="userQuery" data-search value="${esc(filters.query)}" placeholder="用户名或完整用户 ID（按 / 快速聚焦）" autocomplete="off" spellcheck="false"></span></label>
          <label class="field"><span class="field-label">账号状态</span><select id="userStatus"><option value="">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option></select></label>
          <label class="field"><span class="field-label">角色</span><select id="userRole"><option value="">全部角色</option><option value="user">普通用户</option><option value="admin">管理员</option></select></label>
          <div class="toolbar-actions"><button class="btn btn-ghost" type="button" data-reset>${icon('rotate')}重置</button><button class="btn btn-primary" type="submit">${icon('search')}查询</button></div>
        </form>
        <div id="userTable" data-table>${skeletonMarkup()}</div>
      </div>`;
    $('#userStatus').value = filters.status;
    $('#userRole').value = filters.role;
    const apply = () => { filters.query = $('#userQuery').value.trim(); filters.status = $('#userStatus').value; filters.role = $('#userRole').value; resetPager('users'); fetchUsers(); };
    $('#userFilters').onsubmit = event => { event.preventDefault(); apply(); };
    $('#userQuery').addEventListener('input', debounce(apply, 400));
    $('#userStatus').onchange = $('#userRole').onchange = apply;
    $('[data-reset]', root).onclick = () => { $('#userQuery').value = ''; $('#userStatus').value = ''; $('#userRole').value = ''; apply(); };
    $('[data-refresh="users"]', root).onclick = fetchUsers;
    await fetchUsers();
  }

  async function fetchUsers() {
    const table = $('#userTable'); if (!table) return;
    const filters = state.filters.users;
    const token = nextRequest('users');
    const params = new URLSearchParams({ limit: '50' });
    if (filters.query) params.set('query', filters.query);
    if (filters.status) params.set('status', filters.status);
    if (filters.role) params.set('role', filters.role);
    if (currentCursor('users')) params.set('cursor', currentCursor('users'));
    markLoading(table);
    try {
      const data = await api(`/api/admin/users?${params}`);
      if (isStale('users', token)) return;
      const items = data.items || [];
      const filtered = filters.query || filters.status || filters.role;
      table.innerHTML = items.length ? `<div class="table-wrap"><table aria-label="用户列表"><thead><tr><th>用户</th><th>状态</th><th class="is-num">当前余额</th><th class="is-num">可用</th><th class="is-num">冻结</th><th class="is-num">累计消耗</th><th>注册时间</th><th class="is-actions">操作</th></tr></thead><tbody>${items.map(user => `<tr>
          <td><div class="cell-user"><span class="avatar" aria-hidden="true">${initial(user.nickname || user.username)}</span><div class="cell-stack"><span><button class="link-button" type="button" data-user-detail="${esc(user.id)}" title="查看用户详情">${userIdentity(user)}</button>${user.role === 'admin' ? ' <span class="tag is-brand">管理员</span>' : ''}</span>${idText(user.id, '用户 ID')}</div></div></td>
          <td>${badge(user.status)}</td>
          <td class="is-num"><b>${money(user.credits)}</b></td>
          <td class="is-num">${money(user.available)}</td>
          <td class="is-num">${Number(user.held) ? `<span class="warn-text">${money(user.held)}</span>` : money(user.held)}</td>
          <td class="is-num">${money(user.totalSpent)}</td>
          <td>${date(user.createdAt)}</td>
          <td class="is-actions"><div class="actions"><button class="btn btn-sm" data-user-detail="${esc(user.id)}" type="button">详情</button><button class="btn btn-sm" data-user-adjust="${esc(user.id)}" type="button">调账</button>${user.status === 'active' ? `<button class="btn btn-sm btn-danger-ghost" data-user-disable="${esc(user.id)}" type="button">停用</button>` : `<button class="btn btn-sm" data-user-enable="${esc(user.id)}" type="button">启用</button>`}</div></td>
        </tr>`).join('')}</tbody></table></div>${pageControls('users', data.total, data.nextCursor, items.length)}`
        : emptyMarkup(filtered ? '没有符合条件的用户' : '还没有用户', filtered ? '换个关键词，或清除状态和角色筛选后再试。' : '用户注册后会显示在这里。', filtered ? '<button class="btn btn-sm" type="button" data-empty-reset>清除筛选</button>' : '');
      doneLoading(table);
      const findUser = id => items.find(item => item.id === id);
      $$('[data-user-detail]', table).forEach(button => button.onclick = () => showUser(button.dataset.userDetail));
      $$('[data-user-adjust]', table).forEach(button => button.onclick = () => showCreditAdjustment(button.dataset.userAdjust, findUser(button.dataset.userAdjust)));
      $$('[data-user-disable]', table).forEach(button => button.onclick = () => changeUser(findUser(button.dataset.userDisable), 'disable'));
      $$('[data-user-enable]', table).forEach(button => button.onclick = () => changeUser(findUser(button.dataset.userEnable), 'enable'));
      $('[data-empty-reset]', table)?.addEventListener('click', () => $('#view-users [data-reset]')?.click());
      bindPageControls(table, 'users', fetchUsers, data.nextCursor);
    } catch (error) {
      if (isStale('users', token)) return;
      doneLoading(table);
      table.innerHTML = errorMarkup(error.message, 'users');
      bindRetry(table, 'users', fetchUsers);
    }
  }

  function userDetailHtml(user) {
    const credits = (user.recentCredits || []).slice(0, 6).map(entry => {
      const amount = entry.amount !== undefined ? Number(entry.amount) : null;
      return `<div class="user-recent-item"><span>${esc(entry.note || entry.reasonCode || entry.type || '积分流水')}</span><span>${amount !== null ? `<b class="${amount < 0 ? 'danger-text' : 'success-text'}">${amount >= 0 ? '+' : ''}${money(amount)}</b> · ` : ''}${date(entry.createdAt || entry.created_at)}</span></div>`;
    }).join('');
    const generations = (user.recentGenerations || []).slice(0, 6).map(item => `<div class="user-recent-item"><span>${badge(item.status)}<span>${esc(item.modelId || item.type || item.id)}</span></span><span>${date(item.createdAt)}</span></div>`).join('');
    const name = user.nickname || user.username || 'U';
    return `<div class="user-detail-identity"><span class="avatar is-lg" aria-hidden="true">${initial(name)}</span><div class="user-detail-identity-main"><strong>${userIdentity(user)}</strong><span class="user-detail-status">${badge(user.status)}${user.role === 'admin' ? '<span class="tag is-brand">管理员</span>' : ''}<span>注册于 ${date(user.createdAt)}</span></span>${idText(user.id, '用户 ID')}</div></div>
      <div class="user-detail-grid">
        <div class="user-detail-metric"><small>当前余额</small><strong>${money(user.credits)}</strong></div>
        <div class="user-detail-metric"><small>可用余额</small><strong>${money(user.available)}</strong></div>
        <div class="user-detail-metric"><small>冻结积分</small><strong>${money(user.held)}</strong></div>
        <div class="user-detail-metric"><small>累计消耗</small><strong>${money(user.totalSpent)}</strong></div>
        <div class="user-detail-metric"><small>生成任务</small><strong>${money(user.generations)}</strong></div>
        <div class="user-detail-metric"><small>积分流水</small><strong>${money(user.creditEntries)}</strong></div>
        <div class="user-detail-metric"><small>LLM 调用</small><strong>${money(user.llmUsage)}</strong></div>
        <div class="user-detail-metric"><small>注册邀请码</small><strong title="${esc(user.inviteCode || '')}">${esc(user.inviteCode || '—')}</strong></div>
      </div>
      <div class="user-recent"><h3>最近生成记录</h3><div class="user-recent-list">${generations || emptyMarkup('暂无生成记录')}</div></div>
      <div class="user-recent"><h3>最近积分流水</h3><div class="user-recent-list">${credits || emptyMarkup('暂无积分流水')}</div></div>`;
  }

  async function showUser(id) {
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(id)}`);
      const user = data.user;
      const result = await showAdminDialog({ kicker: '用户详情', title: user.nickname || user.username, description: '', size: 'wide', html: userDetailHtml(user), submit: '积分调账', cancel: '关闭' });
      if (result) showCreditAdjustment(id, user);
    } catch (error) { toastError(error); }
  }

  async function showCreditAdjustment(id, existingUser = null) {
    let user = existingUser;
    if (!user) {
      try { user = (await api(`/api/admin/users/${encodeURIComponent(id)}`)).user; } catch (error) { toastError(error); return; }
    }
    const balance = Number(user.credits || 0);
    await showAdminDialog({
      kicker: '积分调账',
      title: `调整 ${user.nickname || user.username} 的积分`,
      description: '增加请输入正数，扣减请输入负数。调账会记入积分流水和审计日志。',
      submit: '确认调账',
      busyLabel: '提交中…',
      fields: [
        { name: 'amount', label: '调整数量', type: 'text', value: '', placeholder: '例如 100 或 -50', inputmode: 'decimal', required: true, help: '不能为 0，最多 6 位小数。' },
        { name: 'reasonCode', label: '调整原因', type: 'select', value: 'customer_service', options: [{ value: 'customer_service', label: '客服补偿', hint: '处理用户反馈、服务异常后的补偿' }, { value: 'promotion', label: '运营赠送', hint: '活动奖励、渠道合作赠送' }, { value: 'correction', label: '账务修正', hint: '纠正错误扣费或重复到账' }, { value: 'refund', label: '退款补发', hint: '退款后需要补回的积分' }, { value: 'other', label: '其他', hint: '请在备注中说明原因' }] },
        { name: 'note', label: '备注', type: 'textarea', value: '', placeholder: '说明本次调账的原因，便于日后核对。', help: '备注会显示在积分流水和审计记录中。' },
      ],
      onRender: body => {
        const amountField = $('[data-admin-dialog-field="amount"]', body);
        amountField.closest('.admin-dialog-field').insertAdjacentHTML('beforeend', `<div class="adjust-quick">${['+100', '+500', '+1000', '-100'].map(value => `<button class="chip" type="button" data-quick-amount="${value}">${value}</button>`).join('')}</div>`);
        body.insertAdjacentHTML('beforeend', '<div class="adjust-preview" data-adjust-preview aria-live="polite"></div>');
        const preview = $('[data-adjust-preview]', body);
        const update = () => {
          const raw = String(amountField.value).trim();
          const valid = /^-?\d+(?:\.\d{1,6})?$/.test(raw) && Number(raw) !== 0;
          const next = valid ? Math.round((balance + Number(raw)) * 1e6) / 1e6 : balance;
          preview.className = `adjust-preview${valid ? (Number(raw) > 0 ? ' is-up' : ' is-down') : ''}`;
          preview.innerHTML = `<span>当前余额 ${money(balance)}</span><span>调整后 <b>${money(next)}</b></span>`;
        };
        amountField.addEventListener('input', update);
        $$('[data-quick-amount]', body).forEach(button => button.onclick = () => { amountField.value = button.dataset.quickAmount.replace('+', ''); update(); amountField.focus(); });
        update();
      },
      validate: values => /^-?\d+(?:\.\d{1,6})?$/.test(String(values.amount).trim()) && Number(values.amount) !== 0 ? null : '调整数量必须是非零数字，最多 6 位小数。',
      onSubmit: async values => {
        const result = await api(`/api/admin/users/${encodeURIComponent(id)}/credit-adjustments`, { method: 'POST', body: JSON.stringify({ amount: String(values.amount).trim(), note: values.note, reasonCode: values.reasonCode, idempotencyKey: crypto.randomUUID() }) });
        toast(`调账完成，当前余额 ${money(result.balance)}`);
        await fetchUsers();
      },
    });
  }

  async function changeUser(user, action) {
    if (!user) return;
    const disabling = action === 'disable';
    await showAdminDialog({
      kicker: '账号状态',
      title: disabling ? '停用该用户？' : '恢复该用户？',
      description: '',
      html: `<p class="admin-dialog-confirmation${disabling ? ' is-danger' : ''}"><b>${userIdentity(user)}</b><br>${disabling ? '停用后该用户会立即退出登录，无法继续使用客户端，账户余额会保留。' : '恢复后该用户可以重新登录并正常使用。'}</p>`,
      submit: disabling ? '确认停用' : '确认恢复',
      busyLabel: '处理中…',
      danger: disabling,
      tone: disabling ? '' : 'info',
      size: 'narrow',
      onSubmit: async () => { await api(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, { method: 'POST', body: '{}' }); toast(disabling ? '用户已停用' : '用户已恢复'); await fetchUsers(); },
    });
  }

  /* ---------- 付费订单 ---------- */
  function quickRangeChips(name, filters) {
    const active = activeQuickRange(filters);
    return `<div class="toolbar-row"><span class="toolbar-label">快速选择</span><div class="chips">${quickRanges.map(([key, label]) => `<button class="chip" type="button" data-quick-range="${name}" data-value="${key}" aria-pressed="${String(active === key)}">${label}</button>`).join('')}<button class="chip" type="button" data-quick-range="${name}" data-value="" aria-pressed="${String(!filters.from && !filters.to)}">全部时间</button></div></div>`;
  }

  async function loadOrders() {
    const root = $('#view-orders');
    const filters = state.filters.orders;
    root.innerHTML = pageHead('ordersTitle', '付费订单', '查看支付成功的订单、金额与退款情况', refreshButton('orders')) + `
      <div class="panel">
        <form id="orderFilters" class="toolbar" role="search">
          <label class="field is-wide"><span class="field-label">搜索</span><span class="search-input">${icon('search')}<input id="orderQuery" data-search value="${esc(filters.query)}" placeholder="用户名、用户 ID 或订单号" autocomplete="off" spellcheck="false"></span></label>
          <label class="field is-date"><span class="field-label">支付时间起</span><input id="orderFrom" type="datetime-local" value="${esc(filters.from)}"></label>
          <label class="field is-date"><span class="field-label">支付时间止</span><input id="orderTo" type="datetime-local" value="${esc(filters.to)}"></label>
          <div class="toolbar-actions"><button class="btn btn-ghost" type="button" data-reset>${icon('rotate')}重置</button><button class="btn btn-primary" type="submit">${icon('search')}查询</button></div>
          <div id="orderQuickRange" style="width:100%">${quickRangeChips('orders', filters)}</div>
        </form>
        <div id="orderTable" data-table>${skeletonMarkup()}</div>
      </div>`;
    const apply = () => {
      filters.query = $('#orderQuery').value.trim(); filters.from = $('#orderFrom').value; filters.to = $('#orderTo').value;
      $('#orderQuickRange').innerHTML = quickRangeChips('orders', filters);
      bindQuick();
      resetPager('orders'); fetchOrders();
    };
    const bindQuick = () => $$('[data-quick-range="orders"]', root).forEach(button => button.onclick = () => { $('#orderFrom').value = rangeStart(button.dataset.value); $('#orderTo').value = ''; apply(); });
    bindQuick();
    $('#orderFilters').onsubmit = event => { event.preventDefault(); apply(); };
    $('#orderQuery').addEventListener('input', debounce(apply, 400));
    $('#orderFrom').onchange = $('#orderTo').onchange = apply;
    $('[data-reset]', root).onclick = () => { $('#orderQuery').value = ''; $('#orderFrom').value = ''; $('#orderTo').value = ''; apply(); };
    $('[data-refresh="orders"]', root).onclick = fetchOrders;
    await fetchOrders();
  }

  async function fetchOrders() {
    const table = $('#orderTable'); if (!table) return;
    const filters = state.filters.orders;
    const token = nextRequest('orders');
    const params = new URLSearchParams({ limit: '50' });
    if (filters.query) params.set('query', filters.query);
    if (filters.from) params.set('from', inputToIso(filters.from));
    if (filters.to) params.set('to', inputToIso(filters.to));
    if (currentCursor('orders')) params.set('cursor', currentCursor('orders'));
    markLoading(table);
    try {
      const data = await api(`/api/admin/payment-orders?${params}`);
      if (isStale('orders', token)) return;
      const items = data.items || [];
      const summary = data.summary || {};
      const summaryMarkup = `<div class="cards" style="padding:16px 18px 0;margin-bottom:16px"><div class="stat is-compact"><span class="stat-head">成功订单</span><strong>${money(data.total)}</strong><span class="stat-sub">付费用户 ${money(summary.payingUsers)} 人</span></div><div class="stat is-compact"><span class="stat-head">支付总额</span><strong>${yuan(summary.totalAmount)}</strong><span class="stat-sub">订单原始支付金额</span></div><div class="stat is-compact"><span class="stat-head">退款金额</span><strong>${yuan(summary.refundedAmount)}</strong><span class="stat-sub">含部分与全额退款</span></div><div class="stat is-compact tone-success"><span class="stat-head">净收款</span><strong>${yuan(summary.netAmount)}</strong><span class="stat-sub">支付总额扣除退款</span></div></div>`;
      const filtered = filters.query || filters.from || filters.to;
      table.innerHTML = summaryMarkup + (items.length ? `<div class="table-wrap" style="border-width:1px 0 0;border-radius:0"><table class="payment-table" aria-label="付费订单列表" style="min-width:1100px"><thead><tr><th>用户</th><th class="is-num">支付金额</th><th class="is-num">购买积分</th><th>状态</th><th>支付时间</th><th>商户订单号</th><th>支付宝交易号</th></tr></thead><tbody>${items.map(order => `<tr>
          <td><div class="cell-stack"><b>${esc(order.username || '—')}</b>${idText(order.userId, '用户 ID')}</div></td>
          <td class="is-num"><b>${yuan(order.amount)}</b>${order.refundedAmount ? `<div class="detail">已退 ${yuan(order.refundedAmount)} · 净额 ${yuan(order.netAmount)}</div>` : ''}</td>
          <td class="is-num">${money(order.credits)}</td>
          <td>${badge(order.status, order.status === 'PAID' ? 'ok' : 'warn')}</td>
          <td>${date(order.paidAt)}</td>
          <td>${idText(order.orderNo, '订单号', true)}</td>
          <td>${idText(order.tradeNo, '交易号')}</td>
        </tr>`).join('')}</tbody></table></div>${pageControls('orders', data.total, data.nextCursor, items.length)}`
        : emptyMarkup(filtered ? '没有符合条件的订单' : '暂无支付成功的订单', filtered ? '调整关键词或支付时间范围后再试。' : '用户完成支付后会显示在这里。'));
      doneLoading(table);
      bindPageControls(table, 'orders', fetchOrders, data.nextCursor);
    } catch (error) {
      if (isStale('orders', token)) return;
      doneLoading(table);
      table.innerHTML = errorMarkup(error.message, 'orders');
      bindRetry(table, 'orders', fetchOrders);
    }
  }

  /* ---------- 邀请码 ---------- */
  async function loadInvites() {
    const root = $('#view-invites');
    const filters = state.filters.invites;
    root.innerHTML = pageHead('invitesTitle', '邀请码', '管理注册名额、有效期和注册赠送积分', `${refreshButton('invites')}<button class="btn btn-primary" id="addInvite" type="button">${icon('plus')}新建邀请码</button>`) + `
      <div class="panel">
        <form id="inviteFilters" class="toolbar" role="search">
          <label class="field is-wide"><span class="field-label">搜索</span><span class="search-input">${icon('search')}<input id="inviteQuery" data-search value="${esc(filters.query)}" placeholder="输入邀请码" autocomplete="off" spellcheck="false" autocapitalize="characters"></span></label>
          <label class="field"><span class="field-label">启用状态</span><select id="inviteEnabled"><option value="">全部</option><option value="1">已启用</option><option value="0">已停用</option></select></label>
          <div class="toolbar-actions"><button class="btn btn-ghost" type="button" data-reset>${icon('rotate')}重置</button><button class="btn btn-primary" type="submit">${icon('search')}查询</button></div>
        </form>
        <div id="inviteTable" data-table>${skeletonMarkup()}</div>
      </div>`;
    $('#inviteEnabled').value = filters.enabled;
    const apply = () => { filters.query = $('#inviteQuery').value.trim(); filters.enabled = $('#inviteEnabled').value; resetPager('invites'); fetchInvites(); };
    $('#inviteFilters').onsubmit = event => { event.preventDefault(); apply(); };
    $('#inviteQuery').addEventListener('input', debounce(apply, 400));
    $('#inviteEnabled').onchange = apply;
    $('[data-reset]', root).onclick = () => { $('#inviteQuery').value = ''; $('#inviteEnabled').value = ''; apply(); };
    $('[data-refresh="invites"]', root).onclick = fetchInvites;
    $('#addInvite').onclick = createInvite;
    await fetchInvites();
  }

  async function createInvite() {
    const created = await showAdminDialog({
      kicker: '邀请码',
      title: '新建邀请码',
      description: '邀请码可用于新用户注册，注册成功后自动赠送积分。',
      submit: '创建',
      busyLabel: '创建中…',
      fields: [
        { name: 'code', label: '邀请码', type: 'text', value: '', placeholder: '留空自动生成', maxLength: 64, autocapitalize: 'characters', help: '仅支持字母、数字和连字符，保存时自动转为大写。' },
        { name: 'maxUses', label: '可使用次数', type: 'number', value: '1', min: 1, step: 1, inputmode: 'numeric', required: true },
        { name: 'signupBonus', label: '注册赠送积分', type: 'text', value: '50', inputmode: 'decimal', required: true },
        { name: 'expiresAt', label: '有效期至', type: 'datetime-local', value: '', help: '留空表示长期有效。' },
        { name: 'note', label: '备注', type: 'textarea', value: '', placeholder: '例如：渠道合作、活动名称', maxLength: 500 },
      ],
      validate: values => {
        if (values.code.trim() && !/^[A-Za-z0-9-]+$/.test(values.code.trim())) return '邀请码只能包含字母、数字和连字符。';
        const uses = Number(values.maxUses);
        if (!Number.isSafeInteger(uses) || uses < 1) return '可使用次数必须是大于 0 的整数。';
        const bonus = Number(values.signupBonus);
        if (!Number.isFinite(bonus) || bonus < 0) return '注册赠送积分必须是不小于 0 的数字。';
        if (values.expiresAt && new Date(values.expiresAt) <= new Date()) return '有效期需要晚于当前时间。';
        return null;
      },
      onSubmit: async values => {
        const data = await api('/api/admin/invite-codes', { method: 'POST', body: JSON.stringify({ code: values.code.trim(), maxUses: Number(values.maxUses), signupBonus: values.signupBonus, expiresAt: values.expiresAt ? inputToIso(values.expiresAt) : null, note: values.note }) });
        return data.invite;
      },
    });
    if (!created?.code) return;
    resetPager('invites');
    fetchInvites();
    const copy = await showAdminDialog({ kicker: '邀请码', title: '邀请码已创建', tone: 'success', size: 'narrow', html: `<div class="invite-created"><code>${esc(created.code)}</code><span>可使用 ${money(created.maxUses)} 次 · 注册赠送 ${money(created.signupBonus)} 积分${created.expiresAt ? ` · ${date(created.expiresAt)} 前有效` : ' · 长期有效'}</span></div>`, submit: '复制邀请码', cancel: '完成' });
    if (copy) copyText(created.code, '邀请码');
  }

  async function fetchInvites() {
    const table = $('#inviteTable'); if (!table) return;
    const filters = state.filters.invites;
    const token = nextRequest('invites');
    const params = new URLSearchParams({ limit: '50' });
    if (filters.query) params.set('query', filters.query);
    if (filters.enabled) params.set('enabled', filters.enabled);
    if (currentCursor('invites')) params.set('cursor', currentCursor('invites'));
    markLoading(table);
    try {
      const data = await api(`/api/admin/invite-codes?${params}`);
      if (isStale('invites', token)) return;
      const items = data.items || [];
      const filtered = filters.query || filters.enabled;
      table.innerHTML = items.length ? `<div class="table-wrap"><table aria-label="邀请码列表"><thead><tr><th>邀请码</th><th>状态</th><th>使用情况</th><th class="is-num">注册赠送</th><th>有效期至</th><th>备注</th><th>创建时间</th><th class="is-actions">操作</th></tr></thead><tbody>${items.map(invite => {
        const percent = invite.maxUses ? Math.min(100, (invite.usedCount / invite.maxUses) * 100) : 0;
        return `<tr>
          <td>${idText(invite.code, '邀请码', true)}</td>
          <td>${badge(invite.status)}</td>
          <td><div class="usage"><span>${money(invite.usedCount)} / ${money(invite.maxUses)}</span><div class="meter${percent >= 100 ? ' is-warn' : ' is-brand'}"><span style="width:${percent}%"></span></div></div></td>
          <td class="is-num">${money(invite.signupBonus)}</td>
          <td>${invite.expiresAt ? date(invite.expiresAt) : '<span class="muted">长期有效</span>'}</td>
          <td><span class="cell-clip" title="${esc(invite.note || '')}">${plain(invite.note)}</span></td>
          <td>${date(invite.createdAt)}</td>
          <td class="is-actions"><div class="actions"><button class="btn btn-sm" data-invite-uses="${esc(invite.code)}" type="button">使用记录</button>${invite.enabled ? `<button class="btn btn-sm btn-danger-ghost" data-invite-code="${esc(invite.code)}" data-invite-enabled="true" type="button">停用</button>` : `<button class="btn btn-sm" data-invite-code="${esc(invite.code)}" data-invite-enabled="false" type="button">启用</button>`}</div></td>
        </tr>`;
      }).join('')}</tbody></table></div>${pageControls('invites', data.total, data.nextCursor, items.length)}`
        : emptyMarkup(filtered ? '没有符合条件的邀请码' : '还没有邀请码', filtered ? '换个关键词或状态后再试。' : '创建邀请码后，新用户即可使用它注册。', filtered ? '' : `<button class="btn btn-primary btn-sm" type="button" data-empty-create>${icon('plus')}新建邀请码</button>`);
      doneLoading(table);
      $('[data-empty-create]', table)?.addEventListener('click', createInvite);
      $$('[data-invite-uses]', table).forEach(button => button.onclick = () => showInviteUses(button.dataset.inviteUses));
      $$('[data-invite-code]', table).forEach(button => button.onclick = () => toggleInvite(button.dataset.inviteCode, button.dataset.inviteEnabled === 'true'));
      bindPageControls(table, 'invites', fetchInvites, data.nextCursor);
    } catch (error) {
      if (isStale('invites', token)) return;
      doneLoading(table);
      table.innerHTML = errorMarkup(error.message, 'invites');
      bindRetry(table, 'invites', fetchInvites);
    }
  }

  async function toggleInvite(code, enabled) {
    const nextEnabled = !enabled;
    await showAdminDialog({
      kicker: '邀请码',
      title: nextEnabled ? '启用邀请码？' : '停用邀请码？',
      html: `<p class="admin-dialog-confirmation${nextEnabled ? '' : ' is-danger'}"><code>${esc(code)}</code><br>${nextEnabled ? '启用后可以继续用于注册。' : '停用后将不能再用于注册，已注册的用户不受影响。'}</p>`,
      submit: nextEnabled ? '确认启用' : '确认停用',
      busyLabel: '处理中…',
      danger: !nextEnabled,
      tone: nextEnabled ? 'info' : '',
      size: 'narrow',
      onSubmit: async () => { await api(`/api/admin/invite-codes/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: nextEnabled }) }); toast(`邀请码已${nextEnabled ? '启用' : '停用'}`); await fetchInvites(); },
    });
  }

  async function showInviteUses(code) {
    try {
      const data = await api(`/api/admin/invite-codes/${encodeURIComponent(code)}/uses`);
      const items = data.items || [];
      await showAdminDialog({ kicker: '邀请码', title: `${code} 的使用记录`, description: items.length ? `共 ${items.length} 次使用` : '', size: 'wide', submit: '关闭', hideCancel: true, html: items.length ? `<div class="table-wrap"><table style="min-width:520px"><thead><tr><th>用户</th><th class="is-num">赠送积分</th><th>使用时间</th></tr></thead><tbody>${items.map(item => `<tr><td><div class="cell-stack"><b>${esc(item.username || '—')}</b>${idText(item.userId, '用户 ID')}</div></td><td class="is-num">${money(item.bonus)}</td><td>${date(item.usedAt)}</td></tr>`).join('')}</tbody></table></div>` : emptyMarkup('暂无使用记录', '还没有用户使用这个邀请码注册。') });
    } catch (error) { toastError(error); }
  }

  /* ---------- 消息通知 ---------- */
  function announcementStatusKind(value) { return value === 'published' ? 'ok' : value === 'archived' ? 'muted' : 'warn'; }
  function richTextPlainText(html) {
    const node = document.createElement('div');
    node.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
    return String(node.textContent || '').replace(/\u00a0/g, ' ').trim();
  }
  function announcementEditorMarkup() {
    const tool = (command, iconName, title, value = '') => `<button type="button" data-rich-command="${command}"${value ? ` data-rich-value="${value}"` : ''} title="${title}" aria-label="${title}">${icon(iconName)}</button>`;
    return `<div class="announcement-editor-field">
      <label class="admin-dialog-field" for="adminAnnouncementTitle"><span>标题<span class="required" aria-hidden="true">*</span></span><input id="adminAnnouncementTitle" data-admin-dialog-field="title" maxlength="120" placeholder="例如：视频模型维护通知" required autocomplete="off"><small>标题会显示在用户的通知列表和详情顶部。</small></label>
      <div class="admin-dialog-field"><span id="adminAnnouncementEditorLabel">正文<span class="required" aria-hidden="true">*</span></span>
        <div class="announcement-editor" data-announcement-editor>
          <div class="announcement-editor-toolbar" role="toolbar" aria-label="正文格式">
            ${tool('bold', 'bold', '加粗')}${tool('italic', 'italic', '斜体')}${tool('underline', 'underline', '下划线')}
            <span class="announcement-editor-divider" aria-hidden="true"></span>
            ${tool('insertUnorderedList', 'list', '无序列表')}${tool('insertOrderedList', 'listOrdered', '有序列表')}${tool('formatBlock', 'quote', '引用', 'blockquote')}${tool('removeFormat', 'clearFormat', '清除格式')}
            <span class="announcement-editor-divider" aria-hidden="true"></span>
            <button type="button" data-rich-image title="插入图片">${icon('image')}<span>图片</span></button>
            <input data-rich-image-input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          </div>
          <div id="adminAnnouncementEditor" class="announcement-editor-input" data-admin-dialog-field="content" contenteditable="true" role="textbox" aria-multiline="true" aria-required="true" aria-labelledby="adminAnnouncementEditorLabel" data-placeholder="输入通知内容，支持格式和图片。"></div>
          <div class="announcement-editor-meta"><small>图片会自动压缩后插入正文。</small><small><b data-rich-count>0</b> / 500,000 字</small></div>
        </div>
      </div>
      <label class="admin-dialog-field" for="adminAnnouncementStatus" style="max-width:320px"><span>发布状态</span><select id="adminAnnouncementStatus" data-admin-dialog-field="status"><option value="draft" data-hint="仅管理员可见，可继续编辑">草稿</option><option value="published" data-hint="所有用户都能在消息通知中看到">发布</option><option value="archived" data-hint="从用户端撤下，保留历史记录">归档</option></select></label>
    </div>`;
  }
  function announcementPlainToHtml(value) { return esc(String(value || '')).replace(/\n/g, '<br>'); }
  function rememberAnnouncementSelection(editor) {
    const selection = editor?.ownerDocument?.getSelection?.();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
    editor._announcementRange = selection.getRangeAt(0).cloneRange();
  }
  function restoreAnnouncementSelection(editor) {
    editor.focus({ preventScroll: true });
    const selection = editor.ownerDocument.getSelection();
    selection.removeAllRanges();
    if (editor._announcementRange && editor.contains(editor._announcementRange.commonAncestorContainer)) selection.addRange(editor._announcementRange);
    else { const range = editor.ownerDocument.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.addRange(range); }
  }
  function insertAnnouncementHtml(editor, html) {
    restoreAnnouncementSelection(editor);
    editor.ownerDocument.execCommand('insertHTML', false, html);
    rememberAnnouncementSelection(editor);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
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
    const container = editor.closest('[data-announcement-editor]');
    editor.innerHTML = /<\/?[a-z][^>]*>/i.test(String(initialContent || '')) ? String(initialContent) : announcementPlainToHtml(initialContent);
    const updateCount = () => { const counter = $('[data-rich-count]', container); if (counter) counter.textContent = richTextPlainText(editor.innerHTML).length.toLocaleString('zh-CN'); };
    editor.addEventListener('keyup', () => rememberAnnouncementSelection(editor));
    editor.addEventListener('mouseup', () => rememberAnnouncementSelection(editor));
    editor.addEventListener('input', updateCount);
    $$('[data-rich-command]', container).forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => { restoreAnnouncementSelection(editor); editor.ownerDocument.execCommand(button.dataset.richCommand, false, button.dataset.richValue || null); rememberAnnouncementSelection(editor); updateCount(); });
    });
    const imageInput = $('[data-rich-image-input]', container);
    const imageButton = $('[data-rich-image]', container);
    imageButton?.addEventListener('mousedown', event => event.preventDefault());
    imageButton?.addEventListener('click', () => { rememberAnnouncementSelection(editor); imageInput?.click(); });
    imageInput?.addEventListener('change', async () => {
      const file = imageInput.files?.[0];
      imageInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'error'); return; }
      setButtonBusy(imageButton, true, '处理中');
      try {
        const src = await readAnnouncementImage(file);
        if (src.length > 420_000) throw new Error('图片压缩后仍然过大，请选择尺寸更小的图片');
        insertAnnouncementHtml(editor, `<img src="${src}" alt="${esc(file.name.replace(/\.[^.]+$/, ''))}"><br>`);
        toast('图片已插入');
      } catch (error) { toast(error.message || '图片插入失败', 'error'); }
      finally { setButtonBusy(imageButton, false); }
    });
    updateCount();
  }
  async function editAnnouncement(announcement = null) {
    const editing = Boolean(announcement);
    const dialog = showAdminDialog({
      kicker: '消息通知',
      title: editing ? '编辑公告' : '新增公告',
      description: editing ? '保存后用户端会立即显示最新内容，用户的已读状态会保留。' : '发布后所有用户都能在消息通知中看到这条公告。',
      submit: editing ? '保存' : '创建',
      busyLabel: '保存中…',
      size: 'wide',
      html: announcementEditorMarkup(),
      validate: values => values.title.trim() ? (richTextPlainText(values.content) || /<img\b/i.test(values.content) ? null : '请填写公告正文。') : '请填写公告标题。',
      onSubmit: async values => {
        const body = { title: values.title, content: values.content, status: values.status };
        if (editing) await api(`/api/admin/announcements/${encodeURIComponent(announcement.id)}`, { method: 'PATCH', body: JSON.stringify({ ...body, expectedVersion: announcement.version }) });
        else await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify(body) });
        toast(editing ? '公告已保存' : `公告已创建${values.status === 'published' ? '并发布' : ''}`);
        await fetchAnnouncements();
      },
    });
    $('#adminAnnouncementTitle').value = announcement?.title || '';
    $('#adminAnnouncementStatus').value = announcement?.status || 'draft';
    bindAnnouncementEditor(announcement?.contentHtml || announcement?.content || '');
    await dialog;
  }

  const announcementStatusTabs = [['', '全部'], ['published', '已发布'], ['draft', '草稿'], ['archived', '已归档']];
  async function loadAnnouncements() {
    const root = $('#view-announcements');
    const filters = state.filters.announcements;
    root.innerHTML = pageHead('announcementsTitle', '消息通知', '编辑并发布公告，已发布内容会显示在用户的消息通知中', `${refreshButton('announcements')}<button class="btn btn-primary" id="addAnnouncement" type="button">${icon('plus')}新增公告</button>`) + `
      <div class="panel">
        <div class="toolbar">${segmented('announcementStatus', announcementStatusTabs, filters.status, '按发布状态筛选')}</div>
        <div id="announcementTable" data-table>${skeletonMarkup()}</div>
      </div>`;
    $('#addAnnouncement').onclick = () => editAnnouncement();
    $('[data-refresh="announcements"]', root).onclick = fetchAnnouncements;
    $$('[data-seg="announcementStatus"]', root).forEach(button => button.onclick = () => {
      filters.status = button.dataset.value;
      $$('[data-seg="announcementStatus"]', root).forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      fetchAnnouncements();
    });
    await fetchAnnouncements();
  }

  async function fetchAnnouncements() {
    const table = $('#announcementTable'); if (!table) return;
    const filters = state.filters.announcements;
    const token = nextRequest('announcements');
    markLoading(table);
    try {
      const data = await api(`/api/admin/announcements${filters.status ? `?status=${encodeURIComponent(filters.status)}` : ''}`);
      if (isStale('announcements', token)) return;
      const items = data.items || [];
      table.innerHTML = items.length ? `<div class="table-wrap"><table aria-label="公告列表"><thead><tr><th>公告</th><th>状态</th><th>发布时间</th><th>最近更新</th><th class="is-actions">操作</th></tr></thead><tbody>${items.map(item => `<tr><td style="white-space:normal;min-width:320px"><button class="link-button" type="button" data-edit-announcement="${esc(item.id)}">${esc(item.title)}</button><div class="announcement-preview">${esc(item.contentText || richTextPlainText(item.content))}</div></td><td>${badge(item.status, announcementStatusKind(item.status))}</td><td>${date(item.publishedAt)}</td><td>${date(item.updatedAt)}</td><td class="is-actions"><div class="actions"><button class="btn btn-sm" data-edit-announcement="${esc(item.id)}" type="button">${icon('pencil')}编辑</button></div></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>共 ${money(items.length)} 条公告</span></div>`
        : emptyMarkup(filters.status ? `没有${status(filters.status)}的公告` : '还没有公告', filters.status ? '切换到“全部”查看其他状态的公告。' : '新增一条公告，通知所有用户。', filters.status ? '' : `<button class="btn btn-primary btn-sm" type="button" data-empty-create>${icon('plus')}新增公告</button>`);
      doneLoading(table);
      $('[data-empty-create]', table)?.addEventListener('click', () => editAnnouncement());
      $$('[data-edit-announcement]', table).forEach(button => button.onclick = () => editAnnouncement(items.find(item => item.id === button.dataset.editAnnouncement)));
    } catch (error) {
      if (isStale('announcements', token)) return;
      doneLoading(table);
      table.innerHTML = errorMarkup(error.message, 'announcements');
      bindRetry(table, 'announcements', fetchAnnouncements);
    }
  }

  /* ---------- 渠道与 Key ---------- */
  function credentialDialogFields(credential = null) {
    return [
      { name: 'channelName', label: '渠道名称', type: 'text', value: credential?.channelName || '', placeholder: '例如 WJ', required: true, maxLength: 100, help: '同一渠道可以添加多个不同权限的 Key。' },
      { name: 'label', label: 'Key 名称', type: 'text', value: credential?.label || '', placeholder: '例如 Seedance 2.5 专用 Key', required: true, maxLength: 100 },
      { name: 'provider', label: 'Provider 标识', type: 'text', value: credential?.provider || 'wj', placeholder: '例如 wj', required: true, maxLength: 80 },
      { name: 'adapterType', label: '接口协议', type: 'select', value: credential?.adapterType || 'wj-video', options: Object.entries(adapterLabels).map(([value, label]) => ({ value, label })), required: true },
      { name: 'baseUrl', label: 'API Base URL', type: 'url', value: credential?.baseUrl || '', placeholder: 'https://example.com', required: true, maxLength: 500, span: 'full' },
      { name: 'apiKey', label: credential ? '更换 API Key' : 'API Key', type: 'password', value: '', placeholder: credential ? '留空则保持当前 Key 不变' : '请输入 API Key', required: !credential, maxLength: 2000, span: 'full', help: 'Key 加密保存在服务端，页面不会显示明文。' },
      { name: 'enabled', type: 'checkbox', label: '启用该 Key', checked: credential ? credential.enabled : true, help: '停用后，使用该 Key 的线路不会再被选用。' },
    ];
  }

  function validateCredentialDialog(input, editing = false) {
    const required = ['channelName', 'label', 'provider', 'adapterType', 'baseUrl'].every(name => String(input[name] || '').trim());
    if (!required) return '请完整填写渠道名称、Key 名称、Provider 标识、接口协议和 API Base URL。';
    let validUrl = false;
    try { validUrl = ['http:', 'https:'].includes(new URL(input.baseUrl).protocol); } catch {}
    if (!validUrl) return 'API Base URL 需要以 http:// 或 https:// 开头。';
    if (!editing && !String(input.apiKey || '').trim()) return '请填写 API Key。';
    return null;
  }

  async function editCredential(credential) {
    if (!credential) return;
    await showAdminDialog({ kicker: '渠道与 Key', title: `编辑 ${credential.channelName} · ${credential.label}`, submit: '保存', fields: credentialDialogFields(credential), validate: values => validateCredentialDialog(values, true), onSubmit: async values => { await api(`/api/admin/model-route-credentials/${encodeURIComponent(credential.id)}`, { method: 'PATCH', body: JSON.stringify({ ...values, expectedVersion: credential.version }) }); toast('渠道 Key 已更新'); await loadCredentials(); if (state.routeData) state.routeData = null; } });
  }

  async function addCredential() {
    await showAdminDialog({ kicker: '渠道与 Key', title: '新增渠道 Key', description: '保存后即可在模型线路中选择这个 Key。', submit: '添加', busyLabel: '添加中…', fields: credentialDialogFields(), validate: values => validateCredentialDialog(values, false), onSubmit: async values => { await api('/api/admin/model-route-credentials', { method: 'POST', body: JSON.stringify(values) }); toast('渠道 Key 已添加'); await loadCredentials(); } });
  }

  async function checkCredential(id, button) {
    setButtonBusy(button, true, '检查中…');
    try {
      const result = await api('/api/admin/model-route-credentials/check', { method: 'POST', body: JSON.stringify({ credentialId: id }) });
      mergeCheckedRoutes(result.items, result.prices);
      const bad = (result.items || []).filter(item => ['missing', 'credential_error', 'probe_error'].includes(item.catalogStatus)).length;
      toast(bad ? `已检查 ${result.items?.length || 0} 条线路，其中 ${bad} 条异常` : `已检查 ${result.items?.length || 0} 条线路，全部正常`, bad ? 'error' : 'success');
    } catch (error) { toastError(error); }
    finally { setButtonBusy(button, false); }
  }

  async function loadCredentials() {
    const root = $('#view-credentials');
    const head = pageHead('credentialsTitle', '渠道与 Key', '管理上游渠道和不同权限的 API Key，并检查每个 Key 可调用的模型', `${refreshButton('credentials')}<button class="btn btn-primary" id="addCredential" type="button">${icon('plus')}新增渠道 Key</button>`);
    if (!$('#credentialTable', root)) root.innerHTML = `${head}<div class="panel"><p class="panel-note">${icon('info')}Key 仅显示掩码。停用 Key 后，关联线路会被自动跳过。</p><div id="credentialTable" data-table>${skeletonMarkup()}</div></div>`;
    $('#addCredential').onclick = addCredential;
    $('[data-refresh="credentials"]', root).onclick = loadCredentials;
    const table = $('#credentialTable');
    const token = nextRequest('credentials');
    markLoading(table);
    try {
      const data = await api('/api/admin/model-route-credentials');
      if (isStale('credentials', token)) return;
      const items = data.items || [];
      table.innerHTML = items.length ? `<div class="table-wrap"><table aria-label="渠道 Key 列表" style="min-width:980px"><thead><tr><th>渠道</th><th>Key</th><th>接口协议</th><th>API Base URL</th><th>状态</th><th class="is-num">关联线路</th><th class="is-actions">操作</th></tr></thead><tbody>${items.map(item => `<tr>
          <td><div class="cell-stack"><b>${esc(item.channelName)}</b><span class="detail">${esc(item.provider)}</span></div></td>
          <td><div class="cell-stack"><b>${esc(item.label)}</b><code class="muted">${esc(item.keyHint || (item.configured ? '已配置' : '未配置'))}</code></div></td>
          <td>${esc(adapterLabels[item.adapterType] || item.adapterType)}</td>
          <td>${idText(item.baseUrl, 'URL')}</td>
          <td>${item.enabled ? badge(item.configured ? 'configured' : 'credential_error') : badge('disabled')}</td>
          <td class="is-num">${money(item.routeCount)}</td>
          <td class="is-actions"><div class="actions"><button class="btn btn-sm" data-check-credential="${esc(item.id)}" type="button">检查模型</button><button class="btn btn-sm" data-edit-credential="${esc(item.id)}" type="button">编辑</button></div></td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyMarkup('还没有渠道 Key', '添加渠道 Key 后，就可以在模型线路中选择它。', `<button class="btn btn-primary btn-sm" type="button" data-empty-create>${icon('plus')}新增渠道 Key</button>`);
      doneLoading(table);
      $('[data-empty-create]', table)?.addEventListener('click', addCredential);
      $$('[data-edit-credential]', table).forEach(button => button.onclick = () => editCredential(items.find(item => item.id === button.dataset.editCredential)));
      $$('[data-check-credential]', table).forEach(button => button.onclick = () => checkCredential(button.dataset.checkCredential, button));
    } catch (error) {
      if (isStale('credentials', token)) return;
      doneLoading(table);
      table.innerHTML = errorMarkup(error.message, 'credentials');
      bindRetry(table, 'credentials', loadCredentials);
    }
  }

  /* ---------- 模型与价格 ---------- */
  function routeIdsForModel(modelId, routeData = state.routeData) {
    const legacySeedanceIds = new Set(['seedance-2.0', 'seedance-2.0-text', 'seedance-2.0-img']);
    return (routeData?.items || [])
      .filter(route => route.logicalModelId === modelId || (modelId === 'seedance-2.0' && legacySeedanceIds.has(route.logicalModelId)))
      .map(route => route.id);
  }

  function modelCheckStatus(modelId, routeData = state.routeData) {
    const ids = routeIdsForModel(modelId, routeData);
    const routes = (routeData?.items || []).filter(route => ids.includes(route.id));
    if (!routes.length) return { value: 'unknown', label: '无需线路', kind: 'none' };
    const bad = routes.find(route => ['missing', 'credential_error', 'probe_error'].includes(route.catalogStatus));
    if (bad) return { value: bad.catalogStatus, label: status(bad.catalogStatus), kind: 'bad' };
    if (routes.every(route => route.catalogStatus === 'available')) return { value: 'available', label: '全部可用', kind: 'ok' };
    return { value: 'unknown', label: '待检查', kind: 'warn' };
  }

  function modelCheckMarkup(model, routeData = state.routeData) {
    const result = modelCheckStatus(model.modelId, routeData);
    return result.kind === 'none' ? '<span class="muted">—</span>' : pill(result.label, result.kind);
  }

  function renderModelPanel(modelItems = state.modelItems, routeData = state.routeData) {
    const root = $('#modelPanel');
    if (!root) return;
    const kindOrder = kind => ({ image: 0, video: 1 }[kind] ?? 2);
    const sorted = [...modelItems].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || Number(a.sortOrder) - Number(b.sortOrder));
    let lastKind = null;
    root.innerHTML = `<div class="panel-head"><div><h3>模型控制</h3><p>“用户端展示”决定客户端是否显示该模型；“接收新任务”决定服务端是否接受新的生成请求。</p></div></div>${sorted.length ? `<div class="table-wrap" style="border:0;border-radius:0"><table aria-label="模型控制列表"><thead><tr><th>模型</th><th>用户端展示</th><th>接收新任务</th><th>线路状态</th><th class="is-num">排序</th><th class="is-actions">操作</th></tr></thead><tbody>${sorted.map(model => {
      const routeIds = routeIdsForModel(model.modelId, routeData);
      const groupRow = model.kind !== lastKind ? `<tr class="table-group-row"><td colspan="6">${esc(kindLabels[model.kind] || model.kind || '其他')}模型</td></tr>` : '';
      lastKind = model.kind;
      return `${groupRow}<tr><td><b>${esc(model.modelId)}</b></td><td>${model.userVisible ? pill('显示', 'ok') : pill('隐藏', 'muted')}</td><td>${model.enabled ? pill('接收中', 'ok') : pill('已暂停', 'warn')}</td><td>${modelCheckMarkup(model, routeData)}</td><td class="is-num">${money(model.sortOrder)}</td><td class="is-actions"><div class="actions">${routeIds.length ? `<button class="btn btn-sm" data-check-model="${esc(model.modelId)}" type="button">检查线路</button>` : ''}<button class="btn btn-sm" data-model="${esc(model.modelId)}" type="button">编辑</button></div></td></tr>`;
    }).join('')}</tbody></table></div>` : emptyMarkup('暂无模型配置')}`;
    $$('[data-model]', root).forEach(button => button.onclick = () => editModel(modelItems.find(item => item.modelId === button.dataset.model)));
    $$('[data-check-model]', root).forEach(button => button.onclick = () => checkRoutes(routeIdsForModel(button.dataset.checkModel, routeData), button));
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

  const modelTabs = [['routes', '调用线路'], ['models', '模型控制'], ['pricing', '价格设置']];
  function selectModelsTab(tab) {
    state.modelsTab = modelTabs.some(([key]) => key === tab) ? tab : 'routes';
    $$('#view-models [role="tab"]').forEach(button => {
      const active = button.dataset.tab === state.modelsTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    [['routes', '#routePanel'], ['models', '#modelPanel'], ['pricing', '#pricingPanel']].forEach(([key, selector]) => { const panel = $(selector); if (panel) panel.hidden = key !== state.modelsTab; });
  }

  function updateModelsContent(render) {
    const root = $('#view-models');
    const scroller = document.scrollingElement || document.documentElement;
    const position = { top: scroller.scrollTop, left: scroller.scrollLeft };
    const tableKey = (wrap, index) => $('table', wrap)?.getAttribute('aria-label') || `table-${index}`;
    const tablePositions = new Map($$('.table-wrap', root).map((wrap, index) => [tableKey(wrap, index), { top: wrap.scrollTop, left: wrap.scrollLeft }]));
    render();
    $$('.table-wrap', root).forEach((wrap, index) => {
      const saved = tablePositions.get(tableKey(wrap, index));
      if (saved) { wrap.scrollTop = saved.top; wrap.scrollLeft = saved.left; }
    });
    scroller.scrollTop = position.top;
    scroller.scrollLeft = position.left;
  }

  async function loadModels({ refreshPricing = true } = {}) {
    const root = $('#view-models');
    const initialLoad = !$('#routePanel', root);
    if (initialLoad) {
      root.innerHTML = pageHead('modelsTitle', '模型与价格', '管理调用线路、用户端模型展示和平台价格', refreshButton('models')) + `
      <div class="tabs" role="tablist" aria-label="模型与价格">${modelTabs.map(([key, label]) => `<button class="tab" role="tab" type="button" id="modelsTab-${key}" data-tab="${key}" aria-controls="${key === 'routes' ? 'routePanel' : key === 'models' ? 'modelPanel' : 'pricingPanel'}">${label}</button>`).join('')}</div>
      <div id="routePanel" class="panel" role="tabpanel" aria-labelledby="modelsTab-routes">${skeletonMarkup(8)}</div>
      <div id="modelPanel" class="panel" role="tabpanel" aria-labelledby="modelsTab-models">${skeletonMarkup(8)}</div>
      <div id="pricingPanel" class="panel" role="tabpanel" aria-labelledby="modelsTab-pricing">${skeletonMarkup(6)}</div>`;
      const tabs = $$('[role="tab"]', root);
      tabs.forEach((button, index) => {
        button.onclick = () => selectModelsTab(button.dataset.tab);
        button.onkeydown = event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
          selectModelsTab(next.dataset.tab); next.focus();
        };
      });
      selectModelsTab(state.modelsTab);
    }
    const refresh = $('[data-refresh="models"]', root);
    refresh.onclick = loadModels;
    setButtonBusy(refresh, true, '刷新中…');
    const token = nextRequest('models');
    try {
      const [models, pricing, routes] = await Promise.all([api('/api/admin/models'), initialLoad || refreshPricing ? api('/api/admin/pricing') : null, api('/api/admin/model-routes')]);
      if (isStale('models', token)) return;
      state.modelItems = models.items || [];
      state.routeData = routes;
      updateModelsContent(() => {
        renderRoutePanel(routes);
        renderModelPanel(state.modelItems, routes);
        if (pricing) renderPricingPanel(pricing);
        selectModelsTab(state.modelsTab);
      });
    } catch (error) {
      if (isStale('models', token)) return;
      if (!initialLoad && state.routeData) { toastError(error); return; }
      ['#routePanel', '#modelPanel', '#pricingPanel'].forEach(selector => { const panel = $(selector); if (panel) { panel.innerHTML = errorMarkup(error.message, 'models'); bindRetry(panel, 'models', loadModels); } });
    } finally {
      if (!isStale('models', token)) setButtonBusy(refresh, false);
    }
  }

  function renderPricingPanel(pricing) {
    const root = $('#pricingPanel'); if (!root) return;
    const current = pricing.current || {};
    const history = (pricing.history || []).slice(0, 6);
    const fields = pricing.fields || [];
    const groups = [...fields.reduce((map, field) => map.set(field.label, [...(map.get(field.label) || []), field]), new Map())];
    const priceLabel = field => field.modelId === 'llm' ? ({ input: '普通输入', output: '输出', 'cache-read': '缓存读取', 'cache-creation': '缓存创建' }[field.quality] || field.quality) : field.quality;
    const priceInput = (name, label, value, unit = '') => `<label class="field price-field" data-price-field><span class="field-label">${esc(label)}${unit ? `<small>${esc(unit)}</small>` : ''}</span><input name="${esc(name)}" value="${esc(value)}" data-original="${esc(value)}" inputmode="decimal" required autocomplete="off"></label>`;
    root.innerHTML = `<div class="panel-head"><div><h3>价格设置</h3><p>当前版本 v${esc(current.version)} · 新价格仅对之后提交的任务生效，历史版本保留只读。</p></div></div>
      <form id="pricingForm" novalidate>
        <div class="panel-body">
          <section class="price-section"><h4>通用价格</h4><p>未单独设置价格的图片、视频任务按此计费，单位为积分。</p><div class="price-grid">${priceInput('imagePerRequest', '图片', current.imagePerRequest, '积分 / 次')}${priceInput('videoPerSecond', '视频', current.videoPerSecond, '积分 / 秒')}</div></section>
          ${groups.length ? `<section class="price-section"><h4>按模型设置</h4><p>图片和视频单位为积分，文本模型单位为人民币。缓存读取、缓存创建按各自单价计费，普通输入不含这两类用量。Seedance 各线路的价格在“调用线路”中设置。</p><div class="price-grid is-models">${groups.map(([label, items]) => `<div class="price-model"><h5>${esc(label)}</h5><div class="price-grid">${items.map(field => priceInput(`modelPrice:${field.key}`, priceLabel(field), field.amount, `/ ${field.unit}`)).join('')}</div></div>`).join('')}</div></section>` : ''}
        </div>
        <div class="sticky-bar"><span class="muted" data-price-dirty>价格未修改</span><div class="actions"><button class="btn" type="button" data-price-reset disabled>还原</button><button class="btn btn-primary" type="submit" disabled>发布新价格</button></div></div>
      </form>
      ${history.length ? `<div class="panel-head" style="border-top:1px solid var(--line-soft)"><div><h3>最近价格版本</h3></div></div><div class="table-wrap" style="border:0;border-radius:0 0 12px 12px"><table style="min-width:560px"><thead><tr><th>版本</th><th class="is-num">图片 / 次</th><th class="is-num">视频 / 秒</th><th>发布时间</th></tr></thead><tbody>${history.map(item => `<tr><td><b>v${esc(item.version)}</b>${String(item.version) === String(current.version) ? ' <span class="tag is-brand">当前</span>' : ''}</td><td class="is-num">${money(item.imagePerRequest)}</td><td class="is-num">${money(item.videoPerSecond)}</td><td>${date(item.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    const form = $('#pricingForm');
    const submit = $('button[type="submit"]', form);
    const reset = $('[data-price-reset]', form);
    const labelFor = input => {
      const [kind] = input.name.split(':');
      const key = input.name.slice(kind.length + 1);
      if (kind === 'imagePerRequest') return '图片 · 积分 / 次';
      if (kind === 'videoPerSecond') return '视频 · 积分 / 秒';
      const field = fields.find(item => item.key === key);
      return field ? `${field.label} · ${priceLabel(field)} / ${field.unit}` : input.name;
    };
    const changedInputs = () => $$('input', form).filter(input => input.value.trim() !== input.dataset.original);
    const updateDirty = () => {
      const changed = changedInputs();
      $$('[data-price-field]', form).forEach(field => field.classList.toggle('is-changed', changed.includes($('input', field))));
      $('[data-price-dirty]', form).innerHTML = changed.length ? `已修改 <b>${changed.length}</b> 项，发布后生效` : '价格未修改';
      submit.disabled = !changed.length;
      reset.disabled = !changed.length;
    };
    form.addEventListener('input', updateDirty);
    reset.onclick = () => { $$('input', form).forEach(input => { input.value = input.dataset.original; }); updateDirty(); };
    form.onsubmit = async event => {
      event.preventDefault();
      const changed = changedInputs();
      if (!changed.length) return;
      const invalid = $$('input', form).find(input => !input.value.trim() || !Number.isFinite(Number(input.value)) || Number(input.value) < 0);
      if (invalid) { toast(`“${labelFor(invalid)}”需要填写不小于 0 的数字`, 'error'); invalid.focus(); return; }
      const values = new FormData(form);
      await showAdminDialog({
        kicker: '价格设置',
        title: `发布价格版本 v${Number(current.version) + 1}？`,
        description: '发布后，新提交的任务会按新价格计费，已提交的任务不受影响。',
        size: 'wide',
        submit: '确认发布',
        busyLabel: '发布中…',
        html: `<div class="table-wrap"><table class="diff-table" style="min-width:480px"><thead><tr><th>项目</th><th class="is-num">当前</th><th class="is-num">修改为</th></tr></thead><tbody>${changed.map(input => `<tr><td>${esc(labelFor(input))}</td><td class="is-num">${esc(input.dataset.original)}</td><td class="is-num">${esc(input.value.trim())}</td></tr>`).join('')}</tbody></table></div>`,
        onSubmit: async () => {
          await api('/api/admin/pricing', { method: 'POST', body: JSON.stringify({ imagePerRequest: values.get('imagePerRequest'), videoPerSecond: values.get('videoPerSecond'), modelPrices: Object.fromEntries(fields.map(field => [field.key, values.get(`modelPrice:${field.key}`)])), expectedVersion: current.version }) });
          toast('新价格已发布');
          state.modelsTab = 'pricing';
          await loadModels();
        },
      });
    };
  }

  async function deleteRoute(route) {
    if (!route) return;
    await showAdminDialog({
      kicker: '调用线路', title: `删除线路“${route.displayName}”？`,
      html: `<p class="admin-dialog-confirmation is-danger">上游模型 <code>${esc(route.upstreamModelId)}</code>（${esc(route.quality)}）将不再用于新任务。若当前固定使用此线路，会恢复为自动选择。渠道 Key 和历史记录会保留。</p>`,
      submit: '确认删除', busyLabel: '删除中…', danger: true, size: 'narrow',
      onSubmit: async () => {
        await api(`/api/admin/model-routes/${encodeURIComponent(route.id)}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: route.version }) });
        toast('线路已删除');
        await loadModels({ refreshPricing: false });
      },
    });
  }

  function routeStatusBadge(route) {
    if (!route.adminEnabled && route.autoDisabled) return badge('auto_disabled', 'bad');
    if (!route.adminEnabled) return badge('disabled');
    const kind = route.catalogStatus === 'available' ? 'ok' : ['missing', 'credential_error'].includes(route.catalogStatus) ? 'bad' : 'warn';
    return badge(route.catalogStatus, kind);
  }

  function routeStatusCell(route) {
    const autoInfo = route.autoDisabled
      ? `<div class="route-message is-auto-disabled">${esc(route.autoDisabledReason || '连续多次生成失败，已自动停用')}</div><div class="detail">停用于 ${date(route.autoDisabledAt)}</div>`
      : '';
    const catalogInfo = route.catalogMessage ? `<div class="route-message" title="${esc(route.catalogMessage)}">${esc(route.catalogMessage)}</div>` : '';
    return `${routeStatusBadge(route)}${autoInfo}${catalogInfo}`;
  }

  async function enableRoute(route) {
    if (!route) return;
    await showAdminDialog({
      kicker: '调用线路', title: `恢复启用“${route.displayName}”？`,
      description: '该线路因连续生成失败被自动停用。恢复后会按优先级重新参与选路，失败计数从零开始。',
      submit: '确认启用', busyLabel: '启用中…', tone: 'info', size: 'narrow',
      onSubmit: async () => {
        await api(`/api/admin/model-routes/${encodeURIComponent(route.id)}`, { method: 'PATCH', body: JSON.stringify({ adminEnabled: true, expectedVersion: route.version }) });
        toast('线路已恢复启用');
        await loadModels({ refreshPricing: false });
      },
    });
  }

  function routeRowMarkup(route, selected) {
    return `<tr class="${selected ? 'is-selected' : ''}">
      <td><span class="route-priority">${esc(route.priority)}</span></td>
      <td><div class="cell-stack"><span><b>${esc(route.displayName)}</b>${selected ? ' <span class="tag is-brand">当前使用</span>' : ''}</span>${idText(route.upstreamModelId, '上游模型 ID')}<span class="detail">可选时长 ${esc((route.durations || []).join('、'))} 秒</span></div></td>
      <td>${routeStatusCell(route)}</td>
      <td class="is-num"><b>¥${Number(Number(route.costYuan).toFixed(8))}</b><div class="detail">每秒</div></td>
      <td class="is-num"><b>¥${Number(Number(route.salePriceYuan).toFixed(8))}</b><div class="detail">每秒${route.salePriceConfigured ? '' : ' · 自动定价'}</div></td>
      <td>${date(route.catalogCheckedAt)}</td>
      <td class="is-actions"><div class="actions">${route.autoDisabled ? `<button class="btn btn-sm btn-primary" data-enable-route="${esc(route.id)}" type="button">恢复启用</button>` : ''}<button class="btn btn-sm" data-check-route="${esc(route.id)}" type="button">检查</button><button class="btn btn-sm" data-edit-route="${esc(route.id)}" type="button">编辑</button><button class="btn btn-sm btn-danger-ghost" data-delete-route="${esc(route.id)}" type="button">删除</button></div></td>
    </tr>`;
  }

  // 分组级别的标记只依赖 esc / routeModelLabels，线路行再交给 routeRowMarkup，
  // 这样空分组（例如尚未配置的 1080p 线路池）也能稳定渲染“新增线路”和选路策略。
  function renderRoutePanel(data) {
    const root = $('#routePanel'); if (!root) return;
    const items = data.items || [];
    const seedance20Pools = ['seedance-2.0-text', 'seedance-2.0-img'];
    const configuredGroups = items.map(item => `${item.logicalModelId}:${item.quality}`);
    const emptyPoolGroups = [...seedance20Pools.flatMap(modelId => ['480p', '720p', '1080p'].map(quality => `${modelId}:${quality}`)), ...['480p', '720p', '1080p'].map(quality => `seedance-2.5:${quality}`)];
    const groups = [...new Set([...emptyPoolGroups, ...configuredGroups])];
    const families = [...new Set(groups.map(key => key.split(':')[0]))];
    const activeFamily = families.includes(root.dataset?.routeFilter) ? root.dataset.routeFilter : '';
    const availableTotal = items.filter(item => item.adminEnabled && item.catalogStatus === 'available').length;
    const issueTotal = items.filter(item => item.autoDisabled || ['missing', 'credential_error', 'probe_error'].includes(item.catalogStatus)).length;
    const chips = [['', `全部 ${groups.length}`], ...families.map(modelId => [modelId, routeModelLabels[modelId] || modelId])];
    root.innerHTML = `<div class="panel-head"><div><h3>Seedance 调用线路</h3><p>共 ${items.length} 条线路 · ${availableTotal} 条可用${issueTotal ? ` · <span class="danger-text">${issueTotal} 条需要处理</span>` : ''} · 每 10 分钟自动检查一次；自动模式按优先级选择可用线路。</p></div><button class="btn" id="checkAllRoutes" type="button">检查全部线路</button></div>
      <div class="route-toolbar"><div class="chips" role="group" aria-label="按模型筛选线路">${chips.map(([value, label]) => `<button class="chip" type="button" data-route-filter="${esc(value)}" aria-pressed="${String(value === activeFamily)}">${esc(label)}</button>`).join('')}</div></div>
      <div class="route-groups">${groups.map(key => {
      const [modelId, quality] = key.split(':');
      const routes = items.filter(item => item.logicalModelId === modelId && item.quality === quality).sort((a, b) => Number(a.priority) - Number(b.priority));
      const policy = (data.policies || []).find(item => item.logicalModelId === modelId && item.quality === quality);
      const publicPriceModelId = modelId === 'seedance-2.0-text' || modelId === 'seedance-2.0-img' ? 'seedance-2.0' : modelId;
      const price = (data.prices || []).find(item => item.modelId === publicPriceModelId && item.quality === quality);
      const label = routeModelLabels[modelId] || modelId;
      const usable = routes.filter(route => route.adminEnabled && route.catalogStatus === 'available').length;
      const hint = modelId === 'seedance-2.0-fast' ? '支持 9 图 / 3 视频 / 3 音频' : modelId === 'seedance-2.0-text' ? '用户未上传图片时使用' : modelId === 'seedance-2.0-img' ? '用户上传 1～9 张图片时使用' : '';
      const priceText = price?.available ? `<span class="is-price">用户价 ¥${Number(price.yuan).toFixed(2)} / 秒 · ${money(price.credits)} 积分 / 秒</span>` : '<span class="is-unavailable">暂无可用线路</span>';
      const isSelected = route => policy?.forcedRouteId === route.id || (modelId !== 'seedance-2.0-text' && modelId !== 'seedance-2.0-img' && price?.selectedRouteId === route.id);
      return `<section class="route-group${activeFamily && activeFamily !== modelId ? ' route-group-hidden' : ''}" data-route-group="${esc(modelId)}">
        <header>
          <div class="route-group-title"><h4>${esc(label)}<span class="tag">${esc(quality)}</span></h4><div class="route-group-meta">${priceText}<span>${routes.length} 条线路 · ${usable} 条可用</span>${hint ? `<span>${esc(hint)}</span>` : ''}</div></div>
          <div class="route-header-actions"><label class="route-policy">选路方式<select data-route-policy="${esc(key)}" data-version="${policy?.version || 1}"><option value="" data-hint="按优先级依次选择可用线路">自动（按优先级）</option>${routes.length ? `<optgroup label="固定使用某条线路">${routes.map(route => `<option value="${esc(route.id)}" data-hint="优先级 ${esc(route.priority)} · ${esc(route.adminEnabled ? status(route.catalogStatus) : route.autoDisabled ? '已自动停用' : '已停用')}" ${policy?.forcedRouteId === route.id ? 'selected' : ''}>固定使用 · ${esc(route.displayName)}</option>`).join('')}</optgroup>` : ''}</select></label><button class="btn btn-sm" data-add-route="${esc(key)}" type="button">新增线路</button></div>
        </header>
        ${routes.length ? `<div class="table-wrap"><table class="route-table" aria-label="${esc(label)} ${esc(quality)} 调用线路"><thead><tr><th>优先级</th><th>线路 / 上游模型</th><th>状态</th><th class="is-num">成本</th><th class="is-num">用户价</th><th>最近检查</th><th class="is-actions">操作</th></tr></thead><tbody>${routes.map(route => routeRowMarkup(route, isSelected(route))).join('')}</tbody></table></div>` : '<div class="route-empty"><span>该分组还没有线路，新增后用户才能使用这一清晰度。</span></div>'}
      </section>`;
    }).join('')}</div>`;
    $('#checkAllRoutes')?.addEventListener('click', event => checkRoutes(null, event.currentTarget));
    root.querySelectorAll('[data-route-filter]').forEach(button => button.onclick = () => { root.dataset.routeFilter = button.dataset.routeFilter; renderRoutePanel(state.routeData || data); });
    root.querySelectorAll('[data-add-route]').forEach(button => button.onclick = () => { const [modelId, quality] = button.dataset.addRoute.split(':'); addModelRoute(modelId, quality, data); });
    root.querySelectorAll('[data-check-route]').forEach(button => button.onclick = () => checkRoutes([button.dataset.checkRoute], button));
    root.querySelectorAll('[data-delete-route]').forEach(button => button.onclick = () => deleteRoute(items.find(item => item.id === button.dataset.deleteRoute)));
    root.querySelectorAll('[data-enable-route]').forEach(button => button.onclick = () => enableRoute(items.find(item => item.id === button.dataset.enableRoute)));
    root.querySelectorAll('[data-edit-route]').forEach(button => button.onclick = () => editRoute(items.find(item => item.id === button.dataset.editRoute), data.channels));
    root.querySelectorAll('[data-route-policy]').forEach(select => select.onchange = () => changeRoutePolicy(select));
  }

  async function checkRoutes(routeIds = null, sourceButton = null) {
    const button = sourceButton || $('#checkAllRoutes');
    setButtonBusy(button, true, '检查中…');
    try {
      const result = await api('/api/admin/model-routes/check', { method: 'POST', body: JSON.stringify(routeIds ? { routeIds } : {}) });
      mergeCheckedRoutes(result.items, result.prices);
      const bad = (result.items || []).filter(item => ['missing', 'credential_error', 'probe_error'].includes(item.catalogStatus)).length;
      toast(bad ? `检查完成，${bad} 条线路异常` : `检查完成，已更新 ${result.items?.length || 0} 条线路`, bad ? 'error' : 'success');
    } catch (error) { toastError(error); }
    finally { if (button?.isConnected) setButtonBusy(button, false); }
  }

  async function changeRoutePolicy(select) {
    const [logicalModelId, quality] = select.dataset.routePolicy.split(':');
    const previous = [...select.options].find(option => option.defaultSelected)?.value || '';
    select.disabled = true;
    try {
      const result = await api('/api/admin/model-route-policy', { method: 'PATCH', body: JSON.stringify({ logicalModelId, quality, forcedRouteId: select.value, expectedVersion: Number(select.dataset.version) }) });
      if (state.routeData) {
        const policies = state.routeData.policies || [];
        const exists = policies.some(policy => policy.logicalModelId === logicalModelId && policy.quality === quality);
        state.routeData = { ...state.routeData, policies: exists ? policies.map(policy => policy.logicalModelId === logicalModelId && policy.quality === quality ? result.policy : policy) : [...policies, result.policy].filter(Boolean), prices: result.prices || state.routeData.prices };
        renderRoutePanel(state.routeData);
        renderModelPanel(state.modelItems, state.routeData);
      }
      toast(select.value ? '已改为固定使用所选线路' : '已恢复自动选路');
    } catch (error) { toastError(error); select.value = previous; select.disabled = false; }
  }

  function channelDialogOptions(channels) {
    return (channels || []).filter(channel => channel.id).map(channel => ({ value: channel.id, label: `${channel.label}${channel.configured ? '' : '（未配置 Key）'}${channel.enabled === false ? '（已停用）' : ''}`, hint: [channel.envKey, channel.baseUrl].filter(Boolean).join(' · ') }));
  }
  function routeDialogFields({ route = null, channels = [], nextPriority = 1, logicalModelId = '' }) {
    const selectedChannel = route?.credentialId || channels.find(channel => channel.configured)?.id || channels[0]?.id || '';
    const selectedModelId = route?.logicalModelId || logicalModelId;
    const selectedInputMode = selectedModelId === 'seedance-2.0-img' || (selectedModelId === 'seedance-2.0' && Number(route?.capabilities?.minImage || 0) > 0) ? 'seedance-2.0-img' : 'seedance-2.0-text';
    const modelField = ['seedance-2.0', 'seedance-2.0-text', 'seedance-2.0-img'].includes(selectedModelId)
      ? [{ name: 'logicalModelId', label: '创作类型', type: 'select', value: selectedInputMode, options: [{ value: 'seedance-2.0-text', label: '文生视频', hint: '用户未上传图片时使用' }, { value: 'seedance-2.0-img', label: '图生视频', hint: '用户上传 1～9 张图片时使用' }], required: true }]
      : [];
    return [...modelField,
      { name: 'credentialId', label: '渠道 / API Key', type: 'select', value: selectedChannel, options: channelDialogOptions(channels), required: true, help: '未配置 Key 的渠道保存后会显示“密钥异常”。', span: modelField.length ? '' : 'full' },
      { name: 'upstreamModelId', label: '上游模型 ID', type: 'text', value: route?.upstreamModelId || '', placeholder: '例如 seedance2.0-select-full-720p', required: true, help: '需与该渠道模型列表中的 ID 完全一致。', span: 'full' },
      { name: 'priority', label: '优先级', type: 'number', value: String(route?.priority || nextPriority), min: 1, max: 1000, step: 1, inputmode: 'numeric', required: true, help: '数字越小越优先；与已有线路相同时，原线路依次后移。' },
      { name: 'durations', label: '可选时长（秒）', type: 'text', value: (route?.durations || [selectedModelId === 'seedance-2.5' ? 30 : 15]).join(', '), placeholder: '例如 5, 10, 15', required: true, help: '填写整数秒，多个用逗号分隔。' },
      { name: 'costYuan', label: '成本（元 / 秒）', type: 'number', value: route ? Number(Number(route.costYuan).toFixed(8)) : '', placeholder: '例如 2.50', min: 0, max: 100000, step: 'any', inputmode: 'decimal', required: true },
      { name: 'salePriceYuan', label: '用户价格（元 / 秒）', type: 'number', value: route ? Number(Number(route.salePriceYuan).toFixed(8)) : '', placeholder: '例如 3.00', min: 0, max: 100000, step: 'any', inputmode: 'decimal', required: true, help: '1 元 = 10 积分。' },
      { name: 'adminEnabled', type: 'checkbox', label: '启用线路', checked: route ? route.adminEnabled : true, help: '关闭后，自动和固定选路都会跳过该线路。' },
    ];
  }
  function validateRouteDialog(input) {
    if (!String(input.credentialId || '').trim()) return '请选择渠道 / API Key。';
    if (!String(input.upstreamModelId || '').trim()) return '请填写上游模型 ID。';
    const priority = Number(input.priority);
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 1000) return '优先级需要是 1～1000 的整数。';
    const durations = String(input.durations || '').trim().split(/[，,、\s]+/).map(Number);
    if (!durations.length || durations.some(value => !Number.isSafeInteger(value) || value < 1 || value > 3600)) return '请填写有效的整数秒数，多个秒数用逗号分隔。';
    const cost = Number(input.costYuan); const sale = Number(input.salePriceYuan);
    if (!Number.isFinite(cost) || cost < 0 || input.costYuan === '') return '请填写有效的成本价格。';
    if (!Number.isFinite(sale) || sale < 0 || input.salePriceYuan === '') return '请填写有效的用户价格。';
    return null;
  }
  async function addModelRoute(logicalModelId, quality, data) {
    const routes = (data.items || []).filter(item => item.logicalModelId === logicalModelId && item.quality === quality);
    const nextPriority = Math.min(1000, Math.max(0, ...routes.map(item => Number(item.priority) || 0)) + 1);
    await showAdminDialog({ kicker: '调用线路', title: `新增线路 · ${routeModelLabels[logicalModelId] || logicalModelId} ${quality}`, description: '选择已有渠道，填写该渠道可调用的上游模型 ID 和价格。新线路会先标记为待检查。', submit: '新增线路', busyLabel: '保存中…', fields: routeDialogFields({ channels: data.channels, nextPriority, logicalModelId }), validate: validateRouteDialog, onSubmit: async values => { const result = await api('/api/admin/model-routes', { method: 'POST', body: JSON.stringify({ logicalModelId: values.logicalModelId || logicalModelId, quality, credentialId: values.credentialId, upstreamModelId: values.upstreamModelId.trim(), priority: Number(values.priority), durations: values.durations, costYuan: Number(values.costYuan), salePriceYuan: Number(values.salePriceYuan), adminEnabled: values.adminEnabled }) }); toast(`线路已新增：${result.route.displayName}`); await loadModels({ refreshPricing: false }); } });
  }
  async function editRoute(route, channels = []) {
    if (!route) return;
    await showAdminDialog({ kicker: '调用线路', title: `编辑线路 · ${route.displayName}`, description: '修改创作类型、渠道或上游模型 ID 后，需要重新检查线路状态。', submit: '保存', fields: routeDialogFields({ route, channels }), validate: validateRouteDialog, onSubmit: async values => { await api(`/api/admin/model-routes/${encodeURIComponent(route.id)}`, { method: 'PATCH', body: JSON.stringify({ ...(values.logicalModelId ? { logicalModelId: values.logicalModelId } : {}), credentialId: values.credentialId, upstreamModelId: values.upstreamModelId.trim(), adminEnabled: values.adminEnabled, priority: Number(values.priority), durations: values.durations, costYuan: Number(values.costYuan), salePriceYuan: Number(values.salePriceYuan), expectedVersion: route.version }) }); toast('线路已更新'); await loadModels({ refreshPricing: false }); } });
  }
  async function editModel(model) {
    if (!model) return;
    await showAdminDialog({
      kicker: '模型控制', title: `编辑 ${model.modelId}`, submit: '保存',
      fields: [
        { name: 'userVisible', type: 'checkbox', label: '在用户端展示', checked: model.userVisible, help: '关闭后，用户在客户端的模型列表中看不到它。' },
        { name: 'enabled', type: 'checkbox', label: '接收新任务', checked: model.enabled, help: '关闭后，服务端会拒绝该模型的新生成请求。' },
        { name: 'sortOrder', label: '排序值', type: 'number', value: String(model.sortOrder), min: 0, max: 100000, step: 1, inputmode: 'numeric', required: true, help: '0～100000 的整数，越小越靠前；与同类模型相同时，原模型依次后移。' },
      ],
      validate: values => { const order = Number(values.sortOrder); return Number.isSafeInteger(order) && order >= 0 && order <= 100000 ? null : '排序值必须是 0～100000 的整数。'; },
      onSubmit: async values => { await api(`/api/admin/models/${encodeURIComponent(model.modelId)}`, { method: 'PATCH', body: JSON.stringify({ userVisible: values.userVisible, enabled: values.enabled, sortOrder: Number(values.sortOrder), expectedVersion: model.version }) }); toast('模型设置已保存'); state.modelsTab = 'models'; await loadModels({ refreshPricing: false }); },
    });
  }

  /* ---------- 日志中心 ---------- */
  function logDetailData(item, category) {
    const common = { id: item.id, createdAt: item.createdAt };
    if (category === 'generations') return { ...common, userId: item.userId, userNickname: item.userNickname, type: item.type, status: item.status, creditCost: item.creditCost, creditStatus: item.creditStatus, pricingVersion: item.pricingVersion, modelId: item.modelId, provider: item.provider, assetId: item.assetId, updatedAt: item.updatedAt, details: item.details };
    if (category === 'credits') return { ...common, userId: item.userId, userNickname: item.userNickname, actorUserId: item.actorUserId, type: item.type, reasonCode: item.reasonCode, note: item.note, amount: item.amount, balanceAfter: item.balanceAfter, generationId: item.generationId, requestId: item.requestId, details: item.details };
    if (category === 'llm') return { ...common, userId: item.userId, userNickname: item.userNickname, status: item.status, modelId: item.modelId, inputTokens: item.inputTokens, outputTokens: item.outputTokens, uncachedInputTokens: item.uncachedInputTokens, cacheReadTokens: item.cacheReadTokens, cacheCreationTokens: item.cacheCreationTokens, inputRateYuanPerMillion: item.inputRateYuanPerMillion, outputRateYuanPerMillion: item.outputRateYuanPerMillion, cacheReadRateYuanPerMillion: item.cacheReadRateYuanPerMillion, cacheCreationRateYuanPerMillion: item.cacheCreationRateYuanPerMillion, charged: item.charged, details: item.details };
    if (category === 'audit') return { ...common, actorUserId: item.actorUserId, actorNickname: item.actorNickname, action: item.action, targetType: item.targetType, targetId: item.targetId, requestId: item.requestId, status: item.status, before: item.before, after: item.after, metadata: item.metadata };
    if (category === 'client') return { ...common, userId: item.userId, userNickname: item.userNickname, username: item.username, reference: item.reference, note: item.note, message: item.message, size: item.size, appVersion: item.appVersion, platform: item.platform, deviceId: item.deviceId, details: item.details };
    return { ...common, level: item.level, category: item.category, requestId: item.requestId, userId: item.userId, userNickname: item.userNickname, modelId: item.modelId, generationId: item.generationId, message: item.message, details: item.details };
  }
  function compactLogDetailData(data) { return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== '')); }
  function stringifyLogDetails(value, pretty = false) {
    try { return JSON.stringify(value, null, pretty ? 2 : 0) || '暂无详情'; } catch { return String(value); }
  }
  function logPreview(item, category) {
    if (category === 'credits') return item.note || item.reasonCode || stringifyLogDetails(item.details || {});
    if (category === 'audit') return stringifyLogDetails(item.after || item.before || item.metadata || {});
    if (category === 'client') return item.message || stringifyLogDetails(item.details || {});
    return stringifyLogDetails(item.details || {});
  }
  function logDetailCells(item, category, index, colspan) {
    const detailId = `log-detail-${category}-${index}`;
    const preview = logPreview(item, category);
    const fullDetails = stringifyLogDetails(compactLogDetailData(logDetailData(item, category)), true);
    return `<td class="log-details-cell"><button class="log-expand-button" data-log-expand type="button" aria-expanded="false" aria-controls="${detailId}"><span class="log-json" title="${esc(preview.slice(0, 400))}">${esc(preview.slice(0, 400))}</span><span class="log-expand-label">展开</span>${icon('chevronDown', 'log-expand-icon')}</button></td></tr><tr id="${detailId}" class="log-detail-row" hidden><td colspan="${colspan}"><div class="log-detail-panel"><div class="log-detail-head"><strong>完整记录</strong><div><span>${date(item.createdAt)}</span><button class="btn btn-sm btn-ghost" type="button" data-copy-log>${icon('copy')}复制</button></div></div><pre>${esc(fullDetails)}</pre></div></td></tr>`;
  }
  const logRow = (item, category, index, cells, colspan) => `<tr class="log-row">${cells}${logDetailCells(item, category, index, colspan)}`;
  const userCell = (userId, nickname, extra = '') => userId || nickname ? `<div class="cell-stack"><b>${esc(nickname || extra || '—')}</b>${idText(userId, '用户 ID')}</div>` : '<span class="muted">—</span>';
  const signedAmount = value => `<b class="${Number(value) < 0 ? 'danger-text' : 'success-text'}">${Number(value) >= 0 ? '+' : ''}${money(value)}</b>`;
  function renderLogRows(category, items) {
    const table = (label, heads, rows) => `<table aria-label="${esc(label)}" style="min-width:${heads.length * 140}px"><thead><tr>${heads.map(head => typeof head === 'string' ? `<th>${head}</th>` : `<th class="${head[1]}">${head[0]}</th>`).join('')}<th>详情</th></tr></thead><tbody>${rows}</tbody></table>`;
    const tokenCell = (tokens, rate) => `<td class="is-num"><div class="cell-stack"><span>${tokens === null || tokens === undefined ? '—' : money(tokens)}</span>${rate === null || rate === undefined ? '' : `<small class="muted">${money(rate)} 元 / 百万 Token</small>`}</div></td>`;
    if (category === 'generations') return table('生成任务日志', ['时间', '任务 ID', '状态', '用户', '模型', ['消耗积分', 'is-num']], items.map((item, index) => logRow(item, category, index, `<td>${date(item.createdAt)}</td><td>${idText(item.id, '任务 ID', true)}</td><td>${badge(item.status)}</td><td>${userCell(item.userId, item.userNickname)}</td><td>${plain(item.modelId)}</td><td class="is-num">${item.creditCost === null || item.creditCost === undefined ? '—' : money(item.creditCost)}</td>`, 7)).join(''));
    if (category === 'credits') return table('积分流水日志', ['时间', '流水 ID', '用户', '类型', '关联任务', ['变动', 'is-num'], ['变动后余额', 'is-num']], items.map((item, index) => logRow(item, category, index, `<td>${date(item.createdAt)}</td><td>${idText(item.id, '流水 ID')}</td><td>${userCell(item.userId, item.userNickname)}</td><td><code>${esc(item.type || item.reasonCode || '—')}</code></td><td>${idText(item.generationId, '任务 ID')}</td><td class="is-num">${signedAmount(item.amount)}</td><td class="is-num">${money(item.balanceAfter)}</td>`, 8)).join(''));
    if (category === 'llm') return table('LLM 用量日志', ['时间', '请求 ID', '状态', '用户', '模型', ['普通输入', 'is-num'], ['缓存读取', 'is-num'], ['缓存创建', 'is-num'], ['输出', 'is-num'], ['消耗积分', 'is-num']], items.map((item, index) => logRow(item, category, index, `<td>${date(item.createdAt)}</td><td>${idText(item.id, '请求 ID')}</td><td>${badge(item.status)}</td><td>${userCell(item.userId, item.userNickname)}</td><td>${plain(item.modelId)}</td>${tokenCell(item.uncachedInputTokens, item.inputRateYuanPerMillion)}${tokenCell(item.cacheReadTokens, item.cacheReadRateYuanPerMillion)}${tokenCell(item.cacheCreationTokens, item.cacheCreationRateYuanPerMillion)}${tokenCell(item.outputTokens, item.outputRateYuanPerMillion)}<td class="is-num">${item.charged === null || item.charged === undefined ? '—' : money(item.charged)}</td>`, 11)).join(''));
    if (category === 'audit') return table('管理员审计日志', ['时间', '操作', '目标', '管理员', '结果'], items.map((item, index) => logRow(item, category, index, `<td>${date(item.createdAt)}</td><td><code>${esc(item.action)}</code></td><td><div class="cell-stack"><span>${plain(item.targetType)}</span>${idText(item.targetId, '目标 ID')}</div></td><td>${userCell(item.actorUserId, item.actorNickname)}</td><td>${badge(item.status)}</td>`, 6)).join(''));
    // 客户端日志包存在对象存储里，这一列给的是后端签名跳转，点开即下载 .log.gz。
    if (category === 'client') return table('客户端诊断日志', ['时间', '编号', '用户', '版本 / 平台', '问题描述', '日志包'], items.map((item, index) => logRow(item, category, index, `<td>${date(item.createdAt)}</td><td><code>${esc(item.reference)}</code></td><td>${userCell(item.userId, item.userNickname, item.username)}</td><td><div class="cell-stack"><span>${plain(item.appVersion)}</span><span class="detail">${esc(item.platform || '—')}</span></div></td><td><div class="cell-stack"><span class="cell-clip" title="${esc(item.note || '')}">${plain(item.note)}</span><span class="detail">${money(Math.max(1, Math.round((item.size || 0) / 1024)))} KB</span></div></td><td>${item.downloadable ? `<a class="btn btn-sm" href="/api/admin/logs/client/${encodeURIComponent(item.id)}/download">${icon('download')}下载</a>` : '<span class="muted">—</span>'}</td>`, 7)).join(''));
    return table('系统异常日志', ['时间', '级别', '分类', '消息', '用户', '模型', '关联任务'], items.map((item, index) => logRow(item, category, index, `<td>${date(item.createdAt)}</td><td>${badge(item.level, item.level === 'error' || item.level === 'critical' ? 'bad' : item.level === 'info' ? 'info' : 'warn')}</td><td><code>${esc(item.category || '—')}</code></td><td><span class="cell-clip" title="${esc(item.message || '')}">${plain(item.message)}</span></td><td>${userCell(item.userId, item.userNickname)}</td><td>${plain(item.modelId)}</td><td>${idText(item.generationId, '任务 ID')}</td>`, 8)).join(''));
  }
  function bindLogDetails(root) {
    $$('[data-log-expand]', root).forEach(button => button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') === 'true';
      const detailRow = document.getElementById(button.getAttribute('aria-controls'));
      button.setAttribute('aria-expanded', String(!expanded));
      $('.log-expand-label', button).textContent = expanded ? '展开' : '收起';
      detailRow.hidden = expanded;
      button.closest('.log-row')?.classList.toggle('is-expanded', !expanded);
    }));
    $$('[data-copy-log]', root).forEach(button => button.addEventListener('click', () => copyText($('pre', button.closest('.log-detail-panel'))?.textContent || '', '日志详情')));
  }

  function syncTaskFilter(category = state.logCategory) {
    const input = $('#logTaskId');
    if (input) input.disabled = !taskFilterCategories.has(category);
  }

  function logFiltersMarkup() {
    const category = state.logCategory;
    const spec = logFilterSpec[category] || {};
    const filters = state.filters.logs;
    const statusSpec = spec.status;
    const statusField = !statusSpec ? '' : statusSpec.options
      ? `<label class="field"><span class="field-label">${esc(statusSpec.label)}</span><select id="logStatus">${statusSpec.options.map(([value, label]) => `<option value="${esc(value)}" ${value === filters.status ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`
      : `<label class="field"><span class="field-label">${esc(statusSpec.label)}</span><input id="logStatus" value="${esc(filters.status)}" placeholder="${esc(statusSpec.placeholder || '')}" autocomplete="off" spellcheck="false"></label>`;
    return `${spec.taskId ? `<label class="field is-wide"><span class="field-label">任务 ID</span><span class="search-input">${icon('search')}<input id="logTaskId" data-search value="${esc(filters.taskId)}" placeholder="精确匹配任务 ID" autocomplete="off" spellcheck="false"></span></label>` : ''}
      <label class="field${spec.taskId ? '' : ' is-wide'}"><span class="field-label">${esc(spec.userLabel || '用户 ID')}</span><input id="logUserId" ${spec.taskId ? '' : 'data-search'} value="${esc(filters.userId)}" placeholder="完整 ID" autocomplete="off" spellcheck="false"></label>
      ${spec.modelId ? `<label class="field"><span class="field-label">模型 ID</span><input id="logModelId" value="${esc(filters.modelId)}" placeholder="例如 seedance-2.0" autocomplete="off" spellcheck="false"></label>` : ''}
      ${statusField}
      <label class="field is-date"><span class="field-label">开始时间</span><input id="logFrom" type="datetime-local" value="${esc(filters.from)}"></label>
      <label class="field is-date"><span class="field-label">结束时间</span><input id="logTo" type="datetime-local" value="${esc(filters.to)}"></label>
      <div class="toolbar-actions"><button class="btn btn-ghost" type="button" data-reset>${icon('rotate')}重置</button><button class="btn btn-primary" type="submit">${icon('search')}查询</button></div>
      <div id="logQuickRange" style="width:100%">${quickRangeChips('logs', filters)}</div>`;
  }

  async function loadLogs() {
    const root = $('#view-logs');
    const categories = Object.keys(logLabels);
    if (!categories.includes(state.logCategory)) state.logCategory = 'generations';
    root.innerHTML = pageHead('logsTitle', '日志中心', '按类型、用户、模型和时间范围查找运营记录，点击“展开”查看完整内容', refreshButton('logs')) + `
      <div class="tabs" role="tablist" aria-label="日志类型">${categories.map(key => `<button class="tab" role="tab" type="button" data-log-tab="${key}" aria-selected="${String(key === state.logCategory)}" tabindex="${key === state.logCategory ? 0 : -1}" aria-controls="logPanel">${esc(logLabels[key])}</button>`).join('')}</div>
      <div class="panel" id="logPanel" role="tabpanel">
        <form id="logFilters" class="toolbar" role="search"></form>
        <div id="logTable" data-table>${skeletonMarkup()}</div>
      </div>`;
    const renderFilters = () => {
      const form = $('#logFilters');
      form.innerHTML = logFiltersMarkup();
      syncTaskFilter();
      const readFilters = () => {
        const filters = state.filters.logs;
        const value = selector => $(selector, form)?.value.trim() ?? '';
        if ($('#logTaskId', form)) filters.taskId = value('#logTaskId');
        filters.userId = value('#logUserId');
        if ($('#logModelId', form)) filters.modelId = value('#logModelId');
        filters.status = value('#logStatus');
        filters.from = $('#logFrom', form).value;
        filters.to = $('#logTo', form).value;
      };
      const apply = () => { readFilters(); $('#logQuickRange', form).innerHTML = quickRangeChips('logs', state.filters.logs); bindQuick(); resetPager('log'); fetchLogs(); };
      const bindQuick = () => $$('[data-quick-range="logs"]', form).forEach(button => button.onclick = () => { $('#logFrom', form).value = rangeStart(button.dataset.value); $('#logTo', form).value = ''; apply(); });
      bindQuick();
      form.onsubmit = event => { event.preventDefault(); apply(); };
      $('#logFrom', form).onchange = $('#logTo', form).onchange = apply;
      const statusControl = $('#logStatus', form);
      if (statusControl?.tagName === 'SELECT') statusControl.onchange = apply;
      $('[data-reset]', form).onclick = () => { Object.assign(state.filters.logs, { taskId: '', userId: '', modelId: '', status: '', from: '', to: '' }); renderFilters(); resetPager('log'); fetchLogs(); };
    };
    const tabs = $$('[data-log-tab]', root);
    const selectCategory = key => {
      if (key === state.logCategory) return;
      state.logCategory = key;
      state.filters.logs.status = '';
      tabs.forEach(tab => { const active = tab.dataset.logTab === key; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
      renderFilters();
      $('#logTable').innerHTML = skeletonMarkup();
      resetPager('log');
      fetchLogs();
    };
    tabs.forEach((tab, index) => {
      tab.onclick = () => selectCategory(tab.dataset.logTab);
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        selectCategory(next.dataset.logTab); next.focus();
      };
    });
    renderFilters();
    $('[data-refresh="logs"]', root).onclick = fetchLogs;
    await fetchLogs();
  }

  async function fetchLogs() {
    const table = $('#logTable'); if (!table) return;
    const category = state.logCategory;
    const spec = logFilterSpec[category] || {};
    const filters = state.filters.logs;
    const token = nextRequest('logs');
    const params = new URLSearchParams({ limit: '50' });
    if (currentCursor('log')) params.set('cursor', currentCursor('log'));
    if (spec.taskId && filters.taskId) params.set('taskId', filters.taskId);
    if (filters.userId) params.set('userId', filters.userId);
    if (spec.modelId && filters.modelId) params.set('modelId', filters.modelId);
    if (spec.status && filters.status) params.set(spec.status.param, filters.status);
    if (filters.from) params.set('from', inputToIso(filters.from));
    if (filters.to) params.set('to', inputToIso(filters.to));
    markLoading(table);
    try {
      const data = await api(`/api/admin/logs/${category}?${params}`);
      if (isStale('logs', token) || category !== state.logCategory) return;
      const items = data.items || [];
      const filtered = [...params.keys()].some(key => !['limit', 'cursor'].includes(key));
      table.innerHTML = items.length ? `<div class="table-wrap" style="border:0;border-radius:0">${renderLogRows(category, items)}</div>${pageControls('log', data.total, data.nextCursor, items.length)}`
        : emptyMarkup(`暂无${logLabels[category]}`, filtered ? '尝试放宽筛选条件或调整时间范围。' : '有新的记录时会显示在这里。');
      doneLoading(table);
      bindLogDetails(table);
      bindPageControls(table, 'log', fetchLogs, data.nextCursor);
    } catch (error) {
      if (isStale('logs', token)) return;
      doneLoading(table);
      table.innerHTML = errorMarkup(error.message, 'logs');
      bindRetry(table, 'logs', fetchLogs);
    }
  }

  /* ---------- 登录 ---------- */
  async function login(event) {
    event.preventDefault();
    const errorEl = $('#loginError');
    const button = $('button[type="submit"]', event.currentTarget);
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    errorEl.textContent = '';
    if (!username || !password) { errorEl.textContent = !username ? '请输入管理员账号。' : '请输入密码。'; (!username ? $('#loginUsername') : $('#loginPassword')).focus(); return; }
    setButtonBusy(button, true, '登录中…');
    try {
      const result = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setButtonBusy(button, false);
      enterApp(result);
    } catch (error) {
      errorEl.textContent = error.status === 401 ? (error.message || '账号或密码不正确。') : (error.message || '登录失败，请稍后重试。');
      setButtonBusy(button, false);
      $('#loginPassword').select();
    }
  }

  $('#loginForm').addEventListener('submit', login);
  $('#loginPasswordToggle').addEventListener('click', event => {
    const input = $('#loginPassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-pressed', String(show));
    event.currentTarget.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    event.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
    input.focus();
  });
  ['keydown', 'keyup'].forEach(type => $('#loginPassword').addEventListener(type, event => { if (typeof event.getModifierState === 'function') $('#loginCaps').hidden = !event.getModifierState('CapsLock'); }));
  $('#loginPassword').addEventListener('blur', () => { $('#loginCaps').hidden = true; });
  $('#logoutButton').addEventListener('click', async event => {
    const button = event.currentTarget;
    const confirmed = await showAdminDialog({ kicker: '账号', title: '退出登录？', description: '退出后需要重新登录才能继续使用管理后台。', submit: '退出登录', danger: true, size: 'narrow' });
    if (confirmed === null) return;
    setButtonBusy(button, true, '退出中…');
    try { await api('/api/admin/auth/logout', { method: 'POST', body: '{}' }); } catch {} finally { location.reload(); }
  });
  $$('.nav').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  // 会话检查完成前不显示登录页，避免已登录的管理员看到登录界面闪一下。
  api('/api/admin/auth/session', { skipAuthRedirect: true }).then(enterApp).catch(error => showLogin(error?.status === 401 ? '' : !error?.status ? '暂时无法连接服务，请检查网络后重试。' : (error.message || '')));
})();
