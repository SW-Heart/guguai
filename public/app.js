import { createDramaStudio } from './drama-studio.js?v=30';
import { listSignature, mergeTransientFields, recordSignature } from './list-sync.js?v=1';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { user:null, route:'image', authMode:'login', tasks:[], files:[], credits:0, creditTransactions:[], creditWallet:{ balance:0, held:0, available:0 }, creditDetailTab:'spend', creditDetailRestoreFocus:null, pricing:{ image:1, videoPerSecond:1, signupBonus:50 }, config:{}, dramaAnalysis:null, dramaProject:null, dramaLoading:false, generationFilter:'all', generationView:'large', fileKind:'all', referenceTarget:'image', refs:{ image:[], video:[] }, videoGenerationType:'TEXT', videoFrames:{ first:'', last:'' }, videoFrameTarget:'', dialogSelection:[], uploadContext:'library', detailTaskId:null, previewFileId:null };
const routePaths = Object.freeze({ image:'/image', video:'/video', drama:'/drama', files:'/files' });
const authPath = '/login';
const routeFromPath = pathname => Object.entries(routePaths).find(([, path]) => path === pathname)?.[0] || 'image';
const taskSignatureFields = ['id','type','status','assetId','updatedAt','error','creditStatus','prompt','size','quality','aspectRatio','duration','createdAt'];
const fileSignatureFields = ['id','name','kind','mimeType','size','url','updatedAt','sourceGenerationId','createdAt'];
const taskCardSignatureFields = taskSignatureFields.filter(field => field !== 'updatedAt');
const fileCardSignatureFields = fileSignatureFields.filter(field => field !== 'updatedAt');
let tasksRequest = null;
let filesRequest = null;
let pollTimer = 0;
const activePollDelay = 6000;
const idlePollDelay = 60000;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials:'same-origin', ...options, headers:{ ...(options.body instanceof Blob ? {} : { 'Content-Type':'application/json' }), ...(options.headers || {}) } });
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok) { const error = Object.assign(new Error(data.error || '请求失败'), data); error.status = response.status; throw error; }
  return data;
}
const esc = (value='') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
const dateText = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const fullDateText = value => value ? new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
const imageAccept = 'image/png,image/jpeg,image/webp';
const libraryAccept = `${imageAccept},video/mp4,video/webm,video/quicktime`;
const statusText = value => ({ queued:'排队中', running:'生成中', completed:'已完成', failed:'失败' })[value] || value;
const generationStage = status => status === 'queued' ? 1 : status === 'running' ? 3 : status === 'completed' ? 5 : 0;
const generationStages = ['排队', '准备', '生成', '增强', '完成'];
const taskFailure = task => {
  if (task?.failure && typeof task.failure === 'object') return {
    code: String(task.failure.code || 'UNKNOWN'),
    message: String(task.failure.message || '生成失败'),
    suggestion: String(task.failure.suggestion || '请调整内容后重试。'),
    action: String(task.failure.action || 'edit_input'),
  };
  return task?.status === 'failed' ? { code:'UNKNOWN', message:'生成失败，服务未返回具体原因', suggestion:'请调整提示词或参考图片后重试；若持续失败，请联系支持。', action:'edit_input' } : null;
};
const taskErrorText = task => { const failure = taskFailure(task); return failure ? `${failure.message}\n建议：${failure.suggestion}` : ''; };
const taskFailureActionLabel = failure => ({ retry_later:'稍后重试', retry:'重新生成', contact_support:'联系支持', wait:'稍后刷新' })[failure?.action] || '调整后重试';
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('show'); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3200); }
function emptyState(title, body, action='') { return `<div class="empty-state"><div class="empty-orbit"><i></i><i></i><i></i></div><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`; }

function setAuthMode(mode) { state.authMode = mode; const registering = mode === 'register'; $$('.auth-tabs button').forEach(button => button.classList.toggle('active', button.dataset.auth === mode)); $('#authSubmit span').textContent = registering ? '创建账号' : '登录'; $('#authPassword').autocomplete = registering ? 'new-password' : 'current-password'; $('#inviteField').classList.toggle('hidden', !registering); $('#authInvite').required = registering; $('#authError').textContent = ''; }
$$('.auth-tabs button').forEach(button => button.onclick = () => setAuthMode(button.dataset.auth));
$('#togglePassword').onclick = () => { const input = $('#authPassword'); input.type = input.type === 'password' ? 'text' : 'password'; $('#togglePassword').setAttribute('aria-label', input.type === 'password' ? '显示密码' : '隐藏密码'); };
$('#authForm').onsubmit = async event => { event.preventDefault(); const username = $('#authUsername').value.trim(); const password = $('#authPassword').value; const inviteCode = $('#authInvite').value.trim(); const button = $('#authSubmit'); $('#authError').textContent = ''; if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { $('#authError').textContent = '账号需为 3–24 位字母、数字或下划线'; return; } if (password.length < 8) { $('#authError').textContent = '密码至少需要 8 位'; return; } if (state.authMode === 'register' && !inviteCode) { $('#authError').textContent = '请输入邀请码'; return; } button.disabled = true; try { const result = await api(`/api/auth/${state.authMode}`, { method:'POST', body:JSON.stringify({ username, password, ...(state.authMode === 'register' ? { inviteCode } : {}) }) }); await enterApp(result.user); } catch (error) { $('#authError').textContent = error.status === 404 ? '注册服务未启动，请重启后端服务' : error.message; } finally { button.disabled = false; } };
function creditText(balance) { return (Number(balance) || 0).toLocaleString('zh-CN', { maximumFractionDigits:4 }); }
function creditEntryAmount(entry) {
  const amount = Number(entry?.amount);
  if (Number.isFinite(amount)) return amount;
  const amountMicro = Number(entry?.amountMicro);
  return Number.isFinite(amountMicro) ? amountMicro / 1_000_000 : 0;
}
function creditDateText(value) { const date = new Date(value); return value && !Number.isNaN(date.getTime()) ? fullDateText(value) : '—'; }
function creditModelName(entry, task = null) {
  const modelId = entry?.modelId || task?.modelId || entry?.model || entry?.modelName;
  if (!modelId) return '—';
  if (modelId === 'gpt-image-2') return 'GPT Image 2';
  const catalog = state.config?.videoCapabilities?.models || [];
  return catalog.find(model => model.id === modelId)?.label || String(modelId);
}
function creditGenerationType(entry) {
  const task = entry?.generationId ? state.tasks.find(item => item.id === entry.generationId) : null;
  if (entry?.contentType === 'image' || task?.type === 'image' || entry?.modelId === 'gpt-image-2') return '图像生成';
  if (entry?.contentType === 'video' || task?.type === 'video') return '视频生成';
  return '视频生成';
}
function creditSpendType(entry) {
  if (entry?.type === 'llm_capture') return '文本生成';
  if (entry?.type === 'admin_credit_adjustment') return '后台扣减';
  return creditGenerationType(entry);
}
function creditEarnType(entry) {
  if (entry?.type === 'generation_refund') return '任务失败退款';
  if (entry?.type === 'signup_bonus') return '赠送（通过邀请码注册给的积分）';
  if (entry?.type === 'admin_credit_adjustment') return '充值（后台操作增加积分）';
  return '积分获取';
}
function signedCreditAmount(amount) { return `${amount < 0 ? '-' : '+'}${creditText(Math.abs(amount))}`; }
function renderCreditRows(entries, direction) {
  if (!entries.length) return `<tr><td colspan="${direction === 'spend' ? 4 : 3}"><div class="credit-empty">暂无${direction === 'spend' ? '积分消耗' : '积分获取'}记录</div></td></tr>`;
  return entries.map(entry => {
    const amount = creditEntryAmount(entry);
    const task = entry.generationId ? state.tasks.find(item => item.id === entry.generationId) : null;
    const model = direction === 'spend' ? `<td>${esc(creditModelName(entry, task))}</td>` : '';
    const type = direction === 'spend' ? creditSpendType(entry) : creditEarnType(entry);
    return `<tr><td><time datetime="${esc(entry.createdAt || '')}">${esc(creditDateText(entry.createdAt))}</time></td><td>${esc(type)}</td>${model}<td class="${direction === 'spend' ? 'credit-spend' : 'credit-earn'}">${esc(signedCreditAmount(amount))}</td></tr>`;
  }).join('');
}
function renderCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (!dialog) return;
  const balance = Number(state.creditWallet.balance ?? state.credits) || 0;
  $('#creditDetailBalance').textContent = creditText(balance);
  $('#creditDetailAvailable').textContent = creditText(state.creditWallet.available ?? balance);
  $('#creditDetailHeld').textContent = creditText(state.creditWallet.held ?? 0);
  const spend = state.creditDetailTab === 'spend';
  $('#creditSpendTab').classList.toggle('active', spend);
  $('#creditEarnTab').classList.toggle('active', !spend);
  $('#creditSpendTab').setAttribute('aria-selected', String(spend));
  $('#creditEarnTab').setAttribute('aria-selected', String(!spend));
  $('#creditSpendPanel').hidden = !spend;
  $('#creditEarnPanel').hidden = spend;
  const entries = state.creditTransactions.filter(entry => { const amount = creditEntryAmount(entry); return spend ? amount < 0 : amount > 0; });
  $('#creditSpendBody').innerHTML = renderCreditRows(spend ? entries : [], 'spend');
  $('#creditEarnBody').innerHTML = renderCreditRows(spend ? [] : entries, 'earn');
}
function setCreditDetailTab(tab) { state.creditDetailTab = tab === 'earn' ? 'earn' : 'spend'; renderCreditDetail(); }
function setCreditBalance(balance) {
  state.credits = Number(balance) || 0;
  state.creditWallet = { ...state.creditWallet, balance:state.credits, available:Math.max(0, state.credits - (Number(state.creditWallet.held) || 0)) };
  $('#creditAmount').textContent = creditText(state.credits);
  $('#menuAccountMeta').textContent = `${state.user?.role === 'admin' ? '管理员' : '当前账号'} · ${creditText(state.credits)} 积分`;
  renderCreditDetail();
}
async function loadCredits() {
  try {
    const result = await api('/api/credits');
    state.pricing = result.pricing;
    state.creditWallet = { balance:Number(result.balance) || 0, held:Number(result.held) || 0, available:Number(result.available) || 0 };
    state.creditTransactions = Array.isArray(result.transactions) ? result.transactions : [];
    setCreditBalance(result.balance);
    updateVideoCost();
  } catch (error) { if (error.status === 401) location.reload(); }
}
function closeCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (dialog.open) dialog.close(); dialog.hidden = true;
}
async function openCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (!dialog || dialog.open) return;
  state.creditDetailRestoreFocus = document.activeElement;
  $('#accountMenu').classList.add('hidden');
  dialog.hidden = false;
  renderCreditDetail();
  dialog.showModal();
  requestAnimationFrame(() => $('#closeCreditDetail').focus());
  await loadCredits();
}
$('#creditBalance').onclick = () => { void openCreditDetail(); };
$('#closeCreditDetail').onclick = closeCreditDetail;
$('#creditSpendTab').onclick = () => setCreditDetailTab('spend');
$('#creditEarnTab').onclick = () => setCreditDetailTab('earn');
$('#creditDetailDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeCreditDetail(); });
$('#creditDetailDialog').addEventListener('cancel', event => { event.preventDefault(); closeCreditDetail(); });
$('#creditDetailDialog').addEventListener('close', () => { $('#creditDetailDialog').hidden = true; const restore = state.creditDetailRestoreFocus; state.creditDetailRestoreFocus = null; requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); }); });
function showBoot(title = '正在恢复工作区', message = '正在确认登录状态，请稍候。', { retry = false } = {}) {
  $('#bootTitle').textContent = title;
  $('#bootMessage').textContent = message;
  $('#bootRetry').classList.toggle('hidden', !retry);
  $('#bootView').classList.remove('hidden');
  $('#authView').classList.add('hidden');
  $('#appView').classList.add('hidden');
}
function showAuth() {
  state.user = null;
  $('#bootView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  document.title = '登录 · GuGu AI';
}
function showApp() {
  $('#bootView').classList.add('hidden');
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}
async function enterApp(user) {
  state.user = user;
  showBoot('正在加载工作区', '正在同步你的品牌素材与生成记录，请稍候。');
  const initial = user.username[0].toUpperCase();
  $('#accountName').textContent = user.username;
  $('#menuName').textContent = user.username;
  $('#accountInitial').textContent = initial;
  $('#menuInitial').textContent = initial;
  setCreditBalance(user.credits);
  await Promise.all([loadConfig(), loadCredits(), loadFiles(), loadTasks()]);
  navigate(routeFromPath(window.location.pathname), { historyMode:'replace' });
  showApp();
}

let deleteConfirmationResolver = null;
let deleteConfirmationRestoreFocus = null;
function settleDeleteConfirmation(confirmed) { const resolver = deleteConfirmationResolver; const restoreFocus = deleteConfirmationRestoreFocus; deleteConfirmationResolver = null; deleteConfirmationRestoreFocus = null; const dialog = $('#deleteConfirmDialog'); if (dialog.open) dialog.close(); resolver?.(confirmed); requestAnimationFrame(() => { if (restoreFocus?.isConnected && !restoreFocus.disabled) restoreFocus.focus(); }); }
function confirmDelete({ title = '确认删除', message = '删除后无法恢复。' } = {}) { if (deleteConfirmationResolver) settleDeleteConfirmation(false); const dialog = $('#deleteConfirmDialog'); deleteConfirmationRestoreFocus = document.activeElement; $('#deleteConfirmTitle').textContent = title; $('#deleteConfirmMessage').textContent = message; return new Promise(resolve => { deleteConfirmationResolver = resolve; dialog.showModal(); requestAnimationFrame(() => $('#acceptDeleteConfirm').focus()); }); }
$('#cancelDeleteConfirm').onclick = () => settleDeleteConfirmation(false);
$('#acceptDeleteConfirm').onclick = () => settleDeleteConfirmation(true);
$('#deleteConfirmDialog').addEventListener('cancel', event => { event.preventDefault(); settleDeleteConfirmation(false); });

let renameFileId = '';
let renameFileRestoreFocus = null;
function renameFileError(message = '') { const error = $('#renameFileError'); error.textContent = message; error.classList.toggle('hidden', !message); }
function openRenameFileDialog(file) {
  if (!file) return;
  renameFileId = file.id;
  renameFileRestoreFocus = document.activeElement;
  $('#renameFileInput').value = file.name || '';
  renameFileError();
  $('#saveRenameFile').disabled = false;
  const dialog = $('#renameFileDialog');
  dialog.showModal();
  requestAnimationFrame(() => { const input = $('#renameFileInput'); input.focus(); input.select(); });
}
function closeRenameFileDialog() { const dialog = $('#renameFileDialog'); if (dialog.open) dialog.close(); }
$('#renameFileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const file = state.files.find(item => item.id === renameFileId);
  const name = $('#renameFileInput').value;
  if (!file) return closeRenameFileDialog();
  if (!name.trim()) { renameFileError('请输入文件名。'); $('#renameFileInput').focus(); return; }
  if (name === file.name) return closeRenameFileDialog();
  const button = $('#saveRenameFile'); button.disabled = true; renameFileError();
  try { await api(`/api/files/${file.id}`, { method:'PATCH', body:JSON.stringify({ name }) }); closeRenameFileDialog(); toast('文件已重命名'); await loadFiles(); }
  catch (error) { renameFileError(error.message); button.disabled = false; }
});
$('#closeRenameFile').onclick = $('#cancelRenameFile').onclick = closeRenameFileDialog;
$('#renameFileDialog').addEventListener('cancel', event => { event.preventDefault(); closeRenameFileDialog(); });
$('#renameFileDialog').addEventListener('close', () => { const restore = renameFileRestoreFocus; renameFileId = ''; renameFileRestoreFocus = null; renameFileError(); requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); }); });

const dramaController = createDramaStudio({ api, state, esc, toast, setCreditBalance, creditText, loadTasks, loadCredits, loadFiles, uploadImage:pickAndUploadDramaImage, confirmDelete, taskFailure });

function navigate(route, { historyMode = 'push' } = {}) { const nextRoute = routePaths[route] ? route : 'image'; if (historyMode !== 'none' && window.location.pathname !== routePaths[nextRoute]) { window.history[historyMode === 'replace' ? 'replaceState' : 'pushState']({ route:nextRoute }, '', routePaths[nextRoute]); } state.route = nextRoute; const routeTitles = { image:'图像生成', video:'视频生成', drama:'短剧创作', files:'文件库' }; $('#routeTitle').textContent = routeTitles[nextRoute]; document.title = `${routeTitles[nextRoute]} · GuGu AI`; $$('.rail-button[data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === nextRoute)); const files = nextRoute === 'files'; const drama = nextRoute === 'drama'; const wide = files || drama; $('#appView').classList.toggle('library-mode', files); $('#appView').classList.toggle('wide-mode', drama); $('#appView').classList.toggle('drama-project-open', drama && Boolean(state.dramaProject)); $('#appView').classList.toggle('drama-professional-open', drama && state.dramaProject?.mode === 'professional'); $('#creatorPanel').classList.toggle('hidden', wide); $('#generationView').classList.toggle('hidden', wide); $('#filesView').classList.toggle('hidden', !files); $('#dramaView').classList.toggle('hidden', !drama); if (!wide) { $$('[data-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.panel !== nextRoute)); $('#galleryTitle').textContent = nextRoute === 'image' ? '图像作品' : '视频作品'; renderTasks(); } else if (files) renderFiles(); else { updateDramaModelState(); dramaController.load(); } }
$$('.rail-button[data-route]').forEach(button => button.onclick = () => navigate(button.dataset.route));
window.addEventListener('popstate', () => { if (state.user) navigate(routeFromPath(window.location.pathname), { historyMode:'none' }); });
$('#accountButton').onclick = event => { event.stopPropagation(); $('#accountMenu').classList.toggle('hidden'); };
document.addEventListener('click', event => { if (!$('#accountMenu').contains(event.target)) $('#accountMenu').classList.add('hidden'); });
$('#logoutButton').onclick = async () => { await api('/api/auth/logout', { method:'POST', body:'{}' }); location.reload(); };
async function loadConfig() { const service = $('#serviceState'); try { const config = await api('/api/config'); state.config = config; if (config.pricing) state.pricing = { ...state.pricing, image: config.pricing.imagePerRequest, videoPerSecond: config.pricing.videoPerSecond }; syncVideoModelOptions(); service.classList.toggle('hidden', config.imageGeneration); service.querySelector('i').className = 'bad'; service.querySelector('span').textContent = '生成服务异常'; updateDramaModelState(); } catch { state.config = { videoCapabilities: { models: [] } }; syncVideoModelOptions(); service.classList.remove('hidden'); service.querySelector('i').className = 'bad'; service.querySelector('span').textContent = '生成服务异常'; updateDramaModelState(); } }

function updateDramaModelState() { dramaController.modelState(); }

if (false) {
function assetName(asset) { return typeof asset === 'string' ? asset : asset?.name || '未命名'; }
async function loadDramaWorkspace(force=false) {
  if (state.dramaLoading || (state.dramaProject && !force)) return;
  state.dramaLoading = true;
  try {
    const result = await api('/api/drama/projects/latest');
    state.dramaProject = result.project;
    $('#dramaScript').value = result.project.script || '';
    $('#dramaScriptCount').textContent = Array.from(result.project.script || '').length.toLocaleString('zh-CN');
    if (result.project.storyboard) renderStoryboard(result.project);
    else renderDramaAnalysis({ project:result.project, analysis:result.project.analysis, usage:result.project.analysisUsage });
  } catch (error) {
    if (error.status !== 404) toast(error.message);
  } finally { state.dramaLoading = false; }
}
function renderDramaAnalysis(result) {
  state.dramaAnalysis = result;
  if (result.project) state.dramaProject = result.project;
  const analysis = result.analysis || state.dramaProject?.analysis;
  const usage = result.usage || state.dramaProject?.analysisUsage || {};
  const scenes = analysis.scenes || [];
  const labels = { characters:'角色', locations:'场景', props:'道具', costumes:'服装' };
  $('#dramaAnalysis').innerHTML = `<nav class="workflow-steps" aria-label="短剧制作进度"><span class="done">01 剧本</span><span class="active">02 分镜</span><span>03 关键帧</span><span>04 视频</span></nav><header class="analysis-title"><span>STRUCTURE REPORT</span><h2>${esc(analysis.title)}</h2><p>${esc(analysis.logline || '尚未生成故事梗概')}</p><div class="analysis-usage"><span>输入 ${Number(usage.inputTokens || 0).toLocaleString('zh-CN')} Token</span><span>输出 ${Number(usage.outputTokens || 0).toLocaleString('zh-CN')} Token</span><span>实扣 ${creditText(usage.chargedCredits)} 积分</span></div></header><section class="analysis-section"><header><h3>场次表</h3><span>${scenes.length} SCENES</span></header><div class="scene-ledger">${scenes.length ? scenes.map((scene, index) => `<article class="scene-row"><span class="scene-number">${String(scene.sceneNumber ?? index + 1).padStart(2,'0')}</span><div class="scene-copy"><b>${esc(scene.heading || scene.location || `场次 ${index + 1}`)}</b><p>${esc(scene.summary || scene.dramaticFunction || '待补充场次说明')}</p></div><span class="scene-time">${esc(scene.timeOfDay || '')}</span></article>`).join('') : '<div class="analysis-error">没有识别到场次，请补充场次标题后重新分析。</div>'}</div></section><section class="analysis-section"><header><h3>资产清单</h3><span>FIRST PASS</span></header><div class="asset-groups">${Object.entries(labels).map(([key,label]) => { const items = analysis.assets?.[key] || []; return `<div class="asset-group"><b>${label} · ${items.length}</b><div class="asset-tags">${items.length ? items.map(item => `<span title="${esc(typeof item === 'object' ? item.description || '' : '')}">${esc(assetName(item))}</span>`).join('') : '<span>未识别</span>'}</div></div>`; }).join('')}</div></section><section class="workflow-next"><div><span>NEXT / DIRECTOR BOARD</span><b>分析已保存，下一步生成导演分镜</b><p>将每个场次拆成固定 6 秒镜头，并生成关键帧与视频提示词。分镜按实际 Token 结算。</p></div><button id="generateStoryboardButton" class="gradient-button" type="button">生成导演分镜</button></section>`;
  $('#generateStoryboardButton').onclick = generateStoryboard;
}

async function generateStoryboard() {
  if (!state.dramaProject?.id) return toast('请先完成剧本分析');
  const button = $('#generateStoryboardButton'); button.disabled = true; button.textContent = '正在设计镜头…';
  try {
    const result = await api(`/api/drama/projects/${state.dramaProject.id}/storyboard`, { method:'POST', body:'{}' });
    state.dramaProject = result.project; setCreditBalance(result.balance); renderStoryboard(result.project);
    toast(`分镜完成，实扣 ${creditText(result.usage.chargedCredits)} 积分`);
  } catch (error) { button.disabled = false; button.textContent = '重新生成导演分镜'; toast(error.message); await loadCredits(); }
}

const shotTask = (shot, kind) => shot ? state.tasks.find(task => task.id === shot[kind === 'keyframe' ? 'keyframeTaskId' : 'videoTaskId']) : null;
const shotAsset = task => task?.assetId ? state.files.find(file => file.id === task.assetId) : null;
function shotAction(shot, keyframeTask, videoTask) {
  if (!keyframeTask) return `<button class="shot-generate" data-shot-action="keyframe" data-shot-id="${shot.id}" type="button">生成关键帧 <small>预扣 ${state.pricing.image} 积分</small></button>`;
  if (['queued','running'].includes(keyframeTask.status)) return `<span class="shot-progress"><i></i>关键帧${statusText(keyframeTask.status)}</span>`;
  if (keyframeTask.status === 'failed') return `<button class="shot-generate retry" data-shot-action="keyframe" data-shot-id="${shot.id}" type="button">重试关键帧 <small>预扣 ${state.pricing.image} 积分</small></button>`;
  if (!videoTask) return `<button class="shot-generate video" data-shot-action="video" data-shot-id="${shot.id}" type="button">生成 6 秒视频 <small>预扣 ${6 * state.pricing.videoPerSecond} 积分</small></button>`;
  if (['queued','running'].includes(videoTask.status)) return `<span class="shot-progress"><i></i>视频${statusText(videoTask.status)}</span>`;
  if (videoTask.status === 'failed') return `<button class="shot-generate retry" data-shot-action="video" data-shot-id="${shot.id}" type="button">重试视频 <small>预扣 ${6 * state.pricing.videoPerSecond} 积分</small></button>`;
  return '<span class="shot-complete">✓ 镜头视频完成</span>';
}
function renderStoryboard(project=state.dramaProject) {
  if (!project?.storyboard) return;
  state.dramaProject = project;
  const shots = project.storyboard.shots || [];
  const completedVideos = shots.filter(shot => shotTask(shot, 'video')?.status === 'completed').length;
  $('#dramaAnalysis').innerHTML = `<nav class="workflow-steps" aria-label="短剧制作进度"><span class="done">01 剧本</span><span class="done">02 分镜</span><span class="active">03 关键帧</span><span class="${completedVideos === shots.length && shots.length ? 'done' : ''}">04 视频</span></nav><header class="storyboard-title"><div><span>DIRECTOR BOARD / ${shots.length} SHOTS</span><h2>${esc(project.title)}</h2><p>每个镜头固定 6 秒。先生成关键帧，确认视觉后再单独预扣视频费用。</p></div><strong>${completedVideos}<small> / ${shots.length} 完片</small></strong></header><div class="shot-list">${shots.map((shot,index) => { const keyframeTask = shotTask(shot,'keyframe'); const videoTask = shotTask(shot,'video'); const keyframe = shotAsset(keyframeTask); const video = shotAsset(videoTask); const media = video ? `<video src="${video.url}" controls preload="metadata"></video>` : keyframe ? `<img src="${keyframe.url}" alt="${esc(shot.title)}" loading="lazy">` : `<div class="shot-placeholder"><span>${String(index+1).padStart(2,'0')}</span><small>KEYFRAME</small></div>`; return `<article class="shot-card"><div class="shot-media">${media}<span class="shot-duration">6 SEC</span></div><div class="shot-copy"><header><span>SCENE ${String(shot.sceneNumber).padStart(2,'0')} / SHOT ${String(shot.shotNumber).padStart(2,'0')}</span><h3>${esc(shot.title)}</h3></header><div class="shot-meta"><span>${esc(shot.shotSize)}</span><span>${esc(shot.cameraMovement)}</span><span>${esc((shot.characters || []).join('、') || '空镜')}</span></div><p>${esc(shot.action)}</p>${shot.dialogue ? `<blockquote>${esc(shot.dialogue)}</blockquote>` : ''}<details><summary>查看生成提示词</summary><p>${esc(videoTask ? shot.videoPrompt : shot.keyframePrompt)}</p></details><footer>${shotAction(shot,keyframeTask,videoTask)}</footer></div></article>`; }).join('')}</div>`;
  $$('[data-shot-action]').forEach(button => button.onclick = () => button.dataset.shotAction === 'video' ? startShotVideo(button.dataset.shotId, button) : startShotKeyframe(button.dataset.shotId, button));
}

async function bindShotTask(shotId, kind, task) {
  state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)];
  const result = await api(`/api/drama/projects/${state.dramaProject.id}/shots/${shotId}`, { method:'PATCH', body:JSON.stringify({ kind, taskId:task.id }) });
  state.dramaProject = result.project; renderStoryboard();
}
async function startShotKeyframe(shotId, button) {
  const shot = state.dramaProject.storyboard.shots.find(item => item.id === shotId); if (!shot) return;
  button.disabled = true; button.textContent = '正在提交关键帧…';
  try { const task = await api('/api/generations', { method:'POST', body:JSON.stringify({ type:'image', prompt:shot.keyframePrompt, size:'9:16', quality:'medium', referenceAssetIds:[] }) }); setCreditBalance(task.balance); await bindShotTask(shotId,'keyframe',task); toast(`关键帧已提交，预扣 ${task.creditCost} 积分`); }
  catch (error) { button.disabled = false; toast(error.message); await loadCredits(); }
}
async function startShotVideo(shotId, button) {
  const shot = state.dramaProject.storyboard.shots.find(item => item.id === shotId); const keyframeTask = shotTask(shot,'keyframe');
  if (!shot || keyframeTask?.status !== 'completed' || !keyframeTask.assetId) return toast('关键帧完成后才能生成视频');
  button.disabled = true; button.textContent = '正在提交视频…';
  try { const task = await api('/api/generations', { method:'POST', body:JSON.stringify({ type:'video', prompt:shot.videoPrompt, aspectRatio:'9:16', duration:6, referenceAssetIds:[keyframeTask.assetId] }) }); setCreditBalance(task.balance); await bindShotTask(shotId,'video',task); toast(`6 秒视频已提交，预扣 ${task.creditCost} 积分`); }
  catch (error) { button.disabled = false; toast(error.message); await loadCredits(); }
}

$('#dramaScript').oninput = event => $('#dramaScriptCount').textContent = Array.from(event.target.value).length.toLocaleString('zh-CN');
$('#dramaScriptForm').onsubmit = async event => {
  event.preventDefault(); const script = $('#dramaScript').value.trim(); if (!script) return;
  const button = $('#analyzeScriptButton'); const original = button.innerHTML; button.disabled = true; button.innerHTML = '<span class="button-spinner"></span><span>正在拆解场次</span>';
  $('#dramaAnalysis').innerHTML = '<div class="analysis-loading"><span class="loader-ring"></span><b>导演模型正在阅读剧本</b><span>完成后按实际 Token 结算</span></div>';
  try { const result = await api('/api/drama/analyze-script', { method:'POST', body:JSON.stringify({ script }) }); setCreditBalance(result.balance); renderDramaAnalysis(result); toast(`剧本分析完成，实扣 ${creditText(result.usage.chargedCredits)} 积分`); }
  catch (error) { $('#dramaAnalysis').innerHTML = `<div class="analysis-error"><b>剧本分析未完成</b><br>${esc(error.message)}</div>`; toast(error.message); await loadCredits(); }
  finally { button.disabled = !state.config.llm; button.innerHTML = original; }
};
}

async function loadTasks({ background=false }={}) {
  if (tasksRequest) { const pending = tasksRequest; return background ? pending : pending.then(() => loadTasks({ background:true })); }
  tasksRequest = (async () => {
    try {
      const tasks = await api('/api/generations');
      const previousCreditStatus = new Map(state.tasks.map(task => [task.id, task.creditStatus]));
      const refundedTask = tasks.some(task => ['refunded', 'refund_failed'].includes(task.creditStatus) && previousCreditStatus.get(task.id) !== task.creditStatus);
      const changed = listSignature(state.tasks, taskSignatureFields) !== listSignature(tasks, taskSignatureFields);
      if (changed) state.tasks = tasks;
      if (refundedTask) await loadCredits();
      const missingAssets = tasks.some(task => task.assetId && !state.files.some(file => file.id === task.assetId));
      if (missingAssets) await loadFiles({ background:true });
      if (changed) {
        if (state.route === 'drama') dramaController.refreshTasks();
        else renderTasks();
      }
      if (state.user && !document.hidden) scheduleTaskPoll();
      return state.tasks;
    } catch (error) {
      if (error.status === 401) return location.reload();
      if (!background) toast(error.message);
      return state.tasks;
    }
  })();
  try { return await tasksRequest; }
  finally { tasksRequest = null; }
}
function taskCard(task) {
  const asset = state.files.find(file => file.id === task.assetId);
  const activeStage = generationStage(task.status);
  const stageTrack = '';
  const failure = task.status === 'failed' ? taskFailure(task) : null;
  const media = asset
    ? (task.type === 'image' ? `<div class="card-media"><img src="${asset.url}" alt="${esc(asset.name)}" loading="lazy"></div>` : `<div class="card-media video"><video src="${asset.url}" preload="metadata" muted></video><span class="play-mark"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></span></div>`)
    : task.status === 'failed'
      ? `<div class="card-failure"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg><b>${esc(failure?.message || '生成失败')}</b><p>${esc(failure?.suggestion || '请调整内容后重试')}</p></div>`
      : task.assetId
        ? `<div class="card-failure"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 1.7 3h15.4a2 2 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg><b>成品文件未找到</b><p>任务已完成，但文件库中没有对应文件</p></div>`
        : `<div class="card-placeholder ${task.status}" aria-hidden="true"><div class="skeleton-frame"><i></i><i></i><i></i></div>${stageTrack}</div>`;
  const completedActions = asset ? `<div class="card-workflow-actions"><button class="task-action" type="button" data-action="preview" data-task-id="${task.id}" title="预览"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4M11 8v6M8 11h6"/></svg><span>预览</span></button>${task.type === 'image' ? `<button class="task-action" type="button" data-action="reference" data-task-id="${task.id}" title="作为参考"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="m4 16 5-5 4 4 2-2 5 4"/></svg><span>参考</span></button>` : ''}<button class="task-action" type="button" data-action="continue" data-task-id="${task.id}" title="再创作"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg><span>再创作</span></button><a class="task-action" href="/api/files/${asset.id}/download" title="下载" aria-label="下载"><svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg></a><button class="task-action" type="button" data-action="more" data-task-id="${task.id}" title="更多操作" aria-label="更多操作"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button></div>` : '';
  const failedAction = task.status === 'failed' && !['wait','contact_support'].includes(failure?.action) ? `<button class="failure-retry task-action" type="button" data-action="continue" data-task-id="${task.id}"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>${esc(taskFailureActionLabel(failure))}</button>` : '';
  return `<article class="task-card ${task.status}" data-record-id="${task.id}"><div class="card-visual">${media}<button class="media-open open-task" type="button" data-task-id="${task.id}" aria-label="查看${task.type === 'image' ? '商品图' : '商品视频'}详情"></button>${completedActions}${failedAction}</div></article>`;
}
function elementFromHtml(html) { const template = document.createElement('template'); template.innerHTML = html.trim(); return template.content.firstElementChild; }
function reconcileCards(container, records, { card, signature, bind, empty }) {
  const existing = new Map([...container.children].filter(node => node.dataset.recordId).map(node => [node.dataset.recordId, node]));
  if (!records.length) {
    const emptySignature = empty;
    if (container.dataset.emptySignature !== emptySignature || container.children.length !== 1 || !container.firstElementChild?.classList.contains('empty-state')) container.innerHTML = empty;
    container.dataset.emptySignature = emptySignature;
    return;
  }
  delete container.dataset.emptySignature;
  const desired = records.map(record => {
    const value = signature(record);
    const current = existing.get(record.id);
    if (current?.dataset.renderSignature === value) return current;
    const node = elementFromHtml(card(record));
    node.dataset.renderSignature = value;
    bind(node);
    return node;
  });
  const desiredNodes = new Set(desired);
  [...container.children].forEach(node => { if (!desiredNodes.has(node)) node.remove(); });
  desired.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
}
function bindTaskCard(card) {
  card.querySelector('.open-task')?.addEventListener('click', event => openGenerationDetail(event.currentTarget.dataset.taskId));
  card.querySelectorAll('.task-action[data-action]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); handleTaskAction(button.dataset.action, button.dataset.taskId); }));
}
function taskRenderSignature(task) {
  const asset = state.files.find(file => file.id === task.assetId);
  return `${recordSignature(task, taskCardSignatureFields)}|asset:${asset ? recordSignature(asset, fileCardSignatureFields) : ''}`;
}
function syncGenerationView() {
  const small = state.generationView === 'small';
  $('#generationGrid').classList.toggle('small-view', small);
  $$('.view-toggle').forEach(button => {
    const active = button.dataset.view === state.generationView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function renderTasks() {
  if (!['image','video'].includes(state.route)) return;
  syncGenerationView();
  let tasks = state.tasks.filter(task => task.type === state.route);
  if (state.generationFilter !== 'all') tasks = tasks.filter(task => state.generationFilter === 'running' ? ['queued','running'].includes(task.status) : task.status === state.generationFilter);
  const empty = emptyState(`还没有商品${state.route === 'image' ? '图' : '视频'}`, state.route === 'image' ? '从商品主图、场景图或细节特写开始制作。' : '上传商品素材，制作第一条营销视频。');
  reconcileCards($('#generationGrid'), tasks, { card:taskCard, signature:taskRenderSignature, bind:bindTaskCard, empty });
}
$$('.filter').forEach(button => button.onclick = () => { state.generationFilter = button.dataset.status; $$('.filter').forEach(x => x.classList.toggle('active', x === button)); renderTasks(); });
$$('.view-toggle').forEach(button => button.onclick = () => { state.generationView = button.dataset.view; syncGenerationView(); });

function detailRow(label, value, id='') { return `<div><dt>${esc(label)}</dt><dd${id ? ` id="${id}"` : ''}>${esc(value)}</dd></div>`; }
function addTaskReference(task, target=task.type) { if (!task) return false; const ids = task.type === 'image' && task.assetId ? [task.assetId] : Array.isArray(task.referenceAssetIds) ? task.referenceAssetIds : []; const references = ids.filter(id => state.files.some(file => file.id === id && file.kind === 'image')); if (!references.length) return false; state.refs[target] = [...new Set([...references, ...state.refs[target]])].slice(0, 7); renderReferences(); return true; }
function continueFromTask(task, target=task.type, includeReference=false) {
  if (!task) return;
  if ($('#generationDetailDialog').open) closeGenerationDetail();
  navigate(target);
  const prompt = $(`#${target}Prompt`); prompt.value = task.prompt || ''; prompt.dispatchEvent(new Event('input', { bubbles:true }));
  if (target === 'image' && task.size) { $('#imageSize').value = task.size; $$('.ratio-grid [data-value]').forEach(button => button.classList.toggle('selected', button.dataset.value === task.size)); const extra = $(`.ratio-extra[data-value="${CSS.escape(task.size)}"]`); if (extra) { extra.classList.remove('hidden'); $('#moreRatios').setAttribute('aria-expanded', 'true'); } if (task.quality) { $('#imageQuality').value = task.quality; $$('.segmented[data-select="imageQuality"] button').forEach(button => button.classList.toggle('selected', button.dataset.value === task.quality)); } }
  if (target === 'video' && task.type === 'video') { $('#videoAspect').value = task.aspectRatio || '16:9'; $('#videoDuration').value = String(task.duration || 10); refreshProductSelect('videoAspect'); refreshProductSelect('videoDuration'); if (task.quality) { $('#videoResolution').value = task.quality; refreshProductSelect('videoResolution'); } updateVideoCost(); }
  if (includeReference) addTaskReference(task, target);
  $('#creatorPanel').scrollTo({ top:0, behavior:'smooth' }); prompt.focus();
  toast(includeReference ? '已带入参考图和创作描述' : '已带入创作描述，可调整后重新生成');
}
function handleTaskAction(action, id) { const task = state.tasks.find(item => item.id === id); if (!task) return; if (action === 'preview' || action === 'more') return openGenerationDetail(id); if (action === 'reference') { continueFromTask(task, task.type, true); return; } if (action === 'continue') continueFromTask(task); }
function fitDetailMedia(media, width, height) { if (!media || !width || !height) return; const portrait=height>width; media.classList.toggle('portrait-media', portrait); media.classList.toggle('landscape-media', !portrait); }
function resetDetailFit(dialog) { dialog.classList.remove('portrait-detail'); dialog.style.removeProperty('--portrait-dialog-width'); }
function closeGenerationDetail() { const dialog = $('#generationDetailDialog'); dialog.close(); resetDetailFit(dialog); $('#generationDetailMedia').innerHTML = ''; state.detailTaskId = null; }
function openGenerationDetail(id) {
  const task = state.tasks.find(item => item.id === id); if (!task) return;
  const asset = state.files.find(file => file.id === task.assetId); state.detailTaskId = id;
  const media = asset
    ? (task.type === 'image' ? `<img src="${asset.url}" alt="${esc(asset.name)}">` : `<video src="${asset.url}" controls autoplay></video>`)
    : task.assetId
      ? `<div class="detail-missing-file"><b>成品文件未找到</b><span>任务已完成，但文件库中没有对应文件</span></div>`
      : `<div class="detail-placeholder ${task.status}" aria-hidden="true"><div class="loader-ring"></div></div>`;
  $('#generationDetailMedia').innerHTML = media;
  $('#generationDetailTitle').textContent = '文件详情';
  const status = $('#generationDetailStatus'); status.className = `detail-status ${task.status}`; status.textContent = statusText(task.status);
  $('#generationDetailPrompt').textContent = task.prompt;
  const promptElement = $('#generationDetailPrompt'); const promptToggle = $('#generationDetailPromptToggle'); promptElement.classList.remove('expanded'); promptToggle.classList.add('hidden'); promptToggle.setAttribute('aria-expanded', 'false'); promptToggle.textContent = '展开全部'; requestAnimationFrame(() => { const overflowing = promptElement.scrollHeight > promptElement.clientHeight + 1; promptToggle.classList.toggle('hidden', !overflowing); });
  const creditText = task.creditStatus === 'refunded' ? `${task.creditCost} 积分 · 已退回` : task.creditStatus === 'refund_failed' ? `${task.creditCost} 积分 · 退款异常` : `${task.creditCost} 积分`;
  const visualSpec = task.type === 'image' ? task.size : `${task.aspectRatio} · ${task.duration} 秒 · 720p`;
  const fileText = asset ? `${formatBytes(asset.size)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height} px` : ''}` : '暂无成品文件';
  $('#generationCoreMeta').innerHTML = detailRow('尺寸与画幅', visualSpec) + detailRow('生成时间', fullDateText(task.createdAt));
  $('#generationDetailMeta').innerHTML = detailRow('内容类型', task.type === 'image' ? '图片' : '视频') + detailRow('文件信息', fileText, 'generationDetailFile') + detailRow('积分记录', creditText) + detailRow('任务编号', task.id);
  const error = $('#generationDetailError'); const failure = taskFailure(task); error.textContent = taskErrorText(task); error.classList.toggle('hidden', !failure);
  const download = $('#downloadGeneration'); download.classList.toggle('hidden', !asset); if (asset) download.href = `/api/files/${asset.id}/download`;
  $('#useGenerationReference').classList.toggle('hidden', !asset || task.type !== 'image');
  const deriveButton = $('#deriveGeneration'); const deriveSame = task.type !== 'image'; deriveButton.classList.toggle('hidden', !asset); deriveButton.classList.toggle('gradient-button', deriveSame); deriveButton.classList.toggle('secondary-button', !deriveSame); deriveButton.innerHTML = deriveSame ? '<svg viewBox="0 0 24 24"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></svg>生成同款' : '生成视频'; deriveButton.parentElement.classList.toggle('single-action', deriveSame);
  const deleteButton = $('#deleteGeneration'); const active = ['queued','running'].includes(task.status); deleteButton.disabled = active; deleteButton.title = active ? '任务生成中，完成后才能删除' : '';

  $('#generationDetailDialog').showModal();
  if (asset) {
    if (task.type === 'image') {
      const image = $('#generationDetailMedia img');
      const syncImage = () => { asset.width = image.naturalWidth; asset.height = image.naturalHeight; fitDetailMedia(image, asset.width, asset.height); $('#generationDetailFile').textContent = `${formatBytes(asset.size)} · ${asset.width} × ${asset.height} px`; };
      if (image.complete) syncImage(); else image.onload = syncImage;
    } else {
      const video = $('#generationDetailMedia video');
      const syncVideo = () => { asset.width = video.videoWidth; asset.height = video.videoHeight; fitDetailMedia(video, asset.width, asset.height); $('#generationDetailFile').textContent = `${formatBytes(asset.size)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height} px` : ''}`; };
      if (video.readyState >= 1) syncVideo(); else video.onloadedmetadata = syncVideo;
    }
  }
}
function copyTextFallback(text) { const textarea = document.createElement('textarea'); textarea.value = text; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.append(textarea); textarea.select(); const copied = document.execCommand('copy'); textarea.remove(); return copied; }
async function copyGenerationPrompt() { const task = state.tasks.find(item => item.id === state.detailTaskId); const prompt = task?.prompt || ''; if (!prompt) return toast('暂无可复制的创作描述'); try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt); else if (!copyTextFallback(prompt)) throw new Error('copy failed'); toast('创作描述已复制'); } catch { toast('复制失败，请手动选择文字复制'); const text = $('#generationDetailPrompt'); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); } }
$('#closeGenerationDetail').onclick = closeGenerationDetail;
$('#generationDetailDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeGenerationDetail(); });
$('#generationDetailDialog').addEventListener('close', () => { $('#generationDetailMedia').innerHTML = ''; $('#generationDetailPrompt').classList.remove('expanded'); $('#generationDetailPromptToggle').classList.add('hidden'); state.detailTaskId = null; });
$('#generationDetailPromptToggle').onclick = () => { const prompt = $('#generationDetailPrompt'); const toggle = $('#generationDetailPromptToggle'); const expanded = prompt.classList.toggle('expanded'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起描述' : '展开全部'; };
$('#copyGenerationPrompt').onclick = copyGenerationPrompt;
$('#useGenerationReference').onclick = () => continueFromTask(state.tasks.find(item => item.id === state.detailTaskId), 'image', true);
$('#deriveGeneration').onclick = () => { const task = state.tasks.find(item => item.id === state.detailTaskId); continueFromTask(task, 'video', true); };
$('#deleteGeneration').onclick = async () => { if ($('#deleteGeneration').disabled) return; const task = state.tasks.find(item => item.id === state.detailTaskId); if (!task || !await confirmDelete({ title:'确认删除作品', message:'作品一旦删除，无法恢复。' })) return; const id = task.id; const button = $('#deleteGeneration'); button.disabled = true; try { await api(`/api/generations/${id}`, { method:'DELETE', body:'{}' }); if (task.assetId) { state.refs.image = state.refs.image.filter(assetId => assetId !== task.assetId); state.refs.video = state.refs.video.filter(assetId => assetId !== task.assetId); } closeGenerationDetail(); await Promise.all([loadTasks(), loadFiles()]); toast('作品及关联文件已删除'); } catch (error) { toast(error.message); } finally { button.disabled = false; } };

async function loadFiles({ background=false }={}) {
  if (filesRequest) { const pending = filesRequest; return background ? pending : pending.then(() => loadFiles({ background:true })); }
  filesRequest = (async () => {
    try {
      const files = await api('/api/files');
      const changed = listSignature(state.files, fileSignatureFields) !== listSignature(files, fileSignatureFields);
      if (!changed) return state.files;
      state.files = mergeTransientFields(state.files, files, ['width','height']);
      renderFiles();
      renderReferences();
      if (['image','video'].includes(state.route)) renderTasks();
      else if (state.route === 'drama') dramaController.refreshTasks();
      return state.files;
    } catch (error) {
      if (error.status === 401) return location.reload();
      if (!background) toast(error.message);
      return state.files;
    }
  })();
  try { return await filesRequest; }
  finally { filesRequest = null; }
}
function assetDisplayName(file) {
  const stem = String(file.name || '').replace(/\.[^.]+$/, '').trim();
  const technical = /^(?:生成图片|生成视频)(?:\s|$)|^codex-clipboard-|^[a-f\d-]{20,}$|^\d+(?:\s*\(\d+\))?$|^(?=[A-Za-z0-9_-]{12,}$)(?=.*\d)[A-Za-z0-9_-]+$/i.test(stem);
  if (!technical && stem) return stem;
  const task = state.tasks.find(item => item.id === file.sourceGenerationId || item.assetId === file.id);
  if (task?.prompt) { const subject = task.prompt.trim().split(/[，。；,;\n]/)[0].replace(/^(请|帮我|生成|制作|创建|一张|一幅|一个|一段)/, '').trim().slice(0, 18); if (subject) return `${subject}｜${file.kind === 'image' ? '商品图' : '商品视频'}`; }
  const date = new Date(file.createdAt); const day = Number.isNaN(date.getTime()) ? '' : `｜${String(date.getMonth()+1).padStart(2,'0')}月${String(date.getDate()).padStart(2,'0')}日`;
  return `导入${file.kind === 'image' ? '图片' : '视频'}${day}`;
}
function fileCard(file) { const displayName = assetDisplayName(file); const media = file.kind === 'image' ? `<img src="${file.url}" alt="${esc(displayName)}" loading="lazy">` : `<video src="${file.url}" preload="metadata"></video><span class="play-mark"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></span>`; return `<article class="file-card" data-record-id="${file.id}"><button class="file-preview preview-file" data-id="${file.id}" aria-label="预览 ${esc(displayName)}">${media}<span class="asset-preview-label">预览</span></button><button class="more-button file-card-more" aria-label="文件操作" data-id="${file.id}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><div class="file-menu hidden" data-menu="${file.id}"><button class="rename-file" data-id="${file.id}">重命名</button><a href="/api/files/${file.id}/download">下载</a><button class="delete-file danger" data-id="${file.id}">删除</button></div></article>`; }
function fileRenderSignature(file) { return `${recordSignature(file, fileCardSignatureFields)}|name:${assetDisplayName(file)}`; }
function renderFiles() {
  if (state.route !== 'files') return;
  const query = $('#fileSearch').value.trim().toLowerCase();
  const files = state.files.filter(file => (state.fileKind === 'all' || file.kind === state.fileKind) && (!query || `${file.name} ${assetDisplayName(file)}`.toLowerCase().includes(query)));
  $('#fileCount').textContent = `${files.length} 个文件`;
  const empty = emptyState(state.files.length ? '没有匹配的文件' : '文件库还是空的', state.files.length ? '换个关键词或文件类型试试。' : '上传素材，或完成一次生成后，文件会自动保存在这里。', state.files.length ? '' : '<button class="upload-button empty-upload">上传第一个文件</button>');
  reconcileCards($('#fileGrid'), files, { card:fileCard, signature:fileRenderSignature, bind:bindFileActions, empty });
  $('#fileGrid .empty-upload')?.addEventListener('click', () => openUploadPicker('library'), { once:true });
}
$('#fileSearch').oninput = renderFiles; $$('.type-tabs button').forEach(button => button.onclick = () => { state.fileKind = button.dataset.kind; $$('.type-tabs button').forEach(x => x.classList.toggle('active', x === button)); renderFiles(); });
function clearFileReferences(fileId) {
  state.refs.image = state.refs.image.filter(id => id !== fileId);
  state.refs.video = state.refs.video.filter(id => id !== fileId);
}
async function removeFile(file) {
  await api(`/api/files/${file.id}`, { method:'DELETE', body:'{}' });
  clearFileReferences(file.id);
  await loadFiles();
}
function bindFileActions(root) {
  root.querySelector('.preview-file')?.addEventListener('click', event => openPreview(event.currentTarget.dataset.id));
  root.querySelector('.more-button')?.addEventListener('click', event => { event.stopPropagation(); const button = event.currentTarget; $$('[data-menu]').forEach(menu => menu.classList.toggle('hidden', menu.dataset.menu !== button.dataset.id || !menu.classList.contains('hidden'))); });
  root.querySelector('.rename-file')?.addEventListener('click', event => { const file = state.files.find(x => x.id === event.currentTarget.dataset.id); openRenameFileDialog(file); });
  root.querySelector('.delete-file')?.addEventListener('click', async event => { const file = state.files.find(x => x.id === event.currentTarget.dataset.id); if (!file || !await confirmDelete({ title:'确认删除素材', message:'素材一旦删除，无法恢复。' })) return; try { await removeFile(file); toast('文件已删除'); } catch (error) { toast(error.message); } });
}
document.addEventListener('click', () => $$('[data-menu]').forEach(menu => menu.classList.add('hidden')));

function openUploadPicker(context) { state.uploadContext = context; $('#fileInput').accept = context === 'reference' ? imageAccept : libraryAccept; $('#fileInput').click(); }
async function readImageSize(file) { if (!file.type.startsWith('image/')) return {}; try { const bitmap = await createImageBitmap(file); const result = { width:bitmap.width, height:bitmap.height }; bitmap.close(); return result; } catch { return new Promise(resolve => { const image = new Image(); const url = URL.createObjectURL(file); image.onload = () => { URL.revokeObjectURL(url); resolve({ width:image.naturalWidth, height:image.naturalHeight }); }; image.onerror = () => { URL.revokeObjectURL(url); resolve({}); }; image.src = url; }); } }
function createUploadRow(file) { const grid = $('#referenceGrid'); grid.querySelector('.empty-state')?.remove(); const row = document.createElement('div'); row.className = 'reference-upload-placeholder'; row.setAttribute('aria-live', 'polite'); row.innerHTML = `<div class="reference-upload-visual"><i class="reference-upload-spinner" aria-hidden="true"></i><strong>0%</strong></div><span title="${esc(file.name)}">${esc(file.name)}</span>`; grid.prepend(row); row.setAttribute('aria-label', `${file.name}，准备上传`); return { row, fileName:file.name, status:row, percent:row.querySelector('strong') }; }
function updateUploadRow(view, percent, status, mode='') { const value = Math.max(0, Math.min(100, Math.round(percent))); view.percent.textContent = mode === 'error' ? '失败' : `${value}%`; view.row.setAttribute('aria-label', `${view.fileName}，${status}`); view.row.dataset.uploadStatus = status; view.row.classList.toggle('failed', mode === 'error'); view.row.classList.toggle('completed', mode === 'completed'); }
function uploadFile(file, dimensions, onProgress) { return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/files/upload'); xhr.responseType = 'json'; xhr.setRequestHeader('Content-Type', file.type); xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); if (dimensions.width && dimensions.height) { xhr.setRequestHeader('X-Image-Width', dimensions.width); xhr.setRequestHeader('X-Image-Height', dimensions.height); } xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(92, event.loaded / event.total * 92), '正在上传到文件库'); }; xhr.upload.onload = () => onProgress(94, '正在保存文件'); xhr.onload = () => { const data = xhr.response || {}; if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `上传失败（${xhr.status}）`)); }; xhr.onerror = () => reject(new Error('上传网络连接失败')); xhr.send(file); }); }
function pickAndUploadDramaImage() { return new Promise((resolve, reject) => { const input=document.createElement('input');input.type='file';input.accept=imageAccept;input.onchange=async()=>{const file=input.files?.[0];if(!file)return resolve(null);try{if(file.size>8*1024*1024)throw new Error(`${file.name} 超过 8 MB`);const dimensions=await readImageSize(file);const asset=await uploadFile(file,dimensions,(progress)=>toast(`${file.name} · ${Math.round(progress)}%`));state.files=[asset,...state.files.filter(item=>item.id!==asset.id)];toast(`${file.name} 已上传到文件库`);resolve(asset);}catch(error){reject(error);}};input.click();});}
$('#uploadButton').onclick = () => openUploadPicker('library');
$('#fileInput').onchange = async event => { const files = [...event.target.files]; const context = state.uploadContext; event.target.value = ''; if (!files.length) return; let done = 0; let selected = 0; const referenceLimit = context === 'reference' && state.referenceTarget === 'video-frame' ? 1 : context === 'reference' && state.referenceTarget === 'video' ? videoReferenceLimit() : 7; for (const file of files) { const inDialog = context === 'reference'; const view = inDialog ? createUploadRow(file) : null; try { const limit = file.type.startsWith('image/') ? 8*1024*1024 : 25*1024*1024; if (file.size > limit) throw new Error(`${file.name} 超过 ${file.type.startsWith('image/') ? '8' : '25'} MB`); if (inDialog && !file.type.startsWith('image/')) throw new Error('参考素材只支持图片'); const dimensions = await readImageSize(file); const asset = await uploadFile(file, dimensions, (progress, label) => view ? updateUploadRow(view, progress, label) : toast(`${file.name} · ${Math.round(progress)}%`)); state.files = [asset, ...state.files.filter(item => item.id !== asset.id)]; let autoSelected = false; if (inDialog && state.dialogSelection.length < referenceLimit) { state.dialogSelection.push(asset.id); autoSelected = true; selected++; } done++; if (view) { updateUploadRow(view, 100, autoSelected ? '上传完成，已自动选中' : '上传完成，选择数量已满', 'completed'); renderReferenceDialog(); } else renderFiles(); } catch (error) { if (view) updateUploadRow(view, 0, error.message, 'error'); toast(error.message); } } renderReferences(); if (!context || context === 'library') await loadFiles(); if (done) toast(`${done} 个文件上传完成${selected ? `，${selected} 个已自动选中` : ''}`); };

function videoGenerationParameters(modelId=$('#videoModel')?.value) {
  const modes = videoModelModes(modelId);
  const mode = resolveVideoGenerationType(modelId, modes);
  return { mode, parameters: videoModelParameters(modelId, mode) };
}
function videoHasImages() {
  return state.refs.video.length > 0 || Boolean(state.videoFrames.first || state.videoFrames.last);
}
function resolveVideoGenerationType(modelId=$('#videoModel')?.value, modes=videoModelModes(modelId)) {
  const supportsText = modes.some(item => item.generationType === 'TEXT');
  const supportsReference = modes.some(item => item.generationType === 'REFERENCE');
  const supportsFirstLast = modes.some(item => item.generationType === 'FIRST&LAST');
  // 普通视频页不再让用户直接选择模式：无图默认文生视频；有图默认参考图。
  // 只有同时支持参考图和首尾帧的模型，才保留用户通过切换按钮选择的首尾帧状态。
  if (supportsReference && supportsFirstLast && state.videoGenerationType === 'FIRST&LAST') return 'FIRST&LAST';
  if (!videoHasImages()) return supportsText ? 'TEXT' : supportsReference ? 'REFERENCE' : modes[0]?.generationType || 'TEXT';
  if (supportsReference) return 'REFERENCE';
  return supportsFirstLast ? 'FIRST&LAST' : supportsText ? 'TEXT' : modes[0]?.generationType || 'TEXT';
}
function videoReferenceLimit() {
  const model = videoModelOptions().find(item => item.id === $('#videoModel')?.value);
  return model?.modes?.find(item => item.generationType === 'REFERENCE')?.maxImages || 7;
}
function renderVideoGenerationMode() {
  const toggle = $('#videoModeToggle');
  const label = $('#videoReferenceLabel');
  if (!toggle || !label) return;
  const dualModeModel = supportsVideoMode('REFERENCE') && supportsVideoFirstLast();
  const { mode } = videoGenerationParameters();
  toggle.classList.toggle('hidden', !dualModeModel);
  label.classList.toggle('hidden', dualModeModel);
  if (!dualModeModel) {
    label.textContent = mode === 'FIRST&LAST' ? '首尾帧' : '参考图片';
    toggle.onclick = null;
    return;
  }
  const firstLast = mode === 'FIRST&LAST';
  const current = firstLast ? '首尾帧' : '参考图片';
  const alternate = firstLast ? '参考图片' : '首尾帧';
  toggle.innerHTML = `<b>${current}</b><span class="video-mode-switch" aria-hidden="true">⇄</span><span>${alternate}</span>`;
  toggle.setAttribute('aria-label', `当前为${current}，点击切换为${alternate}`);
  toggle.setAttribute('aria-pressed', String(firstLast));
  toggle.onclick = () => setVideoGenerationType(firstLast ? 'REFERENCE' : 'FIRST&LAST');
}
function renderVideoFrameSlots() {
  const container = $('#videoReferences');
  if (!container) return;
  const frame = (key, label, hint) => {
    const file = state.files.find(item => item.id === state.videoFrames[key]);
    return file
      ? `<figure class="video-frame-slot filled"><img src="${file.url}" alt="${esc(file.name)}"><figcaption>${label}</figcaption><button type="button" class="remove-ref" data-video-frame-remove="${key}" aria-label="移除${label}">×</button></figure>`
      : `<button type="button" class="video-frame-slot" data-video-frame="${key}"><span>＋</span><b>${label}</b><small>${hint}</small></button>`;
  };
  container.innerHTML = frame('first', '首帧', '上传首帧图片') + '<span class="video-frame-transition" aria-hidden="true">→</span>' + frame('last', '尾帧', '上传尾帧图片');
  container.classList.add('video-frame-strip');
  container.querySelectorAll('[data-video-frame]').forEach(button => button.onclick = () => openVideoFrameDialog(button.dataset.videoFrame));
  container.querySelectorAll('[data-video-frame-remove]').forEach(button => button.onclick = () => { state.videoFrames[button.dataset.videoFrameRemove] = ''; renderReferences(); });
}
function renderReferences() {
  const { mode } = videoGenerationParameters();
  state.refs.video = state.refs.video.slice(0, videoReferenceLimit());
  const imageSelected = state.refs.image.map(id => state.files.find(file => file.id === id)).filter(Boolean);
  $('#imageReferences').innerHTML = imageSelected.map(file => `<div class="reference-thumb"><img src="${file.url}" alt="${esc(file.name)}"><button type="button" class="remove-ref" data-target="image" data-id="${file.id}" aria-label="移除参考图">×</button></div>`).join('') + `<button class="add-reference pick-reference" data-target="image" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>添加</span></button>`;
  const videoReferenceHead = $('#videoReferenceLabel').closest('.reference-head');
  const videoReferences = $('#videoReferences');
  videoReferenceHead.classList.remove('hidden');
  videoReferences.classList.remove('hidden');
  if (mode === 'FIRST&LAST') {
    state.refs.video = [];
    renderVideoFrameSlots();
  } else {
    const selected = state.refs.video.map(id => state.files.find(file => file.id === id)).filter(Boolean);
    videoReferences.classList.remove('video-frame-strip');
    videoReferences.innerHTML = selected.map(file => `<div class="reference-thumb"><img src="${file.url}" alt="${esc(file.name)}"><button type="button" class="remove-ref" data-target="video" data-id="${file.id}" aria-label="移除参考图">×</button></div>`).join('') + `<button class="add-reference pick-reference" data-target="video" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>添加</span></button>`;
  }
  $$('.pick-reference').forEach(button => button.onclick = () => openReferenceDialog(button.dataset.target));
  $$('.remove-ref[data-target]').forEach(button => button.onclick = () => {
    state.refs[button.dataset.target] = state.refs[button.dataset.target].filter(id => id !== button.dataset.id);
    if (!videoHasImages()) state.videoGenerationType = 'TEXT';
    renderReferences();
  });
  renderVideoGenerationMode();
  syncVideoModelParameters();
}
function setVideoGenerationType(type) {
  if (!supportsVideoMode(type) || !['REFERENCE', 'FIRST&LAST'].includes(type)) return;
  const current = videoGenerationParameters().mode;
  if (current === 'REFERENCE' && type === 'FIRST&LAST') {
    const [first, last] = state.refs.video.slice(0, 2);
    state.videoFrames = { first: first || '', last: last || '' };
    state.refs.video = [];
  } else if (current === 'FIRST&LAST' && type === 'REFERENCE') {
    state.refs.video = [state.videoFrames.first, state.videoFrames.last].filter(Boolean).slice(0, videoReferenceLimit());
    state.videoFrames = { first:'', last:'' };
  }
  state.videoGenerationType = type;
  renderReferences();
}
function openReferenceDialog(target) {
  if (target === 'video' && !$('#videoModel').value) return toast('请先选择视频模型');
  if (target === 'video' && videoGenerationParameters().mode === 'FIRST&LAST') return toast('请分别选择首帧和尾帧图片');
  state.referenceTarget = target; state.videoFrameTarget = ''; state.dialogSelection = [...state.refs[target]]; renderReferenceDialog(); $('#referenceDialog').showModal();
}
function openVideoFrameDialog(frame) {
  if (!supportsVideoFirstLast()) return;
  state.referenceTarget = 'video-frame'; state.videoFrameTarget = frame; state.dialogSelection = state.videoFrames[frame] ? [state.videoFrames[frame]] : []; renderReferenceDialog(); $('#referenceDialog').showModal();
}
function renderReferenceDialog() {
  const isFrame = state.referenceTarget === 'video-frame';
  const limit = isFrame ? 1 : state.referenceTarget === 'video' ? videoReferenceLimit() : 7;
  $('#referenceDialog h2').textContent = isFrame ? `选择${state.videoFrameTarget === 'first' ? '首帧' : '尾帧'}图片` : '选择参考图片';
  $('#referenceDialog .dialog-help').textContent = isFrame ? '选择一张图片作为视频的当前帧，单张不超过 8 MB。' : `最多选择 ${limit} 张图片，单张不超过 8 MB。新上传图片会自动选中。`;
  $('#selectionCount').textContent = `已选择 ${state.dialogSelection.length} / ${limit}`;
  $('#confirmReference').textContent = isFrame ? '使用此图片' : '使用所选图片';
  const images = state.files.filter(file => file.kind === 'image');
  $('#referenceGrid').innerHTML = images.length ? images.map(file => `<button class="reference-option ${state.dialogSelection.includes(file.id) ? 'selected' : ''}" data-id="${file.id}"><img src="${file.url}" alt="${esc(file.name)}"><span>${esc(file.name)}</span><i>✓</i></button>`).join('') : emptyState('没有可用图片', '先上传一张图片到文件库。');
  $$('.reference-option').forEach(button => button.onclick = () => { const id = button.dataset.id; if (state.dialogSelection.includes(id)) state.dialogSelection = state.dialogSelection.filter(x => x !== id); else if (state.dialogSelection.length < limit) state.dialogSelection.push(id); else return toast(`最多选择 ${limit} 张参考图`); renderReferenceDialog(); });
}
$('#closeReference').onclick = $('#cancelReference').onclick = () => $('#referenceDialog').close();
$('#confirmReference').onclick = () => {
  if (state.referenceTarget === 'video-frame') state.videoFrames[state.videoFrameTarget] = state.dialogSelection[0] || '';
  else state.refs[state.referenceTarget] = [...state.dialogSelection];
  renderReferences(); $('#referenceDialog').close();
};
$('#dialogUpload').onclick = () => openUploadPicker('reference');

$$('.segmented').forEach(group => group.querySelectorAll('button').forEach(button => button.onclick = () => { group.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === button)); $(`#${group.dataset.select}`).value = button.dataset.value; }));
$$('.ratio-grid').forEach(group => group.querySelectorAll('button[data-value]').forEach(button => button.onclick = () => { group.querySelectorAll('button[data-value]').forEach(x => x.classList.toggle('selected', x === button)); $(`#${group.dataset.select}`).value = button.dataset.value; }));
$('#moreRatios').onclick = () => { const opening = $('#moreRatios').getAttribute('aria-expanded') !== 'true'; $('#moreRatios').setAttribute('aria-expanded', String(opening)); $$('.ratio-extra').forEach(button => button.classList.toggle('hidden', !opening && !button.classList.contains('selected'))); };
function ratioIcon(value) { const [width, height] = value.split(':').map(Number); const scale = Math.min(27 / width, 22 / height); return `<span class="select-ratio-icon" aria-hidden="true"><i style="width:${Math.round(width*scale)}px;height:${Math.round(height*scale)}px"></i></span>`; }
function resolutionIcon(value) {
  const lineCount = value === '1080p' ? 4 : value === '720p' ? 3 : 2;
  const detailLines = Array.from({ length: lineCount }, (_, index) => `<path d="M7 ${9 + index * 2.2}h10"/>`).join('');
  return `<span class="select-resolution-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="14" rx="2"/>${detailLines}<path d="M8 21h8"/></svg></span>`;
}
function clockIcon() { return '<span class="select-clock" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3.5 2"></path></svg></span>'; }
const fallbackVideoModels = Object.freeze([
  // Front-end fallback must mirror modelCatalog above: no FIRST&LAST for GuGu 1.5.
  { id:'grok', label:'GuGu 1.5', description:'全能视频模型，支持最长30秒视频，7张参考图', modes:[
    { generationType:'TEXT', aspectRatios:['2:3','3:2','1:1','9:16','16:9'], durations:[10,20,30], qualityOptions:['480p','720p'], pricing:{ currency:'credit', amount:1.5, unit:'second' }, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['2:3','3:2','1:1','9:16','16:9'], durations:[10,20,30], qualityOptions:['480p','720p'], pricing:{ currency:'credit', amount:1.5, unit:'second' }, minImages:1, maxImages:7 },
  ] },
  // Front-end fallback: GuGu 1.0 supports TEXT and REFERENCE only.
  { id:'grok-15', label:'GuGu 1.0', availability:'coming-soon', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16','1:1','4:3','3:4','2:3','3:2'], durations:[6,12], qualityOptions:['480p','720p'], pricing:{ currency:'credit', amount:1, unit:'second' }, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16','1:1','4:3','3:4','2:3','3:2'], durations:[6,12], qualityOptions:['480p','720p'], pricing:{ currency:'credit', amount:1, unit:'second' }, minImages:1, maxImages:1 },
  ] },
  // Front-end fallback: Omni Flash supports TEXT and REFERENCE only.
  { id:'oai', label:'Omni Flash', description:'Google 最新视频模型，高质量，英文支持效果好', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16'], durations:[10], qualityOptions:['720p'], minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16'], durations:[10], qualityOptions:['720p'], minImages:1, maxImages:5 },
  ] },
  // Front-end fallback: Veo 3.1 Fast is coming soon and cannot be selected.
  { id:'veo', label:'Veo 3.1 Fast', description:'支持首尾帧模式，固定8秒，速度快', availability:'coming-soon', modes:[
    { generationType:'TEXT', aspectRatios:['2:3','3:2','1:1','9:16','16:9'], durations:[8], qualityOptions:['720p'], minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['2:3','3:2','1:1','16:9'], durations:[8], qualityOptions:['720p'], minImages:1, maxImages:3 },
    { generationType:'FIRST&LAST', aspectRatios:['16:9','9:16'], durations:[8], qualityOptions:['720p'], minImages:1, maxImages:2 },
  ] },
  // Front-end fallback: Veo 3.1 supports TEXT, REFERENCE and FIRST&LAST.
  { id:'veo-31', label:'Veo 3.1', description:'支持首尾帧、支持1080P', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16'], durations:[8], qualityOptions:['720p','1080p'], minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9'], durations:[8], qualityOptions:['720p','1080p'], minImages:1, maxImages:3 },
    { generationType:'FIRST&LAST', aspectRatios:['16:9','9:16'], durations:[8], qualityOptions:['720p','1080p'], minImages:1, maxImages:2 },
  ] },
  // Front-end fallback: these models are not yet available and expose no modes.
  { id:'minimax-h3', label:'MiniMax H3', availability:'coming-soon', modes:[] },
  { id:'seedance-2.0', label:'Seedance 2.0', availability:'coming-soon', modes:[] },
]);
const hiddenVideoModelIds = new Set();
const modeLabels = Object.freeze({ TEXT:'文生视频', REFERENCE:'参考图模式', 'FIRST&LAST':'首尾帧' });
function videoModelModes(modelId=$('#videoModel')?.value) { return videoModelOptions().find(model => model.id === modelId)?.modes || []; }
function supportsVideoMode(type, modelId=$('#videoModel')?.value) { return videoModelModes(modelId).some(mode => mode.generationType === type); }
function supportsVideoFirstLast(modelId=$('#videoModel')?.value) { return supportsVideoMode('FIRST&LAST', modelId); }
function videoModelOptions() {
  const hasServerCatalog = Array.isArray(state.config?.videoCapabilities?.models);
  const models = hasServerCatalog ? state.config.videoCapabilities.models : fallbackVideoModels;
  return models
    .filter(model => !hiddenVideoModelIds.has(model.id) && (model.enabled !== false || model.availability === 'coming-soon'))
    .sort((a, b) => Number(a.availability === 'coming-soon') - Number(b.availability === 'coming-soon'));
}
function videoModelParameters(modelId, generationType) { return videoModelOptions().find(model => model.id === modelId)?.modes?.find(mode => mode.generationType === generationType) || null; }
const modelIconUrls = Object.freeze({ grok:'/favicon.svg?v=2', 'grok-15':'/favicon.svg?v=2', veo:'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg', oai:'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg', 'veo-31':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg', 'minimax-h3':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/minimax-color.svg', 'seedance-2.0':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg' });
function modelIcon(modelId) { const src = modelIconUrls[modelId]; return src ? `<img class="select-model-icon" src="${src}" alt="" aria-hidden="true">` : clockIcon(); }
function productSelectIcon(widget, option) { return widget.dataset.model ? modelIcon(option.value) : widget.dataset.ratio ? ratioIcon(option.value) : widget.dataset.resolution ? resolutionIcon(option.value) : clockIcon(); }
function productSelectMarkup(widget, select) { return [...select.options].map(option => { const comingSoon = widget.dataset.model && option.dataset.availability === 'coming-soon'; const model = widget.dataset.model ? videoModelOptions().find(item => item.id === option.value) : null; return `<button type="button" role="option" aria-selected="${option.selected}" data-value="${esc(option.value)}" ${option.disabled ? 'disabled' : ''}>${productSelectIcon(widget, option)}<span class="select-option-label"><b>${esc(option.textContent)}</b>${model?.description ? `<small class="select-model-description">${esc(model.description)}</small>` : ''}${comingSoon ? '<small>即将上线</small>' : ''}</span><i>✓</i></button>`; }).join(''); }
function selectSubtitle(widget, option = null) { if (!widget?.dataset.model) return ''; const selected = option || $(`#${widget.dataset.for}`)?.selectedOptions[0]; const model = selected ? videoModelOptions().find(item => item.id === selected.value) : null; return model?.description ? `<small class="select-model-description">${esc(model.description)}</small>` : ''; }
function refreshProductSelect(id) { const select = $(`#${id}`); const widget = $(`.product-select[data-for="${id}"]`); if (!select || !widget) return; const option = select.selectedOptions[0]; if (!option) return; widget.querySelector('.product-select-trigger').innerHTML = `${productSelectIcon(widget, option)}<span><b>${esc(option.textContent)}</b>${selectSubtitle(widget, option)}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>`; widget.querySelectorAll('[role="option"]').forEach(item => item.setAttribute('aria-selected', String(item.dataset.value === select.value))); if (widget.dataset.dynamicOptions === 'true') widget.querySelector('.product-select-menu').innerHTML = productSelectMarkup(widget, select); }
function setProductSelectEnabled(id, enabled) { const select = $(`#${id}`); const widget = $(`.product-select[data-for="${id}"]`); if (!select || !widget) return; select.disabled = !enabled; const trigger = widget.querySelector('.product-select-trigger'); trigger.disabled = !enabled; widget.classList.toggle('is-disabled', !enabled); if (!enabled) closeProductSelects(); }
function setVideoSelectOptions(id, values, label, preferred) { const select = $(`#${id}`); const widget = $(`.product-select[data-for="${id}"]`); if (!select || !widget) return; const current = select.value; select.innerHTML = values.map(value => `<option value="${esc(value)}">${esc(label(value))}</option>`).join(''); const desired = values.map(String).includes(String(current)) ? current : values.map(String).includes(String(preferred)) ? String(preferred) : String(values[0] || ''); select.value = desired; widget.dataset.dynamicOptions = 'true'; refreshProductSelect(id); }
function syncVideoModelOptions() { const select = $('#videoModel'); const widget = $('.product-select[data-for="videoModel"]'); if (!select || !widget) return; const current = select.value; const models = videoModelOptions(); select.innerHTML = models.map(model => `<option value="${esc(model.id)}" ${model.availability === 'coming-soon' ? 'disabled data-availability="coming-soon"' : ''}>${esc(model.label)}</option>`).join(''); const selectableModels = models.filter(model => model.availability !== 'coming-soon'); select.value = selectableModels.some(model => model.id === current) ? current : String(selectableModels[0]?.id || ''); widget.dataset.dynamicOptions = 'true'; refreshProductSelect('videoModel'); syncVideoModelParameters(); }
function syncVideoModelParameters() {
  const modelId = $('#videoModel')?.value || '';
  const modes = videoModelModes(modelId);
  const { mode:generationType, parameters } = videoGenerationParameters(modelId);
  renderVideoGenerationMode();
  if (!parameters) { setProductSelectEnabled('videoAspect', false); setProductSelectEnabled('videoDuration', false); setProductSelectEnabled('videoResolution', false); syncVideoPromptState(); updateVideoCost(); return; }
  const durations = parameters.durations;
  const qualities = parameters.qualityOptions;
  setVideoSelectOptions('videoAspect', parameters.aspectRatios, value => value, '16:9');
  setVideoSelectOptions('videoDuration', durations, value => `${value} 秒`, modelId === 'grok-15' ? 6 : modelId === 'veo' || modelId === 'veo-31' ? 8 : 20);
  setVideoSelectOptions('videoResolution', qualities, value => value, '720p');
  setProductSelectEnabled('videoAspect', true); setProductSelectEnabled('videoDuration', true); setProductSelectEnabled('videoResolution', true);
  syncVideoPromptState(); updateVideoCost();
}
function closeProductSelects(except=null) { $$('.product-select').forEach(widget => { if (widget === except) return; widget.querySelector('.product-select-menu').classList.add('hidden'); widget.querySelector('.product-select-trigger').setAttribute('aria-expanded', 'false'); }); }
$$('.product-select').forEach(widget => { const select = $(`#${widget.dataset.for}`); const trigger = widget.querySelector('.product-select-trigger'); const menu = widget.querySelector('.product-select-menu'); const renderTrigger = () => { const option = select.selectedOptions[0]; trigger.innerHTML = `${productSelectIcon(widget, option)}<span><b>${esc(option.textContent)}</b>${selectSubtitle(widget, option)}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5-5 5"/></svg>`; }; menu.innerHTML = productSelectMarkup(widget, select); const choose = value => { select.value = value; menu.querySelectorAll('[role="option"]').forEach(item => item.setAttribute('aria-selected', item.dataset.value === value)); renderTrigger(); closeProductSelects(); select.dispatchEvent(new Event('change', { bubbles:true })); }; menu.querySelectorAll('[role="option"]').forEach(item => item.onclick = () => choose(item.dataset.value)); trigger.onclick = event => { event.stopPropagation(); const opening = menu.classList.contains('hidden'); closeProductSelects(opening ? widget : null); menu.classList.toggle('hidden', !opening); trigger.setAttribute('aria-expanded', String(opening)); if (opening) menu.querySelector(`[data-value="${CSS.escape(select.value)}"]`)?.focus(); }; trigger.onkeydown = event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); const options = [...menu.querySelectorAll('button')]; (event.key === 'ArrowDown' ? options[0] : options.at(-1))?.focus(); } }; menu.onkeydown = event => { const options = [...menu.querySelectorAll('button')]; const index = options.indexOf(document.activeElement); if (event.key === 'Escape') { closeProductSelects(); trigger.focus(); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); } }; renderTrigger(); });
document.addEventListener('click', event => { if (!event.target.closest('.product-select')) closeProductSelects(); });
document.addEventListener('click', event => { const option = event.target.closest('.product-select[data-dynamic-options="true"] .product-select-menu [role="option"]'); if (!option || option.disabled) return; const widget = option.closest('.product-select'); const select = $(`#${widget.dataset.for}`); if (!select) return; select.value = option.dataset.value; refreshProductSelect(widget.dataset.for); closeProductSelects(); select.dispatchEvent(new Event('change', { bubbles:true })); });
$$('.prompt-presets button').forEach(button => button.onclick = () => { const form = button.closest('form'); const textarea = form.querySelector('textarea'); textarea.value = button.dataset.preset; textarea.dispatchEvent(new Event('input', { bubbles:true })); textarea.focus(); });
const imagePromptMaxLength = 5000;
const videoPromptMaxLength = 4096;
const promptMaxHeight = 200;
function autoResizePrompt(prompt) { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, promptMaxHeight)}px`; }
function syncImagePromptState() { const prompt = $('#imagePrompt'); autoResizePrompt(prompt); const count = Array.from(prompt.value).length; const countElement = $('#imagePromptCount'); const overLimit = count > imagePromptMaxLength; countElement.textContent = count; countElement.classList.toggle('over-limit', overLimit); prompt.setCustomValidity(overLimit ? `图片提示词不能超过 ${imagePromptMaxLength} 个字符` : ''); $('#imageForm .generate').disabled = overLimit; }
function syncVideoPromptState() { const prompt = $('#videoPrompt'); autoResizePrompt(prompt); const count = Array.from(prompt.value).length; const countElement = $('#videoPromptCount'); const overLimit = count > videoPromptMaxLength; const { mode } = videoGenerationParameters(); const missingImages = mode === 'REFERENCE' ? state.refs.video.length === 0 : mode === 'FIRST&LAST' ? !state.videoFrames.first : false; countElement.textContent = count; countElement.classList.toggle('over-limit', overLimit); prompt.setCustomValidity(overLimit ? `视频提示词不能超过 ${videoPromptMaxLength} 个字符` : ''); $('#videoForm .generate').disabled = overLimit || !$('#videoModel').value || missingImages; }
$('#imagePrompt').oninput = syncImagePromptState; $('#videoPrompt').oninput = syncVideoPromptState;
async function submitGeneration(type, form, payload) { const button = form.querySelector('.generate'); const original = button.innerHTML; button.disabled = true; button.innerHTML = '<span class="button-spinner"></span><span>正在提交</span>'; try { const result = await api('/api/generations', { method:'POST', body:JSON.stringify({ type, referenceAssetIds:state.refs[type], ...payload }) }); setCreditBalance(result.balance); form.querySelector('textarea').value = ''; form.querySelector('textarea').dispatchEvent(new Event('input', { bubbles:true })); state.refs[type] = []; if (type === 'video') state.videoFrames = { first:'', last:'' }; renderReferences(); toast(`任务已提交，扣除 ${result.creditCost} 积分`); await loadTasks(); } catch (error) { toast(error.message); await loadCredits(); } finally { button.innerHTML = original; if (type === 'image') syncImagePromptState(); else { syncVideoPromptState(); updateVideoCost(); } } }
$('#imageForm').onsubmit = event => { event.preventDefault(); syncImagePromptState(); if (Array.from($('#imagePrompt').value).length > imagePromptMaxLength) return; submitGeneration('image', event.currentTarget, { prompt:$('#imagePrompt').value, size:$('#imageSize').value, quality:$('#imageQuality').value }); };
$('#videoForm').onsubmit = event => { event.preventDefault(); syncVideoPromptState(); if (!$('#videoModel').value) return toast('请先选择视频模型'); if (Array.from($('#videoPrompt').value).length > videoPromptMaxLength) return; const { mode } = videoGenerationParameters(); const referenceAssetIds = mode === 'FIRST&LAST' ? [state.videoFrames.first, state.videoFrames.last].filter(Boolean) : state.refs.video; submitGeneration('video', event.currentTarget, { prompt:$('#videoPrompt').value, modelId:$('#videoModel').value, aspectRatio:$('#videoAspect').value, duration:Number($('#videoDuration').value), quality:$('#videoResolution').value, generationType:mode, referenceAssetIds }); };
function updateVideoCost() { const cost = $('#videoCost'); const duration = $('#videoDuration'); if (!cost || !duration) return; const parameters = videoModelParameters($('#videoModel')?.value, videoGenerationParameters().mode); const fixedPrice = parameters?.pricing?.unit === 'request' ? Number(parameters.pricing.amount) / Number(state.pricing.yuanPerCredit || 0.1) : null; const perSecondPrice = parameters?.pricing?.unit === 'second' ? Number(parameters.pricing.amount) : null; cost.textContent = creditText(fixedPrice ?? Number(duration.value || 0) * (perSecondPrice ?? state.pricing.videoPerSecond)); }
$('#videoModel').onchange = () => {
  const hadFirstLast = state.videoGenerationType === 'FIRST&LAST';
  const supportsReference = supportsVideoMode('REFERENCE');
  const supportsFirstLast = supportsVideoFirstLast();
  if (hadFirstLast && !supportsFirstLast) {
    state.refs.video = [state.videoFrames.first, state.videoFrames.last, ...state.refs.video].filter(Boolean);
    state.videoFrames = { first:'', last:'' };
  }
  if (supportsReference) state.refs.video = state.refs.video.slice(0, videoReferenceLimit());
  else if (!supportsFirstLast) state.refs.video = [];
  state.videoGenerationType = hadFirstLast && supportsFirstLast ? 'FIRST&LAST' : 'TEXT';
  renderReferences();
};
$('#videoDuration').onchange = () => { syncVideoModelParameters(); updateVideoCost(); };

function renderPreviewMeta(file, width=file.width, height=file.height) { $('#previewDetailMeta').innerHTML = detailRow('素材类型', file.kind === 'image' ? '图片' : '视频') + detailRow('画面尺寸', width && height ? `${width} × ${height} px` : '读取中', 'previewDimensions') + detailRow('文件大小', formatBytes(file.size)) + detailRow('添加时间', fullDateText(file.createdAt)) + detailRow('原始文件名', file.name); }
function openPreview(id) { const file = state.files.find(item => item.id === id); if (!file) return; const displayName = assetDisplayName(file); state.previewFileId = id; $('#deletePreview').disabled = false; $('#deletePreview').textContent = '删除素材'; $('#previewMedia').innerHTML = file.kind === 'image' ? `<img src="${file.url}" alt="${esc(displayName)}">` : `<video src="${file.url}" controls autoplay></video>`; $('#previewName').textContent = displayName; $('#previewUseActions').classList.toggle('hidden', file.kind !== 'image'); renderPreviewMeta(file); if (file.kind === 'image') { const image = $('#previewMedia img'); const syncImage = () => { file.width = image.naturalWidth; file.height = image.naturalHeight; fitDetailMedia(image, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; if (image.complete) syncImage(); else image.onload = syncImage; } else { const video = $('#previewMedia video'); video.onloadedmetadata = () => { file.width = video.videoWidth; file.height = video.videoHeight; fitDetailMedia(video, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; } $('#previewDownload').href = `/api/files/${file.id}/download`; $('#previewDialog').showModal(); }
function usePreviewAsset(target) { const file = state.files.find(item => item.id === state.previewFileId); if (!file || file.kind !== 'image') return; if (target === 'video' && !$('#videoModel').value) return toast('请先选择视频模型'); if (target === 'video' && supportsVideoFirstLast() && state.videoGenerationType === 'FIRST&LAST') { const frame = state.videoFrames.first ? 'last' : 'first'; state.videoFrames[frame] = file.id; } else { const limit = target === 'video' ? videoReferenceLimit() : 7; if (!state.refs[target].includes(file.id)) state.refs[target] = [file.id, ...state.refs[target]].slice(0, limit); } $('#previewDialog').close(); navigate(target); renderReferences(); toast(`已将“${assetDisplayName(file)}”设为${target === 'video' && supportsVideoFirstLast() && state.videoGenerationType === 'FIRST&LAST' ? '视频帧图片' : '参考图'}`); }
$('#usePreviewForImage').onclick = () => usePreviewAsset('image');
$('#usePreviewForVideo').onclick = () => usePreviewAsset('video');
$('#closePreview').onclick = () => $('#previewDialog').close();
$('#deletePreview').onclick = async () => { if ($('#deletePreview').disabled) return; const file = state.files.find(item => item.id === state.previewFileId); if (!file || !await confirmDelete({ title:'确认删除素材', message:'素材一旦删除，无法恢复。' })) return; const button = $('#deletePreview'); button.disabled = true; try { await removeFile(file); $('#previewDialog').close(); toast('文件已删除'); } catch (error) { toast(error.message); } finally { button.disabled = false; } };


$('#previewDialog').addEventListener('click', event => { if (event.target === event.currentTarget) $('#previewDialog').close(); });
$('#previewDialog').addEventListener('close', () => { resetDetailFit($('#previewDialog')); $('#previewMedia').innerHTML = ''; $('#deletePreview').disabled = false; state.previewFileId = null; });

async function bootstrap() {
  showBoot();
  try {
    const { user } = await api('/api/auth/me');
    await enterApp(user);
  } catch (error) {
    if (error.status === 401) {
      showAuth();
      if (window.location.pathname !== authPath) window.history.replaceState({ route:'login' }, '', authPath);
    } else {
      showBoot('暂时无法恢复工作区', '登录状态确认失败，请检查网络后重试。', { retry:true });
    }
  }
  renderReferences();
}
$('#bootRetry').onclick = () => bootstrap();
function nextPollDelay() { return state.tasks.some(task => ['queued','running'].includes(task.status)) ? activePollDelay : idlePollDelay; }
function scheduleTaskPoll(delay=nextPollDelay()) {
  clearTimeout(pollTimer);
  if (!state.user || document.hidden) return;
  pollTimer = setTimeout(async () => { await loadTasks({ background:true }); scheduleTaskPoll(); }, delay);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else if (state.user) { loadTasks({ background:true }).finally(() => scheduleTaskPoll()); }
});
await bootstrap();
scheduleTaskPoll();
