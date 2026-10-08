// GuGu AI API console: account, keys, logs, model catalog, docs and top-up.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const formatNumber = (value, digits = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('zh-CN', { minimumFractionDigits:0, maximumFractionDigits:digits });
};
const formatTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
};
const formatDate = value => value ? new Date(value).toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }) : '永久有效';

const PROTECTED_VIEWS = new Set(['/', '/keys', '/logs', '/billing']);
const state = { user:null, catalog:null, baseUrl:'', keys:[], logCursor:null, loginMode:'sms', sample:'curl', payOrder:null, payTimer:null, editingKeyId:null };

async function api(path, { method = 'GET', body, quiet = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials:'same-origin',
      headers:body === undefined ? {} : { 'Content-Type':'application/json' },
      body:body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('网络连接失败，请检查网络后重试');
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    if (response.status === 401 && !quiet && state.user) { state.user = null; renderAccount(); route(); }
    throw error;
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 2600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败，请手动选择复制'); }
    area.remove();
  }
}

// ---------------------------------------------------------------- account

function renderAccount() {
  const loginButton = $('[data-action="login"]');
  const chip = $('#accountChip');
  loginButton.hidden = Boolean(state.user);
  chip.hidden = !state.user;
  if (state.user) {
    $('#accountName').textContent = state.user.displayName || state.user.username;
    $('#headerBalance').textContent = formatNumber(state.wallet?.available ?? state.wallet?.balance, 2);
  }
  $$('[data-auth-required]').forEach(element => { element.hidden = !state.user; });
}

async function loadSession() {
  try {
    const data = await api('/api/auth/me', { quiet:true });
    state.user = data.user;
    await refreshWallet();
  } catch { state.user = null; }
  renderAccount();
}

async function refreshWallet() {
  if (!state.user) return;
  try {
    state.wallet = await api('/api/credits');
    $('#headerBalance').textContent = formatNumber(state.wallet.available ?? state.wallet.balance, 2);
    const billingBalance = $('#billingBalance');
    if (billingBalance) billingBalance.textContent = formatNumber(state.wallet.available ?? state.wallet.balance, 2);
  } catch { /* header keeps the last value */ }
}

// ---------------------------------------------------------------- routing

function currentPath() {
  const path = location.pathname.replace(/(.)\/+$/, '$1');
  return ['/', '/models', '/keys', '/logs', '/docs', '/billing'].includes(path) ? path : '/';
}

function navigate(path) {
  if (path !== location.pathname) history.pushState({}, '', path);
  route();
  window.scrollTo({ top:0 });
}

const viewTitles = { '/':'API 概览', '/models':'模型', '/keys':'API 密钥', '/logs':'调用日志', '/docs':'接口文档', '/billing':'充值' };

function route() {
  const path = currentPath();
  const needsLogin = PROTECTED_VIEWS.has(path) && !state.user;
  $$('.view').forEach(view => { view.hidden = view.dataset.view !== (needsLogin ? 'login' : path); });
  $$('.site-nav [data-route]').forEach(link => {
    const active = link.dataset.route === path;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${needsLogin ? '登录' : viewTitles[path]} · GuGu AI API`;
  if (needsLogin) { showLogin(); return; }
  if (path === '/') renderOverview();
  if (path === '/models') renderModels();
  if (path === '/keys') loadKeys();
  if (path === '/logs') loadLogs({ reset:true });
  if (path === '/docs') renderDocs();
  if (path === '/billing') renderBilling();
}

// ---------------------------------------------------------------- catalog

async function loadCatalog({ force = false } = {}) {
  if (state.catalog && !force) return state.catalog;
  const data = await api('/api/public/api-models');
  state.catalog = data.models || [];
  state.baseUrl = data.baseUrl;
  return state.catalog;
}

const typeLabel = type => type === 'image' ? '图片' : '视频';
function priceUnit(model, row) {
  if (row.unit === 'second') return '秒';
  return model.id === 'midjourney' ? '组（4 张）' : '张';
}
function priceSummary(model) {
  const rows = model.pricing || [];
  if (!rows.length) return '暂无价格';
  const lowest = rows.reduce((min, row) => row.credits < min.credits ? row : min, rows[0]);
  return `${rows.length > 1 ? '低至 ' : ''}${formatNumber(lowest.credits, 4)} 积分 / ${priceUnit(model, lowest)}`;
}

function valuesText(param) {
  if (param.values?.length) {
    const values = param.values.map(value => `<code>${escapeHtml(value)}</code>`);
    return values.length > 12 ? `${values.slice(0, 12).join(' ')} <span class="muted">等 ${values.length} 项</span>` : values.join(' ');
  }
  if (param.min !== undefined || param.max !== undefined) return `${escapeHtml(param.min ?? '')} – ${escapeHtml(param.max ?? '')}`;
  return '—';
}

function modelSpecHtml(model) {
  const params = `<div class="table-wrap"><table class="data-table spec-table"><thead><tr><th scope="col">参数</th><th scope="col">类型</th><th scope="col">必填</th><th scope="col">默认值</th><th scope="col">可选值</th><th scope="col">说明</th></tr></thead><tbody>${
    model.parameters.map(param => `<tr><td><code>${escapeHtml(param.name)}</code></td><td>${escapeHtml(param.type)}</td><td>${param.required ? '是' : '否'}</td><td>${param.default === undefined ? '—' : `<code>${escapeHtml(param.default)}</code>`}</td><td class="values-cell">${valuesText(param)}</td><td>${escapeHtml(param.description)}${param.endpoints ? `<br><span class="muted">仅用于 ${param.endpoints.map(escapeHtml).join('、')}</span>` : ''}</td></tr>`).join('')
  }</tbody></table></div>`;
  const modes = model.type === 'video' ? `<h4>生成方式</h4><div class="table-wrap"><table class="data-table spec-table"><thead><tr><th scope="col">mode</th><th scope="col">时长（秒）</th><th scope="col">画幅</th><th scope="col">清晰度</th><th scope="col">参考素材上限</th></tr></thead><tbody>${
    model.modes.map(mode => {
      const refs = mode.mode === 'text' ? '不需要' : `图片 ${mode.references.image} · 视频 ${mode.references.video} · 音频 ${mode.references.audio}（合计 ${mode.references.total}，至少 ${mode.references.min}）`;
      const seconds = mode.seconds_by_resolution
        ? Object.entries(mode.seconds_by_resolution).map(([resolution, values]) => `${escapeHtml(resolution)}：${values.join('、') || '—'}`).join('<br>')
        : mode.seconds.join('、');
      return `<tr><td><code>${escapeHtml(mode.mode)}</code> ${escapeHtml(mode.label)}</td><td>${seconds}</td><td>${mode.aspect_ratios.map(escapeHtml).join('、')}</td><td>${mode.resolutions.map(escapeHtml).join('、')}</td><td>${refs}</td></tr>`;
    }).join('')
  }</tbody></table></div><h4>size 与画幅、清晰度的对应</h4><div class="size-list">${
    [...new Map(model.modes.flatMap(mode => mode.sizes).map(item => [item.size, item])).values()].map(item => `<span><code>${escapeHtml(item.size)}</code> ${escapeHtml(item.aspect_ratio)} · ${escapeHtml(item.resolution)}</span>`).join('')
  }</div>` : '';
  const pricing = model.pricing?.length ? `<h4>价格</h4><div class="table-wrap"><table class="data-table spec-table"><thead><tr><th scope="col">规格</th><th scope="col" class="num">积分</th><th scope="col" class="num">人民币</th></tr></thead><tbody>${
    model.pricing.map(row => `<tr><td>${escapeHtml(row.quality)}${row.seconds ? ` · ${row.seconds} 秒视频` : ''}</td><td class="num">${formatNumber(row.credits, 4)} / ${priceUnit(model, row)}</td><td class="num">¥${formatNumber(row.yuan, 4)} / ${priceUnit(model, row)}</td></tr>`).join('')
  }</tbody></table></div>` : '';
  return `${model.description ? `<p>${escapeHtml(model.description)}</p>` : ''}<p class="muted">接口：${model.endpoints.map(path => `<code>POST ${escapeHtml(path)}</code>`).join(' ')}</p><h4>参数</h4>${params}${modes}${pricing}`;
}

let modelFilter = 'all';
async function renderModels() {
  const list = $('#modelList');
  try {
    const catalog = await loadCatalog();
    const items = catalog.filter(model => modelFilter === 'all' || model.type === modelFilter);
    list.innerHTML = items.length ? items.map(model => `<details class="model-entry" id="model-${escapeHtml(model.id)}">
      <summary>
        <span class="model-name"><b>${escapeHtml(model.name)}</b><span class="type-tag type-${model.type}">${typeLabel(model.type)}</span></span>
        <span class="model-id"><code>${escapeHtml(model.id)}</code><button class="ghost-button compact" type="button" data-copy="${escapeHtml(model.id)}" aria-label="复制模型 ID ${escapeHtml(model.id)}">复制</button></span>
        <span class="model-price">${escapeHtml(priceSummary(model))}</span>
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="model-detail">${modelSpecHtml(model)}</div>
    </details>`).join('') : '<p class="empty-state">当前没有可调用的模型，请稍后刷新。</p>';
  } catch (error) {
    list.innerHTML = `<p class="empty-state">模型读取失败：${escapeHtml(error.message)}</p>`;
  } finally { list.setAttribute('aria-busy', 'false'); }
}

// ---------------------------------------------------------------- samples

function sampleModels() {
  const catalog = state.catalog || [];
  return {
    image:catalog.find(model => model.type === 'image')?.id || 'gpt-image-2',
    video:catalog.find(model => model.type === 'video'),
  };
}

function samples(kind = 'all') {
  const base = state.baseUrl || `${location.origin}/v1`;
  const { image, video } = sampleModels();
  const videoId = video?.id || 'seedance-2.0';
  const videoMode = video?.modes?.find(mode => mode.mode === 'text') || video?.modes?.[0];
  const videoSize = videoMode?.sizes?.find(item => item.resolution === '720p')?.size || videoMode?.sizes?.[0]?.size || '1280x720';
  const videoSeconds = String(videoMode?.seconds?.[0] || 5);
  const curl = `# 1. 创建图片任务
curl ${base}/images/generations \\
  -H "Authorization: Bearer $GUGU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${image}", "prompt": "一只在雨夜霓虹街头散步的橘猫", "n": 1}'

# 2. 查询任务，status 为 completed 时 data 中会给出下载地址
curl ${base}/images/img_xxx -H "Authorization: Bearer $GUGU_API_KEY"

# 3. 创建视频任务
curl ${base}/videos \\
  -H "Authorization: Bearer $GUGU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${videoId}", "prompt": "镜头缓慢推进，海浪拍打礁石", "seconds": "${videoSeconds}", "size": "${videoSize}"}'

# 4. 下载视频
curl -L ${base}/videos/video_xxx/content -H "Authorization: Bearer $GUGU_API_KEY" -o output.mp4`;
  const python = `import time
from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="sk-gugu-...")

# 视频：直接使用 OpenAI SDK 的 videos 接口
video = client.videos.create(
    model="${videoId}",
    prompt="镜头缓慢推进，海浪拍打礁石",
    seconds="${videoSeconds}",
    size="${videoSize}",
)
while video.status in ("queued", "in_progress"):
    time.sleep(10)
    video = client.videos.retrieve(video.id)

if video.status == "completed":
    client.videos.download_content(video.id).write_to_file("output.mp4")

# 图片：任务为异步，创建后查询结果
task = client.post("/images/generations", cast_to=dict, body={
    "model": "${image}", "prompt": "一只在雨夜霓虹街头散步的橘猫", "n": 1,
})
while task["status"] in ("queued", "in_progress"):
    time.sleep(5)
    task = client.get(f"/images/{task['id']}", cast_to=dict)
print([item["url"] for item in task["data"]])`;
  const node = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${base}', apiKey: process.env.GUGU_API_KEY });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let video = await client.videos.create({
  model: '${videoId}',
  prompt: '镜头缓慢推进，海浪拍打礁石',
  seconds: '${videoSeconds}',
  size: '${videoSize}',
});
while (['queued', 'in_progress'].includes(video.status)) {
  await sleep(10_000);
  video = await client.videos.retrieve(video.id);
}

let task = await client.post('/images/generations', {
  body: { model: '${image}', prompt: '一只在雨夜霓虹街头散步的橘猫', n: 1 },
});
while (['queued', 'in_progress'].includes(task.status)) {
  await sleep(5_000);
  task = await client.get(\`/images/\${task.id}\`);
}
console.log(task.data.map(item => item.url));`;
  return kind === 'all' ? { curl, python, node } : { curl, python, node }[kind];
}

function renderSampleTabs(name) {
  const tabs = $(`[data-sample-tabs="${name}"]`);
  const output = $(`[data-sample-output="${name}"]`);
  if (!tabs || !output) return;
  const labels = { curl:'cURL', python:'Python', node:'Node.js' };
  tabs.innerHTML = Object.entries(labels).map(([key, label]) => `<button type="button" role="tab" data-sample="${key}" aria-selected="${state.sample === key}">${label}</button>`).join('');
  output.textContent = samples(state.sample);
}

// ---------------------------------------------------------------- overview

async function renderOverview() {
  const stats = $('#overviewStats');
  await loadCatalog().catch(() => {});
  renderSampleTabs('overview');
  try {
    const data = await api('/api/console/overview');
    $('#baseUrl').textContent = data.baseUrl;
    state.baseUrl = data.baseUrl;
    renderSampleTabs('overview');
    stats.innerHTML = `
      <div class="stat"><span>可用积分</span><b>${formatNumber(data.available, 2)}</b><small>约 ¥${formatNumber(Number(data.available) * 0.1, 2)} · <a href="/billing" data-route="/billing">充值</a></small></div>
      <div class="stat"><span>今日调用</span><b>${formatNumber(data.today.requests, 0)}</b><small>消耗 ${formatNumber(data.today.credits, 2)} 积分${data.today.errors ? ` · 失败 ${data.today.errors} 次` : ''}</small></div>
      <div class="stat"><span>近 30 天调用</span><b>${formatNumber(data.last30Days.requests, 0)}</b><small>消耗 ${formatNumber(data.last30Days.credits, 2)} 积分</small></div>
      <div class="stat"><span>可用密钥</span><b>${formatNumber(data.keys.active, 0)}</b><small>共 ${data.keys.total} 个 · <a href="/keys" data-route="/keys">管理</a></small></div>`;
  } catch (error) {
    stats.innerHTML = `<p class="empty-state">概览读取失败：${escapeHtml(error.message)}</p>`;
  }
}

// ---------------------------------------------------------------- keys

function keyStatus(key) {
  if (key.expired) return '<span class="status status-muted">已过期</span>';
  return key.status === 'active' ? '<span class="status status-ok">可用</span>' : '<span class="status status-muted">已停用</span>';
}

async function loadKeys() {
  const body = $('#keyTable tbody');
  body.innerHTML = '<tr><td colspan="7" class="empty-cell">正在读取…</td></tr>';
  try {
    const data = await api('/api/console/keys');
    state.keys = data.keys;
    body.innerHTML = data.keys.length ? data.keys.map(key => `<tr>
      <td data-label="名称"><b>${escapeHtml(key.name)}</b><small class="muted block">创建于 ${formatTime(key.createdAt)}</small></td>
      <td data-label="密钥"><code>${escapeHtml(key.hint)}</code></td>
      <td data-label="状态">${keyStatus(key)}</td>
      <td data-label="已用 / 额度">${formatNumber(key.usedCredits, 2)} / ${key.creditLimit === null ? '不限' : formatNumber(key.creditLimit, 2)}</td>
      <td data-label="有效期至">${formatDate(key.expiresAt)}</td>
      <td data-label="最近使用">${key.lastUsedAt ? formatTime(key.lastUsedAt) : '尚未使用'}</td>
      <td class="row-actions">
        <button class="ghost-button compact" type="button" data-key-action="toggle" data-key="${key.id}">${key.status === 'active' ? '停用' : '启用'}</button>
        <button class="ghost-button compact" type="button" data-key-action="edit" data-key="${key.id}">编辑</button>
        <button class="ghost-button compact danger" type="button" data-key-action="delete" data-key="${key.id}">删除</button>
      </td></tr>`).join('') : '<tr><td colspan="7" class="empty-cell">还没有 API 密钥。点击“创建密钥”开始使用。</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell">密钥读取失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function openKeyDialog(key = null) {
  state.editingKeyId = key?.id || null;
  const form = $('#keyForm');
  form.reset();
  $('#keyDialogTitle').textContent = key ? '编辑 API 密钥' : '创建 API 密钥';
  $('#keySubmit').textContent = key ? '保存' : '创建';
  $('#keyFormError').hidden = true;
  const keepOption = form.elements.expires.querySelector('option[value="keep"]');
  keepOption.hidden = !key;
  if (key) {
    form.elements.name.value = key.name;
    form.elements.creditLimit.value = key.creditLimit ?? '';
    form.elements.expires.value = key.expiresAt ? 'keep' : '';
    keepOption.textContent = key.expiresAt ? `保持不变（${formatDate(key.expiresAt)}）` : '保持不变';
  }
  $('#keyDialog').showModal();
  form.elements.name.focus();
}

async function submitKeyForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('#keyFormError');
  const name = form.elements.name.value.trim();
  if (!name) { error.textContent = '请填写密钥名称'; error.hidden = false; return; }
  const payload = { name, creditLimit:form.elements.creditLimit.value === '' ? null : Number(form.elements.creditLimit.value) };
  const expires = form.elements.expires.value;
  if (expires !== 'keep') payload.expiresAt = expires ? new Date(Date.now() + Number(expires) * 86400_000).toISOString() : null;
  const submit = $('#keySubmit');
  submit.disabled = true;
  try {
    if (state.editingKeyId) {
      await api(`/api/console/keys/${state.editingKeyId}`, { method:'PATCH', body:payload });
      $('#keyDialog').close();
      toast('密钥已保存');
    } else {
      const data = await api('/api/console/keys', { method:'POST', body:payload });
      $('#keyDialog').close();
      $('#newSecret').textContent = data.secret;
      $('#secretDialog').showModal();
    }
    await loadKeys();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { submit.disabled = false; }
}

async function handleKeyAction(button) {
  const key = state.keys.find(item => item.id === button.dataset.key);
  if (!key) return;
  const action = button.dataset.keyAction;
  if (action === 'edit') return openKeyDialog(key);
  if (action === 'toggle') {
    button.disabled = true;
    try {
      await api(`/api/console/keys/${key.id}`, { method:'PATCH', body:{ status:key.status === 'active' ? 'disabled' : 'active' } });
      toast(key.status === 'active' ? '密钥已停用' : '密钥已启用');
      await loadKeys();
    } catch (error) { toast(error.message); button.disabled = false; }
    return;
  }
  if (action === 'delete') {
    $('#confirmText').textContent = `删除后，使用“${key.name}”（${key.hint}）的请求会立即失败，且无法恢复。`;
    const dialog = $('#confirmDialog');
    const accept = $('#confirmAccept');
    accept.onclick = async () => {
      accept.disabled = true;
      try {
        await api(`/api/console/keys/${key.id}`, { method:'DELETE' });
        dialog.close();
        toast('密钥已删除');
        await loadKeys();
      } catch (error) { toast(error.message); }
      finally { accept.disabled = false; }
    };
    dialog.showModal();
  }
}

// ---------------------------------------------------------------- logs

const taskStatusText = { queued:'排队中', in_progress:'生成中', completed:'已完成', failed:'失败' };
function logResult(log) {
  if (log.statusCode >= 400) return `<span class="status status-error">${log.statusCode}</span> <span class="log-error">${escapeHtml(log.errorMessage || '')}</span>`;
  const task = log.taskStatus;
  const taskText = task ? ` · ${taskStatusText[task.status] || task.status}${task.refunded ? '，已退回积分' : ''}` : '';
  return `<span class="status status-ok">${log.statusCode}</span>${escapeHtml(taskText)}`;
}

async function populateLogFilters() {
  const form = $('#logFilters');
  const keySelect = form.elements.key;
  const modelSelect = form.elements.model;
  try {
    if (!state.keys.length) state.keys = (await api('/api/console/keys')).keys;
    const keyValue = keySelect.value;
    keySelect.innerHTML = `<option value="">全部密钥</option>${state.keys.map(key => `<option value="${key.id}">${escapeHtml(key.name)}</option>`).join('')}`;
    keySelect.value = keyValue;
  } catch { /* filters stay usable */ }
  try {
    const catalog = await loadCatalog();
    const modelValue = modelSelect.value;
    modelSelect.innerHTML = `<option value="">全部模型</option>${catalog.map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('')}`;
    modelSelect.value = modelValue;
  } catch { /* filters stay usable */ }
}

async function loadLogs({ reset = false } = {}) {
  const body = $('#logTable tbody');
  const more = $('#moreLogs');
  if (reset) {
    state.logCursor = null;
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">正在读取…</td></tr>';
    populateLogFilters();
  }
  const form = $('#logFilters');
  const params = new URLSearchParams({ limit:'50' });
  for (const name of ['key', 'model', 'outcome']) if (form.elements[name].value) params.set(name, form.elements[name].value);
  if (form.elements.from.value) params.set('from', new Date(`${form.elements.from.value}T00:00:00`).toISOString());
  if (form.elements.to.value) params.set('to', new Date(new Date(`${form.elements.to.value}T00:00:00`).getTime() + 86400_000).toISOString());
  if (!reset && state.logCursor) params.set('before', state.logCursor);
  more.disabled = true;
  try {
    const data = await api(`/api/console/logs?${params}`);
    const rows = data.logs.map(log => `<tr>
      <td data-label="时间">${formatTime(log.createdAt)}</td>
      <td data-label="密钥">${escapeHtml(log.keyName || '—')}</td>
      <td data-label="请求"><code>${escapeHtml(log.method)} ${escapeHtml(log.path)}</code>${log.taskId ? `<small class="muted block">${escapeHtml(log.taskId)}</small>` : ''}</td>
      <td data-label="模型">${escapeHtml(log.model || '—')}</td>
      <td data-label="结果">${logResult(log)}</td>
      <td data-label="扣费" class="num">${log.credits ? formatNumber(log.credits, 4) : '—'}</td>
      <td data-label="耗时" class="num">${formatNumber(log.latencyMs, 0)} ms</td>
      <td data-label="请求 ID"><button class="ghost-button compact mono" type="button" data-copy="${escapeHtml(log.requestId)}" aria-label="复制请求 ID">${escapeHtml(log.requestId.slice(0, 8))}</button></td>
    </tr>`).join('');
    if (reset) body.innerHTML = rows || '<tr><td colspan="8" class="empty-cell">没有符合条件的调用记录。</td></tr>';
    else body.insertAdjacentHTML('beforeend', rows);
    state.logCursor = data.nextCursor;
    more.hidden = !data.hasMore;
  } catch (error) {
    if (reset) body.innerHTML = `<tr><td colspan="8" class="empty-cell">日志读取失败：${escapeHtml(error.message)}</td></tr>`;
    else toast(error.message);
  } finally { more.disabled = false; }
}

// ---------------------------------------------------------------- docs

function codeBlock(text) { return `<pre class="code-block">${escapeHtml(text)}</pre>`; }

async function renderDocs() {
  const body = $('#docsBody');
  const toc = $('#docsToc');
  let catalog;
  try { catalog = await loadCatalog(); }
  catch (error) { body.innerHTML = `<h1 id="docs-title">接口文档</h1><p class="empty-state">文档读取失败：${escapeHtml(error.message)}</p>`; return; }
  const base = state.baseUrl;
  const image = catalog.find(model => model.type === 'image');
  const video = catalog.find(model => model.type === 'video');
  const videoMode = video?.modes?.find(mode => mode.mode === 'text') || video?.modes?.[0];
  const videoSize = videoMode?.sizes?.find(item => item.resolution === '720p')?.size || videoMode?.sizes?.[0]?.size || '1280x720';
  const videoSeconds = String(videoMode?.seconds?.[0] || 5);
  const sections = [
    ['auth', '认证与接口地址'], ['endpoints', '接口一览'], ['images', '图片生成'], ['videos', '视频生成'],
    ['tasks', '任务状态'], ['download', '下载结果'], ['errors', '错误处理'], ['billing', '计费'], ['limits', '频率限制与重试'], ['models', '模型参数'],
  ];
  toc.innerHTML = `<b>目录</b>${sections.map(([id, title]) => `<a href="#${id}">${title}</a>`).join('')}<div class="toc-models">${catalog.map(model => `<a href="#doc-${escapeHtml(model.id)}">${escapeHtml(model.name)}</a>`).join('')}</div>`;
  body.innerHTML = `
    <h1 id="docs-title">接口文档</h1>
    <p>接口路径与参数格式兼容 OpenAI，可以直接使用 OpenAI 官方 SDK，或任何支持自定义接口地址的工具。图片和视频都是异步任务：先创建任务，再查询结果。</p>

    <h2 id="auth">认证与接口地址</h2>
    <p>接口地址：</p>${codeBlock(base)}
    <p>在 <a href="/keys" data-route="/keys">API 密钥</a> 页面创建密钥，并在每个请求的请求头中携带：</p>${codeBlock('Authorization: Bearer sk-gugu-...')}
    <p>密钥等同于账号的支付凭证，请只在服务端使用，不要写进网页、App 安装包或公开仓库。</p>

    <h2 id="endpoints">接口一览</h2>
    <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">方法与路径</th><th scope="col">说明</th></tr></thead><tbody>
      <tr><td><code>GET /v1/models</code></td><td>列出当前可调用的模型</td></tr>
      <tr><td><code>GET /v1/models/{model}</code></td><td>查看单个模型的参数、生成方式和价格</td></tr>
      <tr><td><code>POST /v1/images/generations</code></td><td>创建图片任务</td></tr>
      <tr><td><code>POST /v1/images/edits</code></td><td>使用参考图创建图片任务</td></tr>
      <tr><td><code>GET /v1/images/{id}</code></td><td>查询图片任务</td></tr>
      <tr><td><code>GET /v1/images/{id}/content?index=0</code></td><td>下载第 index 张图片</td></tr>
      <tr><td><code>GET /v1/images</code></td><td>列出图片任务，支持 <code>limit</code>、<code>after</code>、<code>order</code></td></tr>
      <tr><td><code>DELETE /v1/images/{id}</code></td><td>删除已结束的图片任务及其结果</td></tr>
      <tr><td><code>POST /v1/videos</code></td><td>创建视频任务</td></tr>
      <tr><td><code>GET /v1/videos/{id}</code></td><td>查询视频任务</td></tr>
      <tr><td><code>GET /v1/videos/{id}/content</code></td><td>下载视频文件</td></tr>
      <tr><td><code>GET /v1/videos</code></td><td>列出视频任务，支持 <code>limit</code>、<code>after</code>、<code>order</code></td></tr>
      <tr><td><code>DELETE /v1/videos/{id}</code></td><td>删除已结束的视频任务及其结果</td></tr>
    </tbody></table></div>

    <h2 id="images">图片生成</h2>
    <p>请求体为 JSON。<code>/v1/images/edits</code> 同时支持 multipart/form-data 上传文件，字段名为 <code>image</code> 或 <code>image[]</code>；JSON 请求中 <code>image</code> 可以是图片的 https 链接、data URL 或它们组成的数组。</p>
    ${codeBlock(`curl ${base}/images/generations \\
  -H "Authorization: Bearer $GUGU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${image?.id || 'gpt-image-2'}",
    "prompt": "一只在雨夜霓虹街头散步的橘猫",
    "n": 1
  }'`)}
    <p>创建成功会立即返回任务，此时还没有图片：</p>
    ${codeBlock(`{
  "id": "img_6f1c0a9e2b7d4c3a8e5f1b2c3d4e5f60",
  "object": "image",
  "model": "${image?.id || 'gpt-image-2'}",
  "status": "queued",
  "progress": 0,
  "created_at": 1767225600,
  "completed_at": null,
  "expires_at": null,
  "n": 1,
  "size": "1024x1024",
  "credits": 1,
  "data": [],
  "error": null
}`)}
    <p>生成完成后查询任务，<code>data</code> 中给出每张图片的下载地址（下载时同样需要携带密钥）：</p>
    ${codeBlock(`{
  "id": "img_6f1c0a9e2b7d4c3a8e5f1b2c3d4e5f60",
  "object": "image",
  "status": "completed",
  "progress": 100,
  "data": [
    { "index": 0, "url": "${base}/images/img_6f1c0a9e2b7d4c3a8e5f1b2c3d4e5f60/content?index=0" }
  ],
  "error": null
}`)}

    <h2 id="videos">视频生成</h2>
    <p>与 OpenAI Videos 接口一致。<code>size</code> 决定画幅和清晰度，也可以分别传 <code>aspect_ratio</code> 和 <code>resolution</code>；可选值见下方各模型参数。</p>
    ${codeBlock(`curl ${base}/videos \\
  -H "Authorization: Bearer $GUGU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${video?.id || 'seedance-2.0'}",
    "prompt": "镜头缓慢推进，海浪拍打礁石",
    "seconds": "${videoSeconds}",
    "size": "${videoSize}"
  }'`)}
    ${codeBlock(`{
  "id": "video_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "object": "video",
  "model": "${video?.id || 'seedance-2.0'}",
  "status": "in_progress",
  "progress": 35,
  "created_at": 1767225600,
  "completed_at": null,
  "expires_at": null,
  "seconds": "${videoSeconds}",
  "size": "${videoSize}",
  "aspect_ratio": "${videoMode?.sizes?.find(item => item.size === videoSize)?.aspect_ratio || '16:9'}",
  "resolution": "${videoMode?.sizes?.find(item => item.size === videoSize)?.resolution || '720p'}",
  "mode": "text",
  "credits": 15,
  "error": null
}`)}
    <p>参考素材：</p>
    <ul>
      <li><code>input_reference</code>：参考图片，可以是上传的文件、https 链接、data URL，或它们组成的数组。首尾帧模式（<code>mode: "first_last"</code>）下按顺序作为首帧和尾帧。</li>
      <li><code>reference_videos</code>、<code>reference_audios</code>：参考视频和音频的链接数组，仅部分模型支持。</li>
      <li>有参考素材时默认使用 <code>reference</code> 方式生成；没有时为 <code>text</code>。</li>
      <li>图片不超过 20 MB，视频和音频不超过 25 MB；单次请求体不超过 50 MB，较大的素材请使用链接。</li>
    </ul>

    <h2 id="tasks">任务状态</h2>
    <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">status</th><th scope="col">含义</th></tr></thead><tbody>
      <tr><td><code>queued</code></td><td>已提交，等待开始</td></tr>
      <tr><td><code>in_progress</code></td><td>生成中，<code>progress</code> 为大致进度（0–100）</td></tr>
      <tr><td><code>completed</code></td><td>已完成，可以下载结果</td></tr>
      <tr><td><code>failed</code></td><td>生成失败，<code>error</code> 中有原因，本次扣除的积分会自动退回</td></tr>
    </tbody></table></div>
    <p>建议图片每 5 秒、视频每 10 秒查询一次。多张图片中只有部分失败时，任务仍为 <code>completed</code>，失败的部分不计费，<code>error</code> 中会说明。</p>

    <h2 id="download">下载结果</h2>
    ${codeBlock(`curl -L ${base}/videos/{id}/content -H "Authorization: Bearer $GUGU_API_KEY" -o output.mp4
curl -L "${base}/images/{id}/content?index=0" -H "Authorization: Bearer $GUGU_API_KEY" -o output.png`)}
    <p>下载地址可能会跳转到文件存储地址，请让客户端跟随跳转（curl 使用 <code>-L</code>）。生成结果保存 6 天，<code>expires_at</code> 为到期时间，请及时下载保存。</p>

    <h2 id="errors">错误处理</h2>
    <p>出错时返回对应的 HTTP 状态码，响应体格式与 OpenAI 相同：</p>
    ${codeBlock(`{
  "error": {
    "message": "积分不足，本次需要 15 积分，当前可用 3 积分",
    "type": "insufficient_quota",
    "param": null,
    "code": "insufficient_quota"
  }
}`)}
    <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">状态码</th><th scope="col">code</th><th scope="col">说明</th></tr></thead><tbody>
      <tr><td>400</td><td><code>invalid_parameter</code> · <code>invalid_reference</code></td><td>参数不正确或参考素材无法读取，<code>param</code> 指出具体参数</td></tr>
      <tr><td>401</td><td><code>missing_api_key</code> · <code>invalid_api_key</code> · <code>api_key_disabled</code> · <code>api_key_expired</code></td><td>密钥缺失、无效、已停用或已过期</td></tr>
      <tr><td>403</td><td><code>account_disabled</code></td><td>账号已停用</td></tr>
      <tr><td>404</td><td><code>model_not_found</code> · <code>not_found</code></td><td>模型或任务不存在</td></tr>
      <tr><td>409</td><td><code>task_in_progress</code> · <code>task_not_completed</code> · <code>idempotency_key_reused</code></td><td>任务状态不允许当前操作，或幂等键被用于不同请求</td></tr>
      <tr><td>410</td><td><code>content_expired</code></td><td>结果已超过保存期限</td></tr>
      <tr><td>429</td><td><code>insufficient_quota</code></td><td>积分不足，请 <a href="/billing" data-route="/billing">充值</a></td></tr>
      <tr><td>429</td><td><code>key_quota_exceeded</code></td><td>已达到该密钥的额度上限</td></tr>
      <tr><td>429</td><td><code>rate_limit_exceeded</code></td><td>请求过于频繁，按响应头 <code>Retry-After</code> 等待后重试</td></tr>
      <tr><td>503</td><td><code>model_unavailable</code></td><td>模型暂时不可用，请稍后重试或换用其他模型</td></tr>
      <tr><td>500</td><td><code>server_error</code></td><td>服务暂时异常，请稍后重试</td></tr>
    </tbody></table></div>
    <p>每个响应都带有 <code>X-Request-Id</code> 响应头，联系客服时提供它可以更快定位问题。</p>

    <h2 id="billing">计费</h2>
    <ul>
      <li>价格与 GuGu AI 官网、客户端一致，1 积分 = ¥0.1。各模型价格见 <a href="#models">模型参数</a>，也可以在 <a href="/models" data-route="/models">模型</a> 页面查看。</li>
      <li>创建任务时按所选参数扣除积分，任务对象的 <code>credits</code> 为本次实际扣除的积分；生成失败会自动退回。</li>
      <li>查询任务、下载结果和查看模型不收费。</li>
    </ul>

    <h2 id="limits">频率限制与重试</h2>
    <ul>
      <li>每个密钥每分钟最多 300 次请求，其中创建任务最多 60 次。</li>
      <li>创建任务时可以带上请求头 <code>Idempotency-Key</code>（1–200 个字符）。网络超时后用同一个值重试，不会重复创建任务、也不会重复扣费。</li>
    </ul>

    <h2 id="models">模型参数</h2>
    <p>模型、可选参数和价格会随服务状态更新，以本页和 <code>GET /v1/models/{model}</code> 的返回为准。</p>
    ${catalog.map(model => `<section class="doc-model" id="doc-${escapeHtml(model.id)}"><h3>${escapeHtml(model.name)} <code>${escapeHtml(model.id)}</code></h3>${modelSpecHtml(model)}</section>`).join('')}
  `;
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

// ---------------------------------------------------------------- billing

let selectedAmount = null;
async function renderBilling() {
  await refreshWallet();
  const presets = $('#amountPresets');
  if (!presets.children.length) {
    let amounts = [10, 50, 100, 500];
    try {
      const data = await api('/api/public/credit-packages');
      const packaged = (data.packages || []).map(item => Number(item.amount)).filter(value => Number.isInteger(value) && value >= 1 && value <= 10000);
      if (packaged.length) amounts = packaged;
    } catch { /* default amounts */ }
    presets.innerHTML = amounts.map((amount, index) => `<button type="button" role="radio" aria-checked="${index === 0}" data-amount="${amount}"><b>¥${amount}</b><span>${formatNumber(amount * 10, 0)} 积分</span></button>`).join('');
    selectedAmount = amounts[0];
  }
  loadLedger();
}

async function loadLedger() {
  const body = $('#ledgerTable tbody');
  const labels = { generation_charge:'生成扣费', generation_refund:'失败退回', alipay_purchase:'充值', wechat_purchase:'微信充值', signup_bonus:'注册赠送', admin_credit_adjustment:'积分调整', llm:'智能助手', llm_capture:'智能助手', alipay_refund:'退款', wechat_refund:'退款' };
  try {
    const data = state.wallet?.transactions ? state.wallet : await api('/api/credits');
    const rows = (data.transactions || []).slice(0, 30);
    body.innerHTML = rows.length ? rows.map(item => `<tr><td>${formatTime(item.createdAt)}</td><td>${escapeHtml(labels[item.type] || (Number(item.amount) >= 0 ? '积分增加' : '积分消耗'))}${item.modelId ? ` · ${escapeHtml(item.modelId)}` : ''}</td><td class="num ${Number(item.amount) >= 0 ? 'positive' : ''}">${Number(item.amount) >= 0 ? '+' : ''}${formatNumber(item.amount, 4)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty-cell">还没有积分记录。</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="3" class="empty-cell">读取失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function stopPayPolling() { clearTimeout(state.payTimer); state.payTimer = null; }

function finishPayment(title, message) {
  stopPayPolling();
  state.payOrder = null;
  $('#payTitle').textContent = title;
  $('#payStatus').textContent = message;
}

async function checkPayment({ manual = false } = {}) {
  const orderId = state.payOrder;
  if (!orderId) return;
  try {
    const data = await api(`/api/payments/wechat/orders/${orderId}/query`, { method:'POST' });
    if (state.payOrder !== orderId) return;
    if (data.order?.status === 'PAID') {
      finishPayment('支付成功', '支付成功，积分已到账。');
      state.wallet = null;
      await refreshWallet();
      loadLedger();
      toast('充值成功');
    } else if (data.order?.status === 'CLOSED') {
      finishPayment('订单已关闭', '订单已关闭，请重新发起支付。');
    } else if (manual) toast('暂未查到支付结果，请稍候');
  } catch (error) { if (manual) toast(error.message); }
}

function schedulePayPolling(startedAt = Date.now()) {
  stopPayPolling();
  state.payTimer = setTimeout(async () => {
    await checkPayment();
    if (!state.payOrder) return;
    if (Date.now() - startedAt > 10 * 60_000) { $('#payStatus').textContent = '如已完成支付，请点击“我已支付”刷新结果。'; return; }
    schedulePayPolling(startedAt);
  }, 3000);
}

async function submitRecharge(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('#rechargeError');
  error.hidden = true;
  const custom = form.elements.amount.value.trim();
  const amount = custom ? Number(custom) : selectedAmount;
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) { error.textContent = '请输入 1–10000 的整数金额'; error.hidden = false; return; }
  const submit = $('#rechargeSubmit');
  submit.disabled = true;
  stopPayPolling();
  try {
    const data = await api('/api/payments/wechat/orders', { method:'POST', body:{ amount:String(amount) } });
    state.payOrder = data.order.outTradeNo;
    const panel = $('#payPanel');
    panel.hidden = false;
    $('#payTitle').textContent = '微信扫码支付';
    $('#payAmount').innerHTML = `支付 <b>¥${escapeHtml(data.order.totalAmount)}</b>，到账 ${formatNumber(data.order.credits, 0)} 积分`;
    $('#payStatus').textContent = '请使用微信扫码，支付完成后积分会自动到账。';
    const qr = $('#payQr');
    qr.hidden = !data.qrCodeUrl;
    if (data.qrCodeUrl) qr.src = data.qrCodeUrl;
    const link = $('#payLink');
    link.hidden = !data.paymentUrl;
    if (data.paymentUrl) link.href = data.paymentUrl;
    panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
    schedulePayPolling();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { submit.disabled = false; }
}

// ---------------------------------------------------------------- login

function setLoginMode(mode) {
  state.loginMode = mode;
  $$('[data-login-mode]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.loginMode === mode)));
  $$('[data-login-fields]').forEach(group => { group.hidden = group.dataset.loginFields !== mode; });
  $('#loginError').hidden = true;
}

let captchaId = '';
async function refreshCaptcha() {
  try {
    const data = await api('/api/auth/captcha', { quiet:true });
    captchaId = data.challengeId;
    $('#captchaImage').src = data.image;
  } catch { /* the user can retry */ }
}

function showLogin() {
  if (!captchaId) refreshCaptcha();
}

let smsCooldown = 0;
async function sendSms(button) {
  const form = $('#loginForm');
  const error = $('#loginError');
  error.hidden = true;
  button.disabled = true;
  try {
    const data = await api('/api/auth/sms/send', { method:'POST', quiet:true, body:{ phone:form.elements.phone.value, captchaId, captchaCode:form.elements.captchaCode.value } });
    toast('验证码已发送');
    smsCooldown = Number(data.cooldownSeconds) || 60;
    const tick = () => {
      if (smsCooldown <= 0) { button.disabled = false; button.textContent = '获取验证码'; return; }
      button.textContent = `${smsCooldown} 秒后重发`;
      smsCooldown--;
      setTimeout(tick, 1000);
    };
    tick();
    form.elements.code.focus();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    button.disabled = false;
    refreshCaptcha();
    form.elements.captchaCode.value = '';
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('#loginError');
  error.hidden = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const data = state.loginMode === 'sms'
      ? await api('/api/auth/sms/login', { method:'POST', quiet:true, body:{ phone:form.elements.phone.value, code:form.elements.code.value } })
      : await api('/api/auth/login', { method:'POST', quiet:true, body:{ identifier:form.elements.identifier.value, password:form.elements.password.value } });
    state.user = data.user;
    form.reset();
    await refreshWallet();
    renderAccount();
    route();
    toast('登录成功');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { submit.disabled = false; }
}

async function logout() {
  try { await api('/api/auth/logout', { method:'POST', quiet:true }); } catch { /* the local state resets anyway */ }
  state.user = null;
  state.wallet = null;
  state.keys = [];
  stopPayPolling();
  renderAccount();
  route();
}

// ---------------------------------------------------------------- events

function initMenu() {
  const header = $('#site-header');
  const menu = $('.menu-toggle', header);
  header.classList.add('has-menu');
  const setOpen = open => {
    header.classList.toggle('menu-open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? '收起导航' : '展开导航');
  };
  menu.addEventListener('click', () => setOpen(menu.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('click', event => { if (!header.contains(event.target) || event.target.closest('.site-nav a')) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && header.classList.contains('menu-open')) { setOpen(false); menu.focus(); } });
}

document.addEventListener('click', event => {
  const routeLink = event.target.closest('a[data-route]');
  if (routeLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    navigate(routeLink.dataset.route);
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) { event.preventDefault(); event.stopPropagation(); copyText(copy.dataset.copy); return; }
  const copyTarget = event.target.closest('[data-copy-target]');
  if (copyTarget) { copyText($(`#${copyTarget.dataset.copyTarget}`).textContent); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'login') navigate(PROTECTED_VIEWS.has(currentPath()) ? currentPath() : '/');
  if (action === 'logout') logout();
  if (action === 'create-key') openKeyDialog();
  if (action === 'close-dialog') event.target.closest('dialog')?.close();
  if (action === 'refresh-captcha') refreshCaptcha();
  if (action === 'send-sms') sendSms(event.target.closest('button'));
  const keyAction = event.target.closest('[data-key-action]');
  if (keyAction) handleKeyAction(keyAction);
  const loginMode = event.target.closest('[data-login-mode]');
  if (loginMode) setLoginMode(loginMode.dataset.loginMode);
  const sample = event.target.closest('[data-sample]');
  if (sample) { state.sample = sample.dataset.sample; renderSampleTabs('overview'); }
  const filter = event.target.closest('#modelFilter [data-filter]');
  if (filter) {
    modelFilter = filter.dataset.filter;
    $$('#modelFilter [data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button === filter)));
    renderModels();
  }
  const amount = event.target.closest('[data-amount]');
  if (amount) {
    selectedAmount = Number(amount.dataset.amount);
    $$('#amountPresets [data-amount]').forEach(button => button.setAttribute('aria-checked', String(button === amount)));
    $('#rechargeForm').elements.amount.value = '';
  }
});

$('#keyForm').addEventListener('submit', submitKeyForm);
$('#loginForm').addEventListener('submit', submitLogin);
$('#rechargeForm').addEventListener('submit', submitRecharge);
$('#payCheck').addEventListener('click', () => checkPayment({ manual:true }));
$('#logFilters').addEventListener('submit', event => { event.preventDefault(); loadLogs({ reset:true }); });
$('#moreLogs').addEventListener('click', () => loadLogs());
$('#secretDialog').addEventListener('close', () => { $('#newSecret').textContent = ''; });
window.addEventListener('popstate', route);

initMenu();
loadSession().then(route);
