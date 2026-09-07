import { listSignature, mergeActiveRecords, mergeRecordsAddedDuringRequest, recordSignature } from './list-sync.js?v=3';
import { replaceAssetMentions } from './video-prompt.js?v=4';
import { canRemoveImportedLocalAsset, cloudAssetFromDesktopSync, isRemoteReferenceReady, needsReferenceUpload, shouldRemoveUploadJobLocalAsset } from './desktop-media-sync.js?v=12';
import { createApiClient } from './api-client.js?v=3';
import { createRecordIndexes } from './state/records.js?v=2';
import { createDesktopScope } from './platform/desktop-scope.js?v=3';
import { createTaskPoller } from './features/generation/polling.js?v=2';
import { createGenerationPresentation } from './features/generation/presentation.js?v=3';
import { createCreditPresentation } from './features/credits/presentation.js?v=2';
import { createPromptEditorCodec } from './components/prompt-editor.js?v=2';
import { createAccountScope } from './state/account-scope.js?v=2';
import { createNotificationController } from './features/notifications/controller.js?v=6';
import { resetAccountState } from './state/account-state.js?v=1';
import { createAccountLifecycle } from './state/account-lifecycle.js?v=1';
import { createMediaController } from './features/media/controller.js?v=6';
import { createSupportLogController } from './features/support/controller.js?v=1';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const toggleClass = (element, className, force) => element?.classList.toggle(className, force);
const assetPreviewUrl = file => file?.kind === 'image' ? (String(file.url || '').startsWith('gugu-media://') ? file.url : (file.previewUrl || file.url || '')) : (file?.url || '');
const state = { user:null, route:'image', authMode:'sms', tasks:[], generationPreparations:[], generationTab:'works', generationHistory:{ image:{ items:[], cursor:'', hasMore:true, loaded:false, loading:false, error:'' }, video:{ items:[], cursor:'', hasMore:true, loaded:false, loading:false, error:'' } }, files:[], credits:0, creditTransactions:[], creditWallet:{ balance:0, held:0, available:0 }, creditDetailTab:'spend', creditDetailRestoreFocus:null, creditPurchaseRestoreFocus:null, alipayTopupCredits:10, alipayOrderNo:'', notifications:[], unreadNotifications:0, pricing:{ image:1, videoPerSecond:1, signupBonus:50, yuanPerCredit:.1 }, modelQuote:null, config:{}, dramaAnalysis:null, dramaProject:null, dramaLoading:false, initialSyncReady:false, fileKind:'all', referenceTarget:'image', referenceKind:'all', refs:{ image:[], video:[] }, imagePromptMentions:[], videoPromptMentions:[], videoGenerationType:'TEXT', videoFrames:{ first:'', last:'' }, videoFrameTarget:'', dialogSelection:[], uploadJobs:[], detailTaskId:null, previewFileId:null };
const accountScope = createAccountScope({ getUser: () => state.user });
const alipayOrderStorageKey = user => `gugu_alipay_order:${encodeURIComponent(String(user?.id || user?.username || 'anonymous'))}`;
let referenceDialogCommitted = false;
let referenceDialogOriginal = null;
const recordIndexes = createRecordIndexes({ getFiles: () => state.files, getTasks: () => state.tasks, getHistory: () => state.generationHistory });
const fileById = recordIndexes.fileById;
const taskById = recordIndexes.taskById;
const taskForAsset = recordIndexes.taskForAsset;
let lastTaskRender = { route:'', tab:'', ready:null, tasks:null, preparations:null, files:null };
const failedWorkRetentionMs = 5 * 60 * 1000;
const transientFailureDeadlines = new Map();
const transientFailureTimers = new Map();
const routePaths = Object.freeze({ image:'/image', video:'/video', drama:'/drama', files:'/files' });
const authPath = '/login';
const routeFromPath = pathname => Object.entries(routePaths).find(([, path]) => path === pathname)?.[0] || 'image';
const taskSignatureFields = ['id','type','status','progress','progressStage','awaitingReferences','assetId','updatedAt','error','failure','creditStatus','prompt','size','quality','aspectRatio','duration','videoModelId','modelId','createdAt','submittedAt','finishedAt'];
const fileSignatureFields = ['id','name','kind','mimeType','size','url','remoteUrl','directUrl','localStatus','localPath','deliveryStatus','remoteStatus','referenceSourceAvailable','updatedAt','sourceGenerationId','createdAt'];
const taskCardSignatureFields = taskSignatureFields.filter(field => field !== 'updatedAt');
const fileCardSignatureFields = fileSignatureFields.filter(field => field !== 'updatedAt');
let tasksRequest = null;
let desktopSyncInfo = { deviceId:'', workspaceId:'', cursor:'' };
const activePollDelay = 6000;
const notificationPollDelay = 60000;
let desktopUpdateUnsubscribe = null;
let desktopWindowStateUnsubscribe = null;
let desktopWorkspacePath = '';
let desktopAccountEpoch = 0;
let desktopUpdateReminderSnoozed = false;
let desktopUpdateDialogDismissed = false;
const generationSubmissionForms = new WeakSet();
let desktopUpdateState = { status: 'idle' };
let desktopClientInfo = {};
let routeRenderFrame = 0;
let routeRenderTimer = 0;
let routeRenderEpoch = 0;

const desktopScope = createDesktopScope({ getWindow: () => window, getSyncInfo: () => desktopSyncInfo, getMediaKind: item => desktopMediaKind(item) });
const desktopScopeHeaders = desktopScope.headers;
const apiResponseShape = url => /\/api\/generations\?/.test(String(url)) && /(?:^|[?&])(?:ids|view)=/.test(String(url)) ? 'array' : 'object';
const { request: api, page: apiPage } = createApiClient({ scopeHeaders: desktopScopeHeaders, responseShapeFor: apiResponseShape });
function clearFileReferencesForIds(assetIds) {
  const ids = new Set((Array.isArray(assetIds) ? assetIds : [assetIds]).map(value => String(value || '')).filter(Boolean));
  for (const id of ids) {
    clearFileReferences(id);
    state.refs.image = state.refs.image.filter(value => !ids.has(String(value || '')));
    state.refs.video = state.refs.video.filter(value => !ids.has(String(value || '')));
    if (ids.has(String(state.videoFrames.first || ''))) state.videoFrames.first = '';
    if (ids.has(String(state.videoFrames.last || ''))) state.videoFrames.last = '';
  }
}
function renderAfterDesktopAssetHydration() {
  if (fileById(state.previewFileId)?.localStatus === 'missing') $('#previewDialog')?.close();
  if (fileById(taskById(state.detailTaskId)?.assetId)?.localStatus === 'missing' && $('#generationDetailDialog')?.open) closeGenerationDetail();
  if (state.route === 'files') {
    if (state.initialSyncReady) scheduleRouteContentRender('files', false);
  }
  renderReferences();
  if (['image', 'video'].includes(state.route) && state.initialSyncReady) scheduleRouteContentRender(state.route, false);
  else if (state.route === 'drama') dramaController?.refreshTasks?.();
}
const mediaController = createMediaController({
  state,
  api,
  desktopScope,
  recordIndexes,
  fileById,
  accountSnapshot:accountScope.snapshot,
  isAccountCurrent:accountScope.isCurrent,
  getAccountEpoch:() => desktopAccountEpoch,
  getDesktopSyncInfo:() => desktopSyncInfo,
  setDesktopSyncInfo:info => { desktopSyncInfo = info; },
  getWindow:() => window,
  getFileKind:() => state.fileKind,
  getFileSearch:() => $('#fileSearch')?.value?.trim() || '',
  matchesLibraryFile:file => libraryFileMatches(file),
  clearFileReferencesForIds,
  onChanged:() => renderAfterDesktopAssetHydration(),
  onError:(error, context) => {
    if (context?.action === 'show-folder') toast(`打开失败：${error.message}`);
    if (context?.action === 'copy-asset') toast(`复制失败：${error.message}`);
    if (context?.action === 'load-files') toast(`本地文件库加载失败：${error.message}`);
  },
  removeDramaAssemblyAssets:(assetIds, projectId) => {
    if (dramaController) return dramaController.removeAssemblyVideosForAssets?.(assetIds, projectId);
    if (!projectId) return undefined;
    return ensureDramaController().then(controller => controller.removeAssemblyVideosForAssets?.(assetIds, projectId));
  },
  refreshDramaProject:options => dramaController?.refreshProject?.(options),
});
const desktopLocalClientAsset = mediaController.desktopLocalClientAsset;
const mergeStateFiles = mediaController.mergeStateFiles;
const syncDesktopDeliveries = mediaController.syncDesktopDeliveries;
const loadFiles = mediaController.loadFiles;
const removeDesktopCloudAssets = mediaController.removeDesktopCloudAssets;
const claimLegacyWorkspace = mediaController.claimLegacyWorkspace;
const showDesktopAssetInFolder = mediaController.showAssetInFolder;
const copyDesktopAssetToClipboard = mediaController.copyAssetToClipboard;
async function confirmGenerationDeletion(task, { title = '确认删除作品' } = {}) {
  const failed = task?.status === 'failed';
  if (!await confirmDelete({
    title,
    message: failed ? '失败作品删除后无法恢复。' : '作品、关联云端文件、本机副本及短剧引用都会删除，且无法恢复。',
  })) return false;
  if (failed) return true;
  return confirmDelete({
    title:'再次确认永久删除',
    message:'这是已生成的内容。确认继续删除作品、云端文件、本机副本及所有短剧引用吗？',
  });
}
async function confirmFileDeletion(file) {
  const task = taskForAsset(file);
  if (file?.sourceGenerationId) {
    // A task can be outside the current paginated list. The presence of a
    // sourceGenerationId still means this is generated content, so keep the
    // stronger two-step confirmation even when its status is not hydrated.
    return confirmGenerationDeletion(task || { status:'completed' });
  }
  return confirmDelete({ title:'确认删除素材', message:'素材一旦删除，无法恢复。' });
}
const esc = (value='') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const notificationController = createNotificationController({ state, api, esc, toast, accountSnapshot:accountScope.snapshot, isAccountCurrent:accountScope.isCurrent });
const { load:loadNotifications, render:renderNotifications, setPanelOpen:setNotificationPanelOpen, schedulePanelClose:scheduleNotificationPanelClose, markRead:markNotificationRead, markAllRead:markAllNotificationsRead } = notificationController;
const supportLogController = createSupportLogController({ api, toast, closeNotifications:() => setNotificationPanelOpen(false), getClientInfo:() => desktopClientInfo, getSyncInfo:() => desktopSyncInfo });
const generationPresentation = createGenerationPresentation({ escapeHtml:esc });
const { taskProgress, videoProgressLabel, videoProgressMarkup, generationPreparationMarkup } = generationPresentation;
function assetImageMarkup(file, alt = '', attributes = ' loading="lazy" decoding="async"') {
  const preview = assetPreviewUrl(file);
  const original = String(file?.remoteUrl || file?.url || '');
  const fallback = preview && original && preview !== original ? ` data-original-src="${esc(original)}"` : '';
  return `<img src="${esc(preview)}" alt="${esc(alt)}"${fallback}${attributes}>`;
}
function isDesktopAssetSyncing(file) {
  if (file?.localStatus === 'missing') return false;
  return Boolean(window.guguDesktop && file && file.localStatus !== 'saved' && !String(file.url || '').startsWith('gugu-media://')) || mediaController.isHydrating(file);
}
function taskLocalSyncing(task, file = fileById(task?.assetId)) {
  if (file?.localStatus === 'missing') return false;
  if (!window.guguDesktop || task?.status !== 'completed' || !task.assetId) return false;
  const localReady = Boolean(file && file.localStatus === 'saved' && !isDesktopAssetSyncing(file));
  // A completed cloud task can be rendered before startup recovery has found
  // or downloaded its local copy. That gap is loading, not a missing result.
  return !localReady;
}
function taskDisplayStatus(task, file = fileById(task?.assetId)) {
  // Generation completion is terminal. Local delivery has its own syncing UI
  // and must never make a completed provider task look as if it is generating again.
  return task?.status;
}
function failureDeadline(task, observedAt = Date.now()) {
  const source = Date.parse(task?.finishedAt || task?.updatedAt || task?.createdAt || '');
  return (Number.isFinite(source) ? source : observedAt) + failedWorkRetentionMs;
}
function clearTransientFailureTimer(id) {
  const timer = transientFailureTimers.get(id);
  if (timer) window.clearTimeout(timer);
  transientFailureTimers.delete(id);
}
function transientFailureVisible(task, now = Date.now()) {
  if (task?.status !== 'failed' || !task?.id) return false;
  const deadline = transientFailureDeadlines.get(task.id);
  return Number.isFinite(deadline) && deadline > now;
}
function expireTransientFailure(id) {
  clearTransientFailureTimer(id);
  transientFailureDeadlines.delete(id);
  // The task array is deliberately retained for history and is therefore not
  // replaced when the works-only deadline elapses. Invalidate the gallery
  // render snapshot so the failed card is actually removed at the deadline.
  lastTaskRender.tasks = null;
  if (['image', 'video'].includes(state.route)) renderTasks();
}
function observeTaskFailure(task, previous = null, { force=false } = {}) {
  if (!task?.id || task.status !== 'failed') return;
  if (previous?.status === 'failed' && transientFailureDeadlines.has(task.id)) return;
  // A failed row read from history or a project during startup is not a new
  // failure event. Only a status transition observed from an in-session
  // task (or an explicit local cancellation) may start works retention.
  if (!force && (!previous || previous.status === 'failed')) return;
  clearTransientFailureTimer(task.id);
  const deadline = failureDeadline(task);
  if (deadline <= Date.now()) {
    transientFailureDeadlines.delete(task.id);
    return;
  }
  transientFailureDeadlines.set(task.id, deadline);
  transientFailureTimers.set(task.id, window.setTimeout(() => expireTransientFailure(task.id), Math.max(0, deadline - Date.now())));
}
function pruneExpiredTransientFailures(now = Date.now()) {
  for (const [id, deadline] of transientFailureDeadlines) if (deadline <= now) expireTransientFailure(id);
}
function clearTransientFailures() {
  for (const timer of transientFailureTimers.values()) window.clearTimeout(timer);
  transientFailureTimers.clear();
  transientFailureDeadlines.clear();
}
function mergeTasksIntoLoadedHistory(tasks = []) {
  for (const task of Array.isArray(tasks) ? tasks : [tasks]) {
    const entry = state.generationHistory[task?.type];
    if (!entry?.loaded || !task?.id) continue;
    entry.items = [task, ...entry.items.filter(item => item.id !== task.id)];
  }
  if (state.generationTab === 'history') renderGenerationHistory();
}
function desktopSyncMarkup(task) {
  const delivery = mediaController.downloadState(task?.assetId);
  if (delivery?.status === 'failed') return `<div class="skeleton-progress" role="status"><span>${esc(delivery.error || '下载失败')}</span><button type="button" class="retry-local-download" data-asset-id="${esc(task.assetId)}">重试下载</button></div>`;
  const label = delivery?.status === 'retrying' ? '下载暂时失败，等待重试…' : '正在保存到本地…';
  return `<div class="skeleton-progress" role="status" aria-live="polite" aria-label="${label}"><div class="skeleton-progress-head"><span><i aria-hidden="true"></i>${label}</span></div></div>`;
}
function requireDesktopLocalAsset(file) {
  if (file?.localStatus === 'missing') { toast('本地文件不存在，请重新选择'); return false; }
  if (!isDesktopAssetSyncing(file)) return true;
  toast('素材正在保存到本地，请稍后再预览');
  return false;
}
// Local video cards only load metadata near the viewport. Creating hundreds of
// eager <video> sources at once can saturate the desktop media process and disk.
let videoPreviewObserver = null;
let videoPreviewScanFrame = 0;
function hydrateVisibleVideoPreviews() {
  videoPreviewScanFrame = 0;
  const videos = $$('video[data-preview-src]');
  const hydrate = video => {
    const src = video.dataset.previewSrc;
    if (!src) return;
    video.src = src;
    video.preload = 'metadata';
    delete video.dataset.previewSrc;
  };
  if (!('IntersectionObserver' in window)) {
    videos.forEach(hydrate);
    return;
  }
  videoPreviewObserver ||= new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    videoPreviewObserver.unobserve(entry.target);
    hydrate(entry.target);
  }), { rootMargin:'240px' });
  videos.forEach(video => videoPreviewObserver.observe(video));
}
function scheduleVideoPreviewHydration() {
  if (!videoPreviewScanFrame) videoPreviewScanFrame = requestAnimationFrame(hydrateVisibleVideoPreviews);
}
function videoPreviewMarkup(file, className = '') {
  if (String(file?.url || '').startsWith('gugu-media://')) {
    scheduleVideoPreviewHydration();
    return `<video data-preview-src="${esc(file.url)}" preload="none" muted playsinline></video><span class="play-mark"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></span>`;
  }
  return `<span class="video-placeholder${className ? ` ${className}` : ''}" aria-hidden="true"><span class="play-mark"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></span></span>`;
}
document.addEventListener('error', event => {
  const media = event.target;
  if (media instanceof HTMLImageElement) {
    const original = media.dataset.originalSrc;
    if (!original || media.dataset.previewFallback === 'true') return;
    media.dataset.previewFallback = 'true';
    media.src = original;
    return;
  }
  if (!(media instanceof HTMLVideoElement)) return;
  const src = media.currentSrc || media.src || media.dataset.previewSrc || '';
  if (!src.startsWith('gugu-media://')) return;
  console.warn('[desktop] 本地视频播放失败，刷新本地索引并尝试重新同步', {
    src,
    networkState: media.networkState,
    readyState: media.readyState,
    errorCode: media.error?.code || 0,
  });
  void loadFiles({ background:true });
}, true);
const videoRichEditorEmptyChar = '\u200B';
let videoPromptMentionRequest = null;
let videoPromptCompositionFrame = 0;
const videoPromptCodec = createPromptEditorCodec({ mentionClass: 'video-prompt-mention', mentionSelector: '[data-video-prompt-mention-id]', labelAttribute: 'videoPromptMentionLabel', emptyChar: videoRichEditorEmptyChar });
const imagePromptCodec = createPromptEditorCodec({ mentionClass: 'image-prompt-mention', mentionSelector: '[data-image-prompt-mention-id]', labelAttribute: 'imagePromptMentionLabel', emptyChar: videoRichEditorEmptyChar });

function videoPromptEditor() { return $('#videoPrompt'); }
function videoPromptMentionLabel(mention, file) { return String(mention?.label || file?.name || '未命名素材').replace(/^@/, '').trim() || '未命名素材'; }
function videoPromptMentionKindLabel(kind) { return ({ image:'图片', video:'视频', audio:'音频' }[kind] || '素材'); }
function videoPromptMentionMarkup(mention, resolvedFile = null) {
  const file = resolvedFile || state.files.find(item => item.id === mention?.id);
  const label = videoPromptMentionLabel(mention, file);
  if (!file) return esc(`@${label}`);
  const preview = file.kind === 'image'
    ? assetImageMarkup(file, label)
    : file.kind === 'video'
      ? videoPreviewMarkup(file, 'video-prompt-mention-placeholder')
      : '<b>♫</b>';
  return `<span class="video-prompt-mention" data-video-prompt-mention-id="${esc(file.id)}" data-video-prompt-mention-label="${esc(label)}" data-video-prompt-mention-kind="${esc(file.kind)}" contenteditable="false" aria-label="引用${esc(label)}，${videoPromptMentionKindLabel(file.kind)}"><span class="video-prompt-mention-thumb">${preview}</span><span class="video-prompt-mention-name">${esc(label)}</span></span>`;
}
function serializeVideoPromptEditor(editor = videoPromptEditor()) {
  return videoPromptCodec.serialize(editor);
}
function videoPromptMentionsFromEditor(editor = videoPromptEditor()) {
  return videoPromptCodec.mentions(editor).map(item => ({ ...item, kind:['image', 'video', 'audio'].includes(item.kind) ? item.kind : 'image' }));
}
function normalizeEmptyVideoPrompt(editor = videoPromptEditor()) {
  if (!editor) return;
  if (serializeVideoPromptEditor(editor).trim()) { editor.dataset.empty = 'false'; return; }
  // Keep the editor truly empty so the ::before placeholder does not become
  // part of the caret's visual flow. A zero-width text node here makes the
  // browser place the caret after the generated placeholder text.
  editor.replaceChildren();
  editor.dataset.empty = 'true';
}
function videoPromptText() { return serializeVideoPromptEditor().trimEnd(); }
function restoreVideoPromptFocus(editor, range) {
  if (!editor?.isConnected) return;
  requestAnimationFrame(() => {
    if (!editor.isConnected) return;
    editor.focus({ preventScroll:true });
    if (!range || !editor.contains(range.startContainer)) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}
function setVideoPromptText(value = '') {
  const editor = videoPromptEditor();
  if (!editor) return;
  editor.textContent = String(value || '');
  state.videoPromptMentions = [];
  videoPromptMentionRequest = null;
  normalizeEmptyVideoPrompt(editor);
}
function previousVideoPromptTextPosition(range) {
  let node = range.startContainer;
  let offset = range.startOffset;
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  const child = node.childNodes[offset - 1];
  if (!child) return null;
  node = child;
  while (node.lastChild) node = node.lastChild;
  return node.nodeType === Node.TEXT_NODE ? { node, offset:node.nodeValue.length } : null;
}
function videoPromptTriggerAtCaret(editor = videoPromptEditor()) {
  const selection = window.getSelection();
  if (!editor || !selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return false;
  const previous = previousVideoPromptTextPosition(selection.getRangeAt(0));
  return Boolean(previous && previous.offset > 0 && previous.node.nodeValue[previous.offset - 1] === '@');
}
function removeVideoPromptTrigger(range) {
  const previous = previousVideoPromptTextPosition(range);
  if (!previous || previous.offset < 1 || previous.node.nodeValue[previous.offset - 1] !== '@') return;
  previous.node.deleteData(previous.offset - 1, 1);
  range.setStart(previous.node, previous.offset - 1);
  range.collapse(true);
}
function syncVideoPromptMentionsFromEditor() {
  const previousMentionIds = new Set(state.videoPromptMentions.map(item => item.id));
  const mentions = videoPromptMentionsFromEditor();
  const mentionIds = mentions.map(item => item.id);
  const nextMentionIds = new Set(mentionIds);
  state.videoPromptMentions = mentions;
  state.refs.video = state.refs.video.filter(id => !previousMentionIds.has(id) || nextMentionIds.has(id));
  state.refs.video = normalizeVideoReferenceIds([...mentionIds, ...state.refs.video.filter(id => !nextMentionIds.has(id))]);
}
function videoPromptMentionAtCaret(editor, direction) {
  return videoPromptCodec.mentionAtCaret(editor, direction);
}
function setVideoPromptCaret(editor, node, offset = 0) {
  videoPromptCodec.setCaret(editor, node, offset);
}
function removeVideoPromptMentionAtCaret(editor, event) {
  if (!['Backspace', 'Delete'].includes(event.key) || event.isComposing || editor.dataset.composing === 'true') return false;
  const direction = event.key === 'Backspace' ? 'backward' : 'forward';
  const mention = videoPromptMentionAtCaret(editor, direction);
  if (!mention) return false;
  event.preventDefault();
  const after = mention.nextSibling;
  const before = mention.previousSibling;
  mention.remove();
  syncVideoPromptInput();
  if (after?.isConnected && after.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, after, 0);
  else if (before?.isConnected && before.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, before, before.nodeValue.length);
  else setVideoPromptCaret(editor);
  return true;
}
function removeVideoPromptMentionNodes(assetId) {
  const id = String(assetId || '');
  const editor = videoPromptEditor();
  let restoreCaret = null;
  const selection = window.getSelection();
  const selectionRange = selection?.rangeCount && editor?.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  editor?.querySelectorAll('[data-video-prompt-mention-id]').forEach(node => {
    if (node.dataset.videoPromptMentionId !== id) return;
    let touchesSelection = false;
    try { touchesSelection = Boolean(selectionRange?.intersectsNode(node)); } catch {}
    if (touchesSelection && !restoreCaret) restoreCaret = { after:node.nextSibling, before:node.previousSibling };
    node.remove();
  });
  state.videoPromptMentions = state.videoPromptMentions.filter(item => item.id !== id);
  normalizeEmptyVideoPrompt(editor);
  syncVideoPromptState();
  if (restoreCaret) {
    if (restoreCaret.after?.isConnected && restoreCaret.after.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, restoreCaret.after, 0);
    else if (restoreCaret.before?.isConnected && restoreCaret.before.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, restoreCaret.before, restoreCaret.before.nodeValue.length);
    else setVideoPromptCaret(editor);
  }
}
function pruneVideoPromptMentionsToReferences() {
  const activeReferenceIds = new Set(state.refs.video);
  state.videoPromptMentions.filter(item => !activeReferenceIds.has(item.id)).forEach(item => removeVideoPromptMentionNodes(item.id));
}
function insertVideoPromptMentions(assetIds, request = videoPromptMentionRequest) {
  const editor = request?.editor || videoPromptEditor();
  if (!editor) return;
  const selected = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(String))]
    .map(id => referenceFileById(id))
    .filter(file => file && ['image','video','audio'].includes(file.kind));
  const existingIds = new Set(videoPromptMentionsFromEditor(editor).map(item => item.id));
  const files = selected.filter(file => !existingIds.has(file.id));
  const range = request?.range?.cloneRange?.() || document.createRange();
  if (!request?.range || !editor.contains(range.startContainer)) { range.selectNodeContents(editor); range.collapse(false); }
  editor.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  removeVideoPromptTrigger(range);
  files.forEach(file => {
    const holder = document.createElement('span');
    const mention = { id:file.id, label:file.name, kind:file.kind };
    holder.innerHTML = videoPromptMentionMarkup(mention, file);
    let chip = holder.firstElementChild;
    if (!chip) {
      // A pending local reference may not be present in state.files yet. Never
      // pass null to Range.insertNode; preserve a valid mention chip even when
      // preview markup cannot be produced.
      const label = videoPromptMentionLabel(mention, file);
      chip = document.createElement('span');
      chip.className = 'video-prompt-mention';
      chip.dataset.videoPromptMentionId = String(file.id);
      chip.dataset.videoPromptMentionLabel = label;
      chip.dataset.videoPromptMentionKind = file.kind;
      chip.contentEditable = 'false';
      chip.setAttribute('aria-label', `引用${label}，${videoPromptMentionKindLabel(file.kind)}`);
      chip.textContent = `@${label}`;
    }
    range.insertNode(chip);
    const spacer = document.createTextNode(' ');
    chip.after(spacer);
    // Keep the caret inside an editable text node. Placing it after the node
    // makes Chromium start the next IME composition with the first Latin key
    // outside the composition (for example, `z` in `zai`).
    range.setStart(spacer, spacer.nodeValue.length);
    range.collapse(true);
  });
  selection.removeAllRanges();
  selection.addRange(range);
  normalizeEmptyVideoPrompt(editor);
  syncVideoPromptMentionsFromEditor();
  videoPromptMentionRequest = null;
  return { editor, range:range.cloneRange() };
}
let imagePromptMentionRequest = null;
let imagePromptCompositionFrame = 0;
function imagePromptEditor() { return $('#imagePrompt'); }
function imagePromptMentionMarkup(mention, resolvedFile = null) {
  const file = resolvedFile || state.files.find(item => item.id === mention?.id);
  const label = videoPromptMentionLabel(mention, file);
  if (!file) return esc(`@${label}`);
  return `<span class="image-prompt-mention" data-image-prompt-mention-id="${esc(file.id)}" data-image-prompt-mention-label="${esc(label)}" data-image-prompt-mention-kind="image" contenteditable="false" aria-label="引用${esc(label)}，图片"><span class="image-prompt-mention-thumb">${assetImageMarkup(file, label)}</span><span class="image-prompt-mention-name">${esc(label)}</span></span>`;
}
function serializeImagePromptEditor(editor = imagePromptEditor()) {
  return imagePromptCodec.serialize(editor);
}
function imagePromptMentionsFromEditor(editor = imagePromptEditor()) {
  return imagePromptCodec.mentions(editor).map(item => ({ ...item, kind: 'image' }));
}
function normalizeEmptyImagePrompt(editor = imagePromptEditor()) {
  if (!editor) return;
  if (serializeImagePromptEditor(editor).trim()) { editor.dataset.empty = 'false'; return; }
  editor.replaceChildren();
  editor.dataset.empty = 'true';
}
function imagePromptText() { return serializeImagePromptEditor().trimEnd(); }
function setImagePromptText(value = '') {
  const editor = imagePromptEditor();
  if (!editor) return;
  editor.textContent = String(value || '');
  state.imagePromptMentions = [];
  imagePromptMentionRequest = null;
  normalizeEmptyImagePrompt(editor);
}
function imagePromptMentionAtCaret(editor, direction) {
  return imagePromptCodec.mentionAtCaret(editor, direction);
}
function removeImagePromptMentionAtCaret(editor, event) {
  if (!['Backspace', 'Delete'].includes(event.key) || event.isComposing || editor.dataset.composing === 'true') return false;
  const direction = event.key === 'Backspace' ? 'backward' : 'forward';
  const mention = imagePromptMentionAtCaret(editor, direction);
  if (!mention) return false;
  event.preventDefault();
  const after = mention.nextSibling;
  const before = mention.previousSibling;
  mention.remove();
  syncImagePromptInput();
  if (after?.isConnected && after.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, after, 0);
  else if (before?.isConnected && before.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, before, before.nodeValue.length);
  else setVideoPromptCaret(editor);
  return true;
}
function syncImagePromptMentionsFromEditor() {
  const previousMentionIds = new Set(state.imagePromptMentions.map(item => item.id));
  const mentions = imagePromptMentionsFromEditor();
  const mentionIds = mentions.map(item => item.id);
  const nextMentionIds = new Set(mentionIds);
  state.imagePromptMentions = mentions;
  state.refs.image = state.refs.image.filter(id => !previousMentionIds.has(id) || nextMentionIds.has(id));
  state.refs.image = normalizeImageReferenceIds([...mentionIds, ...state.refs.image.filter(id => !nextMentionIds.has(id))]);
}
function removeImagePromptMentionNodes(assetId) {
  const id = String(assetId || '');
  const editor = imagePromptEditor();
  let restoreCaret = null;
  const selection = window.getSelection();
  const selectionRange = selection?.rangeCount && editor?.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  editor?.querySelectorAll('[data-image-prompt-mention-id]').forEach(node => {
    if (node.dataset.imagePromptMentionId !== id) return;
    let touchesSelection = false;
    try { touchesSelection = Boolean(selectionRange?.intersectsNode(node)); } catch {}
    if (touchesSelection && !restoreCaret) restoreCaret = { after:node.nextSibling, before:node.previousSibling };
    node.remove();
  });
  state.imagePromptMentions = state.imagePromptMentions.filter(item => item.id !== id);
  normalizeEmptyImagePrompt(editor);
  syncImagePromptState();
  if (restoreCaret) {
    if (restoreCaret.after?.isConnected && restoreCaret.after.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, restoreCaret.after, 0);
    else if (restoreCaret.before?.isConnected && restoreCaret.before.nodeType === Node.TEXT_NODE) setVideoPromptCaret(editor, restoreCaret.before, restoreCaret.before.nodeValue.length);
    else setVideoPromptCaret(editor);
  }
}
function pruneImagePromptMentionsToReferences() {
  const activeReferenceIds = new Set(state.refs.image);
  state.imagePromptMentions.filter(item => !activeReferenceIds.has(item.id)).forEach(item => removeImagePromptMentionNodes(item.id));
}
function insertImagePromptMentions(assetIds, request = imagePromptMentionRequest) {
  const editor = request?.editor || imagePromptEditor();
  if (!editor) return;
  const selected = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(String))]
    .map(id => referenceFileById(id))
    .filter(file => file?.kind === 'image');
  const existingIds = new Set(imagePromptMentionsFromEditor(editor).map(item => item.id));
  const files = selected.filter(file => !existingIds.has(file.id));
  const range = request?.range?.cloneRange?.() || document.createRange();
  if (!request?.range || !editor.contains(range.startContainer)) { range.selectNodeContents(editor); range.collapse(false); }
  editor.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  removeVideoPromptTrigger(range);
  files.forEach(file => {
    const holder = document.createElement('span');
    const mention = { id:file.id, label:file.name, kind:'image' };
    holder.innerHTML = imagePromptMentionMarkup(mention, file);
    let chip = holder.firstElementChild;
    if (!chip) {
      const label = videoPromptMentionLabel(mention, file);
      chip = document.createElement('span');
      chip.className = 'image-prompt-mention';
      chip.dataset.imagePromptMentionId = String(file.id);
      chip.dataset.imagePromptMentionLabel = label;
      chip.dataset.imagePromptMentionKind = 'image';
      chip.contentEditable = 'false';
      chip.setAttribute('aria-label', `引用${label}，图片`);
      chip.textContent = `@${label}`;
    }
    range.insertNode(chip);
    const spacer = document.createTextNode(' ');
    chip.after(spacer);
    range.setStart(spacer, spacer.nodeValue.length);
    range.collapse(true);
  });
  selection.removeAllRanges();
  selection.addRange(range);
  normalizeEmptyImagePrompt(editor);
  syncImagePromptMentionsFromEditor();
  imagePromptMentionRequest = null;
  return { editor, range:range.cloneRange() };
}
const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
const dateText = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const fullDateText = value => value ? new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
const creditPresentation = createCreditPresentation({ getState:() => state, escapeHtml:esc, formatFullDate:fullDateText });
const { creditText, creditEntryAmount, creditDateText, creditModelName, creditGenerationType, creditSpendType, creditEarnType, creditEntryStatus, signedCreditAmount, renderCreditRows } = creditPresentation;
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
let toastTimer;
let alipayPaymentPollTimer = 0;
let creditPopoverCloseTimer = 0;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('show'); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3200); }
function emptyState(title, body, action='') { return `<div class="empty-state"><div class="empty-orbit"><i></i><i></i><i></i></div><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`; }
function generationLoadingSkeleton() {
  const cards = Array.from({ length:8 }, () => '<article class="task-card loading-skeleton-card"><div class="card-visual"><div class="card-placeholder"><div class="skeleton-frame"><i></i><i></i><i></i></div><div class="skeleton-card-lines"><i></i><i></i></div></div></div></article>').join('');
  return `<div class="loading-skeleton loading-skeleton--gallery" role="status" aria-live="polite" aria-label="正在加载作品">${cards}</div>`;
}
function generationHistoryLoadingSkeleton() {
  const rows = Array.from({ length:7 }, () => '<article class="generation-history-row loading-skeleton-history-row"><span class="skeleton-history-thumb"></span><span class="skeleton-history-copy"><i></i><i></i></span><span class="skeleton-history-status"><i></i></span><span class="skeleton-history-date"></span><span class="skeleton-history-credit"></span><span class="skeleton-history-actions"><i></i><i></i></span></article>').join('');
  return `<div class="loading-skeleton loading-skeleton--history" role="status" aria-live="polite" aria-label="正在加载历史记录">${rows}</div>`;
}
function fileLibraryLoadingSkeleton() {
  const cards = Array.from({ length:10 }, () => '<article class="file-card loading-skeleton-file"><div class="file-preview"><span class="skeleton-file-thumb"></span><div class="skeleton-file-copy"><i class="skeleton-file-line"></i><i class="skeleton-file-line short"></i></div></div></article>').join('');
  return `<div class="loading-skeleton loading-skeleton--files" role="status" aria-live="polite" aria-label="正在加载文件库">${cards}</div>`;
}
function dramaProjectsLoadingSkeleton() {
  const cards = Array.from({ length:7 }, () => '<article class="project-card loading-skeleton-project"><div class="skeleton-project-content"><i class="skeleton-project-kicker"></i><i class="skeleton-project-title"></i><i class="skeleton-project-title short"></i><span class="skeleton-project-footer"></span></div></article>').join('');
  return `<div class="loading-skeleton loading-skeleton--projects" role="status" aria-live="polite" aria-label="正在加载短剧项目"><div class="project-library-toolbar loading-skeleton-project-toolbar"><span class="skeleton-project-search"></span><span class="skeleton-project-count"></span></div><div class="project-library-grid"><div class="create-project-card loading-skeleton-project-create"><span></span><i></i></div>${cards}</div></div>`;
}

let captchaRequest = null;
let smsCountdownTimer = 0;
let smsCooldownUntil = 0;
function setAuthMode(mode) {
  state.authMode = mode === 'login' ? 'login' : 'sms';
  const smsLogin = state.authMode === 'sms';
  $$('.auth-tabs button').forEach(button => {
    const active = button.dataset.auth === state.authMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#authSubmit span').textContent = '登录';
  $('#authPassword').autocomplete = 'current-password';
  $('#authUsernameField').classList.toggle('hidden', smsLogin);
  $('#authPasswordField').classList.toggle('hidden', smsLogin);
  $('#smsFields').classList.toggle('hidden', !smsLogin);
  $('#authUsername').required = !smsLogin;
  $('#authPassword').required = !smsLogin;
  $('#authPhone').required = smsLogin;
  $('#authSmsCode').required = smsLogin;
  $('#captchaCode').required = false;
  $('#authError').textContent = '';
  if (smsLogin && !$('#captchaImage').dataset.challengeId) void loadCaptcha();
}
function setupIntroCardInteraction() {
  const stage = $('#introStage');
  const card = $('#introCard');
  if (!stage || !card || stage.dataset.interactive === 'true') return;
  stage.dataset.interactive = 'true';
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const setPointerState = (x, y) => {
    if (reduceMotion) return;
    stage.style.setProperty('--pointer-shift-x', `${x * 24}px`);
    stage.style.setProperty('--pointer-shift-y', `${y * 20}px`);
    stage.style.setProperty('--pointer-tilt-x', `${x * 9}deg`);
    stage.style.setProperty('--pointer-tilt-y', `${y * -7}deg`);
    stage.style.setProperty('--pointer-roll', `${x * -1.4}deg`);
    stage.style.setProperty('--orbit-shift-x', `${x * -14}px`);
    stage.style.setProperty('--orbit-shift-y', `${y * -11}px`);
  };
  const resetPointerState = () => setPointerState(0, 0);
  stage.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    const bounds = stage.getBoundingClientRect();
    const x = clamp((event.clientX - (bounds.left + bounds.width / 2)) / (bounds.width / 2), -1, 1);
    const y = clamp((event.clientY - (bounds.top + bounds.height / 2)) / (bounds.height / 2), -1, 1);
    setPointerState(x, y);
  });
  stage.addEventListener('pointerleave', resetPointerState);
  card.addEventListener('click', () => {
    const flipped = card.classList.toggle('is-flipped');
    card.style.setProperty('--flip-angle', flipped ? '180deg' : '0deg');
    card.setAttribute('aria-pressed', String(flipped));
    card.setAttribute('aria-label', flipped ? '翻回品牌卡牌正面' : '翻转品牌卡牌');
  });
}
async function loadCaptcha() {
  if (captchaRequest) return captchaRequest;
  const image = $('#captchaImage');
  image.removeAttribute('src');
  delete image.dataset.challengeId;
  captchaRequest = api('/api/auth/captcha').then(result => {
    image.src = result.image;
    image.dataset.challengeId = result.challengeId;
    $('#captchaCode').value = '';
    return result;
  }).finally(() => { captchaRequest = null; });
  return captchaRequest;
}
function updateSmsCountdown() {
  const button = $('#sendSmsCode');
  const remaining = Math.max(0, Math.ceil((smsCooldownUntil - Date.now()) / 1000));
  if (remaining > 0) {
    button.disabled = true;
    button.textContent = `${remaining}s 后重试`;
    smsCountdownTimer = window.setTimeout(updateSmsCountdown, 250);
  } else {
    button.disabled = false;
    button.textContent = '获取验证码';
    smsCountdownTimer = 0;
  }
}
function startSmsCountdown(seconds) {
  window.clearTimeout(smsCountdownTimer);
  smsCooldownUntil = Date.now() + Math.max(1, Number(seconds) || 60) * 1000;
  updateSmsCountdown();
}
$$('.auth-tabs button').forEach(button => button.onclick = () => setAuthMode(button.dataset.auth));
$('#togglePassword').onclick = () => { const input = $('#authPassword'); input.type = input.type === 'password' ? 'text' : 'password'; $('#togglePassword').setAttribute('aria-label', input.type === 'password' ? '显示密码' : '隐藏密码'); };
function captchaDialogError(message = '') {
  const error = $('#captchaDialogError');
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}
function closeCaptchaDialog() {
  const dialog = $('#captchaDialog');
  if (dialog?.open) dialog.close();
}
async function openCaptchaDialog() {
  const dialog = $('#captchaDialog');
  if (!dialog || dialog.open) return;
  $('#captchaCode').value = '';
  captchaDialogError();
  dialog.showModal();
  requestAnimationFrame(() => $('#captchaCode').focus());
  if ($('#captchaImage').dataset.challengeId) return;
  try { await loadCaptcha(); }
  catch (error) { captchaDialogError(error.message); }
}
$('#refreshCaptcha').onclick = () => { captchaDialogError(); void loadCaptcha().catch(error => captchaDialogError(error.message)); };
$('#sendSmsCode').onclick = () => {
  const phone = $('#authPhone').value.trim();
  $('#authError').textContent = '';
  if (!/^1[3-9]\d{9}$/.test(phone)) { $('#authError').textContent = '请输入正确的手机号'; return; }
  void openCaptchaDialog();
};
$('#captchaForm').onsubmit = async event => {
  event.preventDefault();
  const phone = $('#authPhone').value.trim();
  const captchaCode = $('#captchaCode').value.trim();
  const captchaId = $('#captchaImage').dataset.challengeId || '';
  captchaDialogError();
  if (!/^1[3-9]\d{9}$/.test(phone)) { captchaDialogError('手机号已变化，请返回重新输入'); return; }
  if (!captchaId || !captchaCode) { captchaDialogError('请输入图中字符'); return; }
  const confirm = $('#confirmCaptcha');
  confirm.disabled = true;
  try {
    const result = await api('/api/auth/sms/send', { method:'POST', body:JSON.stringify({ phone, captchaId, captchaCode }) });
    startSmsCountdown(result.cooldownSeconds);
    toast('验证码已发送');
    closeCaptchaDialog();
    try { await loadCaptcha(); } catch {}
  } catch (error) {
    if (error.status === 429 && error.cooldownSeconds) {
      startSmsCountdown(error.cooldownSeconds);
      $('#authError').textContent = error.message;
      closeCaptchaDialog();
    } else {
      captchaDialogError(error.message);
      try { await loadCaptcha(); } catch {}
    }
  } finally {
    confirm.disabled = false;
  }
};
$('#closeCaptchaDialog').onclick = $('#cancelCaptchaDialog').onclick = closeCaptchaDialog;
$('#captchaDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeCaptchaDialog(); });
$('#captchaDialog').addEventListener('cancel', event => { event.preventDefault(); closeCaptchaDialog(); });
$('#authForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('#authSubmit');
  $('#authError').textContent = '';
  if (state.authMode === 'sms') {
    const phone = $('#authPhone').value.trim();
    const code = $('#authSmsCode').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) { $('#authError').textContent = '请输入正确的手机号'; return; }
    if (!/^\d{4,8}$/.test(code)) { $('#authError').textContent = '请输入短信验证码'; return; }
    button.disabled = true;
    try {
      const result = await api('/api/auth/sms/login', { method:'POST', body:JSON.stringify({ phone, code }) });
      await enterApp(result.user);
    } catch (error) { $('#authError').textContent = error.message; }
    finally { button.disabled = false; }
    return;
  }
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value;
  if (!username || username.length > 64) { $('#authError').textContent = '请输入账号、昵称或手机号'; return; }
  if (password.length < 8) { $('#authError').textContent = '密码至少需要 8 位'; return; }
  button.disabled = true;
  try {
    const result = await api('/api/auth/login', { method:'POST', body:JSON.stringify({ username, password }) });
    await enterApp(result.user);
  } catch (error) { $('#authError').textContent = error.status === 404 ? '注册服务未启动，请重启后端服务' : error.message; }
  finally { button.disabled = false; }
};
function renderCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (!dialog) return;
  const balance = Number(state.creditWallet.balance ?? state.credits) || 0;
  $('#creditDetailBalance').textContent = creditText(balance);
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
function renderCreditPurchase() {
  const rate = Number(state.pricing?.yuanPerCredit) || .1;
  $$('[data-alipay-credits]').forEach(button => {
    const selected = Number(button.dataset.alipayCredits) === state.alipayTopupCredits;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  $('#alipayTopupAmount').textContent = `¥${(state.alipayTopupCredits * rate).toFixed(2)}`;
  const meta = $('#alipayTopupMeta');
  if (meta) meta.textContent = `${creditText(state.alipayTopupCredits)} 积分 · 1 元 = ${creditText(1 / rate)} 积分`;
  const balance = $('#creditPurchaseBalance');
  if (balance) balance.textContent = creditText(state.credits);
  $('#alipayRefreshPayment').classList.toggle('hidden', !state.alipayOrderNo);
}
function setAlipayStatus(message = '', tone = '') {
  const target = $('#alipayTopupStatus');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}
function stopAlipayPaymentPolling() { clearTimeout(alipayPaymentPollTimer); alipayPaymentPollTimer = 0; }
function scheduleAlipayPaymentPolling() {
  stopAlipayPaymentPolling();
  if (!state.alipayOrderNo) return;
  alipayPaymentPollTimer = window.setTimeout(() => { void refreshAlipayPayment({ polling:true }); }, 3000);
}
async function refreshAlipayPayment({ polling = false } = {}) {
  if (!state.alipayOrderNo) return;
  const requestAccount = accountScope.snapshot();
  const button = $('#alipayRefreshPayment');
  button.disabled = true;
  if (!polling) setAlipayStatus('正在向支付宝确认订单状态…');
  try {
    const result = await api(`/api/payments/alipay/orders/${encodeURIComponent(state.alipayOrderNo)}/query`, { method:'POST', body:'{}' });
    if (!accountScope.isCurrent(requestAccount)) return;
    if (result.order?.status === 'PAID') {
      stopAlipayPaymentPolling();
      sessionStorage.removeItem(alipayOrderStorageKey(state.user));
      state.alipayOrderNo = '';
      await loadCredits();
      setCreditBalance(state.creditWallet.balance);
      setAlipayStatus(`${creditText(result.order.credits)} 积分已到账`, 'success');
      renderCreditPurchase();
      if (window.guguDesktop?.payments?.complete) {
        try { await window.guguDesktop.payments.complete(); } catch {}
      }
      showPaymentSuccess(result.order.credits, state.creditWallet.balance);
    } else { setAlipayStatus('等待扫码付款…'); scheduleAlipayPaymentPolling(); }
  } catch (error) { if (accountScope.isCurrent(requestAccount)) setAlipayStatus(error.message || '暂时无法确认支付状态', 'error'); }
  finally { button.disabled = false; }
}
async function startAlipayTopup() {
  const requestAccount = accountScope.snapshot();
  const button = $('#alipayTopupButton');
  button.disabled = true;
  setAlipayStatus('正在创建支付宝扫码收银台…');
  try {
    const result = await api('/api/payments/alipay/orders', { method:'POST', body:JSON.stringify({ credits:state.alipayTopupCredits }) });
    if (!accountScope.isCurrent(requestAccount)) return;
    state.alipayOrderNo = result.order.outTradeNo;
    sessionStorage.setItem(alipayOrderStorageKey(state.user), state.alipayOrderNo);
    renderCreditPurchase();
    if (!window.guguDesktop?.payments?.open) throw new Error('桌面支付能力尚未就绪，请重启客户端后再试');
    await window.guguDesktop.payments.open(result.paymentHtml);
    setAlipayStatus('支付宝扫码收银台已打开，支付后可刷新状态。');
    scheduleAlipayPaymentPolling();
  } catch (error) {
    if (accountScope.isCurrent(requestAccount)) setAlipayStatus(error.message || '支付订单创建失败', 'error');
  } finally { button.disabled = false; }
}
function setCreditDetailTab(tab) { state.creditDetailTab = tab === 'earn' ? 'earn' : 'spend'; renderCreditDetail(); }
function setCreditBalance(balance) {
  state.credits = Number(balance) || 0;
  state.creditWallet = { ...state.creditWallet, balance:state.credits, available:Math.max(0, state.credits - (Number(state.creditWallet.held) || 0)) };
  $('#creditAmount').textContent = creditText(state.credits);
  renderCreditDetail();
  if ($('#creditPurchaseDialog')?.open) renderCreditPurchase();
}
async function loadCredits() {
  const requestAccount = accountScope.snapshot();
  try {
    const result = await api('/api/credits');
    if (!accountScope.isCurrent(requestAccount)) return;
    state.pricing = result.pricing;
    state.creditWallet = { balance:Number(result.balance) || 0, held:Number(result.held) || 0, available:Number(result.available) || 0 };
    state.creditTransactions = Array.isArray(result.transactions) ? result.transactions : [];
    state.credits = state.creditWallet.balance;
    $('#creditAmount').textContent = creditText(state.credits);
    updateImageCost();
    updateVideoCost();
    renderCreditDetail();
    renderCreditPurchase();
  } catch (error) { if (accountScope.isCurrent(requestAccount) && error.status === 401) location.reload(); }
}

function setCreditPopoverOpen(open) {
  ensureCreditPopoverEntry();
  const control = $('#creditControl');
  const popover = $('#creditDetailPopover');
  const button = $('#creditBalance');
  if (!control || !popover || !button) return;
  window.clearTimeout(creditPopoverCloseTimer);
  creditPopoverCloseTimer = 0;
  control.classList.toggle('is-open', open);
  toggleClass(popover, 'hidden', !open);
  popover.setAttribute('aria-hidden', String(!open));
  button.setAttribute('aria-expanded', String(open));
}
function ensureCreditPopoverEntry() {
  const popover = $('#creditDetailPopover');
  if (!popover || popover.dataset.entryReady === 'true') return;
  popover.setAttribute('aria-labelledby', 'creditDetailEntryTitle');
  popover.innerHTML = '<button id="creditDetailEntry" class="credit-detail-entry" type="button"><span class="credit-detail-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.5 14.1 9l5.9 2.1-5.9 2.1L12 19l-2.1-5.8L4 11.1 9.9 9 12 3.5Z"/></svg></span><span class="credit-detail-entry-copy"><b id="creditDetailEntryTitle">积分详情</b></span><svg class="credit-detail-entry-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>';
  popover.dataset.entryReady = 'true';
}
function scheduleCreditPopoverClose() {
  window.clearTimeout(creditPopoverCloseTimer);
  creditPopoverCloseTimer = window.setTimeout(() => {
    const control = $('#creditControl');
    if (!control?.matches(':hover') && !control?.matches(':focus-within')) setCreditPopoverOpen(false);
  }, 160);
}
function closeCreditPurchase() {
  const dialog = $('#creditPurchaseDialog');
  if (dialog?.open) dialog.close();
  if (dialog) dialog.hidden = true;
  setCreditPopoverOpen(false);
}
function closePaymentSuccess() {
  const dialog = $('#paymentSuccessDialog');
  if (dialog?.open) dialog.close();
  if (dialog) dialog.hidden = true;
}
function showPaymentSuccess(credits, balance) {
  const purchaseDialog = $('#creditPurchaseDialog');
  if (purchaseDialog?.open) {
    state.creditPurchaseRestoreFocus = null;
    purchaseDialog.close();
    purchaseDialog.hidden = true;
  }
  const dialog = $('#paymentSuccessDialog');
  if (!dialog) return;
  $('#paymentSuccessCredits').textContent = `${creditText(credits)} 积分已到账`;
  $('#paymentSuccessBalance').textContent = creditText(balance);
  dialog.hidden = false;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('#closePaymentSuccess').focus());
}
function closeCreditDetail() {
  const dialog = $('#creditDetailDialog');
  if (dialog?.open) dialog.close();
  if (dialog) dialog.hidden = true;
  setCreditPopoverOpen(false);
}
async function openCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (!dialog || dialog.open) return;
  state.creditDetailRestoreFocus = document.activeElement;
  setNotificationPanelOpen(false);
  $('#accountMenu').classList.add('hidden');
  setCreditPopoverOpen(false);
  dialog.hidden = false;
  renderCreditDetail();
  dialog.showModal();
  requestAnimationFrame(() => $('#closeCreditDetail').focus());
  await loadCredits();
}
async function openCreditPurchase() {
  const dialog = $('#creditPurchaseDialog'); if (!dialog || dialog.open) return;
  const active = document.activeElement;
  state.creditPurchaseRestoreFocus = active?.closest?.('#creditDetailEntry, #creditDetailPurchase, #creditPopoverPurchase') ? $('#creditBalance') : active;
  setNotificationPanelOpen(false);
  $('#accountMenu').classList.add('hidden');
  if ($('#creditDetailDialog')?.open) { state.creditDetailRestoreFocus = null; $('#creditDetailDialog').close(); $('#creditDetailDialog').hidden = true; }
  setCreditPopoverOpen(false);
  dialog.hidden = false;
  renderCreditPurchase();
  dialog.showModal();
  requestAnimationFrame(() => $('#closeCreditPurchase').focus());
  await loadCredits();
}
const creditControl = $('#creditControl');
ensureCreditPopoverEntry();
creditControl?.addEventListener('mouseenter', () => setCreditPopoverOpen(true));
creditControl?.addEventListener('mouseleave', scheduleCreditPopoverClose);
creditControl?.addEventListener('focusin', () => setCreditPopoverOpen(true));
creditControl?.addEventListener('focusout', scheduleCreditPopoverClose);
$('#creditBalance').onclick = () => { void openCreditPurchase(); };
$('#creditDetailEntry').onclick = () => { void openCreditDetail(); };
$('#creditDetailPurchase').onclick = () => { void openCreditPurchase(); };
$('#creditSpendTab').onclick = () => setCreditDetailTab('spend');
$('#creditEarnTab').onclick = () => setCreditDetailTab('earn');
$$('[data-alipay-credits]').forEach(button => { button.onclick = () => { state.alipayTopupCredits = Number(button.dataset.alipayCredits); setAlipayStatus(); renderCreditPurchase(); }; });
$('#alipayTopupButton').onclick = () => { void startAlipayTopup(); };
$('#alipayRefreshPayment').onclick = () => { void refreshAlipayPayment(); };
$('#closeCreditPurchase').onclick = () => closeCreditPurchase();
$('#creditPurchaseDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeCreditPurchase(); });
$('#creditPurchaseDialog').addEventListener('cancel', event => { event.preventDefault(); closeCreditPurchase(); });
$('#creditPurchaseDialog').addEventListener('close', () => { $('#creditPurchaseDialog').hidden = true; const restore = state.creditPurchaseRestoreFocus; state.creditPurchaseRestoreFocus = null; requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); }); });
$('#closePaymentSuccess').onclick = () => closePaymentSuccess();
$('#paymentSuccessDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closePaymentSuccess(); });
$('#paymentSuccessDialog').addEventListener('cancel', event => { event.preventDefault(); closePaymentSuccess(); });
$('#paymentSuccessDialog').addEventListener('close', () => { $('#paymentSuccessDialog').hidden = true; });
$('#creditDetailDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeCreditDetail(); });
$('#creditDetailDialog').addEventListener('cancel', event => { event.preventDefault(); closeCreditDetail(); });
$('#creditDetailDialog').addEventListener('close', () => { $('#creditDetailDialog').hidden = true; const restore = state.creditDetailRestoreFocus; state.creditDetailRestoreFocus = null; requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); }); });
$('#closeCreditDetail').onclick = () => closeCreditDetail();
document.addEventListener('pointerdown', event => { if (!creditControl?.contains(event.target)) setCreditPopoverOpen(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#creditPurchaseDialog')?.open && !$('#creditDetailDialog')?.open) setCreditPopoverOpen(false); });
function setDesktopSurface(surface) {
  const desktop = Boolean(window.guguDesktop);
  document.body.classList.toggle('desktop-app-visible', desktop && surface === 'app');
  toggleClass($('#desktopDragRegion'), 'hidden', !desktop || surface === 'app');
}
function updateWindowState(maximized) {
  const button = $('#windowMaximize');
  const isMaximized = Boolean(maximized);
  toggleClass(button?.querySelector('.maximize-icon'), 'hidden', isMaximized);
  toggleClass(button?.querySelector('.restore-icon'), 'hidden', !isMaximized);
  button?.setAttribute('aria-label', isMaximized ? '还原窗口' : '最大化窗口');
  if (button) button.title = isMaximized ? '还原' : '最大化';
}
function updateFullscreenState(state) {
  const payload = state && typeof state === 'object' ? state : { fullscreen: state };
  // The mark only appears once macOS settled the window frame, so it never
  // fades in on top of an animating titlebar.
  const settledFullscreen = Boolean(payload.fullscreen) && !payload.transitioning;
  document.body.classList.toggle('desktop-fullscreen', settledFullscreen);
}
function closeDesktopUpdateDialog({ dismiss = false } = {}) {
  const dialog = $('#desktopUpdateDialog');
  if (!dialog) return;
  if (dismiss) desktopUpdateDialogDismissed = true;
  if (dialog.open) dialog.close();
  else dialog.hidden = true;
}
function openDesktopUpdateDialog() {
  const dialog = $('#desktopUpdateDialog');
  if (desktopUpdateDialogDismissed || !dialog || !['available', 'downloading', 'downloaded', 'installing', 'error'].includes(desktopUpdateState.status)) return;
  dialog.hidden = false;
  if (!dialog.open) dialog.showModal();
}
function renderDesktopUpdateDialog(payload, { open = false } = {}) {
  const dialog = $('#desktopUpdateDialog');
  if (!dialog) return;
  desktopUpdateState = { ...desktopUpdateState, ...(payload || {}) };
  const status = desktopUpdateState.status;
  const currentVersion = desktopUpdateState.currentVersion || '—';
  const version = desktopUpdateState.version || '新版本';
  const title = $('#desktopUpdateTitle');
  const message = $('#desktopUpdateMessage');
  const current = $('#desktopUpdateCurrentVersion');
  const next = $('#desktopUpdateVersion');
  const progressWrap = $('#desktopUpdateProgressWrap');
  const progress = $('#desktopUpdateProgress');
  const hint = $('#desktopUpdateHint');
  const action = $('#desktopUpdateAction');
  const later = $('#laterDesktopUpdate');
  if (!title || !message || !current || !next || !progressWrap || !progress || !hint || !action || !later) return;
  const setProgressLabel = text => progressWrap.setAttribute('aria-label', text);
  current.textContent = currentVersion;
  next.textContent = version;
  dialog.classList.toggle('update-ready', status === 'downloaded');
  dialog.classList.toggle('update-error', status === 'error');
  progress.classList.remove('is-indeterminate');
  progressWrap.classList.remove('hidden');
  later.disabled = status === 'installing';
  if (status === 'available') {
    title.textContent = '发现新版本';
    message.textContent = `GuGu AI ${version} 可更新。`;
    progress.style.width = '0%';
    progress.classList.add('is-indeterminate');
    setProgressLabel('准备下载…');
    hint.textContent = '下载完成后可重启更新。';
    action.textContent = '准备下载…';
    action.disabled = true;
  } else if (status === 'downloading') {
    const percent = Number(desktopUpdateState.percent);
    const hasProgress = Number.isFinite(percent) && percent >= 0;
    title.textContent = '正在下载更新';
    message.textContent = `GuGu AI ${version} 正在下载。`;
    progress.style.width = `${Math.max(0, Math.min(100, hasProgress ? percent : 0))}%`;
    if (!hasProgress) progress.classList.add('is-indeterminate');
    setProgressLabel(hasProgress ? `${Math.round(percent)}% · 正在下载` : '正在下载…');
    hint.textContent = '下载完成后可重启更新。';
    action.textContent = '正在下载…';
    action.disabled = true;
  } else if (status === 'downloaded') {
    title.textContent = '下载已完成';
    message.textContent = `GuGu AI ${version} 已下载。`;
    progress.style.width = '100%';
    setProgressLabel('下载完成');
    hint.textContent = '重启后立即应用。';
    action.textContent = '重启更新';
    action.disabled = false;
  } else if (status === 'installing') {
    title.textContent = '正在退出客户端';
    message.textContent = `GuGu AI ${version} 正在安装。`;
    progress.style.width = '100%';
    setProgressLabel('正在退出…');
    hint.textContent = '请稍候。';
    action.textContent = '正在退出…';
    action.disabled = true;
  } else if (status === 'error') {
    title.textContent = '更新暂不可用';
    message.textContent = desktopUpdateState.message || '更新下载失败，请稍后重试。';
    progressWrap.classList.add('hidden');
    hint.textContent = '可以稍后再次检查更新。';
    action.textContent = '重新检查';
    action.disabled = false;
  }
  if (open && ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(status)) openDesktopUpdateDialog();
}
function initDesktopUpdateDialog(bridge) {
  const dialog = $('#desktopUpdateDialog');
  if (!dialog || !bridge?.updates || dialog.dataset.bound === 'true') return;
  const close = () => closeDesktopUpdateDialog({ dismiss: true });
  const snooze = async () => {
    // Hide immediately even if the IPC round trip is slow. The main process
    // also keeps this state so a renderer reload cannot bring the reminder
    // back during the same client session.
    desktopUpdateReminderSnoozed = true;
    desktopUpdateState = { ...desktopUpdateState, snoozed: true };
    const updateButton = $('#desktopUpdateButton');
    updateButton?.classList.add('hidden');
    updateButton?.classList.remove('has-update');
    closeDesktopUpdateDialog({ dismiss: true });
    try { await bridge.updates.snooze?.(); }
    catch (error) { console.warn('[desktop] 稍后提醒状态保存失败', error); }
  };
  $('#closeDesktopUpdate').onclick = close;
  $('#laterDesktopUpdate').onclick = () => void snooze();
  $('#desktopUpdateAction').onclick = async () => {
    if (desktopUpdateState.status === 'error') {
      close();
      try { await bridge.updates.check(); } catch (error) { console.warn('[desktop] 重新检查更新失败', error); }
      return;
    }
    if (desktopUpdateState.status !== 'downloaded') return;
    const action = $('#desktopUpdateAction');
    action.disabled = true;
    renderDesktopUpdateDialog({ status: 'installing', version: desktopUpdateState.version });
    try {
      const started = await bridge.updates.install();
      if (!started) throw new Error('更新安装包尚未准备好，请稍后再试');
    } catch (error) {
      action.disabled = false;
      renderDesktopUpdateDialog({ status: 'error', message: error.message, version: desktopUpdateState.version }, { open: true });
    }
  };
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.hidden = true; });
  dialog.dataset.bound = 'true';
}
function initWindowControls(bridge, info = {}) {
  const controls = $('#desktopWindowControls');
  const windowApi = bridge?.window;
  if (!windowApi) return;
  // Windows uses Electron's native Window Controls Overlay. Keep the HTML
  // controls only for platforms that still need the custom fallback.
  const custom = Boolean(info.platform) && info.platform !== 'darwin' && info.nativeWindowControls !== true;
  desktopWindowStateUnsubscribe?.();
  desktopWindowStateUnsubscribe = null;
  toggleClass(controls, 'hidden', !custom);
  const safeAction = action => Promise.resolve().then(action).catch(error => console.warn('[desktop] 窗口操作失败', error));
  if (custom && controls?.dataset.bound !== 'true') {
    $('#windowMinimize').onclick = () => void safeAction(() => windowApi.minimize());
    $('#windowMaximize').onclick = () => void safeAction(() => windowApi.toggleMaximize());
    $('#windowClose').onclick = () => void safeAction(() => windowApi.close());
    controls.dataset.bound = 'true';
  }
  desktopWindowStateUnsubscribe = typeof windowApi.onState === 'function' ? windowApi.onState(payload => {
    updateWindowState(payload?.maximized);
    updateFullscreenState(payload);
  }) : null;
  Promise.resolve(windowApi.isMaximized?.()).then(updateWindowState).catch(() => updateWindowState(false));
  Promise.resolve(windowApi.isFullScreen?.()).then(updateFullscreenState).catch(() => updateFullscreenState(false));
  const topbar = $('.topbar');
  if (topbar && topbar.dataset.windowDragBound !== 'true') {
    topbar.addEventListener('dblclick', event => {
      const target = event.target;
      if (target?.closest?.('button, a, input, textarea, select, [contenteditable="true"], .top-actions, .drama-steps, .account-menu')) return;
      void safeAction(() => windowApi.toggleMaximize());
    });
    topbar.dataset.windowDragBound = 'true';
  }
}
function initDesktopModalState(bridge) {
  const setModalState = bridge?.window?.setModalState;
  if (typeof setModalState !== 'function' || document.body.dataset.desktopModalStateBound === 'true') return;
  let queuedFrame = 0;
  let active = false;
  const sync = () => {
    queuedFrame = 0;
    const next = Boolean(document.querySelector('dialog[open]'));
    if (next === active) return;
    active = next;
    void Promise.resolve(setModalState(active)).catch(error => console.warn('[desktop] 弹窗标题栏状态同步失败', error));
  };
  const queueSync = () => {
    if (queuedFrame) return;
    queuedFrame = window.requestAnimationFrame(sync);
  };
  const observer = new MutationObserver(queueSync);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.body.dataset.desktopModalStateBound = 'true';
  sync();
}
function setBootProgress(progress, label = '', { indeterminate = false } = {}) {
  const progressWrap = $('#bootProgress');
  const track = $('#bootProgressTrack');
  const fill = $('#bootProgressFill');
  const value = $('#bootProgressValue');
  const labelElement = $('#bootProgressLabel');
  if (!progressWrap || !track || !fill || !value || !labelElement) return;
  const next = Math.max(0, Math.min(100, Number(progress) || 0));
  progressWrap.classList.remove('hidden');
  progressWrap.classList.toggle('is-indeterminate', indeterminate);
  fill.style.width = indeterminate ? '42%' : `${next}%`;
  labelElement.textContent = label || '正在处理';
  value.textContent = indeterminate ? '进行中' : `${Math.round(next)}%`;
  track.setAttribute('aria-valuetext', indeterminate ? labelElement.textContent : `${Math.round(next)}% · ${labelElement.textContent}`);
  if (indeterminate) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', String(Math.round(next)));
}
function hideBootProgress() {
  const progressWrap = $('#bootProgress');
  const track = $('#bootProgressTrack');
  if (!progressWrap || !track) return;
  progressWrap.classList.add('hidden');
  progressWrap.classList.remove('is-indeterminate');
  track.setAttribute('aria-valuenow', '0');
}
function updateBootCopy(title, message) {
  if (title !== undefined) $('#bootTitle').textContent = title;
  if (message !== undefined) $('#bootMessage').textContent = message;
}
function showBoot(title = '正在连接服务…', message = '', { retry = false, progress = null, progressLabel = '' } = {}) {
  setDesktopSurface('boot');
  updateBootCopy(title, message);
  if (Number.isFinite(progress)) setBootProgress(progress, progressLabel);
  else hideBootProgress();
  toggleClass($('#bootRetry'), 'hidden', !retry);
  toggleClass($('#bootView'), 'hidden', false);
  toggleClass($('#authView'), 'hidden', true);
  toggleClass($('#appView'), 'hidden', true);
}
function clearDesktopAccountState() {
  tasksRequest = null;
  state.alipayOrderNo = '';
  stopAlipayPaymentPolling();
  clearTransientFailures();
  taskPoller.stop();
  mediaController.reset();
  state.files = [];
  state.tasks = [];
  state.generationPreparations = [];
  state.refs = { image:[], video:[] };
  state.imagePromptMentions = [];
  state.videoPromptMentions = [];
  state.uploadJobs.splice(0).forEach(job => {
    if (job.revokePreview && job.previewUrl) URL.revokeObjectURL(job.previewUrl);
  });
  dramaController?.resetForAccount?.();
  resetAccountState(state);
  desktopSyncInfo = { deviceId:'', workspaceId:'', cursor:'', accountId:'' };
  desktopWorkspacePath = '';
  cancelRouteContentRender();
  recordIndexes.invalidateAll();
  lastTaskRender = { route:'', tab:'', ready:null, tasks:null, preparations:null, files:null };
}
const accountLifecycle = createAccountLifecycle({
  advanceScope:accountScope.advance,
  onInvalidate:epoch => { desktopAccountEpoch = epoch; },
  resetState:clearDesktopAccountState,
});
function resetDesktopAccountState() { accountLifecycle.reset(); }
async function activateDesktopAccount(user) {
  const bridge = window.guguDesktop;
  if (!bridge?.workspace?.activateAccount || !user?.id) throw new Error('客户端账号工作区尚未就绪');
  const info = await accountLifecycle.activate(user, account => bridge.workspace.activateAccount(String(account.id)));
  if (!info) throw Object.assign(new Error('账号切换已取消'), { stale:true });
  desktopWorkspacePath = String(info.path || '');
  // Keep the workspace path out of the native `title` tooltip. The button sits
  // in the page chrome, and a long native tooltip can appear to belong to the
  // adjacent works area while the pointer is resting there.
  $$('[data-workspace-open]').forEach(button => { button.removeAttribute('title'); });
  desktopSyncInfo = {
    deviceId: String(info.deviceId || desktopSyncInfo.deviceId || ''),
    workspaceId: String(info.workspaceId || desktopSyncInfo.workspaceId || ''),
    cursor: String(info.cursor || ''),
    accountId: String(info.accountId || user.id),
  };
  return info;
}
async function initDesktopBridge() {
  const bridge = window.guguDesktop;
  const buttons = $$('[data-workspace-open]');
  if (!bridge) {
    toggleClass($('#desktopWindowControls'), 'hidden', true);
    return false;
  }
  document.body.classList.add('desktop-runtime');
  initWindowControls(bridge);
  try {
    const info = await bridge.getInfo();
    desktopSyncInfo = {
      deviceId: String(info.deviceId || ''),
      workspaceId: String(info.workspaceId || ''),
      cursor: String(info.assetSyncCursor || ''),
      accountId: String(info.workspaceAccountId || ''),
    };
    desktopWorkspacePath = String(info.workspacePath || '');
    if (!desktopSyncInfo.deviceId && bridge.sync?.getState) desktopSyncInfo = { ...desktopSyncInfo, ...(await bridge.sync.getState()) };
    desktopClientInfo = info;
    document.body.classList.add(`desktop-${info.platform}`);
    initWindowControls(bridge, info);
    initDesktopModalState(bridge);
    initDesktopUpdateDialog(bridge);
    supportLogController.init(bridge);
    supportLogController.initRendererLogForwarding(bridge);
    buttons.forEach(button => {
      button.classList.remove('hidden');
      button.removeAttribute('title');
      button.onclick = async () => {
        try {
          const opened = await bridge.workspace.open();
          if (!opened) toast('本地工作区尚未初始化');
        } catch (error) {
          toast(`打开本地工作区失败：${error.message}`);
        }
      };
    });
    const updateButton = $('#desktopUpdateButton');
    if (updateButton && bridge.updates && info.updateUrl) {
      const updateLabel = updateButton.querySelector('.rail-update-label') || updateButton.querySelector('span') || updateButton;
      const setUpdateLabel = text => { updateLabel.textContent = text; };
      const setUpdateTitle = text => { updateButton.title = text; };
      const setUpdateState = state => { if (state) updateButton.dataset.updateState = state; else delete updateButton.dataset.updateState; };
      const hideUpdateButton = () => {
        updateButton.classList.add('hidden');
        updateButton.classList.remove('has-update');
        updateButton.disabled = false;
      };
      const showUpdateButton = () => {
        updateButton.classList.remove('hidden');
        updateButton.classList.add('has-update');
      };
      hideUpdateButton();
      const applyUpdateStatus = payload => {
        const status = payload?.status;
        desktopUpdateState = { ...desktopUpdateState, ...(payload || {}) };
        if (desktopUpdateReminderSnoozed || payload?.snoozed) {
          desktopUpdateReminderSnoozed = true;
          hideUpdateButton();
          closeDesktopUpdateDialog();
          return;
        }
        const shouldPrompt = payload?.promptOnStartup === true || payload?.promptOnOpen === true;
        if (payload?.promptOnOpen) desktopUpdateDialogDismissed = false;
        if (status === 'unconfigured' || status === 'current' || status === 'idle') { hideUpdateButton(); closeDesktopUpdateDialog(); return; }
        if (status === 'checking') {
          if (payload?.promptOnStartup) desktopUpdateDialogDismissed = false;
          hideUpdateButton(); closeDesktopUpdateDialog(); setUpdateLabel('检查更新…'); setUpdateTitle('正在检查更新'); updateButton.disabled = true; return;
        }
        // The first automatic check is part of the launch experience. Any
        // update found after that is intentionally silent; the bottom-left
        // control appears only after the download is complete.
        if (status === 'available' || status === 'downloading') {
          if (shouldPrompt) showUpdateButton();
          else hideUpdateButton();
        } else {
          showUpdateButton();
        }
        renderDesktopUpdateDialog(payload, { open: shouldPrompt });
        if (status === 'available') { setUpdateState('available'); setUpdateLabel('有新版本'); setUpdateTitle(`下载 GuGu AI ${payload.version || '新版本'}`); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
        else if (status === 'downloading') { setUpdateState('downloading'); setUpdateLabel(`${Math.round(Number(payload.percent) || 0)}%`); setUpdateTitle('正在下载更新'); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
        else if (status === 'downloaded') { setUpdateState('downloaded'); setUpdateLabel('重启更新'); setUpdateTitle('重启客户端并安装更新'); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
        else if (status === 'installing') { setUpdateState('installing'); setUpdateLabel('更新中'); setUpdateTitle('正在安装更新'); updateButton.disabled = true; }
        else if (status === 'error') { setUpdateState('error'); setUpdateLabel('重试'); setUpdateTitle('更新暂不可用'); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
      };
      desktopUpdateUnsubscribe?.();
      desktopUpdateUnsubscribe = bridge.updates.onStatus(applyUpdateStatus);
      Promise.resolve(bridge.updates.getStatus?.()).then(payload => {
        if (payload?.status && payload.status !== 'idle') applyUpdateStatus(payload);
      }).catch(() => {});
    }
    return true;
  } catch (error) {
    buttons.forEach(button => { button.title = `本地工作区不可用：${error.message}`; });
    return false;
  }
}
function showAuth() {
  setDesktopSurface('auth');
  resetDesktopAccountState();
  void Promise.resolve(window.guguDesktop?.workspace?.deactivateAccount?.()).catch(error => console.warn('[desktop] 关闭账号工作区失败', error));
  state.user = null;
  toggleClass($('#bootView'), 'hidden', true);
  toggleClass($('#authView'), 'hidden', false);
  toggleClass($('#appView'), 'hidden', true);
  setAuthMode('sms');
  setupIntroCardInteraction();
  document.title = '登录 · GuGu AI';
}
function showApp() {
  setDesktopSurface('app');
  toggleClass($('#bootView'), 'hidden', true);
  toggleClass($('#authView'), 'hidden', true);
  toggleClass($('#appView'), 'hidden', false);
}
function loginReturnDestination() {
  if (window.location.pathname !== authPath) return '';
  const value = new URLSearchParams(window.location.search).get('next');
  if (!value) return '';
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname !== '/pricing') return '';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return ''; }
}
function accountDisplayName(user = state.user) {
  return String(user?.nickname || user?.displayName || user?.username || 'user');
}
function accountUuid(user = state.user) {
  return String(user?.id || user?.uuid || user?.userId || '').trim();
}
function ensureAccountMenuProfile() {
  const menu = $('#accountMenu');
  const profile = menu?.querySelector('.account-profile');
  if (!menu || !profile) return null;
  const copy = profile.querySelector('p');
  if (copy) copy.className = 'account-profile-copy';
  const legacyMeta = $('#menuAccountMeta');
  legacyMeta?.remove();
  menu.querySelector('.account-credit-row')?.remove();
  if (!profile.querySelector('#copyAccountUuid')) {
    const button = document.createElement('button');
    button.id = 'copyAccountUuid';
    button.className = 'account-uuid';
    button.type = 'button';
    button.title = '复制 UUID';
    button.setAttribute('aria-label', '复制 UUID');
    button.innerHTML = '<span>UUID</span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
    button.onclick = event => { event.stopPropagation(); void copyAccountUuid(); };
    copy?.append(button);
  }
  return profile;
}
async function copyAccountUuid() {
  const uuid = accountUuid();
  if (!uuid) return toast('暂无可复制的 UUID');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(uuid);
    else if (!copyTextFallback(uuid)) throw new Error('copy failed');
    toast('UUID 已复制');
  } catch {
    toast('复制失败，请手动重试');
  }
}
function updateAccountIdentity(user = state.user) {
  const displayName = accountDisplayName(user);
  const phone = String(user?.phoneNumber || '').replace(/\D/g, '');
  const initial = phone.length >= 3 ? phone.slice(0, 3) : Array.from(displayName)[0]?.toUpperCase() || 'U';
  $('#accountName').textContent = displayName;
  $('#menuName').textContent = displayName;
  $('#accountInitial').textContent = initial;
  $('#menuInitial').textContent = initial;
  $('#accountButton')?.setAttribute('aria-label', `打开${displayName}的用户菜单`);
  ensureAccountMenuProfile();
}
function finishInitialWorkspaceSync() {
  state.initialSyncReady = true;
  scheduleRouteContentRender(state.route, false);
}
async function enterApp(user) {
  const returnDestination = loginReturnDestination();
  if (returnDestination) {
    window.location.replace(returnDestination);
    return;
  }
  await activateDesktopAccount(user);
  state.user = user;
  const startupRequest = accountLifecycle.snapshot();
  const isStartupCurrent = () => accountLifecycle.isCurrent(startupRequest);
  state.alipayOrderNo = sessionStorage.getItem(alipayOrderStorageKey(user)) || '';
  state.initialSyncReady = false;
  showBoot('正在加载工作区', '正在读取本地素材与生成记录，请稍候。', { progress:8, progressLabel:'准备本地工作区' });
  updateAccountIdentity(user);
  setCreditBalance(user.credits);

  // The desktop workspace is local-only. Do not block startup on a cloud
  // history scan or attempt to hydrate files created on another device.
  try {
    await claimLegacyWorkspace(user);
    if (!isStartupCurrent()) return;
  } catch (error) {
    if (!isStartupCurrent()) return;
    // A temporary API failure must not prevent the local editor from opening;
    // the claim is retried on the next startup until it succeeds.
    console.warn('[desktop] 老版本本地记录归属迁移暂不可用', error.message);
  }
  if (!isStartupCurrent()) return;
  navigate(routeFromPath(window.location.pathname), { historyMode:'replace' });
  const schedulePriceDialog = () => window.setTimeout(() => { if (isStartupCurrent()) void openModelPriceDialog({ auto:true }); }, 300);
  const initialLoadSteps = [
    { label:'读取创作配置', run:loadConfig },
    { label:'读取积分信息', run:loadCredits },
    { label:'读取消息通知', run:loadNotifications },
    { label:'读取本地文件', run:loadFiles },
    { label:'读取生成记录', run:loadTasks },
  ];
  let completedLoadSteps = 0;
  updateBootCopy('正在加载工作区', '正在准备创作数据，请稍候。');
  await Promise.all(initialLoadSteps.map(async step => {
    if (!isStartupCurrent()) return;
    await step.run();
    if (!isStartupCurrent()) return;
    completedLoadSteps += 1;
    const progress = 8 + ((100 - 8) * completedLoadSteps / initialLoadSteps.length);
    setBootProgress(progress, completedLoadSteps === initialLoadSteps.length ? '工作区即将打开' : step.label);
    updateBootCopy('正在加载工作区', `已准备 ${completedLoadSteps} / ${initialLoadSteps.length} 项创作数据。`);
  }));
  if (!isStartupCurrent()) return;
  finishInitialWorkspaceSync();
  setBootProgress(100, '工作区已准备好');
  showApp();
  void syncDesktopDeliveries().catch(error => console.warn('[desktop] 启动时同步本地投递确认失败', error.message));
  schedulePriceDialog();
  // The price catalog is non-essential for the first interaction. It is
  // deferred until the initial background sync settles so it cannot compete
  // with the first page render or duplicate the config request.
}

let accountSettingsRestoreFocus = null;
function accountSettingsError(message = '') {
  const error = $('#accountSettingsError');
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}
function maskedPhoneNumber(phone) {
  const value = String(phone || '');
  return /^1[3-9]\d{9}$/.test(value) ? `${value.slice(0, 3)} ${value.slice(3, 7)} ${value.slice(7)}` : '未绑定手机号';
}
function openAccountSettings() {
  const dialog = $('#accountSettingsDialog');
  if (!dialog || dialog.open || !state.user) return;
  accountSettingsRestoreFocus = $('#accountButton');
  setNotificationPanelOpen(false);
  $('#accountMenu').classList.add('hidden');
  $('#accountPhone').value = maskedPhoneNumber(state.user.phoneNumber);
  $('#accountNickname').value = state.user.nickname || '';
  $('#accountNewPassword').value = '';
  $('#accountPasswordConfirm').value = '';
  accountSettingsError();
  $('#saveAccountSettings').disabled = false;
  dialog.showModal();
  requestAnimationFrame(() => $('#accountNickname').focus());
}
function closeAccountSettings() {
  const dialog = $('#accountSettingsDialog');
  if (dialog?.open) dialog.close();
}
$('#accountSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const nickname = $('#accountNickname').value.trim();
  const password = $('#accountNewPassword').value;
  const confirmation = $('#accountPasswordConfirm').value;
  accountSettingsError();
  if (nickname && !/^[\p{L}\p{N}_-]{2,24}$/u.test(nickname)) {
    accountSettingsError('昵称需为 2–24 位中文、字母、数字、下划线或短横线');
    $('#accountNickname').focus();
    return;
  }
  if (password && (password.length < 8 || password.length > 128)) {
    accountSettingsError('密码长度需为 8–128 位');
    $('#accountNewPassword').focus();
    return;
  }
  if (password !== confirmation) {
    accountSettingsError('两次输入的密码不一致');
    $('#accountPasswordConfirm').focus();
    return;
  }
  const button = $('#saveAccountSettings');
  button.disabled = true;
  try {
    const payload = { nickname };
    if (password) payload.password = password;
    const result = await api('/api/auth/profile', { method:'PATCH', body:JSON.stringify(payload) });
    state.user = result.user;
    updateAccountIdentity(result.user);
    closeAccountSettings();
    toast('账号设置已保存');
  } catch (error) {
    accountSettingsError(error.message);
    button.disabled = false;
  }
});
$('#closeAccountSettings').onclick = $('#cancelAccountSettings').onclick = closeAccountSettings;
$('#accountSettingsDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeAccountSettings(); });
$('#accountSettingsDialog').addEventListener('cancel', event => { event.preventDefault(); closeAccountSettings(); });
$('#accountSettingsDialog').addEventListener('close', () => {
  const restore = accountSettingsRestoreFocus;
  accountSettingsRestoreFocus = null;
  accountSettingsError();
  requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); });
});

let deleteConfirmationResolver = null;
let deleteConfirmationRestoreFocus = null;
function settleDeleteConfirmation(confirmed) { const resolver = deleteConfirmationResolver; const restoreFocus = deleteConfirmationRestoreFocus; deleteConfirmationResolver = null; deleteConfirmationRestoreFocus = null; const dialog = $('#deleteConfirmDialog'); if (dialog.open) dialog.close(); resolver?.(confirmed); requestAnimationFrame(() => { if (restoreFocus?.isConnected && !restoreFocus.disabled) restoreFocus.focus(); }); }
function confirmAction({ kicker = '危险操作', title = '确认操作', message = '操作后无法恢复。', confirmLabel = '确认' } = {}) { if (deleteConfirmationResolver) settleDeleteConfirmation(false); const dialog = $('#deleteConfirmDialog'); deleteConfirmationRestoreFocus = document.activeElement; $('#deleteConfirmKicker').textContent = kicker; $('#deleteConfirmTitle').textContent = title; $('#deleteConfirmMessage').textContent = message; $('#acceptDeleteConfirm').textContent = confirmLabel; return new Promise(resolve => { deleteConfirmationResolver = resolve; dialog.showModal(); requestAnimationFrame(() => $('#acceptDeleteConfirm').focus()); }); }
function confirmDelete({ title = '确认删除', message = '删除后无法恢复。' } = {}) { return confirmAction({ kicker:'危险操作', title, message, confirmLabel:'确认删除' }); }
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
  try {
    if (!window.guguDesktop?.media?.renameLocal) throw new Error('桌面文件能力尚未就绪，请重启客户端后再试');
    await window.guguDesktop.media.renameLocal({ assetId:file.localId || file.id, name });
    file.name = name.trim();
    recordIndexes.invalidateFiles();
    closeRenameFileDialog(); toast('文件名已保存'); await loadFiles();
  }
  catch (error) { renameFileError(error.message); button.disabled = false; }
});
$('#closeRenameFile').onclick = $('#cancelRenameFile').onclick = closeRenameFileDialog;
$('#renameFileDialog').addEventListener('cancel', event => { event.preventDefault(); closeRenameFileDialog(); });
$('#renameFileDialog').addEventListener('close', () => { const restore = renameFileRestoreFocus; renameFileId = ''; renameFileRestoreFocus = null; renameFileError(); requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); }); });

let dramaController = null;
let dramaControllerPromise = null;
function ensureDramaController() {
  if (dramaController) return Promise.resolve(dramaController);
  if (!dramaControllerPromise) {
    dramaControllerPromise = import('./drama-studio.js?v=89').then(({ createDramaStudio }) => {
      dramaController = createDramaStudio({ api, state, esc, toast, setCreditBalance, creditText, loadTasks, scheduleTaskPoll, loadCredits, loadFiles, uploadImage:pickAndUploadDramaImage, uploadAsset:pickAndUploadDramaAsset, confirmDelete, taskFailure, isAssetSyncing:isDesktopAssetSyncing, localDeliveryMarkup:desktopSyncMarkup, localDeliverySignature:id => JSON.stringify(mediaController.downloadState(id)), retryLocalDownload:id => mediaController.retryDownload(id), showAssetInFolder:showDesktopAssetInFolder, removeCloudAssets:removeDesktopCloudAssets, accountSnapshot:accountScope.snapshot, isAccountCurrent:accountScope.isCurrent });
      return dramaController;
    });
  }
  return dramaControllerPromise;
}

function renderRouteLoadingShell(route) {
  if (route === 'files') {
    const library = mediaController.libraryState();
    const count = library.files.length ? `${library.total} 个文件` : '正在加载…';
    $('#fileCount').textContent = count;
    const grid = $('#fileGrid');
    if (grid) grid.innerHTML = fileLibraryLoadingSkeleton();
    $('#loadMoreFiles')?.classList.add('hidden');
    return;
  }
  if (['image', 'video'].includes(route)) {
    lastTaskRender = { route:'', tab:'', ready:null, tasks:null, preparations:null, files:null };
    syncGenerationTab();
    if (state.generationTab === 'history') {
      const history = $('#generationHistory');
      if (history) history.innerHTML = generationHistoryLoadingSkeleton();
      $('#loadMoreGenerationHistory')?.classList.add('hidden');
    } else {
      const grid = $('#generationGrid');
      if (grid) grid.innerHTML = generationLoadingSkeleton();
    }
    return;
  }
  if (route === 'drama') {
    const projects = $('#dramaProjects');
    if (projects && !projects.children.length) projects.innerHTML = dramaProjectsLoadingSkeleton();
  }
}

function cancelRouteContentRender() {
  if (routeRenderFrame) cancelAnimationFrame(routeRenderFrame);
  if (routeRenderTimer) window.clearTimeout(routeRenderTimer);
  routeRenderFrame = 0;
  routeRenderTimer = 0;
  routeRenderEpoch += 1;
}
function scheduleRouteContentRender(route, routeChanged) {
  cancelRouteContentRender();
  const epoch = routeRenderEpoch;
  // Let the route shell paint first. The second task is intentional: doing the
  // heavy card/media render directly inside requestAnimationFrame would still
  // delay the first frame after a navigation click.
  routeRenderFrame = requestAnimationFrame(() => {
    routeRenderFrame = 0;
    routeRenderTimer = window.setTimeout(() => {
      routeRenderTimer = 0;
      if (epoch !== routeRenderEpoch || state.route !== route) return;
      if (route === 'files') {
        renderFiles();
        return;
      }
      if (route === 'drama') {
        void ensureDramaController().then(controller => {
          if (epoch !== routeRenderEpoch || state.route !== 'drama') return;
          controller.modelState();
          return controller.load();
        }).catch(error => toast(`短剧模块加载失败：${error.message}`));
        return;
      }
      renderTasks();
      if (state.generationTab === 'history') void loadGenerationHistory({ reset:routeChanged });
    }, 0);
  });
}
function navigate(route, { historyMode = 'push' } = {}) {
  const nextRoute = routePaths[route] ? route : 'image';
  const routeChanged = state.route !== nextRoute;
  if (state.route === 'drama' && nextRoute !== 'drama') dramaController?.suspend?.();
  if (historyMode !== 'none' && window.location.pathname !== routePaths[nextRoute]) {
    window.history[historyMode === 'replace' ? 'replaceState' : 'pushState']({ route:nextRoute }, '', routePaths[nextRoute]);
  }
  state.route = nextRoute;
  const routeTitles = { image:'图像生成', video:'视频生成', drama:'短剧创作', files:'文件库' };
  $('#routeTitle').textContent = routeTitles[nextRoute];
  document.title = `${routeTitles[nextRoute]} · GuGu AI`;
  $$('.rail-button[data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === nextRoute));
  const files = nextRoute === 'files';
  const drama = nextRoute === 'drama';
  const wide = files || drama;
  toggleClass($('#appView'), 'library-mode', files);
  toggleClass($('#appView'), 'wide-mode', drama);
  toggleClass($('#appView'), 'drama-project-open', drama && Boolean(state.dramaProject));
  toggleClass($('#appView'), 'drama-professional-open', drama && state.dramaProject?.mode === 'professional');
  toggleClass($('#creatorPanel'), 'hidden', wide);
  toggleClass($('#generationView'), 'hidden', wide);
  toggleClass($('#filesView'), 'hidden', !files);
  toggleClass($('#dramaView'), 'hidden', !drama);
  cancelRouteContentRender();
  if (!wide) {
    $$('[data-panel]').forEach(panel => toggleClass(panel, 'hidden', panel.dataset.panel !== nextRoute));
    renderRouteLoadingShell(nextRoute);
  } else if (files) {
    renderRouteLoadingShell('files');
  } else {
    renderRouteLoadingShell('drama');
  }
  scheduleRouteContentRender(nextRoute, routeChanged);
}
$$('.rail-button[data-route]').forEach(button => button.onclick = () => navigate(button.dataset.route));
window.addEventListener('popstate', () => { if (state.user) navigate(routeFromPath(window.location.pathname), { historyMode:'none' }); });

// The skip link may only surface while the user is genuinely tabbing. Neither
// `:focus` nor `:focus-visible` is trustworthy here: the desktop shell hides the
// window to the tray, and when it is shown again macOS restores the first
// responder, which Chromium reports as a keyboard focus. That repainted the
// panel over the window chrome on every reopen, so keyboard intent is tracked
// explicitly and reset whenever the window stops being the active one.
const setKeyboardNavigating = active => document.body.classList.toggle('keyboard-nav', active);
window.addEventListener('keydown', event => { if (event.key === 'Tab') setKeyboardNavigating(true); }, true);
window.addEventListener('pointerdown', () => setKeyboardNavigating(false), true);
window.addEventListener('blur', () => setKeyboardNavigating(false));
const notificationMenuItem = $('.notification-menu-item');
const notificationMenuButton = $('#notificationMenuButton');
notificationMenuItem?.addEventListener('mouseenter', () => { if (!$('#accountMenu').classList.contains('hidden')) setNotificationPanelOpen(true); });
notificationMenuItem?.addEventListener('mouseleave', () => { if (!notificationMenuItem.matches(':focus-within')) scheduleNotificationPanelClose(); });
notificationMenuItem?.addEventListener('focusin', () => { if (!$('#accountMenu').classList.contains('hidden')) setNotificationPanelOpen(true); });
notificationMenuItem?.addEventListener('focusout', () => requestAnimationFrame(() => { if (!notificationMenuItem.matches(':focus-within') && !notificationMenuItem.matches(':hover')) scheduleNotificationPanelClose(); }));
notificationMenuButton?.addEventListener('click', event => { event.stopPropagation(); setNotificationPanelOpen(true); });
$('#accountSettingsButton').onclick = event => { event.stopPropagation(); openAccountSettings(); };
$('#accountButton').onclick = event => { event.stopPropagation(); const menu = $('#accountMenu'); const opening = menu.classList.contains('hidden'); menu.classList.toggle('hidden', !opening); $('#accountButton').setAttribute('aria-expanded', String(opening)); if (!opening) setNotificationPanelOpen(false); if (opening) renderNotifications(); };
$('#markAllNotifications').onclick = event => { event.stopPropagation(); void markAllNotificationsRead(); };
document.addEventListener('click', event => { if (!$('#accountMenu').contains(event.target) && event.target !== $('#accountButton')) { $('#accountMenu').classList.add('hidden'); setNotificationPanelOpen(false); $('#accountButton').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#accountMenu').classList.contains('hidden')) { $('#accountMenu').classList.add('hidden'); setNotificationPanelOpen(false); $('#accountButton').setAttribute('aria-expanded', 'false'); $('#accountButton').focus(); } });
$('#logoutButton').onclick = async () => {
  if (!await confirmAction({ kicker:'账号操作', title:'确认退出登录', message:'退出后需要重新登录才能继续创作。', confirmLabel:'确认退出' })) return;
  accountLifecycle.invalidate();
  taskPoller.stop();
  try { await api('/api/auth/logout', { method:'POST', body:'{}' }); }
  finally {
    resetDesktopAccountState();
    await Promise.resolve(window.guguDesktop?.workspace?.deactivateAccount?.()).catch(error => console.warn('[desktop] 关闭账号工作区失败', error));
    location.reload();
  }
};
async function loadConfig() {
  const requestAccount = accountScope.snapshot();
  const service = $('#serviceState');
  const updateServiceState = hidden => {
    if (!service) return;
    service.classList.toggle('hidden', hidden);
    service.querySelector('i')?.classList.add('bad');
    const label = service.querySelector('span');
    if (label) label.textContent = '生成服务异常';
  };
  try {
    const config = await api('/api/config');
    if (!accountScope.isCurrent(requestAccount)) return;
    state.config = config;
    if (config.pricing) state.pricing = { ...state.pricing, image: config.pricing.imagePerRequest, videoPerSecond: config.pricing.videoPerSecond };
    syncVideoModelOptions();
    updateServiceState(config.imageGeneration);
    updateDramaModelState();
  } catch {
    if (!accountScope.isCurrent(requestAccount)) return;
    state.config = { videoCapabilities: { models: [] } };
    syncVideoModelOptions();
    updateServiceState(false);
    updateDramaModelState();
  }
}

function updateDramaModelState() { dramaController?.modelState?.(); }

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
  $('#dramaAnalysis').innerHTML = `<nav class="workflow-steps" aria-label="短剧制作进度"><span class="done">01 剧本</span><span class="done">02 分镜</span><span class="active">03 关键帧</span><span class="${completedVideos === shots.length && shots.length ? 'done' : ''}">04 视频</span></nav><header class="storyboard-title"><div><span>DIRECTOR BOARD / ${shots.length} SHOTS</span><h2>${esc(project.title)}</h2><p>每个镜头固定 6 秒。先生成关键帧，确认视觉后再单独预扣视频费用。</p></div><strong>${completedVideos}<small> / ${shots.length} 完片</small></strong></header><div class="shot-list">${shots.map((shot,index) => { const keyframeTask = shotTask(shot,'keyframe'); const videoTask = shotTask(shot,'video'); const keyframe = shotAsset(keyframeTask); const video = shotAsset(videoTask); const media = video ? videoPreviewMarkup(video, 'shot-video-placeholder') : keyframe ? `<img src="${keyframe.url}" alt="${esc(shot.title)}" loading="lazy">` : `<div class="shot-placeholder"><span>${String(index+1).padStart(2,'0')}</span><small>KEYFRAME</small></div>`; return `<article class="shot-card"><div class="shot-media">${media}<span class="shot-duration">6 SEC</span></div><div class="shot-copy"><header><span>SCENE ${String(shot.sceneNumber).padStart(2,'0')} / SHOT ${String(shot.shotNumber).padStart(2,'0')}</span><h3>${esc(shot.title)}</h3></header><div class="shot-meta"><span>${esc(shot.shotSize)}</span><span>${esc(shot.cameraMovement)}</span><span>${esc((shot.characters || []).join('、') || '空镜')}</span></div><p>${esc(shot.action)}</p>${shot.dialogue ? `<blockquote>${esc(shot.dialogue)}</blockquote>` : ''}<details><summary>查看生成提示词</summary><p>${esc(videoTask ? shot.videoPrompt : shot.keyframePrompt)}</p></details><footer>${shotAction(shot,keyframeTask,videoTask)}</footer></div></article>`; }).join('')}</div>`;
  $$('[data-shot-action]').forEach(button => button.onclick = () => button.dataset.shotAction === 'video' ? startShotVideo(button.dataset.shotId, button) : startShotKeyframe(button.dataset.shotId, button));
}

async function bindShotTask(shotId, kind, task) {
  state.tasks = [task, ...state.tasks.filter(item => item.id !== task.id)];
  mergeTasksIntoLoadedHistory(task);
  scheduleTaskPoll();
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

function dramaProjectGenerationIds(project) {
  return new Set([
    ...(project?.resources || []).flatMap(resource => [resource.selectedTaskId, ...(resource.versions || [])]),
    ...(project?.shots || []).flatMap(shot => [
      shot.selectedVideoTaskId,
      ...(shot.videoVersions || []),
      ...(shot.pendingImageGenerations || []).map(item => item?.taskId),
    ]),
    ...(project?.storyboard?.shots || []).flatMap(shot => [shot.keyframeTaskId, shot.videoTaskId]),
  ].map(value => String(value || '')).filter(Boolean));
}

async function loadTasks({ background=false, activeOnly=false, projectOnly=false }={}) {
  if (tasksRequest) {
    const pending = tasksRequest;
    if (background) return projectOnly ? pending.then(() => loadTasks({ background:true, projectOnly:true })) : pending;
    return pending.then(() => loadTasks({ background:true, activeOnly, projectOnly }));
  }
  const requestSnapshot = state.tasks;
  const requestAccount = accountScope.snapshot();
  const activeIds = activeOnly ? activeGenerationIds() : [];
  if (activeOnly && !activeIds.length) return state.tasks;
  const request = (async () => {
    try {
      const projectTaskIds = projectOnly
        ? dramaProjectGenerationIds(state.dramaProject)
        : !activeOnly && state.route === 'drama' ? dramaProjectGenerationIds(state.dramaProject) : new Set();
      const targetedIds = projectOnly ? [...projectTaskIds] : activeIds;
      const responseTasks = activeOnly || projectOnly
        ? (targetedIds.length
          ? (await Promise.all(Array.from({ length:Math.ceil(targetedIds.length / 200) }, (_, index) => api(`/api/generations?ids=${encodeURIComponent(targetedIds.slice(index * 200, index * 200 + 200).join(','))}`)))).flat()
          : [])
          : await api('/api/generations?view=works&limit=200');
      if (!accountScope.isCurrent(requestAccount)) return state.tasks;
      // The global list is ordered/paginated for the gallery. A project must
      // never use that list as the authority for one of its versions: the
      // gallery request can already be in flight when a task reaches terminal
      // failure. Re-read every task referenced by the open drama project by ID
      // and let those records win.
      const projectTaskIdsToHydrate = projectOnly ? [] : [...projectTaskIds];
      const projectTasks = [];
      try {
        for (let index = 0; index < projectTaskIdsToHydrate.length; index += 100) {
          const ids = projectTaskIdsToHydrate.slice(index, index + 100);
          projectTasks.push(...await api(`/api/generations?ids=${encodeURIComponent(ids.join(','))}`));
        }
      } catch (error) {
        if (error.status === 401) throw error;
        console.warn('[tasks] failed to hydrate drama project generations', error);
        const responseTaskIds = new Set(responseTasks.map(task => task.id));
        const hydratedTaskIds = new Set(projectTasks.map(task => task.id));
        // Keep an already-known project task only when the global response did
        // not contain it. Never let a stale in-memory record replace a newer
        // terminal status returned by the gallery request.
        projectTasks.push(...state.tasks.filter(task => projectTaskIds.has(task.id)
          && !responseTaskIds.has(task.id)
          && !hydratedTaskIds.has(task.id)));
      }
      if (!accountScope.isCurrent(requestAccount)) return state.tasks;
      const hydratedTasks = [...responseTasks];
      const hydratedIndexById = new Map(hydratedTasks.map((task, index) => [task.id, index]));
      for (const task of projectTasks) {
        const index = hydratedIndexById.get(task.id);
        if (index === undefined) {
          hydratedIndexById.set(task.id, hydratedTasks.length);
          hydratedTasks.push(task);
        } else {
          hydratedTasks[index] = task;
        }
      }
      // A local submission may finish while this GET is in flight. Do not let
      // its older response erase tasks that are already visible in memory.
      // The works query intentionally omits failures, so keep failures that
      // were observed during this session until their task-local deadline.
      const transientFailures = state.tasks.filter(task => transientFailureVisible(task)
        && !hydratedTasks.some(item => item.id === task.id));
      // A task can change from queued/running to failed while this works
      // request is in flight. Keep the last active snapshot long enough for
      // the task-targeted poll to observe that terminal event; otherwise the
      // works query would remove the ID before the failure can be scheduled.
      const activeTasks = !activeOnly && !projectOnly ? state.tasks.filter(task => ['queued', 'running'].includes(task.status)
        && !hydratedTasks.some(item => item.id === task.id)) : [];
      const tasks = activeOnly || projectOnly
        ? mergeActiveRecords(state.tasks, hydratedTasks, activeOnly ? activeIds : [...projectTaskIds])
        : mergeRecordsAddedDuringRequest(requestSnapshot, state.tasks, [...hydratedTasks, ...transientFailures, ...activeTasks]);
      const previousTasks = new Map(state.tasks.map(task => [task.id, task]));
      for (const task of tasks) observeTaskFailure(task, previousTasks.get(task.id));
      const previousCreditStatus = new Map(state.tasks.map(task => [task.id, task.creditStatus]));
      const refundedTask = tasks.some(task => ['refunded', 'refund_failed'].includes(task.creditStatus) && previousCreditStatus.get(task.id) !== task.creditStatus);
      // updatedAt is useful metadata but is not rendered on a task card. Do
      // not rebuild the gallery merely because the server touched a timestamp
      // during background polling.
      const stateChanged = listSignature(state.tasks, taskSignatureFields) !== listSignature(tasks, taskSignatureFields);
      const cardsChanged = listSignature(state.tasks, taskCardSignatureFields) !== listSignature(tasks, taskCardSignatureFields);
      if (stateChanged) state.tasks = tasks;
      mergeTasksIntoLoadedHistory(tasks);
      if (cardsChanged && $('#previewDialog')?.open && state.previewFileId) {
        const previewFile = fileById(state.previewFileId);
        if (previewFile) renderPreviewMeta(previewFile);
      }
      if (refundedTask) await loadCredits();
      if (!accountScope.isCurrent(requestAccount)) return state.tasks;
      const assetTasks = projectOnly ? hydratedTasks : tasks;
      const missingAssetIds = [...new Set(assetTasks.map(task => task.assetId).filter(assetId => assetId && !state.files.some(file => file.id === assetId)))];
      let assetsChanged = false;
      if (missingAssetIds.length && window.guguDesktop?.media?.listLocalByCloudIds) {
        const localAssets = [];
        for (let index = 0; index < missingAssetIds.length; index += 500) {
          localAssets.push(...(await window.guguDesktop.media.listLocalByCloudIds(missingAssetIds.slice(index, index + 500)))
            .map(desktopLocalClientAsset)
            .filter(Boolean));
        }
        if (!accountScope.isCurrent(requestAccount)) return state.tasks;
        mediaController.mergeLocalAssets(localAssets);
        assetsChanged = localAssets.length > 0;
      }
      if (missingAssetIds.length && window.guguDesktop?.sync && desktopSyncInfo.deviceId && desktopSyncInfo.workspaceId) {
        // A local database row can be gone even though the cloud asset still
        // exists. Ask the delivery endpoint for these exact assets so the
        // normal hydration queue can repair the file instead of leaving a
        // completed task stuck at “视频文件未找到”.
        void syncDesktopDeliveries({ assetIds:missingAssetIds }).catch(error => console.warn('[tasks] failed to re-request missing local assets', error));
      }
      if (state.route === 'drama') {
        if (stateChanged || assetsChanged) dramaController?.refreshTasks?.();
      } else if ((cardsChanged || assetsChanged) && state.initialSyncReady) {
        scheduleRouteContentRender(state.route, false);
      }
      if (state.user && !document.hidden) scheduleTaskPoll();
      return state.tasks;
    } catch (error) {
      if (!accountScope.isCurrent(requestAccount)) return state.tasks;
      if (error.status === 401) return location.reload();
      if (!background) toast(error.message);
      return state.tasks;
    }
  })();
  tasksRequest = request;
  try { return await request; }
  finally { if (tasksRequest === request) tasksRequest = null; }
}
function localFileAction(file, label='打开文件所在文件夹') {
  return `<button class="task-action show-in-folder" type="button" data-asset-id="${esc(file.id)}" data-tooltip="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/><path d="m12 13 3 3m0-3v3h-3"/></svg></button>`;
}
function configureLocalFileAction(link, file) {
  if (!link || !file) return;
  link.onclick = null;
  link.href = '#';
  link.removeAttribute('download');
  link.title = '在文件夹中显示';
  link.setAttribute('aria-label', '在文件夹中显示');
  const icon = link.querySelector('svg');
  if (icon) icon.innerHTML = '<path d="M3 7h7l2 2h9v10H3z"/><path d="m12 13 3 3m0-3v3h-3"/>';
  const labelNode = [...link.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (labelNode) labelNode.textContent = '在文件夹中显示';
  link.onclick = event => { event.preventDefault(); void showDesktopAssetInFolder(file, link); };
}
function taskCard(task) {
  const asset = fileById(task.assetId);
  const localSyncing = taskLocalSyncing(task, asset);
  const localReady = Boolean(asset && asset.localStatus === 'saved' && !localSyncing);
  const displayStatus = taskDisplayStatus(task, asset);
  const progressMarkup = task.localPreparation || task.awaitingReferences ? generationPreparationMarkup(task) : localSyncing ? desktopSyncMarkup(task) : videoProgressMarkup(task);
  const failure = task.status === 'failed' ? taskFailure(task) : null;
  const media = localReady
    ? (task.type === 'image' ? `<div class="card-media">${assetImageMarkup(asset, asset.name)}</div>` : `<div class="card-media video">${videoPreviewMarkup(asset)}</div>`)
    : task.status === 'failed'
      ? `<div class="card-failure"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg><b>${esc(failure?.message || '生成失败')}</b><p>${esc(failure?.suggestion || '请调整内容后重试')}</p></div>`
      : `<div class="card-placeholder ${displayStatus}"${progressMarkup ? '' : ' aria-hidden="true"'}><div class="skeleton-frame"><i></i><i></i><i></i></div>${progressMarkup}</div>`;
  const imageActions = task.type === 'image'
    ? `<button class="task-action" type="button" data-action="reference" data-task-id="${task.id}" data-tooltip="用作参考图" aria-label="用作参考图"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="m4 16 5-5 4 4 2-2 5 4"/><path d="M18 3v5M15.5 5.5h5"/></svg></button>
      <button class="task-action" type="button" data-action="video-reference" data-task-id="${task.id}" data-tooltip="生成视频" aria-label="生成视频"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2"/><path d="m8 9 4 3-4 3z"/></svg></button>`
    : '';
  const copyIcon = task.type === 'image'
    ? '<path d="M8 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/><path d="m9 15 2-2 2 2 2-2 2 2"/>'
    : '<path d="M8 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/><path d="m10 12 4 2-4 2z"/>';
  const copyLabel = task.type === 'image' ? '复制图片' : '复制视频';
  const completedActions = localReady
    ? `<div class="card-workflow-actions" aria-label="作品操作">
        ${imageActions}
        <button class="task-action" type="button" data-action="regenerate" data-task-id="${task.id}" data-tooltip="再次生成" aria-label="再次生成"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>
        <button class="task-action" type="button" data-action="copy" data-task-id="${task.id}" data-tooltip="${copyLabel}" aria-label="${copyLabel}"><svg viewBox="0 0 24 24" aria-hidden="true">${copyIcon}</svg></button>
        ${localFileAction(asset)}
        <button class="task-action danger-action" type="button" data-action="delete" data-task-id="${task.id}" data-tooltip="删除" aria-label="删除"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button>
      </div>`
    : '';
  const failedActions = task.status === 'failed' ? `<div class="card-failure-actions" aria-label="失败任务操作"><button class="failure-retry task-action" type="button" data-action="retry" data-task-id="${task.id}" title="重试"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg><span>重试</span></button><button class="failure-delete task-action" type="button" data-action="delete" data-task-id="${task.id}" title="删除失败任务" aria-label="删除失败任务"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg><span>删除</span></button></div>` : '';
  const openButton = localReady || task.status === 'failed' ? `<button class="media-open open-task" type="button" data-task-id="${task.id}" aria-label="查看${task.type === 'image' ? '图片' : '视频'}详情"></button>` : '';
  return `<article class="task-card ${displayStatus}${localSyncing ? ' local-syncing' : ''}" data-record-id="${task.id}"><div class="card-visual">${media}${openButton}${completedActions}${failedActions}</div></article>`;
}
function elementFromHtml(html) { const template = document.createElement('template'); template.innerHTML = html.trim(); return template.content.firstElementChild; }
let generationLayoutFrame = 0;
let generationLayoutObserver = null;
function scheduleGenerationLayout() {
  if (generationLayoutFrame || !$('#generationGrid')) return;
  generationLayoutFrame = requestAnimationFrame(layoutGenerationMasonry);
}
function layoutGenerationMasonry() {
  generationLayoutFrame = 0;
  const grid = $('#generationGrid');
  if (!grid || !['image','video'].includes(state.route)) return;
  const cards = [...grid.children].filter(node => node.classList.contains('task-card'));
  if (!cards.length || !grid.clientWidth) {
    grid.classList.remove('masonry-ready');
    grid.style.removeProperty('height');
    generationLayoutObserver?.disconnect();
    return;
  }
  const computed = getComputedStyle(grid);
  const columns = Math.max(1, Number.parseInt(computed.getPropertyValue('--generation-columns'), 10) || 1);
  const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(computed.paddingRight) || 0;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
  const gap = Number.parseFloat(computed.columnGap) || Number.parseFloat(computed.gap) || 0;
  const contentWidth = grid.clientWidth - paddingLeft - paddingRight;
  const cardWidth = (contentWidth - gap * (columns - 1)) / columns;
  if (cardWidth <= 0) return;

  grid.classList.add('masonry-ready');
  const columnHeights = Array.from({ length: columns }, () => 0);
  cards.forEach((card, index) => {
    const column = index < columns ? index : columnHeights.indexOf(Math.min(...columnHeights));
    card.style.width = `${cardWidth}px`;
    card.style.left = `${paddingLeft + column * (cardWidth + gap)}px`;
    card.style.top = `${paddingTop + columnHeights[column]}px`;
    columnHeights[column] += card.offsetHeight + gap;
  });
  const contentHeight = Math.max(...columnHeights, 0) - (cards.length ? gap : 0);
  grid.style.height = `${Math.max(0, paddingTop + contentHeight + paddingBottom)}px`;

  if ('ResizeObserver' in window) {
    generationLayoutObserver ||= new ResizeObserver(() => scheduleGenerationLayout());
    generationLayoutObserver.disconnect();
    cards.forEach(card => generationLayoutObserver.observe(card));
  }
}
function reconcileCards(container, records, { card, signature, bind, empty }) {
  const existing = new Map([...container.children].filter(node => node.dataset.recordId).map(node => [node.dataset.recordId, node]));
  if (!records.length) {
    const emptySignature = empty;
    const isPlaceholder = node => node?.classList.contains('empty-state') || node?.classList.contains('loading-skeleton');
    if (container.dataset.emptySignature !== emptySignature || container.children.length !== 1 || !isPlaceholder(container.firstElementChild)) container.innerHTML = empty;
    container.classList.remove('masonry-ready');
    container.style.removeProperty('height');
    generationLayoutObserver?.disconnect();
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
  card.querySelector('.retry-local-download')?.addEventListener('click', event => {
    event.stopPropagation();
    mediaController.retryDownload(event.currentTarget.dataset.assetId);
  });
  card.querySelector('.open-task')?.addEventListener('click', event => openGenerationDetail(event.currentTarget.dataset.taskId));
  card.querySelectorAll('.task-action[data-action]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); void handleTaskAction(button.dataset.action, button.dataset.taskId, button); }));
  card.querySelector('.show-in-folder')?.addEventListener('click', async event => {
    event.stopPropagation();
    await showDesktopAssetInFolder(fileById(event.currentTarget.dataset.assetId), event.currentTarget);
  });
}
function taskRenderSignature(task) {
  const asset = fileById(task.assetId);
  return `${recordSignature(task, taskCardSignatureFields)}|asset:${asset ? recordSignature(asset, fileCardSignatureFields) : ''}|delivery:${JSON.stringify(mediaController.downloadState(task.assetId))}`;
}
function syncGenerationTab() {
  const history = state.generationTab === 'history';
  const worksPanel = $('#generationWorksPanel');
  const historyPanel = $('#generationHistoryPanel');
  toggleClass(worksPanel, 'hidden', history);
  toggleClass(historyPanel, 'hidden', !history);
  if (worksPanel) worksPanel.hidden = history;
  if (historyPanel) historyPanel.hidden = !history;
  $$('.generation-tab').forEach(button => {
    const active = button.dataset.generationView === state.generationTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (!history) scheduleGenerationLayout();
}
window.addEventListener('resize', scheduleGenerationLayout, { passive:true });
function taskRecency(task) { return String(task.finishedAt || task.updatedAt || task.createdAt || ''); }
function compareTasksByRecency(left, right) {
  const timeOrder = taskRecency(right).localeCompare(taskRecency(left));
  return timeOrder || String(right.id || '').localeCompare(String(left.id || ''));
}
function historyTaskThumbnail(task) {
  const asset = fileById(task.assetId);
  if (asset?.localStatus === 'missing') return '<span class="history-missing-mark">本地文件已移除</span>';
  const localReady = Boolean(asset && asset.localStatus === 'saved' && !taskLocalSyncing(task, asset));
  if (localReady) return task.type === 'image' ? assetImageMarkup(asset, assetDisplayName(asset)) : videoPreviewMarkup(asset, 'history-video-placeholder');
  if (task.status === 'failed') return '<span class="history-failure-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7 3 2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg></span>';
  return '<span class="history-loading-mark" aria-hidden="true"><i></i><i></i><i></i></span>';
}
function historyTaskSummary(task) {
  const prompt = String(task.prompt || '').replace(/\s+/g, ' ').trim();
  return prompt ? prompt.slice(0, 90) + (prompt.length > 90 ? '…' : '') : `未命名${task.type === 'image' ? '图像' : '视频'}任务`;
}
function historyTaskMeta(task) {
  const type = task.type === 'image' ? '图像' : '视频';
  const parameter = task.type === 'image' ? task.size || '—' : `${task.aspectRatio || '—'} · ${task.duration || '—'} 秒`;
  return `${type} · ${generationModelName(task)} · ${parameter}`;
}
function historyTaskCredit(task) {
  const cost = Number(task.creditCost);
  if (!Number.isFinite(cost)) return '';
  if (task.creditStatus === 'refunded') return `${cost} 积分 · 已退回`;
  if (task.creditStatus === 'refund_failed') return `${cost} 积分 · 退款异常`;
  return `${cost} 积分`;
}
function historyTaskRow(task) {
  const status = taskDisplayStatus(task);
  const summary = historyTaskSummary(task);
  const credit = historyTaskCredit(task);
  const canContinue = ['completed', 'failed'].includes(task.status);
  const action = task.status === 'failed' ? `<button class="history-action" type="button" data-action="retry" data-task-id="${esc(task.id)}">重试</button>` : canContinue ? `<button class="history-action" type="button" data-action="continue" data-task-id="${esc(task.id)}">再创作</button>` : '';
  const deletable = !taskLocalSyncing(task) && !['queued', 'running'].includes(task.status);
  const creditMarkup = `<em class="history-credit${credit ? '' : ' is-empty'}"${credit ? '' : ' aria-hidden="true"'}>${esc(credit)}</em>`;
  return `<article class="generation-history-row" data-record-id="${esc(task.id)}"><button class="history-open" type="button" data-task-id="${esc(task.id)}" aria-label="查看${esc(summary)}"><span class="history-thumb ${status}">${historyTaskThumbnail(task)}</span><span class="history-copy"><b title="${esc(summary)}">${esc(summary)}</b><small>${esc(historyTaskMeta(task))}</small></span><span class="history-status ${status}"><i aria-hidden="true"></i>${esc(statusText(status))}</span><time datetime="${esc(taskRecency(task))}">${esc(fullDateText(taskRecency(task)))}</time>${creditMarkup}</button><span class="history-actions">${action}${deletable ? `<button class="history-action history-delete" type="button" data-action="delete" data-task-id="${esc(task.id)}">删除</button>` : ''}</span></article>`;
}
function bindHistoryRow(row) {
  row.querySelector('.history-open')?.addEventListener('click', event => openGenerationDetail(event.currentTarget.dataset.taskId));
  row.querySelectorAll('.history-action[data-action]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); void handleTaskAction(button.dataset.action, button.dataset.taskId, button); }));
}
function renderGenerationHistory() {
  if (!['image', 'video'].includes(state.route) || state.generationTab !== 'history') return;
  const entry = state.generationHistory[state.route];
  const container = $('#generationHistory');
  if (!container || !entry) return;
  const tasks = [...entry.items].sort(compareTasksByRecency);
  const empty = entry.error
    ? emptyState('历史记录加载失败', entry.error, '<button class="secondary-button history-retry" type="button">重试</button>')
    : entry.loaded
      ? emptyState(`还没有${state.route === 'image' ? '图像' : '视频'}历史记录`, '完成一次生成后，任务会出现在这里。')
      : generationHistoryLoadingSkeleton();
  reconcileCards(container, tasks, { card:historyTaskRow, signature:taskRenderSignature, bind:bindHistoryRow, empty });
  container.querySelector('.history-retry')?.addEventListener('click', () => void loadGenerationHistory({ reset:true }), { once:true });
  const loadMore = $('#loadMoreGenerationHistory');
  if (loadMore) {
    loadMore.classList.toggle('hidden', !entry.hasMore || !entry.loaded);
    loadMore.disabled = entry.loading;
    loadMore.textContent = entry.loading ? '正在加载…' : entry.hasMore ? '加载更多历史记录' : '已加载全部历史记录';
  }
}
async function loadGenerationHistory({ reset=false, background=false } = {}) {
  if (!['image', 'video'].includes(state.route)) return;
  const kind = state.route;
  const entry = state.generationHistory[kind];
  const requestAccount = accountScope.snapshot();
  if (!entry || entry.loading || (!reset && entry.loaded && !entry.hasMore)) return;
  if (reset) {
    entry.items = [];
    entry.cursor = '';
    entry.hasMore = true;
    entry.loaded = false;
    entry.error = '';
  }
  entry.loading = true;
  renderGenerationHistory();
  try {
    const query = new URLSearchParams({ view:'history', type:kind, limit:'50' });
    if (entry.cursor) query.set('cursor', entry.cursor);
    if (entry.cursor) query.set('includeTotal', '0');
    const page = await apiPage(`/api/generations?${query}`);
    if (!accountScope.isCurrent(requestAccount) || state.generationHistory[kind] !== entry) return;
    const ids = new Set(entry.items.map(task => task.id));
    entry.items = [...entry.items, ...page.items.filter(task => !ids.has(task.id))];
    entry.cursor = page.nextCursor || '';
    entry.hasMore = Boolean(entry.cursor);
    entry.loaded = true;
    entry.error = '';
  } catch (error) {
    if (!accountScope.isCurrent(requestAccount) || state.generationHistory[kind] !== entry) return;
    entry.error = error.message || '请稍后重试';
    if (!background) toast(`历史记录加载失败：${error.message}`);
  } finally {
    if (accountScope.isCurrent(requestAccount) && state.generationHistory[kind] === entry) {
      entry.loading = false;
      renderGenerationHistory();
    }
  }
}
function setGenerationTab(tab) {
  const next = tab === 'history' ? 'history' : 'works';
  if (state.generationTab === next && document.querySelector('.generation-tab.active')) return;
  state.generationTab = next;
  syncGenerationTab();
  renderTasks();
  if (next === 'history') void loadGenerationHistory();
}
function renderTasks() {
  if (!['image','video'].includes(state.route)) return;
  syncGenerationTab();
  if (state.generationTab === 'history') {
    renderGenerationHistory();
    return;
  }
  const renderState = { route:state.route, tab:state.generationTab, ready:state.initialSyncReady, tasks:state.tasks, preparations:state.generationPreparations, files:state.files };
  if (lastTaskRender.route === renderState.route
    && lastTaskRender.tab === renderState.tab
    && lastTaskRender.ready === renderState.ready
    && lastTaskRender.tasks === renderState.tasks
    && lastTaskRender.preparations === renderState.preparations
    && lastTaskRender.files === renderState.files) return;
  // Keep completed tasks with an asset ID visible until their local delivery
  // is resolved. Hiding them here made the generation page show only the
  // failed sibling versions while the drama page showed a spinner forever.
  let tasks = [...state.generationPreparations, ...state.tasks].filter(task => task.type === state.route
    && fileById(task.assetId)?.localStatus !== 'missing'
    && (task.status !== 'completed' || Boolean(task.assetId))
    && (task.status !== 'failed' || transientFailureVisible(task)));
  tasks.sort(compareTasksByRecency);
  const hasInitialData = state.initialSyncReady || state.tasks.length > 0 || state.generationPreparations.length > 0;
  const empty = hasInitialData
    ? emptyState(`还没有商品${state.route === 'image' ? '图' : '视频'}`, state.route === 'image' ? '从商品主图、场景图或细节特写开始制作。' : '上传商品素材，制作第一条营销视频。')
    : generationLoadingSkeleton();
  reconcileCards($('#generationGrid'), hasInitialData ? tasks : [], { card:taskCard, signature:taskRenderSignature, bind:bindTaskCard, empty });
  scheduleGenerationLayout();
  lastTaskRender = renderState;
}
$$('.generation-tab').forEach(button => {
  button.onclick = () => setGenerationTab(button.dataset.generationView);
  button.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setGenerationTab(button.dataset.generationView === 'works' ? 'history' : 'works'); document.querySelector('.generation-tab.active')?.focus(); } };
});
$('#loadMoreGenerationHistory')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await loadGenerationHistory(); } finally { button.disabled = false; }
});

function detailRow(label, value, id='') { return `<div><dt>${esc(label)}</dt><dd${id ? ` id="${id}"` : ''}>${esc(value)}</dd></div>`; }
const imageQualityLabels = Object.freeze({ low:'低', medium:'中', high:'高' });
function generationModelName(task) {
  const modelId = String(task?.videoModelId || task?.modelId || task?.model || '').trim();
  if (!modelId) return '—';
  if (modelId === 'gpt-image-2') return 'GPT Image 2';
  const configuredModels = Array.isArray(state.config?.videoCapabilities?.models) ? state.config.videoCapabilities.models : [];
  const model = [...configuredModels, ...fallbackVideoModels].find(item => item.id === modelId);
  if (model?.label) return model.label;
  const legacyLabels = { 'grok-15':'GuGu 2.0', 'legacy-grok-video-1.5':'GuGu 1.5' };
  return legacyLabels[modelId] || modelId;
}
function generationModeName(task) {
  const value = String(task?.generationType || '').toUpperCase();
  if (value === 'TEXT') return '文生视频';
  if (value === 'REFERENCE') return '参考素材';
  if (value === 'FIRST&LAST') return '首尾帧';
  return task?.type === 'video' ? (task?.referenceAssetIds?.length ? '参考素材' : '文生视频') : '—';
}
function generationReferenceText(task) {
  const ids = [...new Set(Array.isArray(task?.referenceAssetIds) ? task.referenceAssetIds.map(String).filter(Boolean) : [])];
  if (!ids.length) return '无';
  const names = ids.map(id => fileById(id)).filter(Boolean).map(file => assetDisplayName(file));
  if (!names.length) return `${ids.length} 个素材`;
  const shown = names.slice(0, 3).join('、');
  return names.length > 3 ? `${shown} 等 ${ids.length} 个素材` : shown;
}
function generationParameterRows(task) {
  if (!task) return '';
  const rows = [detailRow('使用模型', generationModelName(task))];
  if (task.type === 'image') {
    rows.push(detailRow('画布比例', task.size || '—'));
    rows.push(detailRow('质量', imageQualityLabels[task.quality] || task.quality || '—'));
    if (Number(task.batchSize) > 1) rows.push(detailRow('生成数量', `${task.batchSize} 张`));
  } else {
    rows.push(detailRow('生成模式', generationModeName(task)));
    rows.push(detailRow('画幅', task.aspectRatio || '—'));
    rows.push(detailRow('时长', Number.isFinite(Number(task.duration)) ? `${task.duration} 秒` : '—'));
    rows.push(detailRow('分辨率', task.quality || '—'));
  }
  rows.push(detailRow('生成时间', fullDateText(task.createdAt)));
  return rows.join('');
}
function generationSupplementalRows(task, fileText, fileInfoId='generationDetailFile') {
  if (!task) return '';
  const credit = Number.isFinite(Number(task.creditCost)) ? `${task.creditCost} 积分` : '—';
  const creditText = task.creditStatus === 'refunded' ? `${credit} · 已退回` : task.creditStatus === 'refund_failed' ? `${credit} · 退款异常` : credit;
  return detailRow('内容类型', task.type === 'image' ? '图片' : '视频')
    + detailRow('参考素材', generationReferenceText(task))
    + detailRow('文件信息', fileText, fileInfoId)
    + detailRow('积分记录', creditText)
    + detailRow('任务编号', task.id);
}
function taskReferenceIds(task, { fallbackToOutput = false, forceOutput = false } = {}) {
  if (!task) return [];
  if ((forceOutput || fallbackToOutput) && task.type === 'image' && task.assetId) {
    if (forceOutput) return [String(task.assetId)];
  }
  const references = Array.isArray(task.referenceAssetIds) ? task.referenceAssetIds.map(String).filter(Boolean) : [];
  if (references.length || !fallbackToOutput || task.type !== 'image') return [...new Set(references)];
  return task.assetId ? [String(task.assetId)] : [];
}
function taskReferenceFiles(task, target, options = {}) {
  const allowedKinds = target === 'image' ? new Set(['image']) : new Set(['image', 'video', 'audio']);
  return taskReferenceIds(task, options).map(id => fileById(id)).filter(file => file && allowedKinds.has(file.kind));
}
function taskPromptMentionNode(target, file) {
  const mention = { id:file.id, label:file.name, kind:file.kind };
  const holder = document.createElement('span');
  holder.innerHTML = target === 'image' ? imagePromptMentionMarkup(mention, file) : videoPromptMentionMarkup(mention, file);
  const chip = holder.firstElementChild;
  if (chip) return chip;
  const fallback = document.createElement('span');
  fallback.className = target === 'image' ? 'image-prompt-mention' : 'video-prompt-mention';
  fallback.dataset[`${target}PromptMentionId`] = String(file.id);
  fallback.dataset[`${target}PromptMentionLabel`] = videoPromptMentionLabel(mention, file);
  fallback.dataset[`${target}PromptMentionKind`] = file.kind;
  fallback.contentEditable = 'false';
  fallback.textContent = `@${videoPromptMentionLabel(mention, file)}`;
  return fallback;
}
function restoreTaskPromptMentions(target, task, files) {
  const editor = target === 'image' ? imagePromptEditor() : videoPromptEditor();
  if (!editor) return 0;
  const byKind = { image:[], video:[], audio:[] };
  files.forEach(file => { if (byKind[file.kind]) byKind[file.kind].push(file); });
  const source = String(task?.prompt || '');
  const tokenPattern = /\b(Image|Video|Audio)(\d+)\b/g;
  const mentions = [];
  let cursor = 0;
  let restored = 0;
  editor.replaceChildren();
  for (const match of source.matchAll(tokenPattern)) {
    const kind = match[1].toLowerCase();
    const file = byKind[kind]?.[Number(match[2]) - 1];
    if (!file) continue;
    if (match.index > cursor) editor.append(document.createTextNode(source.slice(cursor, match.index)));
    editor.append(taskPromptMentionNode(target, file));
    mentions.push({ id:String(file.id), label:videoPromptMentionLabel({ label:file.name }, file), kind:file.kind });
    cursor = match.index + match[0].length;
    restored += 1;
  }
  if (cursor < source.length) editor.append(document.createTextNode(source.slice(cursor)));
  if (target === 'image') {
    state.imagePromptMentions = mentions;
    normalizeEmptyImagePrompt(editor);
  } else {
    state.videoPromptMentions = mentions;
    normalizeEmptyVideoPrompt(editor);
  }
  return restored;
}
function addTaskReference(task, target=task.type, { fallbackToOutput = false, forceOutput = false, replace = false, restoreMentions = false } = {}) {
  if (!task) return false;
  const references = taskReferenceFiles(task, target, { fallbackToOutput, forceOutput });
  const ids = references.map(file => String(file.id));
  if (target === 'video' && String(task.generationType || '').toUpperCase() === 'FIRST&LAST') {
    const [first, last] = ids;
    state.videoFrames = replace ? { first:first || '', last:last || '' } : { first:state.videoFrames.first || first || '', last:state.videoFrames.last || last || '' };
    if (replace) state.refs.video = [];
  } else {
    state.refs[target] = replace ? ids : [...new Set([...ids, ...state.refs[target]])];
  }
  if (restoreMentions) restoreTaskPromptMentions(target, task, references);
  renderReferences();
  return ids.length > 0;
}
function continueFromTask(task, target=task.type, includeReference=false, { fallbackToOutput = false, forceOutput = false, replaceReferences = false, restoreMentions = false, carryPrompt = true } = {}) {
  if (!task) return;
  if ($('#generationDetailDialog').open) closeGenerationDetail();
  if (includeReference && replaceReferences) {
    state.refs[target] = [];
    if (target === 'video') state.videoFrames = { first:'', last:'' };
  }
  if (target === 'video') {
    if (task.type === 'video') {
      const generationType = String(task.generationType || '').toUpperCase();
      state.videoGenerationType = ['TEXT', 'REFERENCE', 'FIRST&LAST'].includes(generationType)
        ? generationType
        : (task.referenceAssetIds?.length ? 'REFERENCE' : 'TEXT');
    } else if (includeReference && (fallbackToOutput || forceOutput)) {
      state.videoGenerationType = 'REFERENCE';
    }
  }
  navigate(target);
  const prompt = $(`#${target}Prompt`);
  if (carryPrompt) {
    if (target === 'video') setVideoPromptText(task.prompt || '');
    else setImagePromptText(task.prompt || '');
  }
  if (carryPrompt && target === 'image' && task.size) { $('#imageSize').value = task.size; $$('.ratio-grid [data-value]').forEach(button => button.classList.toggle('selected', button.dataset.value === task.size)); const extra = $(`.ratio-extra[data-value="${CSS.escape(task.size)}"]`); if (extra) { extra.classList.remove('hidden'); $('#moreRatios').setAttribute('aria-expanded', 'true'); } if (task.quality) { $('#imageQuality').value = task.quality; $$('.segmented[data-select="imageQuality"] button').forEach(button => button.classList.toggle('selected', button.dataset.value === task.quality)); } }
  if (carryPrompt && target === 'image' && task.batchSize) commitImageQuantity(task.batchSize);
  if (target === 'video' && task.type === 'video') {
    const taskModelId = task.videoModelId || task.modelId;
    const selectableModel = videoModelOptions().some(model => model.id === taskModelId && model.availability !== 'coming-soon');
    if (selectableModel) $('#videoModel').value = taskModelId;
    refreshProductSelect('videoModel');
    syncVideoModelParameters();
  }
  if (includeReference) addTaskReference(task, target, { fallbackToOutput, forceOutput, replace:replaceReferences, restoreMentions });
  if (target === 'video' && task.type === 'video') {
    const parameters = videoGenerationParameters().parameters;
    if (parameters?.aspectRatios.includes(task.aspectRatio)) $('#videoAspect').value = task.aspectRatio;
    if (parameters?.durations.includes(Number(task.duration))) $('#videoDuration').value = String(task.duration);
    if (parameters?.qualityOptions.includes(task.quality)) $('#videoResolution').value = task.quality;
    refreshProductSelect('videoAspect'); refreshProductSelect('videoDuration'); refreshProductSelect('videoResolution'); updateVideoCost();
  }
  if (carryPrompt) prompt.dispatchEvent(new Event('input', { bubbles:true }));
  $('#creatorPanel').scrollTo({ top:0, behavior:'smooth' }); prompt.focus();
  toast(includeReference ? (carryPrompt ? '已带入参考素材和创作描述' : target === 'image' ? '已添加为参考图' : '已带入视频参考素材') : '已带入创作描述，可调整后重新生成');
}
async function deleteGenerationTask(task, button = null) {
  if (!task) return false;
  const active = taskLocalSyncing(task) || ['queued','running'].includes(task.status);
  if (active) { toast('任务生成中，完成后才能删除'); return false; }
  if (!await confirmGenerationDeletion(task)) return false;
  const card = button?.closest('.task-card');
  const originalButtonMarkup = button?.innerHTML || '';
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = '<span>删除中…</span>';
  }
  card?.classList.add('is-removing');
  try {
    const id = task.id;
    const result = await api(`/api/generations/${id}`, { method:'DELETE', body:'{}' });
    if (result.deletedAssetId || task.assetId) await removeDesktopCloudAssets([result.deletedAssetId || task.assetId]);
    else if (task.assetId) clearFileReferences(task.assetId);
    if (state.route === 'drama') await Promise.resolve(dramaController?.refreshProject?.({ quiet:true })).catch(error => console.warn('[drama] 刷新项目删除状态失败', error));
    for (const entry of Object.values(state.generationHistory)) entry.items = entry.items.filter(item => item.id !== id);
    if (state.generationTab === 'history') renderGenerationHistory();
    clearTransientFailureTimer(id);
    transientFailureDeadlines.delete(id);
    if ($('#generationDetailDialog')?.open && state.detailTaskId === id) closeGenerationDetail();
    await Promise.all([loadTasks(), loadFiles()]);
    toast(task.status === 'failed' ? '失败任务已删除' : '作品及关联文件已删除');
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.innerHTML = originalButtonMarkup;
    }
    card?.classList.remove('is-removing');
  }
}
async function copyTaskAsset(task, button = null) {
  const file = fileById(task?.assetId);
  if (!file || !requireDesktopLocalAsset(file)) return;
  if (!copyDesktopAssetToClipboard) return toast('复制素材需要更新客户端后使用');
  const copied = await copyDesktopAssetToClipboard(file, button);
  if (copied) toast(`${task.type === 'image' ? '图片' : '视频'}已复制到剪贴板`);
}
function handleTaskAction(action, id, button = null) {
  const task = taskById(id);
  if (!task) return;
  if (action === 'preview' || action === 'more') return openGenerationDetail(id);
  if (action === 'reference') { continueFromTask(task, 'image', true, { forceOutput:true, carryPrompt:false }); return; }
  if (action === 'video-reference') { continueFromTask(task, 'video', true, { forceOutput:true, carryPrompt:false }); return; }
  if (action === 'regenerate') { continueFromTask(task, task.type, true, { replaceReferences:true, restoreMentions:true }); return; }
  if (action === 'copy') { void copyTaskAsset(task, button); return; }
  if (action === 'retry' || action === 'continue') { continueFromTask(task); return; }
  if (action === 'delete') return deleteGenerationTask(task, button);
}
function fitDetailMedia(media, width, height) { if (!media || !width || !height) return; const portrait=height>width; media.classList.toggle('portrait-media', portrait); media.classList.toggle('landscape-media', !portrait); }
function resetDetailFit(dialog) { dialog.classList.remove('portrait-detail'); dialog.style.removeProperty('--portrait-dialog-width'); }
function closeGenerationDetail() { const dialog = $('#generationDetailDialog'); dialog.close(); resetDetailFit(dialog); $('#generationDetailMedia').innerHTML = ''; state.detailTaskId = null; }
function openGenerationDetail(id) {
  const task = taskById(id); if (!task) return;
  const asset = fileById(task.assetId);
  const localSyncing = taskLocalSyncing(task, asset);
  const localReady = Boolean(asset && asset.localStatus === 'saved' && !localSyncing);
  if (localSyncing && !requireDesktopLocalAsset(asset)) return; state.detailTaskId = id;
  const displayStatus = taskDisplayStatus(task, asset);
  const detailFailure = task.status === 'failed' ? taskFailure(task) : null;
  const media = localSyncing
    ? desktopSyncMarkup(task)
    : localReady
    ? (task.type === 'image' ? `<img src="${asset.url}" alt="${esc(asset.name)}">` : `<video src="${asset.url}" controls autoplay></video>`)
    : asset?.localStatus === 'missing'
      ? '<div class="detail-missing-file"><b>本地文件已移除</b><span>请重新选择素材或重新生成</span></div>'
    : detailFailure
      ? `<div class="detail-missing-file" role="alert"><b>${esc(detailFailure.message || '生成失败')}</b><span>${esc(detailFailure.suggestion || '请调整内容后重试')}</span></div>`
      : `<div class="detail-placeholder ${task.status}" aria-hidden="true"><div class="loader-ring"></div></div>`;
  $('#generationDetailMedia').innerHTML = media;
  $('#generationDetailMedia').querySelector('.retry-local-download')?.addEventListener('click', () => mediaController.retryDownload(task.assetId));
  $('#generationDetailTitle').textContent = '文件详情';
  const status = $('#generationDetailStatus'); status.className = `detail-status ${displayStatus}`; status.textContent = statusText(displayStatus);
  $('#generationDetailPrompt').textContent = task.prompt;
  const promptElement = $('#generationDetailPrompt'); const promptToggle = $('#generationDetailPromptToggle'); promptElement.classList.remove('expanded'); promptToggle.classList.add('hidden'); promptToggle.setAttribute('aria-expanded', 'false'); promptToggle.textContent = '展开全部'; requestAnimationFrame(() => { const overflowing = promptElement.scrollHeight > promptElement.clientHeight + 1; promptToggle.classList.toggle('hidden', !overflowing); });
  const fileText = localSyncing ? '正在加载并恢复到本机' : localReady ? `${formatBytes(asset.size)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height} px` : ''}` : '暂无成品文件';
  $('#generationCoreMeta').innerHTML = generationParameterRows(task);
  $('#generationDetailMeta').innerHTML = generationSupplementalRows(task, fileText);
  const error = $('#generationDetailError'); const failure = taskFailure(task); error.textContent = taskErrorText(task); error.classList.toggle('hidden', !failure);
  const fileAction = $('#downloadGeneration'); fileAction.classList.toggle('hidden', !localReady); configureLocalFileAction(fileAction, localReady ? asset : null);
  $('#useGenerationReference').classList.toggle('hidden', !localReady || task.type !== 'image');
  const deriveButton = $('#deriveGeneration'); const deriveSame = task.type !== 'image'; deriveButton.classList.toggle('hidden', !localReady); deriveButton.classList.toggle('gradient-button', deriveSame); deriveButton.classList.toggle('secondary-button', !deriveSame); deriveButton.innerHTML = deriveSame ? '<svg viewBox="0 0 24 24"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></svg>生成同款' : '生成视频'; deriveButton.parentElement.classList.toggle('single-action', deriveSame);
  const deleteButton = $('#deleteGeneration'); const active = localSyncing || ['queued','running'].includes(task.status); deleteButton.disabled = active; deleteButton.title = active ? '任务生成中，完成后才能删除' : '';

  $('#generationDetailDialog').showModal();
  if (localReady) {
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
async function copyGenerationPrompt() { const task = taskById(state.detailTaskId); const prompt = task?.prompt || ''; if (!prompt) return toast('暂无可复制的创作描述'); try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt); else if (!copyTextFallback(prompt)) throw new Error('copy failed'); toast('创作描述已复制'); } catch { toast('复制失败，请手动选择文字复制'); const text = $('#generationDetailPrompt'); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); } }
$('#closeGenerationDetail').onclick = closeGenerationDetail;
$('#generationDetailDialog').addEventListener('click', event => { if (event.target === event.currentTarget) closeGenerationDetail(); });
$('#generationDetailDialog').addEventListener('close', () => { $('#generationDetailMedia').innerHTML = ''; $('#generationDetailPrompt').classList.remove('expanded'); $('#generationDetailPromptToggle').classList.add('hidden'); state.detailTaskId = null; });
$('#generationDetailPromptToggle').onclick = () => { const prompt = $('#generationDetailPrompt'); const toggle = $('#generationDetailPromptToggle'); const expanded = prompt.classList.toggle('expanded'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起描述' : '展开全部'; };
$('#copyGenerationPrompt').onclick = copyGenerationPrompt;
$('#useGenerationReference').onclick = () => continueFromTask(taskById(state.detailTaskId), 'image', true, { forceOutput:true, carryPrompt:false });
$('#deriveGeneration').onclick = () => { const task = taskById(state.detailTaskId); continueFromTask(task, 'video', true, { forceOutput:task?.type === 'image', carryPrompt:task?.type === 'video' }); };
$('#deleteGeneration').onclick = async () => { if ($('#deleteGeneration').disabled) return; const task = taskById(state.detailTaskId); if (!task) return; await deleteGenerationTask(task, $('#deleteGeneration')); };

function assetDisplayName(file) {
  const stem = String(file.name || '').replace(/\.[^.]+$/, '').trim();
  const technical = /^(?:生成图片|生成视频)(?:\s|$)|^codex-clipboard-|^[a-f\d-]{20,}$|^\d+(?:\s*\(\d+\))?$|^(?=[A-Za-z0-9_-]{12,}$)(?=.*\d)[A-Za-z0-9_-]+$/i.test(stem);
  if (!technical && stem) return stem;
  const task = taskForAsset(file);
  if (task?.prompt) { const subject = task.prompt.trim().split(/[，。；,;\n]/)[0].replace(/^(请|帮我|生成|制作|创建|一张|一幅|一个|一段)/, '').trim().slice(0, 18); if (subject) return `${subject}｜${file.kind === 'image' ? '商品图' : file.kind === 'audio' ? '音频' : '商品视频'}`; }
  const date = new Date(file.createdAt); const day = Number.isNaN(date.getTime()) ? '' : `｜${String(date.getMonth()+1).padStart(2,'0')}月${String(date.getDate()).padStart(2,'0')}日`;
  return `导入${file.kind === 'image' ? '图片' : file.kind === 'audio' ? '音频' : '视频'}${day}`;
}
function fileCard(file) { const displayName = assetDisplayName(file); const media = file.kind === 'image' ? assetImageMarkup(file, displayName) : file.kind === 'audio' ? '<span class="audio-file-mark">♫</span>' : videoPreviewMarkup(file); const reveal = `<button class="show-in-folder" data-asset-id="${esc(file.id)}">在文件夹中显示</button>`; return `<article class="file-card" data-record-id="${file.id}"><button class="file-preview preview-file" data-id="${file.id}" aria-label="预览 ${esc(displayName)}">${media}<span class="asset-preview-label">预览</span></button><button class="more-button file-card-more" aria-label="文件操作" data-id="${file.id}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><div class="file-menu hidden" data-menu="${file.id}"><button class="rename-file" data-id="${file.id}">重命名</button>${reveal}<button class="delete-file danger" data-id="${file.id}">删除</button></div></article>`; }
function fileRenderSignature(file) { return `${recordSignature(file, fileCardSignatureFields)}|name:${assetDisplayName(file)}`; }
function uploadJobKind(mimeType) { const value = String(mimeType || ''); return value.startsWith('image/') ? 'image' : value.startsWith('video/') ? 'video' : value.startsWith('audio/') ? 'audio' : ''; }
function uploadJobMediaMarkup(job) { if (job.kind === 'image' && job.previewUrl) return `<img src="${esc(job.previewUrl)}" alt="${esc(job.name)}">`; if (job.kind === 'video' && job.previewUrl) return `<video src="${esc(job.previewUrl)}" preload="metadata" muted></video><span class="play-mark"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></span>`; return '<span class="audio-file-mark">♫</span>'; }
function uploadJobCard(job, variant='file') {
  const failed = job.status === 'failed';
  const completed = job.status === 'completed';
  const progress = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  const percent = failed ? '失败' : `${progress}%`;
  const label = failed ? job.error : completed ? (job.selected ? '上传完成，已选中' : '上传完成') : (job.label || '准备上传');
  const selected = job.selected ? '<i class="upload-job-selected" aria-label="已选中">✓</i>' : '';
  const ring = failed ? '<span class="upload-progress-ring upload-progress-error"><b>!</b></span>' : `<span class="upload-progress-ring" style="--upload-progress:${progress}%"><b>${percent}</b></span>`;
  const media = uploadJobMediaMarkup(job);
  if (variant === 'reference') return `<article class="reference-upload-placeholder upload-job-card ${failed ? 'failed' : ''} ${completed ? 'completed' : ''}" data-upload-id="${esc(job.id)}" aria-live="polite" aria-label="${esc(job.name)}，${esc(label)}"><div class="reference-upload-visual upload-job-visual">${media}<span class="upload-job-shade">${ring}</span>${selected}</div><span title="${esc(job.name)}">${esc(job.name)}</span></article>`;
  return `<article class="file-card upload-job-file-card upload-job-card ${failed ? 'failed' : ''} ${completed ? 'completed' : ''}" data-upload-id="${esc(job.id)}" aria-live="polite" aria-label="${esc(job.name)}，${esc(label)}"><div class="file-preview upload-job-visual">${media}<span class="upload-job-shade">${ring}</span>${selected}</div></article>`;
}
function renderUploadJobCards(container, jobs, variant='file') { container.querySelectorAll('[data-upload-id]').forEach(node => node.remove()); if (jobs.length) container.prepend(...jobs.map(job => elementFromHtml(uploadJobCard(job, variant)))); }
function notifyUploadSurfaceChanged() { if (state.route === 'files') renderFiles(); if ($('#referenceDialog')?.open) renderReferenceDialog(); renderReferences(); window.dispatchEvent(new CustomEvent('gugu-upload-state-change')); }
function createUploadJob(file, context, { previewUrl='', mimeType='', deferUpload=false, localAssetId='', removeLocalOnDiscard=false } = {}) {
  const job = { id:`upload-${crypto.randomUUID()}`, context, referenceTarget:context==='reference' ? state.referenceTarget : '', videoFrameTarget:context==='reference' ? state.videoFrameTarget : '', name:String(file?.name || '未命名文件'), mimeType, kind:uploadJobKind(mimeType), size:Number(file?.size || 0), previewUrl:String(previewUrl || ''), revokePreview:false, localAssetId, removeLocalOnDiscard, deferUpload, progress:0, status:deferUpload ? 'pending' : 'queued', label:deferUpload ? '已加入，创作时上传' : '准备上传', error:'', selected:false, assetId:'' };
  state.uploadJobs.push(job); notifyUploadSurfaceChanged(); return job;
}
function updateUploadJob(job, progress, label='正在上传') { if (!job) return; job.progress=Math.max(0, Math.min(100, Number(progress) || 0)); job.label=label; job.status=job.status === 'queued' ? 'uploading' : job.status; const now=Date.now(); if (now-job.lastRenderAt < 60 && job.progress < 100) return; job.lastRenderAt=now; notifyUploadSurfaceChanged(); }
function finishUploadJob(job, asset, selected=false, afterAsset=null) { if (!job || !asset) return; mediaController.mergeLocalAssets([asset]); const finalSelected=afterAsset ? Boolean(afterAsset(asset)) : selected; job.assetId=asset.id; job.progress=100; job.status='completed'; job.label=finalSelected ? '上传完成，已选中' : '上传完成'; job.selected=finalSelected; notifyUploadSurfaceChanged(); window.setTimeout(() => removeUploadJob(job.id), 1200); }
function failUploadJob(job, error) { if (!job) return; job.status='failed'; job.progress=0; job.error=error?.message || '上传失败'; job.label=job.error; notifyUploadSurfaceChanged(); }
function removeUploadJob(id) { const index=state.uploadJobs.findIndex(job=>job.id===id); if (index<0) return; const [job]=state.uploadJobs.splice(index,1); if (job.revokePreview && job.previewUrl) URL.revokeObjectURL(job.previewUrl); if (shouldRemoveUploadJobLocalAsset(job) && window.guguDesktop?.media?.removeLocal) void window.guguDesktop.media.removeLocal(job.localAssetId).then(() => loadFiles({ background:true })).catch(error => console.warn('[desktop] 清理待上传本地素材失败', error)); notifyUploadSurfaceChanged(); }
function autoSelectUploadedReference(asset, kind, job) {
  if (!asset || job?.context !== 'reference') return false;
  const referenceTarget=job.referenceTarget || state.referenceTarget; const isFrame=referenceTarget==='video-frame'; const isVideo=referenceTarget==='video';
  const limits=isFrame ? {image:1,video:0,audio:0,total:1} : isVideo ? referenceLimits() : {image:7,video:0,audio:0,total:7};
  const allowedKinds=isFrame ? new Set(['image']) : isVideo ? referenceFileKinds() : new Set(['image']);
  if (!allowedKinds.has(kind)) return false;
  const selectedFiles=state.dialogSelection.map(id=>referenceFileById(id)).filter(Boolean);
  const counts=Object.fromEntries(['image','video','audio'].map(type=>[type,selectedFiles.filter(file=>file.kind===type).length]));
  if (state.dialogSelection.includes(asset.id) || state.dialogSelection.length >= limits.total || counts[kind] >= Number(limits[kind] || 0)) return false;
  state.dialogSelection.push(asset.id); return true;
}
function projectPendingReferenceToCreation(job) {
  if (!job?.deferUpload) return;
  if (job.referenceTarget === 'video-frame') state.videoFrames[job.videoFrameTarget] = job.id;
  else if (['image','video'].includes(job.referenceTarget) && !state.refs[job.referenceTarget].includes(job.id)) state.refs[job.referenceTarget] = [...state.refs[job.referenceTarget], job.id];
  renderReferences();
}
function libraryFileMatches(file) {
  const query = $('#fileSearch').value.trim().toLowerCase();
  return (state.fileKind === 'all' || file.kind === state.fileKind)
    && (!query || `${file.name} ${assetDisplayName(file)}`.toLowerCase().includes(query));
}
function renderFiles() {
  if (state.route !== 'files') return;
  const { files:libraryFiles, total:localFileTotal, hasMore:localFileHasMore } = mediaController.libraryState();
  const query = $('#fileSearch').value.trim().toLowerCase();
  const uploads = state.uploadJobs.filter(job => job.context === 'library' && (!query || job.name.toLowerCase().includes(query)) && (state.fileKind === 'all' || job.kind === state.fileKind));
  const uploadingAssetIds = new Set(uploads.map(job => job.assetId).filter(Boolean));
  const files = libraryFiles.filter(file => libraryFileMatches(file) && !uploadingAssetIds.has(file.id));
  const hasInitialData = state.initialSyncReady || libraryFiles.length > 0 || uploads.length > 0;
  $('#fileCount').textContent = hasInitialData ? `${localFileTotal + uploads.length} 个文件${uploads.length ? ` · ${uploads.length} 个同步中` : ''}` : '正在加载…';
  const empty = hasInitialData
    ? uploads.length ? '' : emptyState(libraryFiles.length ? '没有匹配的文件' : '文件库还是空的', libraryFiles.length ? '换个关键词或文件类型试试。' : '上传素材，或完成一次生成后，文件会自动保存在这里。', libraryFiles.length ? '' : '<button class="upload-button empty-upload">上传第一个文件</button>')
    : fileLibraryLoadingSkeleton();
  const grid = $('#fileGrid');
  reconcileCards(grid, files, { card:fileCard, signature:fileRenderSignature, bind:bindFileActions, empty });
  renderUploadJobCards(grid, uploads, 'file');
  grid.querySelector('.empty-upload')?.addEventListener('click', () => openUploadPicker('library'), { once:true });
  const loadMore = $('#loadMoreFiles');
  if (loadMore) {
    const hasMore = localFileHasMore;
    loadMore.classList.toggle('hidden', !hasMore);
    loadMore.disabled = false;
    loadMore.textContent = hasMore ? '加载更多' : '已加载全部';
  }
}
let fileSearchTimer = 0;
$('#fileSearch').oninput = () => {
  renderFiles();
  clearTimeout(fileSearchTimer);
  fileSearchTimer = window.setTimeout(() => void loadFiles(), 240);
};
$$('.type-tabs button').forEach(button => button.onclick = () => {
  state.fileKind = button.dataset.kind;
  $$('.type-tabs button').forEach(x => {
    const active = x === button;
    x.classList.toggle('active', active);
    x.setAttribute('aria-selected', String(active));
  });
  renderFiles();
  void loadFiles({ background:true });
});
$('#loadMoreFiles')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await loadFiles({ loadMore:true }); } finally { button.disabled = false; }
});
function clearFileReferences(fileId) {
  state.refs.image = state.refs.image.filter(id => id !== fileId);
  state.refs.video = state.refs.video.filter(id => id !== fileId);
  if (state.videoFrames.first === fileId) state.videoFrames.first = '';
  if (state.videoFrames.last === fileId) state.videoFrames.last = '';
  removeImagePromptMentionNodes(fileId);
  removeVideoPromptMentionNodes(fileId);
}
async function removeFile(file) {
  const cloudAssetId = file?.localOnly ? '' : String(file?.cloudAssetId || file?.id || '');
  if (cloudAssetId) {
    const result = await api(`/api/files/${encodeURIComponent(cloudAssetId)}`, { method:'DELETE', body:'{}' });
    await removeDesktopCloudAssets([result.deletedAssetId || cloudAssetId]);
    if (state.route === 'drama') await Promise.resolve(dramaController?.refreshProject?.({ quiet:true })).catch(error => console.warn('[drama] 刷新项目删除状态失败', error));
    await Promise.all([loadTasks(), loadFiles()]);
    return;
  }
  await mediaController.removeLocalAsset(file);
}
function bindFileActions(root) {
  root.querySelector('.preview-file')?.addEventListener('click', event => openPreview(event.currentTarget.dataset.id));
  root.querySelector('.more-button')?.addEventListener('click', event => { event.stopPropagation(); const button = event.currentTarget; $$('[data-menu]').forEach(menu => menu.classList.toggle('hidden', menu.dataset.menu !== button.dataset.id || !menu.classList.contains('hidden'))); });
  root.querySelector('.show-in-folder')?.addEventListener('click', async event => { event.stopPropagation(); await showDesktopAssetInFolder(fileById(event.currentTarget.dataset.assetId), event.currentTarget); });
  root.querySelector('.rename-file')?.addEventListener('click', event => { event.stopPropagation(); const file = state.files.find(x => x.id === event.currentTarget.dataset.id); openRenameFileDialog(file); });
  root.querySelector('.delete-file')?.addEventListener('click', async event => { const file = state.files.find(x => x.id === event.currentTarget.dataset.id); if (!file || !await confirmFileDeletion(file)) return; try { await removeFile(file); toast(file.sourceGenerationId ? '作品及关联文件已删除' : '文件已删除'); } catch (error) { toast(error.message); } });
}
document.addEventListener('click', () => $$('[data-menu]').forEach(menu => menu.classList.add('hidden')));

function videoReferenceParameters(modelId=$('#videoModel')?.value) { return videoModelParameters(modelId, 'REFERENCE'); }
function referenceLimits(modelId=$('#videoModel')?.value) { const parameters = videoReferenceParameters(modelId); const configured = parameters?.referenceLimits; if (configured) return configured; const maxImages = Number(parameters?.maxImages || 0); return { image: maxImages, video: 0, audio: 0, total: maxImages }; }
function referenceFileKinds(modelId=$('#videoModel')?.value) { const limits = referenceLimits(modelId); return new Set(['image', 'video', 'audio'].filter(kind => Number(limits[kind] || 0) > 0)); }
function normalizeImageReferenceIds(ids) { return [...new Set(Array.isArray(ids) ? ids : [])].filter(id => referenceFileById(id)?.kind === 'image').slice(0, 7); }
function pendingReferenceJob(id) { return state.uploadJobs.find(job => job.id === id && job.context === 'reference') || null; }
function pendingReferenceFile(job) { return job ? { id:job.id, name:job.name, kind:job.kind, mimeType:job.mimeType, size:job.size, url:job.previewUrl, previewUrl:job.previewUrl, pendingUpload:true, localOnly:true } : null; }
function referenceFileById(id) {
  const file = state.files.find(item => item.id === id);
  return file || pendingReferenceFile(pendingReferenceJob(id));
}
function videoReferenceCounts(ids=state.dialogSelection) { return Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, (Array.isArray(ids) ? ids : []).reduce((count, id) => count + Number(referenceFileById(id)?.kind === kind), 0)])); }
function normalizeVideoReferenceIds(ids, modelId=$('#videoModel')?.value) {
  const limits = referenceLimits(modelId);
  const allowedKinds = referenceFileKinds(modelId);
  const counts = { image:0, video:0, audio:0 };
  const selected = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (selected.includes(id)) continue;
    const file = referenceFileById(id);
    if (!file || !allowedKinds.has(file.kind) || selected.length >= Number(limits.total || 0)) continue;
    if (counts[file.kind] >= Number(limits[file.kind] || 0)) continue;
    selected.push(id);
    counts[file.kind] += 1;
  }
  return selected;
}
function desktopMediaKind(item) {
  const mimeType = String(item?.mimeType || '').toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return '';
}
async function desktopImportToContext(context, { multiple = true } = {}) {
  const bridge = window.guguDesktop;
  if (!bridge?.media?.chooseAndImport) throw new Error('桌面导入能力尚未就绪，请重启客户端后再试');
  const imported = await bridge.media.chooseAndImport({ multiple });
  if (!imported.length) return [];
  const inDialog = context === 'reference';
  const isFrame = inDialog && state.referenceTarget === 'video-frame';
  const isVideoReference = inDialog && state.referenceTarget === 'video';
  const allowedKinds = inDialog ? (isFrame ? new Set(['image']) : referenceFileKinds()) : new Set(['image', 'video', 'audio']);
  const limits = isFrame ? { image: 1, video: 0, audio: 0, total: 1 } : isVideoReference ? referenceLimits() : { image: 7, video: 0, audio: 0, total: 7 };
  let synced = 0;
  let selected = 0;
  const processedFiles = [];
  for (const item of imported) {
    if (item.error) { if (canRemoveImportedLocalAsset(item)) void bridge.media.removeLocal(item.id).catch(()=>{}); toast(`${item.filePath || '文件'} 导入失败：${item.error}`); continue; }
    const kind = desktopMediaKind(item);
    const discardImported = () => { if (canRemoveImportedLocalAsset(item)) void bridge.media.removeLocal(item.id).catch(error => console.warn('[desktop] 清理非法导入失败', error)); };
    const sizeLimit = kind === 'image' ? 20 * 1024 * 1024 : 25 * 1024 * 1024;
    if (item.size > sizeLimit) {
      discardImported();
      toast(`${item.name || '文件'} 超过 ${kind === 'image' ? '20' : '25'} MB`);
      continue;
    }
    if (!kind || (inDialog && (!allowedKinds.has(kind) || limits[kind] <= 0))) {
      discardImported();
      toast(`${item.name || '文件'} 不符合当前入口支持的素材类型`);
      continue;
    }
    const selectedCounts = inDialog ? videoReferenceCounts() : null;
    if (inDialog && selectedCounts[kind] >= Number(limits[kind] || 0)) {
      discardImported();
      toast(`当前模型最多选择 ${limits[kind]} 个${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}`);
      continue;
    }
    let job=null;
    try {
      const previewUrl=await bridge.media.url(item.id).catch(()=> '');
      job=createUploadJob({ name:item.name, size:item.size, type:item.mimeType }, context, { previewUrl, mimeType:item.mimeType, deferUpload:inDialog, localAssetId:item.id, removeLocalOnDiscard:!item.reused });
      if (inDialog) {
        if (!autoSelectUploadedReference(pendingReferenceFile(job), kind, job)) throw new Error('参考素材数量已达到当前模型限制');
        job.selected=true; job.label='已加入，创作时同步'; projectPendingReferenceToCreation(job); selected+=1;
        processedFiles.push(pendingReferenceFile(job));
        continue;
      }
      updateUploadJob(job, 8, '正在同步到云端');
      const result = await bridge.media.syncLocal({ assetId: item.id });
      const cloudAsset = cloudAssetFromDesktopSync(result);
      if (!cloudAsset?.id) throw new Error('云端素材记录创建失败');
      const file = { ...cloudAsset, url: result.url, remoteUrl: cloudAsset.url, localStatus: 'saved', localPath: result.relativePath, sha256: item.sha256 || cloudAsset.sha256 };
      finishUploadJob(job, file, true);
      processedFiles.push(file);
      synced += 1;
    } catch (error) {
      if (job) failUploadJob(job,error);
      toast(`${item.name || '文件'} ${inDialog ? '加入参考区' : '云端同步'}失败：${error.message}`);
    }
  }
  renderReferenceDialog(); resetReferenceDialogScroll(); renderReferences();
  if (!inDialog) await loadFiles();
  if (synced) toast(`${synced} 个素材已保存到本地并同步到云端`);
  else if (selected) toast(`${selected} 个参考素材已加入，发起创作时同步`);
  return processedFiles;
}
function openUploadPicker(context) {
  void desktopImportToContext(context).catch(error => toast(`导入素材失败：${error.message}`));
}
async function pickAndUploadDramaImage({ context='professional' } = {}) {
  const files = await desktopImportToContext(context, { multiple:false });
  return files.find(file => file?.kind === 'image') || null;
}
async function pickAndUploadDramaAsset({ context='professional-project' } = {}) {
  const files = await desktopImportToContext(context, { multiple:false });
  return files[0] || null;
}
$('#uploadButton').onclick = () => openUploadPicker('library');
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
  return referenceLimits().total || 0;
}
function referenceCapabilityText(limits=referenceLimits()) {
  const parts = [['image', '图片'], ['video', '视频'], ['audio', '音频']].filter(([kind]) => Number(limits[kind] || 0) > 0).map(([kind, label]) => `${label} ${limits[kind]}`);
  return parts.length ? `${parts.join(' · ')} · 共 ${limits.total} 个` : '当前模型不支持参考素材';
}
function renderVideoGenerationMode() {
  const toggle = $('#videoModeToggle');
  const label = $('#videoReferenceLabel');
  const hint = $('#videoReferenceHint');
  if (!toggle || !label) return;
  const limits = referenceLimits();
  const dualModeModel = supportsVideoMode('REFERENCE') && supportsVideoFirstLast();
  const { mode } = videoGenerationParameters();
  const firstLast = mode === 'FIRST&LAST';
  label.classList.remove('hidden');
  label.textContent = firstLast ? '首尾帧' : '参考素材';
  if (hint) hint.textContent = firstLast ? '上传两张图分别代表控制视频的首尾画面' : referenceCapabilityText(limits);
  toggle.classList.toggle('hidden', !dualModeModel);
  if (!dualModeModel) {
    toggle.onclick = null;
    return;
  }
  const alternate = firstLast ? '参考素材' : '首尾帧';
  toggle.innerHTML = `<span class="video-mode-switch" aria-hidden="true">⇄</span><span>${alternate}</span>`;
  toggle.setAttribute('aria-label', `当前为${label.textContent}，点击切换为${alternate}`);
  toggle.setAttribute('aria-pressed', String(firstLast));
  toggle.onclick = () => setVideoGenerationType(firstLast ? 'REFERENCE' : 'FIRST&LAST');
  toggle.disabled = false;
}
function renderVideoFrameSlots() {
  const container = $('#videoReferences');
  if (!container) return;
  const frame = (key, label, hint) => {
    const file = referenceFileById(state.videoFrames[key]);
    return file
      ? `<figure class="video-frame-slot filled">${referenceMediaMarkup(file, file.name)}<figcaption>${label}</figcaption><button type="button" class="remove-ref" data-video-frame-remove="${key}" aria-label="移除${label}">×</button></figure>`
      : `<button type="button" class="video-frame-slot" data-video-frame="${key}"><span>＋</span><b>${label}</b><small>${hint}</small></button>`;
  };
  container.innerHTML = frame('first', '首帧', '上传首帧图片') + '<span class="video-frame-transition" aria-hidden="true">→</span>' + frame('last', '尾帧', '上传尾帧图片');
  container.classList.add('video-frame-strip');
  container.querySelectorAll('[data-video-frame]').forEach(button => button.onclick = () => openVideoFrameDialog(button.dataset.videoFrame));
  container.querySelectorAll('[data-video-frame-remove]').forEach(button => button.onclick = () => { const id=state.videoFrames[button.dataset.videoFrameRemove]; state.videoFrames[button.dataset.videoFrameRemove] = ''; if (pendingReferenceJob(id)) removeUploadJob(id); renderReferences(); });
}
function renderReferences() {
  const { mode } = videoGenerationParameters();
  const limits = referenceLimits();
  const canAddVideoReference = supportsVideoMode('REFERENCE') && limits.total > 0;
  if (mode !== 'FIRST&LAST') {
    state.refs.video = normalizeVideoReferenceIds(state.refs.video);
    pruneVideoPromptMentionsToReferences();
  }
  state.refs.image = normalizeImageReferenceIds(state.refs.image);
  pruneImagePromptMentionsToReferences();
  if (state.videoFrames.first && !referenceFileById(state.videoFrames.first)) state.videoFrames.first = '';
  if (state.videoFrames.last && !referenceFileById(state.videoFrames.last)) state.videoFrames.last = '';
  const imageSelected = state.refs.image.map(id => referenceFileById(id)).filter(Boolean);
  const imageReferences = $('#imageReferences');
  if (imageReferences) imageReferences.innerHTML = imageSelected.map(file => `<div class="reference-thumb${file.pendingUpload ? ' pending-reference-thumb' : ''}">${referenceMediaMarkup(file, file.name)}${file.pendingUpload ? '<small>待上传</small>' : ''}<button type="button" class="remove-ref" data-target="image" data-id="${file.id}" aria-label="移除参考图">×</button></div>`).join('') + `<button class="add-reference pick-reference" data-target="image" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>添加</span></button>`;
  const videoReferenceHead = $('#videoReferenceLabel')?.closest('.reference-head');
  const videoReferences = $('#videoReferences');
  videoReferenceHead?.classList.remove('hidden');
  videoReferences?.classList.remove('hidden');
  if (mode === 'FIRST&LAST') {
    if (videoReferences) renderVideoFrameSlots();
  } else if (videoReferences) {
    const selected = state.refs.video.map(id => referenceFileById(id)).filter(Boolean);
    videoReferences.classList.remove('video-frame-strip');
    videoReferences.innerHTML = selected.map(file => `<div class="reference-thumb reference-${file.kind}${file.pendingUpload ? ' pending-reference-thumb' : ''}">${referenceMediaMarkup(file, file.name)}${file.pendingUpload ? '<small>待上传</small>' : ''}<button type="button" class="remove-ref" data-target="video" data-id="${file.id}" aria-label="移除参考素材">×</button></div>`).join('') + (canAddVideoReference ? `<button class="add-reference pick-reference" data-target="video" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>添加</span></button>` : `<button class="add-reference" type="button" disabled><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>不支持</span></button>`);
  }
  $$('.pick-reference').forEach(button => button.onclick = () => openReferenceDialog(button.dataset.target));
  $$('.remove-ref[data-target]').forEach(button => button.onclick = () => {
    const id=button.dataset.id;
    state.refs[button.dataset.target] = state.refs[button.dataset.target].filter(item => item !== id);
    if (button.dataset.target === 'image') removeImagePromptMentionNodes(id);
    if (button.dataset.target === 'video') removeVideoPromptMentionNodes(id);
    if (pendingReferenceJob(id)) removeUploadJob(id);
    if (!videoHasImages()) state.videoGenerationType = 'TEXT';
    renderReferences();
  });
  renderVideoGenerationMode();
  syncVideoModelParameters();
}
function setVideoGenerationType(type) {
  if (!supportsVideoMode(type) || !['REFERENCE', 'FIRST&LAST'].includes(type)) return;
  const current = state.videoGenerationType === 'FIRST&LAST' ? 'FIRST&LAST' : (videoHasImages() ? 'REFERENCE' : videoGenerationParameters().mode);
  if (type === 'FIRST&LAST') {
    if (state.videoPromptMentions.length) return toast('提示词中已引用参考素材，请先移除后再使用首尾帧');
    const imageRefs = state.refs.video.filter(id => referenceFileById(id)?.kind === 'image');
    const [first, last] = imageRefs.slice(0, 2);
    state.videoFrames = { first: first || '', last: last || '' };
  } else if (current === 'FIRST&LAST') {
    state.refs.video = normalizeVideoReferenceIds([state.videoFrames.first, state.videoFrames.last, ...state.refs.video]);
    state.videoFrames = { first:'', last:'' };
  }
  state.videoGenerationType = type;
  renderReferences();
}
function cleanupUncommittedReferenceJobs() {
  const committed = new Set([...state.refs.image, ...state.refs.video, state.videoFrames.first, state.videoFrames.last].filter(Boolean));
  state.uploadJobs.filter(job => job.context === 'reference' && job.deferUpload && !job.assetId && !committed.has(job.id)).map(job => job.id).forEach(removeUploadJob);
}
function restoreReferenceDialogOriginal() {
  if (!referenceDialogOriginal) return;
  if (referenceDialogOriginal.target === 'video-frame') state.videoFrames[referenceDialogOriginal.frame] = referenceDialogOriginal.value || '';
  else if (['image','video'].includes(referenceDialogOriginal.target)) state.refs[referenceDialogOriginal.target] = [...referenceDialogOriginal.value];
}
function openReferenceDialog(target, { mentionRequest = null } = {}) {
  if (target === 'video' && !$('#videoModel').value) return toast('请先选择视频模型');
  if (target === 'video' && !supportsVideoMode('REFERENCE')) return toast('当前模型不支持参考素材');
  if (target === 'video' && videoGenerationParameters().mode === 'FIRST&LAST') return toast('请分别选择首帧和尾帧图片');
  referenceDialogCommitted=false;
  referenceDialogOriginal={ target, value:[...state.refs[target]] };
  imagePromptMentionRequest = target === 'image' ? mentionRequest : null;
  videoPromptMentionRequest = target === 'video' ? mentionRequest : null;
  state.referenceTarget = target; state.videoFrameTarget = ''; state.referenceKind = 'all'; state.dialogSelection = [...state.refs[target]]; renderReferenceDialog(); $('#referenceDialog').showModal(); resetReferenceDialogScroll();
}
function openVideoFrameDialog(frame) {
  if (!supportsVideoFirstLast()) return;
  referenceDialogCommitted=false;
  referenceDialogOriginal={ target:'video-frame', frame, value:state.videoFrames[frame] || '' };
  imagePromptMentionRequest = null;
  videoPromptMentionRequest = null;
  state.referenceTarget = 'video-frame'; state.videoFrameTarget = frame; state.referenceKind = 'all'; state.dialogSelection = state.videoFrames[frame] ? [state.videoFrames[frame]] : []; renderReferenceDialog(); $('#referenceDialog').showModal(); resetReferenceDialogScroll();
}
function closeReferenceDialog() { imagePromptMentionRequest = null; videoPromptMentionRequest = null; $('#referenceDialog').close(); }
$('#closeReference').onclick = $('#cancelReference').onclick = closeReferenceDialog;
$('#referenceDialog').addEventListener('close', () => { if (!referenceDialogCommitted) { restoreReferenceDialogOriginal(); cleanupUncommittedReferenceJobs(); renderReferences(); } referenceDialogCommitted=false; referenceDialogOriginal=null; imagePromptMentionRequest = null; videoPromptMentionRequest = null; });
$('#confirmReference').onclick = () => {
  const pendingCount = state.dialogSelection.filter(id => pendingReferenceJob(id)?.deferUpload).length;
  const mentionRequest = state.referenceTarget === 'image' ? imagePromptMentionRequest : state.referenceTarget === 'video' ? videoPromptMentionRequest : null;
  if (state.referenceTarget === 'video-frame') state.videoFrames[state.videoFrameTarget] = state.dialogSelection[0] || '';
  else state.refs[state.referenceTarget] = [...state.dialogSelection];
  let insertion = null;
  if (mentionRequest) insertion = state.referenceTarget === 'image'
    ? insertImagePromptMentions(state.dialogSelection, mentionRequest)
    : insertVideoPromptMentions(state.dialogSelection, mentionRequest);
  else { imagePromptMentionRequest = null; videoPromptMentionRequest = null; }
  cleanupUncommittedReferenceJobs();
  referenceDialogCommitted=true;
  renderReferences(); $('#referenceDialog').close();
  if (pendingCount) toast(`已加入 ${pendingCount} 个本地素材`);
  if (insertion) restoreVideoPromptFocus(insertion.editor, insertion.range);
};
$('#dialogUpload').onclick = () => openUploadPicker('reference');

function audioCoverMarkup() { return '<div class="reference-audio-cover" aria-hidden="true"><b>♫</b><small>AUDIO</small></div>'; }
function referenceMediaMarkup(file, displayName = file.name) {
  if (file.pendingUpload) return uploadJobMediaMarkup(file);
  if (file.kind === 'image') return assetImageMarkup(file, displayName);
  if (file.kind === 'video') return videoPreviewMarkup(file);
  return audioCoverMarkup();
}
function resetReferenceDialogScroll() {
  const dialog = $('#referenceDialog');
  const grid = $('#referenceGrid');
  if (dialog) dialog.scrollTop = 0;
  if (grid) grid.scrollTop = 0;
}
function renderReferenceDialog() {
  const isFrame = state.referenceTarget === 'video-frame';
  const isVideo = state.referenceTarget === 'video';
  const promptMentionMode = ['image', 'video'].includes(state.referenceTarget) && Boolean(isVideo ? videoPromptMentionRequest : imagePromptMentionRequest);
  const limits = isFrame ? { image: 1, video: 0, audio: 0, total: 1 } : isVideo ? referenceLimits() : { image: 7, video: 0, audio: 0, total: 7 };
  const allowedKinds = isFrame ? new Set(['image']) : isVideo ? referenceFileKinds() : new Set(['image']);
  if (state.referenceKind !== 'all' && !allowedKinds.has(state.referenceKind)) state.referenceKind = 'all';
  const visibleKind = state.referenceKind;
  state.dialogSelection = state.dialogSelection.filter(id => { const file=referenceFileById(id); return file && allowedKinds.has(file.kind); });
  const selectedFiles = state.dialogSelection.map(id => referenceFileById(id)).filter(Boolean);
  const counts = Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, selectedFiles.filter(file => file.kind === kind).length]));
  const totalSelected = state.dialogSelection.length;
  $('#referenceDialog h2').textContent = isFrame ? `选择${state.videoFrameTarget === 'first' ? '首帧' : '尾帧'}图片` : promptMentionMode ? '选择要引用的素材' : '选择参考素材';
  $('#referenceDialog .dialog-help').textContent = isFrame ? '选择一张图片作为视频的当前帧，单张不超过 20 MB。' : `${promptMentionMode ? '所选素材会插入创作描述，并同步添加到下方参考素材区。' : ''}当前模型支持：${referenceCapabilityText(limits)}；单个图片不超过 20 MB，视频或音频不超过 25 MB。`;
  $('#dialogUpload').innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg><span>${isFrame ? '上传首尾帧图片' : '上传素材'}</span>`;
  $('#selectionCount').textContent = isFrame ? `已选择 ${totalSelected} / 1` : `已选择 ${totalSelected} / ${limits.total}（图${counts.image} / 视${counts.video} / 音${counts.audio}）`;
  const confirmLabel = isFrame ? '使用此图片' : promptMentionMode ? '插入并使用所选素材' : '使用所选素材';
  $('#confirmReference').textContent = confirmLabel;
  const kindLabels = { all:'全部', image:'图片', video:'视频', audio:'音频' };
  const kindCounts = Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, state.files.filter(file => file.localStatus !== 'missing' && allowedKinds.has(file.kind) && file.kind === kind).length + state.uploadJobs.filter(job => job.context === 'reference' && !job.deferUpload && allowedKinds.has(job.kind) && job.kind === kind).length]));
  $('#referenceKindFilter').innerHTML = [['all', '全部'], ...['image', 'video', 'audio'].filter(kind => allowedKinds.has(kind)).map(kind => [kind, kindLabels[kind]])].map(([kind, label]) => `<button type="button" role="tab" class="${visibleKind === kind ? 'active' : ''}" data-reference-kind="${kind}" aria-selected="${visibleKind === kind}"><span>${label}</span><small>${kind === 'all' ? kindCounts.image + kindCounts.video + kindCounts.audio : kindCounts[kind]}</small></button>`).join('');
  $$('#referenceKindFilter [data-reference-kind]').forEach(button => button.onclick = () => { state.referenceKind = button.dataset.referenceKind; renderReferenceDialog(); });
  const uploadJobs = state.uploadJobs.filter(job => job.context === 'reference');
  const pendingJobs = uploadJobs.filter(job => job.deferUpload && allowedKinds.has(job.kind) && (visibleKind === 'all' || job.kind === visibleKind));
  const uploadingAssetIds = new Set(uploadJobs.map(job => job.assetId).filter(Boolean));
  const pendingMarkup = pendingJobs.map(job => {
    const file=pendingReferenceFile(job); const selected=state.dialogSelection.includes(job.id); const status=job.status === 'failed' ? '素材不可用，请重新选择' : '已选择';
    return `<button class="reference-option pending-reference-option ${selected ? 'selected' : ''} ${job.status === 'failed' ? 'failed' : ''}" data-id="${esc(job.id)}" type="button">${referenceMediaMarkup(file, file.name)}<span>${esc(file.name)}<small>${esc(status)}</small></span><i>✓</i></button>`;
  }).join('');
  const uploadMarkup = uploadJobs.filter(job => !job.deferUpload && (visibleKind === 'all' || job.kind === visibleKind)).map(job => uploadJobCard(job, 'reference')).join('');
  const pendingLocalAssetIds = new Set(pendingJobs.map(job => job.localAssetId).filter(Boolean));
  const files = state.files.filter(file => file.localStatus !== 'missing' && allowedKinds.has(file.kind) && (visibleKind === 'all' || file.kind === visibleKind) && (file.localOnly ? Boolean(window.guguDesktop) && !pendingLocalAssetIds.has(file.localId || file.id) : !uploadingAssetIds.has(file.id)));
  const fileMarkup = files.map(file => `<button class="reference-option ${state.dialogSelection.includes(file.id) ? 'selected' : ''}" data-id="${file.id}" type="button">${referenceMediaMarkup(file, file.name)}<span>${esc(file.name)}</span><i>✓</i></button>`).join('');
  $('#referenceGrid').innerHTML = pendingMarkup + uploadMarkup + (fileMarkup || pendingMarkup || uploadMarkup ? fileMarkup : emptyState('没有可用参考素材', '先上传当前模型支持的素材类型。'));
  $$('.reference-option').forEach(button => button.onclick = () => {
    let id = button.dataset.id;
    let file = referenceFileById(id);
    if (!file) {
      const local = state.files.find(item => item.id === id && item.localOnly);
      if (!local) return;
      const localAssetId = local.localId || local.id;
      const existingJob = state.uploadJobs.find(job => job.context === 'reference' && job.deferUpload && job.localAssetId === localAssetId);
      const job = existingJob || createUploadJob({ name:local.name, size:local.size, type:local.mimeType }, 'reference', { previewUrl:local.url, mimeType:local.mimeType, deferUpload:true, localAssetId });
      id = job.id; file = pendingReferenceFile(job);
    }
    if (!file || !allowedKinds.has(file.kind)) return toast('该素材不符合当前创作模式');
    if (state.dialogSelection.includes(id)) {
      state.dialogSelection = state.dialogSelection.filter(item => item !== id);
      if (pendingReferenceJob(id)) {
        if (state.referenceTarget === 'video-frame' && state.videoFrames[state.videoFrameTarget] === id) state.videoFrames[state.videoFrameTarget] = '';
        else if (['image','video'].includes(state.referenceTarget)) state.refs[state.referenceTarget] = state.refs[state.referenceTarget].filter(item => item !== id);
      }
    } else if (totalSelected >= limits.total) return toast(`参考素材最多选择 ${limits.total} 个`);
    else if ((counts[file.kind] || 0) >= (limits[file.kind] || 0)) return toast(`参考${file.kind === 'image' ? '图片' : file.kind === 'video' ? '视频' : '音频'}最多选择 ${limits[file.kind] || 0} 个`);
    else {
      state.dialogSelection.push(id);
      if (file.pendingUpload) projectPendingReferenceToCreation(pendingReferenceJob(id));
    }
    renderReferenceDialog();
  });
}

$$('.segmented').forEach(group => group.querySelectorAll('button').forEach(button => button.onclick = () => { group.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === button)); $(`#${group.dataset.select}`).value = button.dataset.value; }));
$$('.ratio-grid').forEach(group => group.querySelectorAll('button[data-value]').forEach(button => button.onclick = () => { group.querySelectorAll('button[data-value]').forEach(x => { const active = x === button; x.classList.toggle('selected', active); x.setAttribute('aria-selected', String(active)); }); $(`#${group.dataset.select}`).value = button.dataset.value; }));
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
  { id:'grok', label:'GuGu 1.5', description:'全能视频模型，支持最长20秒视频，7张参考图', modes:[
    { generationType:'TEXT', aspectRatios:['2:3','3:2','1:1','9:16','16:9'], durations:[10,15,20], qualityOptions:['480p','720p'], pricing:{ currency:'credit', amount:1.5, unit:'second' }, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['2:3','3:2','1:1','9:16','16:9'], durations:[10,15,20], qualityOptions:['480p','720p'], pricing:{ currency:'credit', amount:1.5, unit:'second' }, minImages:1, maxImages:7 },
  ] },
  // Front-end fallback: route to the upstream model selected by resolution.
  { id:'seedance-2.0', label:'Seedance 2.0', description:'支持 15 秒、1:1/16:9/9:16 文生视频与参考图视频', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16','1:1'], durations:[15], qualityOptions:['480p','720p'], referenceLimits:{image:9,video:3,audio:3,total:15}, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16','1:1'], durations:[15], qualityOptions:['480p','720p'], referenceLimits:{image:9,video:3,audio:3,total:15}, minImages:1, maxImages:9 },
  ] },
  { id:'seedance-2.5', label:'Seedance 2.5', description:'固定 30 秒，支持 480p/720p 与多模态参考素材', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16','1:1'], durations:[30], qualityOptions:['480p','720p'], referenceLimits:{image:30,video:10,audio:10,total:50}, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16','1:1'], durations:[30], qualityOptions:['480p','720p'], referenceLimits:{image:30,video:10,audio:10,total:50}, minImages:1, maxImages:30 },
  ] },
  { id:'seedance-2.0-fast', label:'Seedance 2.0 Fast', description:'固定 15 秒、720p，支持 9 张图片 + 3 段视频 + 3 段音频参考', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','1:1','9:16'], durations:[15], qualityOptions:['720p'], referenceLimits:{image:9,video:3,audio:3,total:15}, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','1:1','9:16'], durations:[15], qualityOptions:['720p'], referenceLimits:{image:9,video:3,audio:3,total:15}, minImages:1, maxImages:9 },
  ] },
  { id:'minimax-h3', label:'MiniMax H3', description:'支持 768p 与 2K，4～15 秒视频', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16','1:1','21:9','4:3','3:4'], durations:[4,5,6,7,8,9,10,11,12,13,14,15], qualityOptions:['768p','2k'], pricingByQuality:{'768p':{currency:'credit',amount:2,unit:'second'},'2k':{currency:'credit',amount:3,unit:'second'}}, referenceLimits:{image:5,video:3,audio:3,total:15}, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16','1:1','21:9','4:3','3:4'], durations:[4,5,6,7,8,9,10,11,12,13,14,15], qualityOptions:['768p','2k'], pricingByQuality:{'768p':{currency:'credit',amount:2,unit:'second'},'2k':{currency:'credit',amount:3,unit:'second'}}, referenceLimits:{image:5,video:3,audio:3,total:15}, minImages:1, maxImages:5 },
    { generationType:'FIRST&LAST', aspectRatios:['16:9','9:16','1:1','21:9','4:3','3:4'], durations:[4,5,6,7,8,9,10,11,12,13,14,15], qualityOptions:['768p','2k'], pricingByQuality:{'768p':{currency:'credit',amount:2,unit:'second'},'2k':{currency:'credit',amount:3,unit:'second'}}, minImages:1, maxImages:2 },
  ] },
  // Front-end fallback: Omni Flash supports TEXT and REFERENCE only.
  { id:'oai', label:'Omni Flash', description:'Google 最新视频模型，高质量，英文支持效果好', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16'], durations:[10], qualityOptions:['720p'], minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16'], durations:[10], qualityOptions:['720p'], minImages:1, maxImages:5 },
  ] },
  // Front-end fallback: Veo 3.1 supports TEXT, REFERENCE and FIRST&LAST.
  { id:'veo-31', label:'Veo 3.1', description:'支持首尾帧、支持1080P', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16'], durations:[8], qualityOptions:['720p','1080p'], minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9'], durations:[8], qualityOptions:['720p','1080p'], minImages:1, maxImages:3 },
    { generationType:'FIRST&LAST', aspectRatios:['16:9','9:16'], durations:[8], qualityOptions:['720p','1080p'], minImages:1, maxImages:2 },
  ] },
  // Front-end fallback: GuGu 2.0 is available through the AutoDL workflow.
  { id:'minimax-h3-15s', label:'GuGu 2.0', description:'支持最多 9 张参考图片 + 3 段参考音频，1～15 秒视频生成', modes:[
    { generationType:'TEXT', aspectRatios:['16:9','9:16'], durations:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], qualityOptions:['768p','480p'], pricing:{ currency:'credit', amount:0.5, unit:'second' }, referenceLimits:{image:9,video:0,audio:3,total:12}, minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['16:9','9:16'], durations:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], qualityOptions:['768p','480p'], pricing:{ currency:'credit', amount:0.5, unit:'second' }, referenceLimits:{image:9,video:0,audio:3,total:12}, minImages:1, maxImages:9 },
  ] },
  // Front-end fallback: Veo 3.1 Fast is coming soon and cannot be selected.
  { id:'veo', label:'Veo 3.1 Fast', description:'支持首尾帧模式，固定8秒，速度快', availability:'coming-soon', modes:[
    { generationType:'TEXT', aspectRatios:['2:3','3:2','1:1','9:16','16:9'], durations:[8], qualityOptions:['720p'], minImages:0, maxImages:0 },
    { generationType:'REFERENCE', aspectRatios:['2:3','3:2','1:1','16:9'], durations:[8], qualityOptions:['720p'], minImages:1, maxImages:3 },
    { generationType:'FIRST&LAST', aspectRatios:['16:9','9:16'], durations:[8], qualityOptions:['720p'], minImages:1, maxImages:2 },
  ] },
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
    .map(model => model.id === 'grok'
      ? { ...model, modes: model.modes?.map(mode => ({ ...mode, durations: mode.durations?.filter(value => Number(value) !== 30) })) }
      : model)
    .sort((a, b) => {
      const aIsGugu2 = a.id === 'minimax-h3-15s';
      const bIsGugu2 = b.id === 'minimax-h3-15s';
      if (aIsGugu2 !== bIsGugu2) return Number(bIsGugu2) - Number(aIsGugu2);
      return Number(a.availability === 'coming-soon') - Number(b.availability === 'coming-soon');
    });
}
function videoModelParameters(modelId, generationType) { return videoModelOptions().find(model => model.id === modelId)?.modes?.find(mode => mode.generationType === generationType) || null; }
function videoModelPromo(modelId) { return modelId === 'minimax-h3-15s' ? '限时特惠 ¥0.05/s' : ''; }
const modelIconUrls = Object.freeze({ 'gpt-image-2':'/favicon.svg?v=2', grok:'/favicon.svg?v=2', 'minimax-h3-15s':'/favicon.svg?v=2', veo:'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg', oai:'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg', 'veo-31':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg', 'minimax-h3':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/minimax-color.svg', 'seedance-2.0':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg', 'seedance-2.5':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg', 'seedance-2.0-fast':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg' });
function modelIcon(modelId) { const src = modelIconUrls[modelId]; return src ? `<img class="select-model-icon" src="${src}" alt="" aria-hidden="true">` : clockIcon(); }
function productSelectIcon(widget, option) { return widget.dataset.model ? modelIcon(option.value) : widget.dataset.ratio ? ratioIcon(option.value) : widget.dataset.resolution ? resolutionIcon(option.value) : clockIcon(); }
function modelTitleMarkup(widget, option) { const model = widget?.dataset.model ? videoModelOptions().find(item => item.id === option?.value) : null; const promo = model ? videoModelPromo(model.id) : ''; return `<span class="select-model-title"><b>${esc(option?.textContent || '')}</b>${promo ? `<em class="model-promo">${promo}</em>` : ''}</span>`; }
function productSelectMarkup(widget, select) { return [...select.options].map(option => { const comingSoon = widget.dataset.model && option.dataset.availability === 'coming-soon'; const model = widget.dataset.model ? videoModelOptions().find(item => item.id === option.value) : null; return `<button type="button" role="option" aria-selected="${option.selected}" data-value="${esc(option.value)}" ${option.disabled ? 'disabled' : ''}>${productSelectIcon(widget, option)}<span class="select-option-label">${modelTitleMarkup(widget, option)}${model?.description ? `<small class="select-model-description">${esc(model.description)}</small>` : ''}${comingSoon ? '<small>即将上线</small>' : ''}</span><i>✓</i></button>`; }).join(''); }
function selectSubtitle(widget, option = null) { if (!widget?.dataset.model) return ''; const selected = option || $(`#${widget.dataset.for}`)?.selectedOptions[0]; const model = selected ? videoModelOptions().find(item => item.id === selected.value) : null; return model?.description ? `<small class="select-model-description">${esc(model.description)}</small>` : ''; }
function refreshProductSelect(id) { const select = $(`#${id}`); const widget = $(`.product-select[data-for="${id}"]`); if (!select || !widget) return; const option = select.selectedOptions[0]; const trigger = widget.querySelector('.product-select-trigger'); const menu = widget.querySelector('.product-select-menu'); if (!option || !trigger || !menu) return; trigger.innerHTML = `${productSelectIcon(widget, option)}<span>${modelTitleMarkup(widget, option)}${selectSubtitle(widget, option)}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>`; widget.querySelectorAll('[role="option"]').forEach(item => item.setAttribute('aria-selected', String(item.dataset.value === select.value))); if (widget.dataset.dynamicOptions === 'true') menu.innerHTML = productSelectMarkup(widget, select); }
function setProductSelectEnabled(id, enabled) { const select = $(`#${id}`); const widget = $(`.product-select[data-for="${id}"]`); if (!select || !widget) return; select.disabled = !enabled; const trigger = widget.querySelector('.product-select-trigger'); if (trigger) trigger.disabled = !enabled; widget.classList.toggle('is-disabled', !enabled); if (!enabled) closeProductSelects(); }
function setVideoSelectOptions(id, values, label, preferred, { preserveCurrent = true } = {}) { const select = $(`#${id}`); const widget = $(`.product-select[data-for="${id}"]`); if (!select || !widget) return; const current = select.value; const options = Array.isArray(values) ? values : []; select.innerHTML = options.map(value => `<option value="${esc(value)}">${esc(label(value))}</option>`).join(''); const supported = options.map(String); const desired = preserveCurrent && supported.includes(String(current)) ? current : supported.includes(String(preferred)) ? String(preferred) : String(options[0] || ''); select.value = desired; widget.dataset.dynamicOptions = 'true'; refreshProductSelect(id); }
function syncVideoModelOptions() { const select = $('#videoModel'); const widget = $('.product-select[data-for="videoModel"]'); if (!select || !widget) return; const current = select.value; const models = videoModelOptions(); select.innerHTML = models.map(model => `<option value="${esc(model.id)}" ${model.availability === 'coming-soon' ? 'disabled data-availability="coming-soon"' : ''}>${esc(model.label)}</option>`).join(''); const selectableModels = models.filter(model => model.availability !== 'coming-soon'); select.value = selectableModels.some(model => model.id === current) ? current : String(selectableModels[0]?.id || ''); widget.dataset.dynamicOptions = 'true'; refreshProductSelect('videoModel'); syncVideoModelParameters(); }
function syncVideoModelParameters({ reset = false } = {}) {
  const modelId = $('#videoModel')?.value || '';
  const modes = videoModelModes(modelId);
  const { mode:generationType, parameters } = videoGenerationParameters(modelId);
  renderVideoGenerationMode();
  if (!parameters) { setProductSelectEnabled('videoAspect', false); setProductSelectEnabled('videoDuration', false); setProductSelectEnabled('videoResolution', false); syncVideoPromptState(); updateVideoCost(); return; }
  const durations = parameters.durations;
  const qualities = parameters.qualityOptions;
  const preserveCurrent = !reset;
  setVideoSelectOptions('videoAspect', parameters.aspectRatios, value => value, '16:9', { preserveCurrent });
  setVideoSelectOptions('videoDuration', durations, value => `${value} 秒`, modelId === 'grok' ? 10 : modelId === 'minimax-h3-15s' ? 5 : modelId === 'veo' || modelId === 'veo-31' ? 8 : 10, { preserveCurrent });
  setVideoSelectOptions('videoResolution', qualities, value => value, modelId === 'minimax-h3-15s' || modelId === 'minimax-h3' ? '768p' : '720p', { preserveCurrent });
  setProductSelectEnabled('videoAspect', true); setProductSelectEnabled('videoDuration', true); setProductSelectEnabled('videoResolution', true);
  syncVideoPromptState(); updateVideoCost();
}
function closeProductSelects(except=null) { $$('.product-select').forEach(widget => { if (widget === except) return; widget.querySelector('.product-select-menu')?.classList.add('hidden'); widget.querySelector('.product-select-trigger')?.setAttribute('aria-expanded', 'false'); }); }
$$('.product-select').forEach(widget => { const select = $(`#${widget.dataset.for}`); const trigger = widget.querySelector('.product-select-trigger'); const menu = widget.querySelector('.product-select-menu'); if (!select || !trigger || !menu) return; const renderTrigger = () => { const option = select.selectedOptions[0]; if (!option) return; trigger.innerHTML = `${productSelectIcon(widget, option)}<span>${modelTitleMarkup(widget, option)}${selectSubtitle(widget, option)}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5-5 5"/></svg>`; }; menu.innerHTML = productSelectMarkup(widget, select); const choose = value => { select.value = value; menu.querySelectorAll('[role="option"]').forEach(item => item.setAttribute('aria-selected', item.dataset.value === value)); renderTrigger(); closeProductSelects(); select.dispatchEvent(new Event('change', { bubbles:true })); }; menu.querySelectorAll('[role="option"]').forEach(item => item.onclick = () => choose(item.dataset.value)); trigger.onclick = event => { event.stopPropagation(); const opening = menu.classList.contains('hidden'); closeProductSelects(opening ? widget : null); menu.classList.toggle('hidden', !opening); trigger.setAttribute('aria-expanded', String(opening)); if (opening) menu.querySelector(`[data-value="${CSS.escape(select.value)}"]`)?.focus(); }; trigger.onkeydown = event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); const options = [...menu.querySelectorAll('button')]; (event.key === 'ArrowDown' ? options[0] : options.at(-1))?.focus(); } }; menu.onkeydown = event => { const options = [...menu.querySelectorAll('button')]; const index = options.indexOf(document.activeElement); if (event.key === 'Escape') { closeProductSelects(); trigger.focus(); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); } }; renderTrigger(); });
document.addEventListener('click', event => { if (!event.target.closest('.product-select')) closeProductSelects(); });
document.addEventListener('click', event => { const option = event.target.closest('.product-select[data-dynamic-options="true"] .product-select-menu [role="option"]'); if (!option || option.disabled) return; const widget = option.closest('.product-select'); const select = $(`#${widget.dataset.for}`); if (!select) return; select.value = option.dataset.value; refreshProductSelect(widget.dataset.for); closeProductSelects(); select.dispatchEvent(new Event('change', { bubbles:true })); });
const imagePromptMaxLength = 5000;
const videoPromptMaxLength = 4096;
function videoPromptLimit(modelId=$('#videoModel')?.value) { return modelId === 'minimax-h3-15s' ? 10000 : videoPromptMaxLength; }
const promptMaxHeight = 200;
function autoResizePrompt(prompt) { if (!prompt) return; prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, promptMaxHeight)}px`; }
function syncImagePromptState() { const prompt = imagePromptEditor(); autoResizePrompt(prompt); const count = Array.from(imagePromptText()).length; const countElement = $('#imagePromptCount'); const overLimit = count > imagePromptMaxLength; countElement.textContent = count; countElement.classList.toggle('over-limit', overLimit); prompt.setAttribute('aria-invalid', String(overLimit)); prompt.dataset.maxLength = String(imagePromptMaxLength); $('#imageForm .generate').disabled = overLimit; }
function syncVideoPromptState() {
  const prompt = videoPromptEditor();
  autoResizePrompt(prompt);
  const count = Array.from(videoPromptText()).length;
  const countElement = $('#videoPromptCount');
  const maxLength = videoPromptLimit();
  $('#videoPromptLimit').textContent = maxLength;
  const overLimit = count > maxLength;
  const { mode } = videoGenerationParameters();
  const missingImages = mode === 'REFERENCE' ? state.refs.video.length === 0 : mode === 'FIRST&LAST' ? !state.videoFrames.first : false;
  countElement.textContent = count;
  countElement.classList.toggle('over-limit', overLimit);
  prompt.setAttribute('aria-invalid', String(overLimit));
  prompt.dataset.maxLength = String(maxLength);
  $('#videoForm .generate').disabled = overLimit || !$('#videoModel').value || missingImages;
}
function syncImagePromptInput() {
  const prompt = imagePromptEditor();
  const previousReferenceIds = [...state.refs.image];
  normalizeEmptyImagePrompt(prompt);
  syncImagePromptMentionsFromEditor();
  syncImagePromptState();
  if (previousReferenceIds.length !== state.refs.image.length || previousReferenceIds.some(id => !state.refs.image.includes(id))) renderReferences();
  if (imagePromptMentionRequest || !videoPromptTriggerAtCaret(prompt)) return;
  const selection = window.getSelection();
  imagePromptMentionRequest = { editor:prompt, range:selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null };
  openReferenceDialog('image', { mentionRequest:imagePromptMentionRequest });
}
$('#imagePrompt').addEventListener('compositionstart', () => { $('#imagePrompt').dataset.composing = 'true'; });
$('#imagePrompt').addEventListener('compositionend', () => {
  const editor = imagePromptEditor();
  editor.dataset.composing = 'false';
  cancelAnimationFrame(imagePromptCompositionFrame);
  imagePromptCompositionFrame = requestAnimationFrame(() => syncImagePromptInput());
});
$('#imagePrompt').addEventListener('keydown', event => { removeImagePromptMentionAtCaret(imagePromptEditor(), event); });
$('#imagePrompt').oninput = event => {
  const editor = imagePromptEditor();
  if (event.isComposing || event.inputType === 'insertCompositionText' || editor.dataset.composing === 'true') return;
  syncImagePromptInput();
};
function syncVideoPromptInput() {
  const prompt = videoPromptEditor();
  const previousReferenceIds = [...state.refs.video];
  normalizeEmptyVideoPrompt(prompt);
  syncVideoPromptMentionsFromEditor();
  syncVideoPromptState();
  if (previousReferenceIds.length !== state.refs.video.length || previousReferenceIds.some(id => !state.refs.video.includes(id))) renderReferences();
  if (videoPromptMentionRequest || !videoPromptTriggerAtCaret(prompt)) return;
  const selection = window.getSelection();
  videoPromptMentionRequest = { editor:prompt, range:selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null };
  openReferenceDialog('video', { mentionRequest:videoPromptMentionRequest });
}
$('#videoPrompt').addEventListener('compositionstart', () => { $('#videoPrompt').dataset.composing = 'true'; });
$('#videoPrompt').addEventListener('compositionend', () => {
  const editor = $('#videoPrompt');
  editor.dataset.composing = 'false';
  cancelAnimationFrame(videoPromptCompositionFrame);
  videoPromptCompositionFrame = requestAnimationFrame(() => syncVideoPromptInput());
});
$('#videoPrompt').addEventListener('keydown', event => { removeVideoPromptMentionAtCaret($('#videoPrompt'), event); });
$('#videoPrompt').oninput = event => {
  const editor = $('#videoPrompt');
  if (event.isComposing || event.inputType === 'insertCompositionText' || editor.dataset.composing === 'true') return;
  syncVideoPromptInput();
};
function replacePendingReferenceId(oldId, newId) {
  const replace = ids => ids.map(id => id === oldId ? newId : id);
  state.refs.image=replace(state.refs.image);
  state.refs.video=replace(state.refs.video);
  if (state.videoFrames.first === oldId) state.videoFrames.first=newId;
  if (state.videoFrames.last === oldId) state.videoFrames.last=newId;
  state.dialogSelection=replace(state.dialogSelection);
  state.imagePromptMentions=state.imagePromptMentions.map(item => item.id === oldId ? { ...item, id:newId } : item);
  state.videoPromptMentions=state.videoPromptMentions.map(item => item.id === oldId ? { ...item, id:newId } : item);
  $('#imagePrompt')?.querySelectorAll(`[data-image-prompt-mention-id="${CSS.escape(oldId)}"]`).forEach(node => { node.dataset.imagePromptMentionId=newId; });
  $('#videoPrompt')?.querySelectorAll(`[data-video-prompt-mention-id="${CSS.escape(oldId)}"]`).forEach(node => { node.dataset.videoPromptMentionId=newId; });
}
async function uploadPendingReferenceJob(job) {
  if (!job) throw new Error('参考素材不存在，请重新选择');
  const existing=job.assetId ? state.files.find(file => file.id === job.assetId) : null;
  if (existing && !existing.localOnly) return existing;
  if (!job.localAssetId || !window.guguDesktop?.media?.syncLocal) throw new Error(`${job.name} 未准备好，请重新选择`);
  updateUploadJob(job, 8, '正在同步到云端');
  const result=await window.guguDesktop.media.syncLocal({ assetId:job.localAssetId });
  const cloudAsset=cloudAssetFromDesktopSync(result);
  if (!cloudAsset?.id) throw new Error('云端素材记录创建失败');
  const file={ ...cloudAsset, url:result.url, remoteUrl:cloudAsset.url, localStatus:'saved', localPath:result.relativePath, sha256:cloudAsset.sha256 };
  finishUploadJob(job, file, false);
  return file;
}
async function resolveReferenceAssetIds(ids) {
  const resolved=[];
  for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
    const file=state.files.find(item => item.id === id);
    if (isRemoteReferenceReady(file)) { resolved.push(file.id); continue; }
    if (needsReferenceUpload(file)) {
      const localAssetId=file.localId || (file.localOnly ? file.id : '');
      if (!localAssetId || !window.guguDesktop?.media?.syncLocal) throw new Error('参考素材仅保存在原桌面设备，请重新上传后再创作');
      const result=await window.guguDesktop.media.syncLocal({ assetId:localAssetId, uploadForReference:true });
      const cloudAsset=cloudAssetFromDesktopSync(result);
      if (!cloudAsset?.id || cloudAsset.remoteStatus === 'local_only') throw new Error('参考素材同步到云端失败，请重新上传后再试');
      const syncedFile={ ...cloudAsset, url:result.url || file.url, remoteUrl:cloudAsset.url, localStatus:'saved', localPath:result.relativePath || file.localPath, sha256:cloudAsset.sha256 || file.sha256 };
      state.files=[syncedFile,...state.files.filter(item=>item.id!==syncedFile.id)];
      replacePendingReferenceId(id, syncedFile.id);
      resolved.push(syncedFile.id);
      continue;
    }
    const job=pendingReferenceJob(id);
    if (!job) throw new Error('参考素材不存在，请重新选择');
    const asset=await uploadPendingReferenceJob(job);
    replacePendingReferenceId(id, asset.id);
    resolved.push(asset.id);
  }
  renderReferences();
  return [...new Set(resolved)];
}
function hasUnresolvedReference(ids=currentVideoReferenceIds()) { return ids.some(id => { const file=state.files.find(item => item.id === id); return Boolean(pendingReferenceJob(id) || needsReferenceUpload(file)); }); }
function referenceCountsForIds(ids) {
  const files = [...new Set(Array.isArray(ids) ? ids : [])].map(referenceFileById).filter(Boolean);
  return Object.fromEntries(['image','video','audio'].map(kind => [kind, files.filter(file => file.kind === kind).length]));
}
async function submitGeneration(type, form, payload) {
  if (generationSubmissionForms.has(form)) return;
  generationSubmissionForms.add(form);
  const requestAccount = accountScope.snapshot();
  const requestedReferenceIds = type === 'video' ? (payload.referenceAssetIds || []) : state.refs[type];
  const referenceCounts = referenceCountsForIds(requestedReferenceIds);
  const deferredReferences = hasUnresolvedReference(requestedReferenceIds);
  const routedVideo = type === 'video' && ['seedance-2.0','seedance-2.0-fast','seedance-2.5'].includes(payload.modelId);
  const quoteInput = type === 'video' ? { modelId:payload.modelId, aspectRatio:payload.aspectRatio, duration:payload.duration, quality:payload.quality, generationType:payload.generationType, referenceAssetIds:[], referenceCounts } : null;
  const quoteSignature = quoteInput ? JSON.stringify(quoteInput) : '';
  const preparationCount = type === 'image' ? Math.max(1, Number(payload.quantity) || 1) : 1;
  const preparationGroupId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const initialStage = routedVideo && state.modelQuote?.signature !== quoteSignature ? 'confirming_price' : 'submitting';
  const preparations = Array.from({ length:preparationCount }, (_, index) => ({ id:`local-preparation-${preparationGroupId}-${index + 1}`, type, status:'running', progressStage:initialStage, prompt:payload.prompt, createdAt, localPreparation:true }));
  const preparationIds = new Set(preparations.map(item => item.id));
  const setPreparationStage = progressStage => {
    state.generationPreparations = state.generationPreparations.map(item => preparationIds.has(item.id) ? { ...item, progressStage } : item);
    renderTasks();
  };
  state.generationPreparations = [...preparations, ...state.generationPreparations];
  renderTasks();
  let chargedTasks = [];
  try {
    let expectedPriceVersion = '';
    if (routedVideo) {
      if (state.modelQuote?.signature !== quoteSignature) {
        const quote=await api('/api/model-quote', { method:'POST', body:JSON.stringify(quoteInput) });
        if (!accountScope.isCurrent(requestAccount)) return;
        state.modelQuote={ ...quote, signature:quoteSignature };
      }
      expectedPriceVersion=state.modelQuote.priceVersion || '';
    }
    setPreparationStage('submitting');
    const requestId = crypto.randomUUID();
    const referenceAssetIds = deferredReferences ? [] : requestedReferenceIds;
    const result = await api('/api/generations', { method:'POST', headers:{ 'Idempotency-Key':requestId }, body:JSON.stringify({ type, ...payload, referenceAssetIds, requestId, ...(deferredReferences ? { deferReferenceUpload:true, referenceCounts } : {}), ...(expectedPriceVersion ? { expectedPriceVersion } : {}) }) });
    if (!accountScope.isCurrent(requestAccount)) return;
    const tasks = Array.isArray(result.tasks) ? result.tasks : [result];
    chargedTasks = tasks;
    state.generationPreparations = state.generationPreparations.filter(item => !preparationIds.has(item.id));
    state.tasks = [...tasks, ...state.tasks.filter(item => !tasks.some(task => task.id === item.id))];
    mergeTasksIntoLoadedHistory(tasks);
    renderTasks();
    setCreditBalance(result.balance);
    if (type === 'video') setVideoPromptText(''); else setImagePromptText('');
    (type === 'video' ? videoPromptEditor() : imagePromptEditor()).dispatchEvent(new Event('input', { bubbles:true }));
    state.refs[type] = [];
    if (type === 'video') { state.videoFrames = { first:'', last:'' }; state.modelQuote = null; }
    renderReferences();
    const totalCost = tasks.reduce((sum, task) => sum + (Number(task.creditCost) || 0), 0);
    toast(tasks.length > 1 ? `已提交 ${tasks.length} 个图像任务，预扣 ${creditText(totalCost)} 积分` : `已提交，扣除 ${tasks[0].creditCost} 积分`);
    if (deferredReferences) {
      const uploadedReferenceAssetIds = await resolveReferenceAssetIds(requestedReferenceIds);
      if (!accountScope.isCurrent(requestAccount)) return;
      const completed = await api('/api/generations/references/complete', { method:'POST', body:JSON.stringify({ taskIds:tasks.map(task => task.id), referenceAssetIds:uploadedReferenceAssetIds }) });
      if (!accountScope.isCurrent(requestAccount)) return;
      const startedTasks = Array.isArray(completed.tasks) ? completed.tasks : [];
      state.tasks = [...startedTasks, ...state.tasks.filter(item => !startedTasks.some(task => task.id === item.id))];
      mergeTasksIntoLoadedHistory(startedTasks);
      renderTasks();
    }
    await loadTasks();
  } catch (error) {
    if (!accountScope.isCurrent(requestAccount)) return;
    state.generationPreparations = state.generationPreparations.filter(item => !preparationIds.has(item.id));
    if (chargedTasks.length) {
      try {
        const cancelled = await api('/api/generations/references/cancel', { method:'POST', body:JSON.stringify({ taskIds:chargedTasks.map(task => task.id), error:`素材准备失败：${error.message}` }) });
        const failedTasks = Array.isArray(cancelled.tasks) ? cancelled.tasks : [];
        failedTasks.forEach(task => observeTaskFailure(task, state.tasks.find(item => item.id === task.id) || null, { force:true }));
        state.tasks = [...failedTasks, ...state.tasks.filter(item => !failedTasks.some(task => task.id === item.id))];
        mergeTasksIntoLoadedHistory(failedTasks);
        setCreditBalance(cancelled.balance);
      } catch (cancelError) { console.warn('[generation] 素材准备失败后的退款请求未完成', cancelError); }
    }
    renderTasks(); renderReferences(); toast(error.message); await loadCredits();
  }
  finally { generationSubmissionForms.delete(form); if (type === 'image') { syncImagePromptState(); updateImageCost(); } else { syncVideoPromptState(); updateVideoCost(); } }
}
$('#imageForm').onsubmit = event => { event.preventDefault(); syncImagePromptInput(); const prompt = imagePromptText(); if (!prompt.trim()) return toast('请填写创作描述'); if (Array.from(prompt).length > imagePromptMaxLength) return; const quantity = commitImageQuantity($('#imageQuantity').value); submitGeneration('image', event.currentTarget, { prompt:replaceAssetMentions(prompt, state.imagePromptMentions), size:$('#imageSize').value, quality:$('#imageQuality').value, quantity }); };
$('#imageQuantity').oninput = () => { const input = $('#imageQuantity'); const value = imageQuantityValue(input.value); if (value !== null) input.value = String(value); updateImageCost(); };
$('#imageQuantity').onchange = () => commitImageQuantity($('#imageQuantity').value);
$('#imageQuantityDecrease').onclick = () => changeImageQuantity(-1);
$('#imageQuantityIncrease').onclick = () => changeImageQuantity(1);
$('#videoForm').onsubmit = event => {
  event.preventDefault();
  syncVideoPromptState();
  const prompt = videoPromptText();
  if (!$('#videoModel').value) return toast('请先选择视频模型');
  if (!prompt.trim()) { toast('请填写创作描述'); videoPromptEditor().focus(); return; }
  if (Array.from(prompt).length > videoPromptLimit()) return;
  syncVideoModelParameters();
  const input = currentVideoFormInput();
  if (!input) return toast('当前模型的创作参数已变化，请重新选择时长、画幅和清晰度');
  const referenceAssetIds = input.generationType === 'FIRST&LAST' ? [state.videoFrames.first, state.videoFrames.last].filter(Boolean) : state.refs.video;
  submitGeneration('video', event.currentTarget, { prompt:replaceAssetMentions(prompt, state.videoPromptMentions), ...input, referenceAssetIds });
};
const imageQuantityMin = 1;
const imageQuantityMax = 10;
function imageQuantityValue(value) { const text = String(value ?? '').trim(); if (!text) return null; const quantity = Number(text); return Number.isInteger(quantity) ? Math.min(imageQuantityMax, Math.max(imageQuantityMin, quantity)) : null; }
function updateImageQuantityButtons(value=imageQuantityValue($('#imageQuantity')?.value)) { const quantity = value ?? imageQuantityMin; $('#imageQuantityDecrease').disabled = quantity <= imageQuantityMin; $('#imageQuantityIncrease').disabled = quantity >= imageQuantityMax; }
function updateImageCost() { const cost = $('#imageCost'); const quantity = $('#imageQuantity'); if (!cost || !quantity) return; const count = imageQuantityValue(quantity.value) ?? imageQuantityMin; cost.textContent = creditText(count * (Number(state.pricing.image) || 1)); updateImageQuantityButtons(count); }
function commitImageQuantity(value) { const input = $('#imageQuantity'); const quantity = imageQuantityValue(value) ?? imageQuantityMin; input.value = String(quantity); updateImageCost(); return quantity; }
function changeImageQuantity(delta) { const input = $('#imageQuantity'); const current = imageQuantityValue(input.value) ?? imageQuantityMin; commitImageQuantity(current + delta); }
function videoPricingFor(modelId, parameters, quality) {
  const selectedPricing = parameters?.pricingByQuality?.[quality] || parameters?.pricing;
  if (selectedPricing) return selectedPricing;
  if (modelId === 'minimax-h3') {
    if (quality === '768p') return { currency:'credit', amount:2, unit:'second' };
    if (quality === '2k') return { currency:'credit', amount:3, unit:'second' };
  }
  return null;
}
let videoQuoteTimer = 0;
let videoQuoteSequence = 0;
function currentVideoReferenceIds() { const mode = videoGenerationParameters().mode; return mode === 'FIRST&LAST' ? [state.videoFrames.first, state.videoFrames.last].filter(Boolean) : state.refs.video; }
function currentVideoFormInput() {
  const modelId = $('#videoModel')?.value || '';
  const { mode, parameters } = videoGenerationParameters(modelId);
  if (!modelId || !parameters) return null;
  const aspectRatio = String($('#videoAspect')?.value || '').trim();
  const duration = Number($('#videoDuration')?.value);
  const quality = String($('#videoResolution')?.value || '').trim();
  if (!parameters.aspectRatios.includes(aspectRatio) || !Number.isFinite(duration) || !parameters.durations.includes(duration) || !parameters.qualityOptions.includes(quality)) return null;
  return { modelId, aspectRatio, duration, quality, generationType:mode };
}
function currentVideoQuoteInput() {
  const input = currentVideoFormInput();
  const referenceIds = currentVideoReferenceIds();
  return input ? { ...input, referenceAssetIds:[], referenceCounts:referenceCountsForIds(referenceIds) } : null;
}
function updateVideoCost() {
  const cost = $('#videoCost'); const duration = $('#videoDuration'); if (!cost || !duration) return;
  clearTimeout(videoQuoteTimer);
  const sequence = ++videoQuoteSequence;
  const input = currentVideoQuoteInput();
  if (!input) { state.modelQuote = null; cost.textContent = '—'; return; }
  const routed = ['seedance-2.0','seedance-2.0-fast','seedance-2.5'].includes(input.modelId);
  if (routed) {
    const signature = JSON.stringify(input);
    if (state.modelQuote?.signature === signature) { cost.textContent = creditText(state.modelQuote.credits); return; }
    cost.textContent = '…';
    videoQuoteTimer = setTimeout(async () => { try { const quote = await api('/api/model-quote', { method:'POST', body:JSON.stringify(input) }); if (sequence !== videoQuoteSequence) return; state.modelQuote = { ...quote, signature }; cost.textContent = creditText(quote.credits); } catch { if (sequence !== videoQuoteSequence) return; state.modelQuote = null; cost.textContent = '暂不可用'; } }, 180);
    return;
  }
  state.modelQuote = null;
  const parameters = videoModelParameters(input.modelId, input.generationType); const selectedPricing = videoPricingFor(input.modelId, parameters, input.quality); const fixedPrice = selectedPricing?.unit === 'request' ? Number(selectedPricing.amount) / Number(state.pricing.yuanPerCredit || 0.1) : null; const perSecondPrice = selectedPricing?.unit === 'second' ? Number(selectedPricing.amount) : null; cost.textContent = creditText(fixedPrice ?? input.duration * (perSecondPrice ?? state.pricing.videoPerSecond));
}
$('#videoModel').onchange = () => {
  const hadFirstLast = state.videoGenerationType === 'FIRST&LAST';
  const supportsReference = supportsVideoMode('REFERENCE');
  const supportsFirstLast = supportsVideoFirstLast();
  if (hadFirstLast && !supportsFirstLast) {
    state.refs.video = [state.videoFrames.first, state.videoFrames.last, ...state.refs.video].filter(Boolean);
    state.videoFrames = { first:'', last:'' };
  }
  if (supportsReference) state.refs.video = normalizeVideoReferenceIds(state.refs.video);
  else if (!supportsFirstLast) state.refs.video = [];
  state.videoGenerationType = hadFirstLast && supportsFirstLast ? 'FIRST&LAST' : 'TEXT';
  syncVideoModelParameters({ reset:true });
  renderReferences();
};
$('#videoDuration').onchange = () => { syncVideoModelParameters(); updateVideoCost(); };
$('#videoResolution').onchange = () => updateVideoCost();
$('#videoAspect').onchange = () => updateVideoCost();

const priceUnitLabels = Object.freeze({ request:'次', second:'秒' });
function priceUnitLabel(unit) { return priceUnitLabels[unit] || '秒'; }
// Sorts quality tiers the way people read them (480p < 720p < 2k) so the card
// always opens on the cheapest tier without relying on upstream ordering.
function priceQualityWeight(quality) {
  const text = String(quality || '');
  const kilo = text.match(/([\d.]+)\s*k/i);
  if (kilo) return Number(kilo[1]) * 1000;
  const plain = text.match(/[\d.]+/);
  return plain ? Number(plain[0]) : 0;
}
function priceAmountText(yuan) { return Number(yuan).toFixed(2); }
function priceCreditsText(credits, unit) {
  const amount = unit === 'second' ? Number(credits).toFixed(1) : creditText(credits);
  return `${amount} 积分 / ${priceUnitLabel(unit)}`;
}
function modelPriceCard(modelId, rows, kind) {
  const label = rows[0]?.label || modelId;
  const tiers = [...rows].sort((a, b) => priceQualityWeight(a.quality) - priceQualityWeight(b.quality));
  const active = tiers.reduce((cheapest, item) => (Number(item.yuan) < Number(cheapest.yuan) ? item : cheapest), tiers[0]);
  const meta = kind === 'image' ? '图像生成 · 按次计费' : '视频生成 · 按秒计费';
  const tierRow = tiers.length > 1
    ? `<div class="price-tier-row" role="group" aria-label="${esc(label)} 清晰度">${tiers.map(item => `<button class="price-tier${item === active ? ' active' : ''}" type="button" aria-pressed="${item === active ? 'true' : 'false'}" data-amount="${priceAmountText(item.yuan)}" data-unit="${esc(priceUnitLabel(item.unit))}" data-credits="${esc(priceCreditsText(item.credits, item.unit))}">${esc(item.quality)}</button>`).join('')}</div>`
    : `<div class="price-tier-row"><span class="price-tier price-tier-static">${esc(tiers[0].quality)}</span></div>`;
  return `<article class="price-model-card"><header class="price-model-card-head">${modelIcon(modelId)}<div><h3>${esc(label)}</h3><small>${meta}</small></div></header><div class="price-model-figure"><span class="price-model-currency">¥</span><strong class="price-model-amount">${priceAmountText(active.yuan)}</strong><span class="price-model-unit">/ ${priceUnitLabel(active.unit)}</span></div><p class="price-model-credits">${priceCreditsText(active.credits, active.unit)}</p>${tierRow}</article>`;
}
function renderModelPrices(items = state.config?.modelPrices || []) {
  const body = $('#modelPriceBody');
  if (!body) return;
  const visibleItems = items.filter(item => item.available === true && item.enabled !== false && item.availability !== 'coming-soon' && Number.isFinite(Number(item.credits)) && Number.isFinite(Number(item.yuan)));
  if (!visibleItems.length) { body.innerHTML = '<div class="price-catalog-empty">暂时没有可用的模型价格。</div>'; return; }
  const videoModelIds = new Set((state.config?.videoCapabilities?.models || []).map(model => model.id));
  const groups = [...new Set(visibleItems.map(item => item.modelId))].map(modelId => {
    const rows = visibleItems.filter(item => item.modelId === modelId);
    return { modelId, rows, kind: videoModelIds.has(modelId) || rows.some(row => row.unit !== 'request') ? 'video' : 'image' };
  });
  const sections = [{ kind:'video', title:'视频模型', hint:'按秒计费' }, { kind:'image', title:'图像模型', hint:'按次计费' }];
  body.innerHTML = sections.map(section => {
    const cards = groups.filter(group => group.kind === section.kind);
    if (!cards.length) return '';
    return `<section class="price-section"><header class="price-section-head"><h4>${section.title}</h4><span>${cards.length} 个 · ${section.hint}</span></header><div class="price-section-grid">${cards.map(card => modelPriceCard(card.modelId, card.rows, card.kind)).join('')}</div></section>`;
  }).join('');
}

const modelPriceAutoOpenKey = 'gugu:model-price-auto-open-date';
function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function modelPriceAutoOpenStorageKey() {
  const account = state.user?.id || state.user?.username || 'anonymous';
  return `${modelPriceAutoOpenKey}:${encodeURIComponent(String(account))}`;
}
function hasAutoOpenedModelPricesToday() {
  try { return localStorage.getItem(modelPriceAutoOpenStorageKey()) === localDateKey(); }
  catch { return false; }
}
function markModelPricesAutoOpened() {
  try { localStorage.setItem(modelPriceAutoOpenStorageKey(), localDateKey()); }
  catch {}
}
async function openModelPriceDialog({ auto = false } = {}) {
  const dialog = $('#modelPriceDialog');
  if (!dialog || dialog.open || (auto && hasAutoOpenedModelPricesToday())) return;
  if (auto) markModelPricesAutoOpened();
  renderModelPrices();
  dialog.showModal();
  const requestAccount = accountScope.snapshot();
  try {
    const config = await api('/api/config');
    if (!accountScope.isCurrent(requestAccount)) return;
    state.config = { ...state.config, ...config };
    // The price dialog refreshes the catalog after the initial workspace load.
    // Rebuild model controls too, otherwise a model disabled in admin remains
    // as a stale option and leaves its dependent parameters unusable.
    syncVideoModelOptions();
    if (state.route === 'drama' && dramaController?.project) dramaController.render(true, { focus: false });
    renderModelPrices(config.modelPrices || []);
  }
  catch { if (!(state.config?.modelPrices || []).length) $('#modelPriceBody').innerHTML = '<div class="price-catalog-empty">价格获取失败，请稍后重试。</div>'; }
}
// Tier chips swap the headline price in place; the dialog body is a stable
// element so one delegated listener survives every re-render.
$('#modelPriceBody')?.addEventListener('click', event => {
  const tier = event.target.closest('.price-tier[data-amount]');
  const card = tier?.closest('.price-model-card');
  if (!card || tier.classList.contains('active')) return;
  for (const button of card.querySelectorAll('.price-tier')) {
    const selected = button === tier;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
  const amount = card.querySelector('.price-model-amount');
  const unit = card.querySelector('.price-model-unit');
  const credits = card.querySelector('.price-model-credits');
  if (amount) amount.textContent = tier.dataset.amount || '';
  if (unit) unit.textContent = `/ ${tier.dataset.unit || '秒'}`;
  if (credits) credits.textContent = tier.dataset.credits || '';
  const figure = card.querySelector('.price-model-figure');
  if (figure) { figure.classList.remove('price-figure-flash'); void figure.offsetWidth; figure.classList.add('price-figure-flash'); }
});
$('#modelPriceButton').onclick = () => { void openModelPriceDialog(); };
$('#closeModelPrice').onclick = () => $('#modelPriceDialog').close();
$('#modelPriceDialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

function assetFileInfoText(file, width=file?.width, height=file?.height) { if (!file) return '暂无成品文件'; const dimensions = width && height ? ` · ${width} × ${height} px` : ''; return `${formatBytes(file.size)}${dimensions}`; }
function renderPreviewGenerationDetails(file, fileText=assetFileInfoText(file)) {
  const task = taskForAsset(file);
  const details = $('#previewGenerationDetails');
  const promptSection = $('#previewGenerationPrompt');
  const advanced = $('#previewGenerationAdvanced');
  if (!details || !promptSection || !advanced) return;
  const available = Boolean(task);
  details.classList.toggle('hidden', !available);
  promptSection.classList.toggle('hidden', !available || !task.prompt);
  advanced.classList.toggle('hidden', !available);
  if (!available) return;
  $('#previewGenerationPromptText').textContent = task.prompt || '';
  $('#previewGenerationCoreMeta').innerHTML = generationParameterRows(task);
  $('#previewGenerationDetailMeta').innerHTML = generationSupplementalRows(task, fileText, 'previewGenerationFile');
  const prompt = $('#previewGenerationPromptText');
  const toggle = $('#previewGenerationPromptToggle');
  toggle.classList.add('hidden');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '展开全部';
  requestAnimationFrame(() => toggle.classList.toggle('hidden', prompt.scrollHeight <= prompt.clientHeight + 1));
}
function renderPreviewMeta(file, width=file.width, height=file.height) {
  renderPreviewGenerationDetails(file, assetFileInfoText(file, width, height));
  $('#previewDetailMeta').innerHTML = detailRow('素材类型', file.kind === 'image' ? '图片' : file.kind === 'audio' ? '音频' : '视频')
    + detailRow('画面尺寸', file.kind === 'audio' ? '—' : width && height ? `${width} × ${height} px` : '读取中', 'previewDimensions')
    + detailRow('文件大小', formatBytes(file.size))
    + detailRow('文件格式', file.mimeType || '—')
    + detailRow('添加时间', fullDateText(file.createdAt))
    + detailRow('原始文件名', file.name);
}
function renderPreviewMetaLegacy(file, width=file.width, height=file.height) { renderPreviewMeta(file, width, height); }
function openPreviewLegacy(id) { const file = state.files.find(item => item.id === id); if (!file || !requireDesktopLocalAsset(file)) return; const displayName = assetDisplayName(file); state.previewFileId = id; $('#deletePreview').disabled = false; $('#deletePreview').textContent = '删除素材'; $('#previewMedia').innerHTML = file.kind === 'image' ? `<img src="${file.url}" alt="${esc(displayName)}">` : `<video src="${file.url}" controls autoplay></video>`; $('#previewName').textContent = displayName; $('#previewUseActions').classList.toggle('hidden', file.kind !== 'image'); renderPreviewMeta(file); if (file.kind === 'image') { const image = $('#previewMedia img'); const syncImage = () => { file.width = image.naturalWidth; file.height = image.naturalHeight; fitDetailMedia(image, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; if (image.complete) syncImage(); else image.onload = syncImage; } else { const video = $('#previewMedia video'); video.onloadedmetadata = () => { file.width = video.videoWidth; file.height = video.videoHeight; fitDetailMedia(video, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; } configureLocalFileAction($('#previewDownload'), file); $('#previewDialog').showModal(); }
function usePreviewAsset(target) { const file = state.files.find(item => item.id === state.previewFileId); if (!file || file.kind !== 'image') return; if (target === 'video' && !$('#videoModel').value) return toast('请先选择视频模型'); if (target === 'video' && supportsVideoFirstLast() && state.videoGenerationType === 'FIRST&LAST') { const frame = state.videoFrames.first ? 'last' : 'first'; state.videoFrames[frame] = file.id; } else { const limit = target === 'video' ? videoReferenceLimit() : 7; if (!state.refs[target].includes(file.id)) state.refs[target] = [file.id, ...state.refs[target]].slice(0, limit); } $('#previewDialog').close(); navigate(target); renderReferences(); toast(`已将“${assetDisplayName(file)}”设为${target === 'video' && supportsVideoFirstLast() && state.videoGenerationType === 'FIRST&LAST' ? '视频帧图片' : '参考图'}`); }
async function copyPreviewGenerationPrompt() { const task = taskForAsset(fileById(state.previewFileId)); const prompt = task?.prompt || ''; if (!prompt) return toast('暂无可复制的创作描述'); try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt); else if (!copyTextFallback(prompt)) throw new Error('copy failed'); toast('创作描述已复制'); } catch { toast('复制失败，请手动选择文字复制'); const text = $('#previewGenerationPromptText'); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); } }
let previewNameEditing = false;
let previewNameSaving = false;
const previewNamePencilIcon = '<svg class="asset-name-edit-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.8 4.8L8 20 19.2 8.8a2 2 0 0 0-2.8-2.8L5.2 17.2"/><path d="m14.8 7.2 2.8 2.8"/></svg>';
const previewNameCheckIcon = '<svg class="asset-name-edit-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.3 4.3L19 7.2"/></svg>';
function previewNameError(message = '') { const error = $('#previewNameError'); error.textContent = message; error.classList.toggle('hidden', !message); }
function setPreviewNameEditing(editing) {
  previewNameEditing = editing;
  const display = $('#previewName');
  const input = $('#previewNameInput');
  const button = $('#editPreviewName');
  if (!display || !input || !button) return;
  display.classList.toggle('hidden', editing);
  input.classList.toggle('hidden', !editing);
  button.innerHTML = editing ? previewNameCheckIcon : previewNamePencilIcon;
  button.setAttribute('aria-label', editing ? '保存文件名' : '修改文件名');
  button.title = editing ? '保存文件名' : '修改文件名';
  button.disabled = false;
}
function resetPreviewNameEditing() {
  previewNameSaving = false;
  previewNameError();
  setPreviewNameEditing(false);
  const input = $('#previewNameInput');
  if (input) input.value = '';
}
function beginPreviewNameEditing() {
  const file = state.files.find(item => item.id === state.previewFileId);
  if (!file || previewNameSaving) return;
  previewNameError();
  $('#previewNameInput').value = file.name || '';
  setPreviewNameEditing(true);
  requestAnimationFrame(() => { const input = $('#previewNameInput'); input.focus(); input.select(); });
}
function updatePreviewFileName(file, name) {
  const identifiers = new Set([file.id, file.localId, file.cloudAssetId].filter(Boolean));
  for (const item of [file, ...state.files, ...mediaController.libraryState().files]) {
    if (identifiers.has(item.id) || identifiers.has(item.localId) || identifiers.has(item.cloudAssetId)) item.name = name;
  }
  recordIndexes.invalidateFiles();
}
async function savePreviewName({ close = false } = {}) {
  if (!previewNameEditing || previewNameSaving) return false;
  const file = state.files.find(item => item.id === state.previewFileId);
  if (!file) { resetPreviewNameEditing(); return false; }
  let name = String($('#previewNameInput').value || '').trim().replace(/[\\r\\n]/g, '').slice(0, 160);
  if (!name) { previewNameError('请输入文件名。'); $('#previewNameInput').focus(); return false; }
  if (name === String(file.name || '').trim()) { setPreviewNameEditing(false); if (close) $('#previewDialog').close(); return true; }
  previewNameSaving = true;
  $('#editPreviewName').disabled = true;
  previewNameError();
  try {
    if (!window.guguDesktop?.media?.renameLocal) throw new Error('桌面文件能力尚未就绪，请重启客户端后再试');
    await window.guguDesktop.media.renameLocal({ assetId:file.localId || file.id, name });
    updatePreviewFileName(file, name);
    $('#previewName').textContent = assetDisplayName(file);
    renderPreviewMeta(file, file.width, file.height);
    setPreviewNameEditing(false);
    renderFiles();
    toast('文件名已保存');
    if (close) $('#previewDialog').close();
    return true;
  } catch (error) {
    previewNameError(error.message || '保存文件名失败');
    return false;
  } finally {
    previewNameSaving = false;
    if (previewNameEditing) $('#editPreviewName').disabled = false;
  }
}
function openPreview(id) { const file = state.files.find(item => item.id === id); if (!file || !requireDesktopLocalAsset(file)) return; resetPreviewNameEditing(); const displayName = assetDisplayName(file); state.previewFileId = id; $('#deletePreview').disabled = false; $('#deletePreview').textContent = '删除素材'; $('#previewMedia').innerHTML = file.kind === 'image' ? `<img src="${file.url}" alt="${esc(displayName)}">` : file.kind === 'audio' ? `<audio src="${file.url}" controls autoplay></audio>` : `<video src="${file.url}" controls autoplay></video>`; $('#previewName').textContent = displayName; $('#previewUseActions').classList.toggle('hidden', file.kind !== 'image'); renderPreviewMeta(file); if (file.kind === 'image') { const image = $('#previewMedia img'); const syncImage = () => { file.width = image.naturalWidth; file.height = image.naturalHeight; fitDetailMedia(image, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; if (image.complete) syncImage(); else image.onload = syncImage; } else if (file.kind === 'video') { const video = $('#previewMedia video'); video.onloadedmetadata = () => { file.width = video.videoWidth; file.height = video.videoHeight; fitDetailMedia(video, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; } configureLocalFileAction($('#previewDownload'), file); $('#previewDialog').showModal(); }
$('#usePreviewForImage').onclick = () => usePreviewAsset('image');
$('#usePreviewForVideo').onclick = () => usePreviewAsset('video');
$('#editPreviewName').onclick = event => { event.stopPropagation(); if (previewNameEditing) void savePreviewName(); else beginPreviewNameEditing(); };
$('#previewNameInput').addEventListener('click', event => event.stopPropagation());
$('#previewNameInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void savePreviewName(); } else if (event.key === 'Escape') { event.stopPropagation(); resetPreviewNameEditing(); } });
$('#closePreview').onclick = () => { if (previewNameEditing) void savePreviewName({ close:true }); else $('#previewDialog').close(); };
$('#deletePreview').onclick = async () => { if ($('#deletePreview').disabled) return; const file = state.files.find(item => item.id === state.previewFileId); if (!file || !await confirmFileDeletion(file)) return; const button = $('#deletePreview'); button.disabled = true; try { await removeFile(file); $('#previewDialog').close(); toast(file.sourceGenerationId ? '作品及关联文件已删除' : '文件已删除'); } catch (error) { toast(error.message); } finally { button.disabled = false; } };


$('#previewDialog').addEventListener('click', event => {
  if (previewNameEditing && event.target !== $('#previewNameInput') && !event.target.closest('#editPreviewName')) {
    const clickedInteractive = event.target.closest('button, a, input, select, textarea');
    if (!clickedInteractive || event.target === event.currentTarget) { event.preventDefault(); void savePreviewName({ close:event.target === event.currentTarget }); return; }
  }
  if (event.target === event.currentTarget) $('#previewDialog').close();
});
$('#previewDialog').addEventListener('close', () => { resetDetailFit($('#previewDialog')); $('#previewMedia').innerHTML = ''; $('#deletePreview').disabled = false; resetPreviewNameEditing(); state.previewFileId = null; });
$('#copyPreviewGenerationPrompt').onclick = copyPreviewGenerationPrompt;
$('#previewGenerationPromptToggle').onclick = () => { const prompt = $('#previewGenerationPromptText'); const toggle = $('#previewGenerationPromptToggle'); const expanded = prompt.classList.toggle('expanded'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起描述' : '展开全部'; };

async function bootstrap() {
  const desktopReady = await initDesktopBridge().catch(error => { console.warn('[desktop] 初始化工作区桥接失败', error); return false; });
  if (!desktopReady) {
    showBoot('请使用 GuGu AI 客户端', '创作工作台不支持浏览器访问。');
    return;
  }
  showBoot();
  try {
    const { user } = await api('/api/auth/me');
    await enterApp(user);
  } catch (error) {
    if (error.status === 401) {
      showAuth();
      if (window.location.pathname !== authPath) window.history.replaceState({ route:'login' }, '', authPath);
    } else {
      showBoot('无法恢复工作区', '请检查网络后重试。', { retry:true });
    }
  }
  renderReferences();
}
$('#bootRetry').onclick = () => bootstrap();
function activeGenerationIds() {
  const historyTasks = Object.values(state.generationHistory || {}).flatMap(entry => entry?.loaded ? entry.items : []);
  return [...new Set([...state.tasks, ...historyTasks].filter(task => ['queued', 'running'].includes(task.status)).map(task => String(task.id || '')).filter(Boolean))];
}
const taskPoller = createTaskPoller({
  setTimeoutFn: window.setTimeout.bind(window),
  clearTimeoutFn: window.clearTimeout.bind(window),
  isHidden: () => document.hidden,
  getUser: () => state.user,
  getActiveIds: activeGenerationIds,
  loadActiveTasks: () => loadTasks({ background: true, activeOnly: true }),
  loadNotifications,
  activeDelay: activePollDelay,
  notificationDelay: notificationPollDelay,
});
const scheduleTaskPoll = taskPoller.scheduleTaskPoll;
const scheduleNotificationPoll = taskPoller.scheduleNotificationPoll;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    taskPoller.stop();
    return;
  }
  if (state.user) {
    pruneExpiredTransientFailures();
    const requestAccount = accountScope.snapshot();
    void Promise.all([loadTasks({ background:true, activeOnly:true }), loadNotifications()]).then(() => {
      if (!document.hidden && state.user && accountScope.isCurrent(requestAccount)) {
        scheduleTaskPoll();
        scheduleNotificationPoll();
      }
    });
  }
});
let localReconcileRequest = null;
function refreshLocalFileAvailability() {
  if (!window.guguDesktop || !state.user || document.hidden || localReconcileRequest) return;
  localReconcileRequest = mediaController.refreshLocalAvailability().finally(() => { localReconcileRequest = null; });
}
window.addEventListener('focus', refreshLocalFileAvailability);
document.addEventListener('visibilitychange', refreshLocalFileAvailability);
window.setInterval(refreshLocalFileAvailability, 15000);
await bootstrap();
scheduleTaskPoll();
scheduleNotificationPoll();
