import { createDramaStudio } from './drama-studio.js?v=52';
import { listSignature, mergeTransientFields, recordSignature } from './list-sync.js?v=1';
import { replaceAssetMentions } from './video-prompt.js?v=4';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const toggleClass = (element, className, force) => element?.classList.toggle(className, force);
const assetPreviewUrl = file => file?.kind === 'image' ? (String(file.url || '').startsWith('gugu-media://') ? file.url : (file.previewUrl || file.url || '')) : (file?.url || '');
const state = { user:null, route:'image', authMode:'login', tasks:[], files:[], credits:0, creditTransactions:[], creditWallet:{ balance:0, held:0, available:0 }, creditDetailTab:'spend', creditDetailRestoreFocus:null, notifications:[], unreadNotifications:0, pricing:{ image:1, videoPerSecond:1, signupBonus:50 }, modelQuote:null, config:{}, dramaAnalysis:null, dramaProject:null, dramaLoading:false, initialSyncReady:false, generationFilter:'all', generationView:'large', fileKind:'all', referenceTarget:'image', refs:{ image:[], video:[] }, videoPromptMentions:[], videoGenerationType:'TEXT', videoFrames:{ first:'', last:'' }, videoFrameTarget:'', dialogSelection:[], uploadContext:'library', uploadJobs:[], detailTaskId:null, previewFileId:null };
let referenceDialogCommitted = false;
let referenceDialogOriginal = null;
let indexedFiles = null;
let filesById = new Map();
let indexedTasks = null;
let tasksById = new Map();
let tasksByAssetId = new Map();
let lastTaskRender = { route:'', filter:'', ready:null, tasks:null, files:null };
function ensureFileIndex() {
  if (indexedFiles === state.files) return;
  indexedFiles = state.files;
  filesById = new Map(state.files.map(file => [file.id, file]));
}
function fileById(id) { ensureFileIndex(); return filesById.get(id); }
function ensureTaskIndex() {
  if (indexedTasks === state.tasks) return;
  indexedTasks = state.tasks;
  tasksById = new Map();
  tasksByAssetId = new Map();
  state.tasks.forEach(task => {
    tasksById.set(task.id, task);
    if (task.assetId && !tasksByAssetId.has(task.assetId)) tasksByAssetId.set(task.assetId, task);
  });
}
function taskById(id) { ensureTaskIndex(); return tasksById.get(id); }
function taskForAsset(file) {
  ensureTaskIndex();
  return tasksById.get(file?.sourceGenerationId) || tasksByAssetId.get(file?.id);
}
const routePaths = Object.freeze({ image:'/image', video:'/video', drama:'/drama', files:'/files' });
const authPath = '/login';
const routeFromPath = pathname => Object.entries(routePaths).find(([, path]) => path === pathname)?.[0] || 'image';
const taskSignatureFields = ['id','type','status','progress','assetId','updatedAt','error','creditStatus','prompt','size','quality','aspectRatio','duration','videoModelId','modelId','createdAt'];
const fileSignatureFields = ['id','name','kind','mimeType','size','url','remoteUrl','directUrl','localStatus','localPath','deliveryStatus','remoteStatus','updatedAt','sourceGenerationId','createdAt'];
const taskCardSignatureFields = taskSignatureFields.filter(field => field !== 'updatedAt');
const fileCardSignatureFields = fileSignatureFields.filter(field => field !== 'updatedAt');
let tasksRequest = null;
let filesRequest = null;
let pollTimer = 0;
let notificationPanelCloseTimer = 0;
const activePollDelay = 6000;
const idlePollDelay = 60000;
let desktopUpdateUnsubscribe = null;
let desktopWindowStateUnsubscribe = null;
const desktopHydrationQueue = [];
const desktopHydrationQueued = new Set();
const desktopHydrationAttempted = new Set();
let desktopHydrationRunning = false;
let desktopInitialSyncStarted = false;
let desktopUpdateState = { status: 'idle' };

async function api(url, options = {}) {
  const response = await fetch(url, { credentials:'same-origin', ...options, headers:{ ...(options.body instanceof Blob ? {} : { 'Content-Type':'application/json' }), ...(options.headers || {}) } });
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok) { const error = Object.assign(new Error(data.error || '请求失败'), data); error.status = response.status; throw error; }
  return data;
}
async function listAllRemoteFiles() {
  const files = [];
  let cursor = '';
  do {
    const query = new URLSearchParams({ limit:'200' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`/api/files?${query}`, { credentials:'same-origin' });
    let data = []; try { data = await response.json(); } catch {}
    if (!response.ok) { const error = Object.assign(new Error(data.error || '请求失败'), data); error.status = response.status; throw error; }
    if (!Array.isArray(data)) throw new Error('文件列表格式无效');
    files.push(...data);
    cursor = response.headers.get('x-next-cursor') || '';
  } while (cursor);
  return files;
}
function desktopLocalClientAsset(item) {
  const cloudAssetId = String(item?.cloudAssetId || '');
  const id = cloudAssetId || String(item?.id || '');
  if (!id || !item?.url) return null;
  const kind = item.kind || desktopMediaKind(item);
  if (!kind) return null;
  return { ...item, id, localId: item.id, cloudAssetId, kind, url: item.url, remoteUrl: item.remoteUrl || (cloudAssetId ? `/api/files/${encodeURIComponent(cloudAssetId)}/content` : ''), localStatus:'saved', localOnly:!cloudAssetId, updatedAt:item.updatedAt || item.createdAt };
}
async function listDesktopFiles() {
  const bridge = window.guguDesktop;
  if (!bridge) return [];
  const local = await bridge.media.listLocal();
  return local.map(desktopLocalClientAsset).filter(Boolean);
}
async function enrichDesktopFiles(files, localFiles=null) {
  const bridge = window.guguDesktop;
  if (!bridge) return files;
  try {
    const local = localFiles || await listDesktopFiles();
    const localByCloudId = new Map(local.filter(item => item.cloudAssetId).map(item => [item.cloudAssetId, item]));
    return files.map(file => {
      const localAsset = localByCloudId.get(file.id);
      return localAsset ? { ...file, url: localAsset.url, remoteUrl: file.url, localStatus: 'saved', localPath: localAsset.relativePath } : file;
    });
  } catch { return files; }
}
function mergeDesktopFiles(remoteFiles, localFiles) {
  if (!window.guguDesktop) return remoteFiles;
  const localByCloudId = new Map(localFiles.filter(item => item.cloudAssetId).map(item => [item.cloudAssetId, item]));
  const remoteIds = new Set(remoteFiles.map(file => file.id));
  const merged = remoteFiles.map(file => {
    const local = localByCloudId.get(file.id);
    return local ? { ...file, ...local, id:file.id, remoteUrl:file.url, localStatus:'saved' } : file;
  });
  localFiles.filter(file => file.localOnly || !remoteIds.has(file.id)).forEach(file => merged.push(file));
  return merged;
}
function renderAfterDesktopAssetHydration() {
  if (state.route === 'files') renderFiles();
  renderReferences();
  if (['image', 'video'].includes(state.route)) renderTasks();
  else if (state.route === 'drama') dramaController.render();
}
function applyDesktopLocalAsset(remoteFile, localAsset) {
  const local = desktopLocalClientAsset(localAsset);
  if (!local) return;
  state.files = state.files.map(file => file.id === remoteFile.id
    ? { ...file, ...local, id: remoteFile.id, localId: local.localId, cloudAssetId: remoteFile.id, remoteUrl: remoteFile.url, localStatus: 'saved', localPath: local.relativePath }
    : file);
  renderAfterDesktopAssetHydration();
}
async function hydrateDesktopAsset(file) {
  const bridge = window.guguDesktop;
  if (!bridge || !file || file.localOnly || file.localStatus === 'saved') return;
  const result = await bridge.media.downloadRemote({
    assetId: file.id,
    url: file.directUrl || `/api/files/${encodeURIComponent(file.id)}/direct`,
    name: file.name,
    kind: file.kind,
    mimeType: file.mimeType,
  });
  if (result?.unavailable) throw new Error(`远端文件已不存在（${result.status || 404}）`);
  applyDesktopLocalAsset(file, result);
  try {
    await api(`/api/files/${encodeURIComponent(file.id)}/local-ready`, {
      method: 'POST',
      body: JSON.stringify({ size: result.size, sha256: result.sha256, mimeType: result.mimeType || file.mimeType }),
    });
  } catch (error) {
    console.warn('[desktop] 本地文件已保存，但本地接收确认失败', { assetId: file.id, message: error.message });
  }
}
async function runDesktopHydrationQueue() {
  if (desktopHydrationRunning) return;
  desktopHydrationRunning = true;
  try {
    while (desktopHydrationQueue.length) {
      const file = desktopHydrationQueue.shift();
      try {
        await hydrateDesktopAsset(file);
        // A successful copy is represented by localStatus in state. Do not
        // retain the attempt marker so a later missing-local-file check can
        // repair the copy in the same client session.
        desktopHydrationAttempted.delete(file?.id);
      }
      catch (error) { console.warn('[desktop] 自动同步素材失败', { assetId: file?.id, message: error.message }); }
      finally { desktopHydrationQueued.delete(file?.id); }
    }
  } finally {
    desktopHydrationRunning = false;
    if (desktopHydrationQueue.length) void runDesktopHydrationQueue();
  }
}
function queueDesktopHydration(files) {
  if (!window.guguDesktop) return;
  const initialBackfill = desktopInitialSyncStarted;
  for (const file of files) {
    // The first successful remote library load is the desktop's migration
    // point: bring old cloud-backed files into the local workspace once. Later
    // loads only pick up newly generated results waiting for local delivery.
    const awaitingDesktopDelivery = file?.deliveryStatus === 'awaiting_local' && file?.remoteStatus === 'pending';
    const shouldHydrate = initialBackfill || awaitingDesktopDelivery;
    if (!file?.id || !shouldHydrate || file.localOnly || file.localStatus === 'saved' || desktopHydrationQueued.has(file.id) || desktopHydrationAttempted.has(file.id)) continue;
    desktopHydrationAttempted.add(file.id);
    desktopHydrationQueued.add(file.id);
    desktopHydrationQueue.push(file);
  }
  if (desktopHydrationQueue.length) void runDesktopHydrationQueue();
}
const esc = (value='') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function assetImageMarkup(file, alt = '', attributes = ' loading="lazy" decoding="async"') {
  const preview = assetPreviewUrl(file);
  const original = String(file?.remoteUrl || file?.url || '');
  const fallback = preview && original && preview !== original ? ` data-original-src="${esc(original)}"` : '';
  return `<img src="${esc(preview)}" alt="${esc(alt)}"${fallback}${attributes}>`;
}
function isDesktopAssetSyncing(file) {
  return Boolean(window.guguDesktop && file && !file.localOnly && file.localStatus !== 'saved' && !String(file.url || '').startsWith('gugu-media://'));
}
function taskLocalSyncing(task, file = fileById(task?.assetId)) {
  return task?.status === 'completed' && isDesktopAssetSyncing(file);
}
function taskDisplayStatus(task, file = fileById(task?.assetId)) {
  return taskLocalSyncing(task, file) ? 'running' : task?.status;
}
function desktopSyncMarkup(task) {
  const label = task?.type === 'image' ? '图片' : '视频';
  return `<div class="skeleton-progress" role="status" aria-live="polite" aria-label="${label}生成中"><div class="skeleton-progress-head"><span><i aria-hidden="true"></i>正在同步到本地…</span></div></div>`;
}
function requireDesktopLocalAsset(file) {
  if (!isDesktopAssetSyncing(file)) return true;
  toast('素材正在同步到本地，请稍后再预览');
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

function videoPromptEditor() { return $('#videoPrompt'); }
function videoPromptMentionLabel(mention, file) { return String(mention?.label || file?.name || '未命名素材').replace(/^@/, '').trim() || '未命名素材'; }
function videoPromptMentionKindLabel(kind) { return ({ image:'图片', video:'视频', audio:'音频' }[kind] || '素材'); }
function videoPromptMentionMarkup(mention) {
  const file = state.files.find(item => item.id === mention?.id);
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
  if (!editor) return '';
  const visit = (node, isRoot = false) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.classList.contains('video-prompt-mention')) return `@${node.dataset.videoPromptMentionLabel || node.textContent.trim()}`;
    if (node.nodeName === 'BR') return '\n';
    const text = [...node.childNodes].map(child => visit(child)).join('');
    return !isRoot && /^(DIV|P)$/.test(node.nodeName) ? `${text}\n` : text;
  };
  return visit(editor, true).replace(/\u00a0/g, ' ').replace(new RegExp(videoRichEditorEmptyChar, 'g'), '');
}
function videoPromptMentionsFromEditor(editor = videoPromptEditor()) {
  if (!editor) return [];
  return [...editor.querySelectorAll('[data-video-prompt-mention-id]')]
    .map(node => ({
      id:String(node.dataset.videoPromptMentionId || ''),
      label:String(node.dataset.videoPromptMentionLabel || '').replace(/^@/, '').trim(),
      kind:['image','video','audio'].includes(node.dataset.videoPromptMentionKind) ? node.dataset.videoPromptMentionKind : 'image',
    }))
    .filter(item => item.id && item.label)
    .filter((item, index, list) => list.findIndex(other => other.id === item.id && other.label === item.label) === index)
    .slice(0, 40);
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
  const selection = window.getSelection();
  if (!editor || !selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  const offset = range.startOffset;
  const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  const inside = element?.closest('.video-prompt-mention');
  if (inside && editor.contains(inside)) return inside;
  const isMention = node => node?.nodeType === Node.ELEMENT_NODE && node.classList.contains('video-prompt-mention');
  if (container.nodeType === Node.TEXT_NODE) {
    const value = container.nodeValue || '';
    if (direction === 'backward' && offset === 0 && isMention(container.previousSibling)) return container.previousSibling;
    if (direction === 'backward' && offset === value.length && value === ' ' && isMention(container.previousSibling)) return container.previousSibling;
    if (direction === 'forward' && offset === value.length && isMention(container.nextSibling)) return container.nextSibling;
  } else if (container.nodeType === Node.ELEMENT_NODE) {
    const adjacent = container.childNodes[direction === 'backward' ? offset - 1 : offset];
    if (isMention(adjacent)) return adjacent;
  }
  return null;
}
function setVideoPromptCaret(editor, node, offset = 0) {
  if (!editor?.isConnected) return;
  editor.focus({ preventScroll:true });
  const range = document.createRange();
  if (node?.isConnected && editor.contains(node)) {
    range.setStart(node, Math.max(0, Math.min(offset, node.nodeValue?.length || 0)));
    range.collapse(true);
  } else {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
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
    holder.innerHTML = videoPromptMentionMarkup({ id:file.id, label:file.name, kind:file.kind });
    const chip = holder.firstElementChild;
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
const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
const dateText = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const fullDateText = value => value ? new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
const imageAccept = 'image/png,image/jpeg,image/webp';
const videoAccept = 'video/mp4,video/webm,video/quicktime';
const audioAccept = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/aac,audio/webm,audio/flac';
const uploadMimeByExtension = Object.freeze({ '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.weba':'audio/webm', '.flac':'audio/flac' });
function normalizedUploadMime(file) { const declared = String(file?.type || '').split(';')[0].trim().toLowerCase(); if (declared === 'image/jpg' || declared === 'image/pjpeg') return 'image/jpeg'; if (declared === 'audio/x-m4a' || declared === 'audio/m4a') return 'audio/mp4'; if (['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/mp4','audio/aac','audio/webm','audio/flac'].includes(declared)) return declared; const extension = `.${String(file?.name || '').split('.').pop()}`.toLowerCase(); return uploadMimeByExtension[extension] || declared; }
const libraryAccept = `${imageAccept},${videoAccept},${audioAccept}`;
const statusText = value => ({ queued:'排队中', running:'生成中', completed:'已完成', failed:'失败' })[value] || value;
const generationStage = status => status === 'queued' ? 1 : status === 'running' ? 3 : status === 'completed' ? 5 : 0;
const generationStages = ['排队', '准备', '生成', '增强', '完成'];
function taskProgress(task) {
  if (!Object.prototype.hasOwnProperty.call(task || {}, 'progress')) return null;
  const progress = Number(task.progress);
  return Number.isFinite(progress) && progress >= 0 && progress <= 100 ? Math.round(progress) : null;
}
function videoProgressLabel(task) {
  return ({
    submitting: '正在提交视频',
    provider_processing: '正在生成视频',
    polling_retry: '正在恢复连接',
    archiving: '正在整理成品',
    awaiting_reconciliation: '正在确认任务',
  })[task.progressStage] || '正在生成视频';
}
function videoProgressMarkup(task) {
  if (task.type !== 'video' || !['queued','running'].includes(task.status)) return '';
  const progress = taskProgress(task);
  if (progress === null) return '';
  return `<div class="skeleton-progress" role="status" aria-live="polite" aria-label="视频生成进度 ${progress}%"><div class="skeleton-progress-head"><span><i aria-hidden="true"></i>${esc(videoProgressLabel(task))}</span><b>${progress}%</b></div><div class="skeleton-progress-track" aria-hidden="true"><i style="--progress:${progress}%"></i></div></div>`;
}
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
function creditEntryStatus(entry, task) {
  if (entry?.type === 'generation_refund' || task?.creditStatus === 'refunded') return { key:'refunded', label:'已退款' };
  if (['queued', 'running'].includes(task?.status) || (task?.status === 'failed' && task?.creditStatus !== 'refunded')) return { key:'pending', label:'进行中' };
  return { key:'completed', label:'已完成' };
}
function signedCreditAmount(amount) { return `${amount < 0 ? '-' : '+'}${creditText(Math.abs(amount))}`; }
function renderCreditRows(entries, direction) {
  if (!entries.length) return `<tr><td colspan="${direction === 'spend' ? 5 : 3}"><div class="credit-empty">暂无${direction === 'spend' ? '积分消耗' : '积分获取'}记录</div></td></tr>`;
  return entries.map(entry => {
    const amount = creditEntryAmount(entry);
    const task = entry.generationId ? state.tasks.find(item => item.id === entry.generationId) : null;
    const model = direction === 'spend' ? `<td>${esc(creditModelName(entry, task))}</td>` : '';
    const type = direction === 'spend' ? creditSpendType(entry) : creditEarnType(entry);
    const status = direction === 'spend' ? creditEntryStatus(entry, task) : null;
    const statusCell = status ? `<td><span class="credit-status credit-status-${status.key}">${esc(status.label)}</span></td>` : '';
    return `<tr><td><time datetime="${esc(entry.createdAt || '')}">${esc(creditDateText(entry.createdAt))}</time></td><td>${esc(type)}</td>${model}<td class="${direction === 'spend' ? 'credit-spend' : 'credit-earn'}">${esc(signedCreditAmount(amount))}</td>${statusCell}</tr>`;
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
    updateImageCost();
    updateVideoCost();
  } catch (error) { if (error.status === 401) location.reload(); }
}

function notificationCountText(count) { return Number(count) > 99 ? '99+' : String(Math.max(0, Number(count) || 0)); }
function notificationDateText(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }) : '—';
}
function renderNotifications() {
  const count = Math.max(0, Number(state.unreadNotifications) || 0);
  const countText = notificationCountText(count);
  const countEl = $('#notificationCount');
  const avatarBadge = $('#avatarNotificationBadge');
  const summary = $('#notificationSummary');
  const list = $('#notificationList');
  if (!list) return;
  countEl.textContent = countText;
  countEl.classList.toggle('hidden', count === 0);
  avatarBadge.textContent = countText;
  avatarBadge.setAttribute('aria-label', `${count} 条未读消息`);
  avatarBadge.classList.toggle('hidden', count === 0);
  summary.textContent = count ? `${countText} 条未读消息 · 共 ${state.notifications.length} 条历史` : `共 ${state.notifications.length} 条历史消息`;
  $('#markAllNotifications').disabled = count === 0;
  if (!state.notifications.length) {
    list.innerHTML = '<div class="notification-empty"><span aria-hidden="true">—</span><b>暂无消息</b><small>新的公告会出现在这里。</small></div>';
    return;
  }
  list.innerHTML = state.notifications.map(item => `<article class="notification-item ${item.isRead ? '' : 'is-unread'}"><button type="button" data-notification-id="${esc(item.id)}"><span class="notification-item-top"><strong>${esc(item.title)}</strong><time datetime="${esc(item.publishedAt || '')}">${esc(notificationDateText(item.publishedAt))}</time></span><span class="notification-item-content">${esc(item.content)}</span>${item.isRead ? '' : '<i class="notification-unread-dot" aria-label="未读"></i>'}</button></article>`).join('');
  list.querySelectorAll('[data-notification-id]').forEach(button => button.onclick = () => markNotificationRead(button.dataset.notificationId));
}
function setNotificationPanelOpen(open) {
  const item = $('.notification-menu-item');
  const panel = $('#notificationPanel');
  const trigger = $('#notificationMenuButton');
  if (!item || !panel || !trigger) return;
  window.clearTimeout(notificationPanelCloseTimer);
  notificationPanelCloseTimer = 0;
  item.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  trigger.setAttribute('aria-expanded', String(open));
  if (open) renderNotifications();
}
function scheduleNotificationPanelClose() {
  window.clearTimeout(notificationPanelCloseTimer);
  notificationPanelCloseTimer = window.setTimeout(() => {
    notificationPanelCloseTimer = 0;
    const item = $('.notification-menu-item');
    if (!item?.matches(':hover') && !item?.matches(':focus-within')) setNotificationPanelOpen(false);
  }, 180);
}
async function loadNotifications() {
  try {
    const result = await api('/api/notifications?limit=200');
    state.notifications = Array.isArray(result.items) ? result.items : [];
    state.unreadNotifications = Number(result.unreadCount) || 0;
    renderNotifications();
  } catch (error) { if (error.status === 401) location.reload(); }
}
async function markNotificationRead(id) {
  const item = state.notifications.find(notification => notification.id === id);
  if (!item || item.isRead) return;
  item.isRead = true;
  state.unreadNotifications = Math.max(0, state.unreadNotifications - 1);
  renderNotifications();
  try { await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method:'POST', body:'{}' }); }
  catch { item.isRead = false; state.unreadNotifications += 1; renderNotifications(); toast('消息状态更新失败，请稍后重试'); }
}
async function markAllNotificationsRead() {
  if (!state.unreadNotifications) return;
  const previous = state.notifications.map(item => item.isRead);
  state.notifications.forEach(item => { item.isRead = true; });
  state.unreadNotifications = 0;
  renderNotifications();
  try { await api('/api/notifications/read-all', { method:'POST', body:'{}' }); }
  catch { state.notifications.forEach((item, index) => { item.isRead = previous[index]; }); state.unreadNotifications = state.notifications.filter(item => !item.isRead).length; renderNotifications(); toast('消息状态更新失败，请稍后重试'); }
}
function closeCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (dialog.open) dialog.close(); dialog.hidden = true;
}
async function openCreditDetail() {
  const dialog = $('#creditDetailDialog'); if (!dialog || dialog.open) return;
  state.creditDetailRestoreFocus = document.activeElement;
  setNotificationPanelOpen(false);
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
function closeDesktopUpdateDialog() {
  const dialog = $('#desktopUpdateDialog');
  if (!dialog) return;
  if (dialog.open) dialog.close();
  else dialog.hidden = true;
}
function openDesktopUpdateDialog() {
  const dialog = $('#desktopUpdateDialog');
  if (!dialog || !['available', 'downloading', 'downloaded', 'installing', 'error'].includes(desktopUpdateState.status)) return;
  dialog.hidden = false;
  if (!dialog.open) dialog.showModal();
}
function renderDesktopUpdateDialog(payload, { open = true } = {}) {
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
  const progressLabel = $('#desktopUpdateProgressLabel');
  const hint = $('#desktopUpdateHint');
  const action = $('#desktopUpdateAction');
  const later = $('#laterDesktopUpdate');
  if (!title || !message || !current || !next || !progressWrap || !progress || !progressLabel || !hint || !action || !later) return;
  current.textContent = currentVersion;
  next.textContent = version;
  dialog.classList.toggle('update-ready', status === 'downloaded');
  dialog.classList.toggle('update-error', status === 'error');
  progress.classList.remove('is-indeterminate');
  progressWrap.classList.remove('hidden');
  later.disabled = status === 'installing';
  if (status === 'available') {
    title.textContent = '发现新版本';
    message.textContent = `GuGu AI ${version} 正在准备下载，完成后会提醒你重启更新。`;
    progress.style.width = '0%';
    progress.classList.add('is-indeterminate');
    progressLabel.textContent = '准备下载…';
    hint.textContent = '更新会在后台下载，你可以先继续使用 GuGu AI。';
    action.textContent = '正在下载…';
    action.disabled = true;
  } else if (status === 'downloading') {
    const percent = Number(desktopUpdateState.percent);
    const hasProgress = Number.isFinite(percent) && percent >= 0;
    title.textContent = '正在下载更新';
    message.textContent = `GuGu AI ${version} 正在下载，完成后会提醒你重启更新。`;
    progress.style.width = `${Math.max(0, Math.min(100, hasProgress ? percent : 0))}%`;
    if (!hasProgress) progress.classList.add('is-indeterminate');
    progressLabel.textContent = hasProgress ? `${Math.round(percent)}% · 正在下载` : '正在下载…';
    hint.textContent = '更新会在后台下载，你可以先继续使用 GuGu AI。';
    action.textContent = '正在下载…';
    action.disabled = true;
  } else if (status === 'downloaded') {
    title.textContent = '更新已下载';
    message.textContent = `GuGu AI ${version} 已下载完成，可以重启客户端更新。`;
    progress.style.width = '100%';
    progressLabel.textContent = '下载完成';
    hint.textContent = '点击“重启更新”后客户端会关闭，请按系统提示重新安装新版本。';
    action.textContent = '重启更新';
    action.disabled = false;
  } else if (status === 'installing') {
    title.textContent = '正在退出客户端';
    message.textContent = `GuGu AI ${version} 即将关闭，请在安装程序中完成更新。`;
    progress.style.width = '100%';
    progressLabel.textContent = '正在退出…';
    hint.textContent = '客户端关闭后，请按安装程序提示完成覆盖安装。';
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
  const close = () => closeDesktopUpdateDialog();
  $('#closeDesktopUpdate').onclick = close;
  $('#laterDesktopUpdate').onclick = close;
  $('#desktopUpdateAction').onclick = async () => {
    if (desktopUpdateState.status === 'error') {
      close();
      try { await bridge.updates.check(); } catch (error) { console.warn('[desktop] 重新检查更新失败', error); }
      return;
    }
    if (desktopUpdateState.status !== 'downloaded') return;
    const action = $('#desktopUpdateAction');
    action.disabled = true;
    try {
      const started = await bridge.updates.install();
      if (!started) throw new Error('更新安装包尚未准备好，请稍后再试');
    } catch (error) {
      action.disabled = false;
      renderDesktopUpdateDialog({ status: 'error', message: error.message, version: desktopUpdateState.version });
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
function showBoot(title = '正在恢复工作区', message = '正在确认登录状态，请稍候。', { retry = false } = {}) {
  setDesktopSurface('boot');
  $('#bootTitle').textContent = title;
  $('#bootMessage').textContent = message;
  toggleClass($('#bootRetry'), 'hidden', !retry);
  toggleClass($('#bootView'), 'hidden', false);
  toggleClass($('#authView'), 'hidden', true);
  toggleClass($('#appView'), 'hidden', true);
}
async function initDesktopBridge() {
  const bridge = window.guguDesktop;
  const buttons = $$('[data-workspace-open]');
  if (!bridge) {
    toggleClass($('#desktopWindowControls'), 'hidden', true);
    return;
  }
  document.body.classList.add('desktop-runtime');
  initWindowControls(bridge);
  try {
    const info = await bridge.getInfo();
    document.body.classList.add(`desktop-${info.platform}`);
    initWindowControls(bridge, info);
    initDesktopModalState(bridge);
    initDesktopUpdateDialog(bridge);
    buttons.forEach(button => {
      button.classList.remove('hidden');
      button.title = `本地工作区：${info.workspacePath || '未设置'}`;
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
      const updateLabel = updateButton.querySelector('span') || updateButton;
      const setUpdateLabel = text => { updateLabel.textContent = text; };
      const setUpdateTitle = text => { updateButton.title = text; };
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
        if (status === 'unconfigured' || status === 'current' || status === 'idle') { hideUpdateButton(); closeDesktopUpdateDialog(); return; }
        showUpdateButton();
        renderDesktopUpdateDialog(payload, { open: ['available', 'downloading', 'downloaded', 'error'].includes(status) });
        if (status === 'checking') { setUpdateLabel('检查更新…'); setUpdateTitle('正在检查更新'); updateButton.disabled = true; }
        else if (status === 'available') { setUpdateLabel('下载更新'); setUpdateTitle(`正在下载 GuGu AI ${payload.version || '新版本'}`); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
        else if (status === 'downloading') { setUpdateLabel(`更新 ${payload.percent || 0}%`); setUpdateTitle('正在下载更新'); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
        else if (status === 'downloaded') { setUpdateLabel('重启更新'); setUpdateTitle('重启客户端并重新安装更新'); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
        else if (status === 'installing') { setUpdateLabel('正在退出…'); setUpdateTitle('退出后将打开安装程序'); updateButton.disabled = true; }
        else if (status === 'error') { setUpdateLabel('检查更新'); setUpdateTitle('更新暂不可用'); updateButton.disabled = false; updateButton.onclick = openDesktopUpdateDialog; }
      };
      desktopUpdateUnsubscribe?.();
      desktopUpdateUnsubscribe = bridge.updates.onStatus(applyUpdateStatus);
      updateButton.onclick = () => bridge.updates.check();
      Promise.resolve(bridge.updates.getStatus?.()).then(payload => {
        if (payload?.status && payload.status !== 'idle') applyUpdateStatus(payload);
      }).catch(() => {});
    }
  } catch (error) {
    buttons.forEach(button => { button.title = `本地工作区不可用：${error.message}`; });
  }
}
function showAuth() {
  setDesktopSurface('auth');
  state.user = null;
  toggleClass($('#bootView'), 'hidden', true);
  toggleClass($('#authView'), 'hidden', false);
  toggleClass($('#appView'), 'hidden', true);
  document.title = '登录 · GuGu AI';
}
function showApp() {
  setDesktopSurface('app');
  toggleClass($('#bootView'), 'hidden', true);
  toggleClass($('#authView'), 'hidden', true);
  toggleClass($('#appView'), 'hidden', false);
}
function finishInitialWorkspaceSync() {
  state.initialSyncReady = true;
  if (state.route === 'files') renderFiles();
  else if (['image', 'video'].includes(state.route)) renderTasks();
  else if (state.route === 'drama') dramaController.refreshTasks();
}
async function enterApp(user) {
  state.user = user;
  state.initialSyncReady = false;
  showBoot('正在加载工作区', '正在同步你的品牌素材与生成记录，请稍候。');
  const initial = user.username[0].toUpperCase();
  $('#accountName').textContent = user.username;
  $('#menuName').textContent = user.username;
  $('#accountInitial').textContent = initial;
  $('#menuInitial').textContent = initial;
  setCreditBalance(user.credits);

  // Route first: the shell and its controls can paint while the workspace data
  // is fetched in parallel. Each loader already refreshes the active surface
  // when its own response arrives.
  navigate(routeFromPath(window.location.pathname), { historyMode:'replace' });
  showApp();

  const schedulePriceDialog = () => window.setTimeout(() => { void openModelPriceDialog({ auto:true }); }, 300);
  void Promise.all([loadConfig(), loadCredits(), loadNotifications(), loadFiles(), loadTasks()]).then(
    () => { finishInitialWorkspaceSync(); schedulePriceDialog(); },
    error => { console.warn('[workspace] initial sync failed', error); finishInitialWorkspaceSync(); schedulePriceDialog(); },
  );
  // The price catalog is non-essential for the first interaction. It is
  // deferred until the initial background sync settles so it cannot compete
  // with the first page render or duplicate the config request.
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
  try {
    if (window.guguDesktop && file.localOnly) await window.guguDesktop.media.renameLocal({ assetId:file.localId || file.id, name });
    else {
      await api(`/api/files/${file.id}`, { method:'PATCH', body:JSON.stringify({ name }) });
      if (window.guguDesktop && file.localId) await window.guguDesktop.media.renameLocal({ assetId:file.localId, name });
    }
    closeRenameFileDialog(); toast('文件已重命名'); await loadFiles();
  }
  catch (error) { renameFileError(error.message); button.disabled = false; }
});
$('#closeRenameFile').onclick = $('#cancelRenameFile').onclick = closeRenameFileDialog;
$('#renameFileDialog').addEventListener('cancel', event => { event.preventDefault(); closeRenameFileDialog(); });
$('#renameFileDialog').addEventListener('close', () => { const restore = renameFileRestoreFocus; renameFileId = ''; renameFileRestoreFocus = null; renameFileError(); requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); }); });

const dramaController = createDramaStudio({ api, state, esc, toast, setCreditBalance, creditText, loadTasks, loadCredits, loadFiles, uploadImage:pickAndUploadDramaImage, uploadAsset:pickAndUploadDramaAsset, confirmDelete, taskFailure, isAssetSyncing:isDesktopAssetSyncing });

function navigate(route, { historyMode = 'push' } = {}) { const nextRoute = routePaths[route] ? route : 'image'; if (historyMode !== 'none' && window.location.pathname !== routePaths[nextRoute]) { window.history[historyMode === 'replace' ? 'replaceState' : 'pushState']({ route:nextRoute }, '', routePaths[nextRoute]); } state.route = nextRoute; const routeTitles = { image:'图像生成', video:'视频生成', drama:'短剧创作', files:'文件库' }; $('#routeTitle').textContent = routeTitles[nextRoute]; document.title = `${routeTitles[nextRoute]} · GuGu AI`; $$('.rail-button[data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === nextRoute)); const files = nextRoute === 'files'; const drama = nextRoute === 'drama'; const wide = files || drama; toggleClass($('#appView'), 'library-mode', files); toggleClass($('#appView'), 'wide-mode', drama); toggleClass($('#appView'), 'drama-project-open', drama && Boolean(state.dramaProject)); toggleClass($('#appView'), 'drama-professional-open', drama && state.dramaProject?.mode === 'professional'); toggleClass($('#creatorPanel'), 'hidden', wide); toggleClass($('#generationView'), 'hidden', wide); toggleClass($('#filesView'), 'hidden', !files); toggleClass($('#dramaView'), 'hidden', !drama); if (!wide) { $$('[data-panel]').forEach(panel => toggleClass(panel, 'hidden', panel.dataset.panel !== nextRoute)); renderTasks(); } else if (files) renderFiles(); else { updateDramaModelState(); dramaController.load(); } }
$$('.rail-button[data-route]').forEach(button => button.onclick = () => navigate(button.dataset.route));
window.addEventListener('popstate', () => { if (state.user) navigate(routeFromPath(window.location.pathname), { historyMode:'none' }); });
const notificationMenuItem = $('.notification-menu-item');
const notificationMenuButton = $('#notificationMenuButton');
notificationMenuItem?.addEventListener('mouseenter', () => { if (!$('#accountMenu').classList.contains('hidden')) setNotificationPanelOpen(true); });
notificationMenuItem?.addEventListener('mouseleave', () => { if (!notificationMenuItem.matches(':focus-within')) scheduleNotificationPanelClose(); });
notificationMenuItem?.addEventListener('focusin', () => { if (!$('#accountMenu').classList.contains('hidden')) setNotificationPanelOpen(true); });
notificationMenuItem?.addEventListener('focusout', () => requestAnimationFrame(() => { if (!notificationMenuItem.matches(':focus-within') && !notificationMenuItem.matches(':hover')) scheduleNotificationPanelClose(); }));
notificationMenuButton?.addEventListener('click', event => { event.stopPropagation(); setNotificationPanelOpen(true); });
$('#accountButton').onclick = event => { event.stopPropagation(); const menu = $('#accountMenu'); const opening = menu.classList.contains('hidden'); menu.classList.toggle('hidden', !opening); $('#accountButton').setAttribute('aria-expanded', String(opening)); if (!opening) setNotificationPanelOpen(false); if (opening) renderNotifications(); };
$('#markAllNotifications').onclick = event => { event.stopPropagation(); void markAllNotificationsRead(); };
document.addEventListener('click', event => { if (!$('#accountMenu').contains(event.target) && event.target !== $('#accountButton')) { $('#accountMenu').classList.add('hidden'); setNotificationPanelOpen(false); $('#accountButton').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#accountMenu').classList.contains('hidden')) { $('#accountMenu').classList.add('hidden'); setNotificationPanelOpen(false); $('#accountButton').setAttribute('aria-expanded', 'false'); $('#accountButton').focus(); } });
$('#logoutButton').onclick = async () => { await api('/api/auth/logout', { method:'POST', body:'{}' }); location.reload(); };
async function loadConfig() {
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
    state.config = config;
    if (config.pricing) state.pricing = { ...state.pricing, image: config.pricing.imagePerRequest, videoPerSecond: config.pricing.videoPerSecond };
    syncVideoModelOptions();
    updateServiceState(config.imageGeneration);
    updateDramaModelState();
  } catch {
    state.config = { videoCapabilities: { models: [] } };
    syncVideoModelOptions();
    updateServiceState(false);
    updateDramaModelState();
  }
}

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
  $('#dramaAnalysis').innerHTML = `<nav class="workflow-steps" aria-label="短剧制作进度"><span class="done">01 剧本</span><span class="done">02 分镜</span><span class="active">03 关键帧</span><span class="${completedVideos === shots.length && shots.length ? 'done' : ''}">04 视频</span></nav><header class="storyboard-title"><div><span>DIRECTOR BOARD / ${shots.length} SHOTS</span><h2>${esc(project.title)}</h2><p>每个镜头固定 6 秒。先生成关键帧，确认视觉后再单独预扣视频费用。</p></div><strong>${completedVideos}<small> / ${shots.length} 完片</small></strong></header><div class="shot-list">${shots.map((shot,index) => { const keyframeTask = shotTask(shot,'keyframe'); const videoTask = shotTask(shot,'video'); const keyframe = shotAsset(keyframeTask); const video = shotAsset(videoTask); const media = video ? videoPreviewMarkup(video, 'shot-video-placeholder') : keyframe ? `<img src="${keyframe.url}" alt="${esc(shot.title)}" loading="lazy">` : `<div class="shot-placeholder"><span>${String(index+1).padStart(2,'0')}</span><small>KEYFRAME</small></div>`; return `<article class="shot-card"><div class="shot-media">${media}<span class="shot-duration">6 SEC</span></div><div class="shot-copy"><header><span>SCENE ${String(shot.sceneNumber).padStart(2,'0')} / SHOT ${String(shot.shotNumber).padStart(2,'0')}</span><h3>${esc(shot.title)}</h3></header><div class="shot-meta"><span>${esc(shot.shotSize)}</span><span>${esc(shot.cameraMovement)}</span><span>${esc((shot.characters || []).join('、') || '空镜')}</span></div><p>${esc(shot.action)}</p>${shot.dialogue ? `<blockquote>${esc(shot.dialogue)}</blockquote>` : ''}<details><summary>查看生成提示词</summary><p>${esc(videoTask ? shot.videoPrompt : shot.keyframePrompt)}</p></details><footer>${shotAction(shot,keyframeTask,videoTask)}</footer></div></article>`; }).join('')}</div>`;
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
      // updatedAt is useful metadata but is not rendered on a task card. Do
      // not rebuild the gallery merely because the server touched a timestamp
      // during background polling.
      const changed = listSignature(state.tasks, taskCardSignatureFields) !== listSignature(tasks, taskCardSignatureFields);
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
function localDownloadAction(file, label='下载') {
  if (window.guguDesktop && file?.localStatus === 'saved') return `<button class="task-action download-local" type="button" data-asset-id="${esc(file.localId || file.id)}" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg></button>`;
  return `<a class="task-action" href="/api/files/${encodeURIComponent(file.id)}/download" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg></a>`;
}
function configureDownloadLink(link, file) {
  if (!link || !file) return;
  link.onclick = null;
  if (window.guguDesktop && file.localStatus === 'saved') {
    link.href = '#';
    link.onclick = async event => { event.preventDefault(); try { const result = await window.guguDesktop.media.saveLocalAs({ assetId:file.localId || file.id }); if (result?.path) toast(`已保存到 ${result.path}`); } catch (error) { toast(`保存失败：${error.message}`); } };
  } else link.href = `/api/files/${encodeURIComponent(file.id)}/download`;
}
function taskCard(task) {
  const asset = fileById(task.assetId);
  const localSyncing = taskLocalSyncing(task, asset);
  const displayStatus = taskDisplayStatus(task, asset);
  const progressMarkup = localSyncing ? desktopSyncMarkup(task) : videoProgressMarkup(task);
  const failure = task.status === 'failed' ? taskFailure(task) : null;
  const media = asset && !localSyncing
    ? (task.type === 'image' ? `<div class="card-media">${assetImageMarkup(asset, asset.name)}</div>` : `<div class="card-media video">${videoPreviewMarkup(asset)}</div>`)
    : task.status === 'failed'
      ? `<div class="card-failure"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg><b>${esc(failure?.message || '生成失败')}</b><p>${esc(failure?.suggestion || '请调整内容后重试')}</p></div>`
      : task.assetId && !localSyncing
        ? `<div class="card-failure"><svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 1.7 3h15.4a2 2 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg><b>成品文件未找到</b><p>任务已完成，但文件库中没有对应文件</p></div>`
        : `<div class="card-placeholder ${displayStatus}"${progressMarkup ? '' : ' aria-hidden="true"'}><div class="skeleton-frame"><i></i><i></i><i></i></div>${progressMarkup}</div>`;
  const completedActions = asset && !localSyncing ? `<div class="card-workflow-actions"><button class="task-action" type="button" data-action="preview" data-task-id="${task.id}" title="预览"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4M11 8v6M8 11h6"/></svg><span>预览</span></button>${task.type === 'image' ? `<button class="task-action" type="button" data-action="reference" data-task-id="${task.id}" title="作为参考"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="m4 16 5-5 4 4 2-2 5 4"/></svg><span>参考</span></button>` : ''}<button class="task-action" type="button" data-action="continue" data-task-id="${task.id}" title="再创作"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg><span>再创作</span></button>${localDownloadAction(asset)}<button class="task-action" type="button" data-action="more" data-task-id="${task.id}" title="更多操作" aria-label="更多操作"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button></div>` : '';
  const failedAction = task.status === 'failed' && !['wait','contact_support'].includes(failure?.action) ? `<button class="failure-retry task-action" type="button" data-action="continue" data-task-id="${task.id}"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>${esc(taskFailureActionLabel(failure))}</button>` : '';
  const openButton = localSyncing ? '' : `<button class="media-open open-task" type="button" data-task-id="${task.id}" aria-label="查看${task.type === 'image' ? '商品图' : '商品视频'}详情"></button>`;
  return `<article class="task-card ${displayStatus}${localSyncing ? ' local-syncing' : ''}" data-record-id="${task.id}"><div class="card-visual">${media}${openButton}${completedActions}${failedAction}</div></article>`;
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
  card.querySelector('.download-local')?.addEventListener('click', async event => {
    event.stopPropagation();
    const result = await window.guguDesktop?.media?.saveLocalAs?.({ assetId:event.currentTarget.dataset.assetId });
    if (result?.path) toast(`已保存到 ${result.path}`);
  });
}
function taskRenderSignature(task) {
  const asset = fileById(task.assetId);
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
function taskRecency(task) { return String(task.finishedAt || task.updatedAt || task.createdAt || ''); }
function compareTasksByRecency(left, right) {
  const timeOrder = taskRecency(right).localeCompare(taskRecency(left));
  return timeOrder || String(right.id || '').localeCompare(String(left.id || ''));
}
function renderTasks() {
  if (!['image','video'].includes(state.route)) return;
  syncGenerationView();
  const renderState = { route:state.route, filter:state.generationFilter, ready:state.initialSyncReady, tasks:state.tasks, files:state.files };
  if (lastTaskRender.route === renderState.route
    && lastTaskRender.filter === renderState.filter
    && lastTaskRender.ready === renderState.ready
    && lastTaskRender.tasks === renderState.tasks
    && lastTaskRender.files === renderState.files) return;
  let tasks = state.tasks.filter(task => task.type === state.route);
  if (state.generationFilter !== 'all') tasks = tasks.filter(task => state.generationFilter === 'running' ? ['queued','running'].includes(task.status) || taskLocalSyncing(task) : task.status === state.generationFilter && !taskLocalSyncing(task));
  tasks.sort(compareTasksByRecency);
  const hasInitialData = state.initialSyncReady || state.tasks.length > 0;
  const empty = hasInitialData
    ? emptyState(`还没有商品${state.route === 'image' ? '图' : '视频'}`, state.route === 'image' ? '从商品主图、场景图或细节特写开始制作。' : '上传商品素材，制作第一条营销视频。')
    : emptyState('正在加载作品', '正在同步你的生成记录，页面可以先使用。');
  reconcileCards($('#generationGrid'), hasInitialData ? tasks : [], { card:taskCard, signature:taskRenderSignature, bind:bindTaskCard, empty });
  lastTaskRender = renderState;
}
$$('.filter').forEach(button => button.onclick = () => { state.generationFilter = button.dataset.status; $$('.filter').forEach(x => x.classList.toggle('active', x === button)); renderTasks(); });
$$('.view-toggle').forEach(button => button.onclick = () => { state.generationView = button.dataset.view; syncGenerationView(); });

function detailRow(label, value, id='') { return `<div><dt>${esc(label)}</dt><dd${id ? ` id="${id}"` : ''}>${esc(value)}</dd></div>`; }
function generationModelName(task) {
  const modelId = String(task?.videoModelId || task?.modelId || '').trim();
  if (!modelId) return '—';
  const configuredModels = Array.isArray(state.config?.videoCapabilities?.models) ? state.config.videoCapabilities.models : [];
  const model = [...configuredModels, ...fallbackVideoModels].find(item => item.id === modelId);
  if (model?.label) return model.label;
  const legacyLabels = { 'grok-15':'GuGu 2.0', 'legacy-grok-video-1.5':'GuGu 1.5' };
  return legacyLabels[modelId] || modelId;
}
function addTaskReference(task, target=task.type) { if (!task) return false; const ids = task.type === 'image' && task.assetId ? [task.assetId] : Array.isArray(task.referenceAssetIds) ? task.referenceAssetIds : []; const references = ids.filter(id => state.files.some(file => file.id === id && file.kind === 'image' && !file.localOnly)); if (!references.length) return false; state.refs[target] = [...new Set([...references, ...state.refs[target]])].slice(0, 7); renderReferences(); return true; }
function continueFromTask(task, target=task.type, includeReference=false) {
  if (!task) return;
  if ($('#generationDetailDialog').open) closeGenerationDetail();
  navigate(target);
  const prompt = $(`#${target}Prompt`);
  if (target === 'video') setVideoPromptText(task.prompt || '');
  else prompt.value = task.prompt || '';
  prompt.dispatchEvent(new Event('input', { bubbles:true }));
  if (target === 'image' && task.size) { $('#imageSize').value = task.size; $$('.ratio-grid [data-value]').forEach(button => button.classList.toggle('selected', button.dataset.value === task.size)); const extra = $(`.ratio-extra[data-value="${CSS.escape(task.size)}"]`); if (extra) { extra.classList.remove('hidden'); $('#moreRatios').setAttribute('aria-expanded', 'true'); } if (task.quality) { $('#imageQuality').value = task.quality; $$('.segmented[data-select="imageQuality"] button').forEach(button => button.classList.toggle('selected', button.dataset.value === task.quality)); } }
  if (target === 'video' && task.type === 'video') {
    const taskModelId = task.videoModelId || task.modelId;
    const selectableModel = videoModelOptions().some(model => model.id === taskModelId && model.availability !== 'coming-soon');
    if (selectableModel && $('#videoModel').value !== taskModelId) {
      $('#videoModel').value = taskModelId;
      $('#videoModel').dispatchEvent(new Event('change', { bubbles:true }));
    } else syncVideoModelParameters();
    const parameters = videoGenerationParameters().parameters;
    if (parameters?.aspectRatios.includes(task.aspectRatio)) $('#videoAspect').value = task.aspectRatio;
    if (parameters?.durations.includes(Number(task.duration))) $('#videoDuration').value = String(task.duration);
    if (parameters?.qualityOptions.includes(task.quality)) $('#videoResolution').value = task.quality;
    refreshProductSelect('videoAspect'); refreshProductSelect('videoDuration'); refreshProductSelect('videoResolution'); updateVideoCost();
  }
  if (includeReference) addTaskReference(task, target);
  $('#creatorPanel').scrollTo({ top:0, behavior:'smooth' }); prompt.focus();
  toast(includeReference ? '已带入参考图和创作描述' : '已带入创作描述，可调整后重新生成');
}
function handleTaskAction(action, id) { const task = taskById(id); if (!task) return; if (action === 'preview' || action === 'more') return openGenerationDetail(id); if (action === 'reference') { continueFromTask(task, task.type, true); return; } if (action === 'continue') continueFromTask(task); }
function fitDetailMedia(media, width, height) { if (!media || !width || !height) return; const portrait=height>width; media.classList.toggle('portrait-media', portrait); media.classList.toggle('landscape-media', !portrait); }
function resetDetailFit(dialog) { dialog.classList.remove('portrait-detail'); dialog.style.removeProperty('--portrait-dialog-width'); }
function closeGenerationDetail() { const dialog = $('#generationDetailDialog'); dialog.close(); resetDetailFit(dialog); $('#generationDetailMedia').innerHTML = ''; state.detailTaskId = null; }
function openGenerationDetail(id) {
  const task = taskById(id); if (!task) return;
  const asset = fileById(task.assetId);
  const localSyncing = taskLocalSyncing(task, asset);
  if (asset && !localSyncing && !requireDesktopLocalAsset(asset)) return; state.detailTaskId = id;
  const displayStatus = taskDisplayStatus(task, asset);
  const media = localSyncing
    ? '<div class="detail-placeholder running" role="status" aria-live="polite"><div class="loader-ring"></div><span>正在同步到本地…</span></div>'
    : asset
    ? (task.type === 'image' ? `<img src="${asset.url}" alt="${esc(asset.name)}">` : `<video src="${asset.url}" controls autoplay></video>`)
    : task.assetId
      ? `<div class="detail-missing-file"><b>成品文件未找到</b><span>任务已完成，但文件库中没有对应文件</span></div>`
      : `<div class="detail-placeholder ${task.status}" aria-hidden="true"><div class="loader-ring"></div></div>`;
  $('#generationDetailMedia').innerHTML = media;
  $('#generationDetailTitle').textContent = '文件详情';
  const status = $('#generationDetailStatus'); status.className = `detail-status ${displayStatus}`; status.textContent = statusText(displayStatus);
  $('#generationDetailPrompt').textContent = task.prompt;
  const promptElement = $('#generationDetailPrompt'); const promptToggle = $('#generationDetailPromptToggle'); promptElement.classList.remove('expanded'); promptToggle.classList.add('hidden'); promptToggle.setAttribute('aria-expanded', 'false'); promptToggle.textContent = '展开全部'; requestAnimationFrame(() => { const overflowing = promptElement.scrollHeight > promptElement.clientHeight + 1; promptToggle.classList.toggle('hidden', !overflowing); });
  const creditText = task.creditStatus === 'refunded' ? `${task.creditCost} 积分 · 已退回` : task.creditStatus === 'refund_failed' ? `${task.creditCost} 积分 · 退款异常` : `${task.creditCost} 积分`;
  const visualSpec = task.type === 'image' ? task.size : `${task.aspectRatio} · ${task.duration} 秒 · ${task.quality || '720p'}`;
  const fileText = localSyncing ? '正在同步到本地' : asset ? `${formatBytes(asset.size)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height} px` : ''}` : '暂无成品文件';
  const modelMeta = task.type === 'video' ? detailRow('使用模型', generationModelName(task)) : '';
  $('#generationCoreMeta').innerHTML = modelMeta + detailRow('尺寸与画幅', visualSpec) + detailRow('生成时间', fullDateText(task.createdAt));
  $('#generationDetailMeta').innerHTML = detailRow('内容类型', task.type === 'image' ? '图片' : '视频') + detailRow('文件信息', fileText, 'generationDetailFile') + detailRow('积分记录', creditText) + detailRow('任务编号', task.id);
  const error = $('#generationDetailError'); const failure = taskFailure(task); error.textContent = taskErrorText(task); error.classList.toggle('hidden', !failure);
  const download = $('#downloadGeneration'); download.classList.toggle('hidden', !asset || localSyncing); configureDownloadLink(download, localSyncing ? null : asset);
  $('#useGenerationReference').classList.toggle('hidden', !asset || localSyncing || task.type !== 'image');
  const deriveButton = $('#deriveGeneration'); const deriveSame = task.type !== 'image'; deriveButton.classList.toggle('hidden', !asset || localSyncing); deriveButton.classList.toggle('gradient-button', deriveSame); deriveButton.classList.toggle('secondary-button', !deriveSame); deriveButton.innerHTML = deriveSame ? '<svg viewBox="0 0 24 24"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></svg>生成同款' : '生成视频'; deriveButton.parentElement.classList.toggle('single-action', deriveSame);
  const deleteButton = $('#deleteGeneration'); const active = localSyncing || ['queued','running'].includes(task.status); deleteButton.disabled = active; deleteButton.title = active ? '任务生成中，完成后才能删除' : '';

  $('#generationDetailDialog').showModal();
  if (asset && !localSyncing) {
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
$('#deleteGeneration').onclick = async () => { if ($('#deleteGeneration').disabled) return; const task = state.tasks.find(item => item.id === state.detailTaskId); if (!task || !await confirmDelete({ title:'确认删除作品', message:'作品一旦删除，无法恢复。' })) return; const id = task.id; const button = $('#deleteGeneration'); button.disabled = true; try { await api(`/api/generations/${id}`, { method:'DELETE', body:'{}' }); if (task.assetId) clearFileReferences(task.assetId); closeGenerationDetail(); await Promise.all([loadTasks(), loadFiles()]); toast('作品及关联文件已删除'); } catch (error) { toast(error.message); } finally { button.disabled = false; } };

async function loadFiles({ background=false }={}) {
  if (filesRequest) { const pending = filesRequest; return background ? pending : pending.then(() => loadFiles({ background:true })); }
  filesRequest = (async () => {
    let localFiles = [];
    try {
      if (window.guguDesktop) {
        localFiles = await listDesktopFiles();
        // Seed an initially empty view from the local index, but never replace
        // an already merged remote list with the local-only subset. Doing so
        // briefly removes remote assets while the next API page is loading and
        // makes every thumbnail disappear and reappear during a refresh.
        if (!state.files.length && localFiles.length) {
          state.files = mergeDesktopFiles([], localFiles);
          renderFiles();
          renderReferences();
          if (['image','video'].includes(state.route)) renderTasks();
        }
      }
      const remoteFiles = await listAllRemoteFiles();
      if (window.guguDesktop) desktopInitialSyncStarted = true;
      const files = mergeDesktopFiles(await enrichDesktopFiles(remoteFiles, localFiles), localFiles);
      const changed = listSignature(state.files, fileCardSignatureFields) !== listSignature(files, fileCardSignatureFields);
      if (changed) {
        state.files = mergeTransientFields(state.files, files, ['width','height']);
        renderFiles();
        renderReferences();
        if (['image','video'].includes(state.route)) renderTasks();
        else if (state.route === 'drama') dramaController.refreshTasks();
      }
      queueDesktopHydration(state.files);
      if (!changed) return state.files;
      return state.files;
    } catch (error) {
      if (error.status === 401) return location.reload();
      if (!background) toast(window.guguDesktop && localFiles.length ? '当前网络不可用，已从本地工作区加载素材' : error.message);
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
  const task = taskForAsset(file);
  if (task?.prompt) { const subject = task.prompt.trim().split(/[，。；,;\n]/)[0].replace(/^(请|帮我|生成|制作|创建|一张|一幅|一个|一段)/, '').trim().slice(0, 18); if (subject) return `${subject}｜${file.kind === 'image' ? '商品图' : file.kind === 'audio' ? '音频' : '商品视频'}`; }
  const date = new Date(file.createdAt); const day = Number.isNaN(date.getTime()) ? '' : `｜${String(date.getMonth()+1).padStart(2,'0')}月${String(date.getDate()).padStart(2,'0')}日`;
  return `导入${file.kind === 'image' ? '图片' : file.kind === 'audio' ? '音频' : '视频'}${day}`;
}
function fileCard(file) { const displayName = assetDisplayName(file); const media = file.kind === 'image' ? assetImageMarkup(file, displayName) : file.kind === 'audio' ? '<span class="audio-file-mark">♫</span>' : videoPreviewMarkup(file); const download = window.guguDesktop && file.localStatus === 'saved' ? `<button class="download-local" data-asset-id="${esc(file.localId || file.id)}">下载</button>` : `<a href="/api/files/${encodeURIComponent(file.id)}/download">下载</a>`; return `<article class="file-card" data-record-id="${file.id}"><button class="file-preview preview-file" data-id="${file.id}" aria-label="预览 ${esc(displayName)}">${media}<span class="asset-preview-label">预览</span></button><button class="more-button file-card-more" aria-label="文件操作" data-id="${file.id}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><div class="file-menu hidden" data-menu="${file.id}"><button class="rename-file" data-id="${file.id}">重命名</button>${download}<button class="delete-file danger" data-id="${file.id}">删除</button></div></article>`; }
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
function notifyUploadSurfaceChanged() { if (state.route === 'files') renderFiles(); if ($('#referenceDialog')?.open) { renderReferenceDialog(); resetReferenceDialogScroll(); } renderReferences(); window.dispatchEvent(new CustomEvent('gugu-upload-state-change')); }
function createUploadJob(file, context, { previewUrl='', mimeType=normalizedUploadMime(file), deferUpload=false, localAssetId='' } = {}) {
  const objectUrl = previewUrl || (file ? URL.createObjectURL(file) : '');
  const job = { id:`upload-${crypto.randomUUID()}`, context, referenceTarget:context==='reference' ? state.referenceTarget : '', videoFrameTarget:context==='reference' ? state.videoFrameTarget : '', name:String(file?.name || '未命名文件'), mimeType, kind:uploadJobKind(mimeType), size:Number(file?.size || 0), previewUrl:objectUrl, revokePreview:Boolean(objectUrl && !previewUrl), file:localAssetId ? null : file, localAssetId, deferUpload, progress:0, status:deferUpload ? 'pending' : 'queued', label:deferUpload ? '已加入，创作时上传' : '准备上传', error:'', selected:false, assetId:'' };
  state.uploadJobs.push(job); notifyUploadSurfaceChanged(); return job;
}
function updateUploadJob(job, progress, label='正在上传') { if (!job) return; job.progress=Math.max(0, Math.min(100, Number(progress) || 0)); job.label=label; job.status=job.status === 'queued' ? 'uploading' : job.status; const now=Date.now(); if (now-job.lastRenderAt < 60 && job.progress < 100) return; job.lastRenderAt=now; notifyUploadSurfaceChanged(); }
function finishUploadJob(job, asset, selected=false, afterAsset=null) { if (!job || !asset) return; state.files=[asset,...state.files.filter(item=>item.id!==asset.id)]; const finalSelected=afterAsset ? Boolean(afterAsset(asset)) : selected; job.assetId=asset.id; job.progress=100; job.status='completed'; job.label=finalSelected ? '上传完成，已选中' : '上传完成'; job.selected=finalSelected; notifyUploadSurfaceChanged(); window.setTimeout(() => removeUploadJob(job.id), 1200); }
function failUploadJob(job, error) { if (!job) return; job.status='failed'; job.progress=0; job.error=error?.message || '上传失败'; job.label=job.error; notifyUploadSurfaceChanged(); }
function removeUploadJob(id) { const index=state.uploadJobs.findIndex(job=>job.id===id); if (index<0) return; const [job]=state.uploadJobs.splice(index,1); if (job.revokePreview && job.previewUrl) URL.revokeObjectURL(job.previewUrl); if (job.localAssetId && !job.assetId && window.guguDesktop?.media?.removeLocal) void window.guguDesktop.media.removeLocal(job.localAssetId).then(() => loadFiles({ background:true })).catch(error => console.warn('[desktop] 清理待上传本地素材失败', error)); notifyUploadSurfaceChanged(); }
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
function renderFiles() {
  if (state.route !== 'files') return;
  const query = $('#fileSearch').value.trim().toLowerCase();
  const matches = file => (state.fileKind === 'all' || file.kind === state.fileKind) && (!query || `${file.name} ${assetDisplayName(file)}`.toLowerCase().includes(query));
  const uploads = state.uploadJobs.filter(job => job.context === 'library' && (!query || job.name.toLowerCase().includes(query)) && (state.fileKind === 'all' || job.kind === state.fileKind));
  const uploadingAssetIds = new Set(uploads.map(job => job.assetId).filter(Boolean));
  const files = state.files.filter(file => matches(file) && !uploadingAssetIds.has(file.id));
  const hasInitialData = state.initialSyncReady || state.files.length > 0 || uploads.length > 0;
  $('#fileCount').textContent = hasInitialData ? `${files.length + uploads.length} 个文件${uploads.length ? ` · ${uploads.length} 个上传中` : ''}` : '正在加载…';
  const empty = hasInitialData
    ? uploads.length ? '' : emptyState(state.files.length ? '没有匹配的文件' : '文件库还是空的', state.files.length ? '换个关键词或文件类型试试。' : '上传素材，或完成一次生成后，文件会自动保存在这里。', state.files.length ? '' : '<button class="upload-button empty-upload">上传第一个文件</button>')
    : emptyState('正在加载文件库', '正在同步你的品牌素材，页面可以先使用。');
  const grid = $('#fileGrid');
  reconcileCards(grid, files, { card:fileCard, signature:fileRenderSignature, bind:bindFileActions, empty });
  renderUploadJobCards(grid, uploads, 'file');
  grid.querySelector('.empty-upload')?.addEventListener('click', () => openUploadPicker('library'), { once:true });
}
$('#fileSearch').oninput = renderFiles; $$('.type-tabs button').forEach(button => button.onclick = () => { state.fileKind = button.dataset.kind; $$('.type-tabs button').forEach(x => x.classList.toggle('active', x === button)); renderFiles(); });
function clearFileReferences(fileId) {
  state.refs.image = state.refs.image.filter(id => id !== fileId);
  state.refs.video = state.refs.video.filter(id => id !== fileId);
  if (state.videoFrames.first === fileId) state.videoFrames.first = '';
  if (state.videoFrames.last === fileId) state.videoFrames.last = '';
  removeVideoPromptMentionNodes(fileId);
}
async function removeFile(file) {
  if (window.guguDesktop && file.localOnly) {
    await window.guguDesktop.media.removeLocal(file.id);
    clearFileReferences(file.id);
    await loadFiles();
    return;
  }
  await api(`/api/files/${file.id}`, { method:'DELETE', body:'{}' });
  if (window.guguDesktop && file.localId) await window.guguDesktop.media.removeLocal(file.localId);
  clearFileReferences(file.id);
  await loadFiles();
}
function bindFileActions(root) {
  root.querySelector('.preview-file')?.addEventListener('click', event => openPreview(event.currentTarget.dataset.id));
  root.querySelector('.more-button')?.addEventListener('click', event => { event.stopPropagation(); const button = event.currentTarget; $$('[data-menu]').forEach(menu => menu.classList.toggle('hidden', menu.dataset.menu !== button.dataset.id || !menu.classList.contains('hidden'))); });
  root.querySelector('.download-local')?.addEventListener('click', async event => { event.stopPropagation(); const result = await window.guguDesktop?.media?.saveLocalAs?.({ assetId:event.currentTarget.dataset.assetId }); if (result?.path) toast(`已保存到 ${result.path}`); });
  root.querySelector('.rename-file')?.addEventListener('click', event => { const file = state.files.find(x => x.id === event.currentTarget.dataset.id); openRenameFileDialog(file); });
  root.querySelector('.delete-file')?.addEventListener('click', async event => { const file = state.files.find(x => x.id === event.currentTarget.dataset.id); if (!file || !await confirmDelete({ title:'确认删除素材', message:'素材一旦删除，无法恢复。' })) return; try { await removeFile(file); toast('文件已删除'); } catch (error) { toast(error.message); } });
}
document.addEventListener('click', () => $$('[data-menu]').forEach(menu => menu.classList.add('hidden')));

function videoReferenceParameters(modelId=$('#videoModel')?.value) { return videoModelParameters(modelId, 'REFERENCE'); }
function referenceLimits(modelId=$('#videoModel')?.value) { const parameters = videoReferenceParameters(modelId); const configured = parameters?.referenceLimits; if (configured) return configured; const maxImages = Number(parameters?.maxImages || 0); return { image: maxImages, video: 0, audio: 0, total: maxImages }; }
function referenceAccept(modelId=$('#videoModel')?.value) { const limits = referenceLimits(modelId); return [limits.image ? imageAccept : '', limits.video ? videoAccept : '', limits.audio ? audioAccept : ''].filter(Boolean).join(','); }
function referenceFileKinds(modelId=$('#videoModel')?.value) { const limits = referenceLimits(modelId); return new Set(['image', 'video', 'audio'].filter(kind => Number(limits[kind] || 0) > 0)); }
function pendingReferenceJob(id) { return state.uploadJobs.find(job => job.id === id && job.context === 'reference') || null; }
function pendingReferenceFile(job) { return job ? { id:job.id, name:job.name, kind:job.kind, mimeType:job.mimeType, size:job.size, url:job.previewUrl, previewUrl:job.previewUrl, pendingUpload:true, localOnly:true } : null; }
function referenceFileById(id) {
  const file = state.files.find(item => item.id === id && !item.localOnly);
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
async function desktopImportToContext(context) {
  const bridge = window.guguDesktop;
  if (!bridge) return;
  const imported = await bridge.media.chooseAndImport();
  if (!imported.length) return;
  const inDialog = context === 'reference';
  const isFrame = inDialog && state.referenceTarget === 'video-frame';
  const isVideoReference = inDialog && state.referenceTarget === 'video';
  const allowedKinds = inDialog ? (isFrame ? new Set(['image']) : referenceFileKinds()) : new Set(['image', 'video', 'audio']);
  const limits = isFrame ? { image: 1, video: 0, audio: 0, total: 1 } : isVideoReference ? referenceLimits() : { image: 7, video: 0, audio: 0, total: 7 };
  let synced = 0;
  let selected = 0;
  for (const item of imported) {
    if (item.error) { if (item.id) void bridge.media.removeLocal(item.id).catch(()=>{}); toast(`${item.filePath || '文件'} 导入失败：${item.error}`); continue; }
    const kind = desktopMediaKind(item);
    const discardImported = () => { if (item.id) void bridge.media.removeLocal(item.id).catch(error => console.warn('[desktop] 清理非法导入失败', error)); };
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
      job=createUploadJob({ name:item.name, size:item.size, type:item.mimeType }, context, { previewUrl, mimeType:item.mimeType, deferUpload:inDialog, localAssetId:item.id });
      if (inDialog) {
        if (!autoSelectUploadedReference(pendingReferenceFile(job), kind, job)) throw new Error('参考素材数量已达到当前模型限制');
        job.selected=true; job.label='已加入，创作时同步'; projectPendingReferenceToCreation(job); selected+=1;
        continue;
      }
      updateUploadJob(job, 8, '正在同步到云端');
      const result = await bridge.media.syncLocal({ assetId: item.id });
      const cloudAsset = result.cloudAsset || result.asset;
      if (!cloudAsset?.id) throw new Error('云端素材记录创建失败');
      const file = { ...cloudAsset, url: result.url, remoteUrl: cloudAsset.url, localStatus: 'saved', localPath: result.relativePath, sha256: item.sha256 || cloudAsset.sha256 };
      finishUploadJob(job, file, true);
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
}
function openUploadPicker(context) {
  if (window.guguDesktop) { state.uploadContext = context; void desktopImportToContext(context); return; }
  state.uploadContext = context; $('#fileInput').accept = context === 'reference' ? (state.referenceTarget === 'video-frame' ? imageAccept : referenceAccept()) : libraryAccept; $('#fileInput').click();
}
async function readImageSize(file) { if (!file.type.startsWith('image/')) return {}; try { const bitmap = await createImageBitmap(file); const result = { width:bitmap.width, height:bitmap.height }; bitmap.close(); return result; } catch { return new Promise(resolve => { const image = new Image(); const url = URL.createObjectURL(file); image.onload = () => { URL.revokeObjectURL(url); resolve({ width:image.naturalWidth, height:image.naturalHeight }); }; image.onerror = () => { URL.revokeObjectURL(url); resolve({}); }; image.src = url; }); } }
function uploadFileLegacy(file, dimensions, onProgress, mimeType=normalizedUploadMime(file), sha256='') { return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/files/upload'); xhr.responseType = 'json'; xhr.setRequestHeader('Content-Type', mimeType); xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); if (sha256) xhr.setRequestHeader('X-File-SHA256', sha256); if (dimensions.width && dimensions.height) { xhr.setRequestHeader('X-Image-Width', dimensions.width); xhr.setRequestHeader('X-Image-Height', dimensions.height); } xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(92, event.loaded / event.total * 92), '正在上传到文件库'); }; xhr.upload.onload = () => onProgress(94, '正在保存文件'); xhr.onload = () => { const data = xhr.response || {}; if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `上传失败（${xhr.status}）`)); }; xhr.onerror = () => reject(new Error('上传网络连接失败')); xhr.send(file); }); }
function uploadFileToStorage(intent, file, onProgress) { return new Promise((resolve, reject) => { const method = String(intent.method || 'POST').toUpperCase(); const xhr = new XMLHttpRequest(); xhr.open(method, intent.uploadUrl); xhr.responseType = 'text'; xhr.withCredentials = false; let body = file; if (method === 'POST') { const form = new FormData(); Object.entries(intent.fields || {}).forEach(([name, value]) => form.append(name, value)); form.append('file', file); body = form; } else { Object.entries(intent.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value)); } xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(5 + event.loaded / event.total * 87, '正在上传到云端'); }; xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') || ''); else reject(Object.assign(new Error(`云端上传失败（${xhr.status}）`), { status: xhr.status })); }; xhr.onerror = () => reject(Object.assign(new Error('云端上传网络连接失败'), { status: 0 })); xhr.onabort = () => reject(Object.assign(new Error('云端上传已取消'), { status: 0 })); xhr.send(body); }); }
async function completeDirectUpload(uploadId, onProgress) { let result = await api(`/api/files/uploads/${encodeURIComponent(uploadId)}/complete`, { method:'POST', body:'{}' }); if (result.status === 'verifying') { for (let attempt = 0; attempt < 6; attempt += 1) { await new Promise(resolve => setTimeout(resolve, Math.min(1500, 300 * (attempt + 1)))); result = await api(`/api/files/uploads/${encodeURIComponent(uploadId)}`); if (result.status === 'completed' && result.asset) return result.asset; if (result.status === 'failed') throw new Error('文件验证失败，请重新选择文件'); if (result.status === 'expired') throw new Error('上传凭证已过期，请重新选择文件'); } throw new Error('文件仍在验证中，请稍后刷新文件库'); } onProgress(99, '正在保存文件'); return result; }
async function sha256Blob(file) { if (!window.crypto?.subtle) return ''; const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''); }
async function uploadFile(file, dimensions, onProgress, mimeType=normalizedUploadMime(file)) { const normalizedFile = file.type === mimeType ? file : new File([file], file.name, { type:mimeType, lastModified:file.lastModified }); let sha256 = ''; try { onProgress(1, '正在计算素材指纹'); sha256 = await sha256Blob(normalizedFile); } catch {} if (!state.config.directOssUpload) return uploadFileLegacy(normalizedFile, dimensions, onProgress, mimeType, sha256); onProgress(2, '正在准备上传'); const intent = await api('/api/files/uploads/init', { method:'POST', body:JSON.stringify({ name:normalizedFile.name, mimeType, size:normalizedFile.size, sha256, width:dimensions.width || 0, height:dimensions.height || 0 }) }); if (intent.mode === 'reuse' && intent.asset) { onProgress(100, '已命中云端素材'); return intent.asset; } await uploadFileToStorage(intent, normalizedFile, onProgress); onProgress(94, '正在验证文件'); const asset = await completeDirectUpload(intent.uploadId, onProgress); onProgress(100, '文件已保存'); return asset; }
function validateBrowserUpload(file, job, context, { checkSelection=true } = {}) {
  const mimeType=normalizedUploadMime(file); const kind=uploadJobKind(mimeType); job.mimeType=mimeType; job.kind=kind;
  const sizeLimit=kind==='image' ? 20*1024*1024 : 25*1024*1024;
  if (!kind || file.size > sizeLimit) throw new Error(`${file.name} 超过 ${kind === 'image' ? '20' : '25'} MB 或格式不支持`);
  const inDialog=context==='reference'; const referenceTarget=job.referenceTarget || state.referenceTarget; const isFrame=inDialog && referenceTarget==='video-frame'; const isVideoReference=inDialog && referenceTarget==='video';
  const allowedKinds=inDialog ? (isFrame ? new Set(['image']) : referenceFileKinds()) : new Set(['image','video','audio']);
  if (inDialog && !allowedKinds.has(kind)) throw new Error(`当前模型不支持${kind==='image'?'图片':kind==='video'?'视频':'音频'}参考`);
  const limits=isVideoReference ? referenceLimits() : { image:7, video:0, audio:0, total:isFrame ? 1 : 7 };
  if (inDialog && checkSelection && state.dialogSelection.length >= limits.total) throw new Error(`参考素材最多选择 ${limits.total} 个`);
  const selectedCounts = inDialog ? videoReferenceCounts() : null;
  if (inDialog && checkSelection && selectedCounts[kind] >= Number(limits[kind] || 0)) throw new Error(`当前模型最多选择 ${limits[kind]} 个${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}`);
  return { mimeType, kind };
}
async function processBrowserUpload(file, job, context, { selectReference=true } = {}) {
  try {
    job.status='queued'; job.error='';
    const { mimeType, kind } = validateBrowserUpload(file, job, context, { checkSelection:selectReference });
    updateUploadJob(job, 0, '正在检查文件');
    const dimensions=await readImageSize(file);
    const asset=await uploadFile(file, dimensions, (progress,label)=>updateUploadJob(job,progress,label), mimeType);
    if (context==='reference') finishUploadJob(job, asset, false, selectReference ? () => autoSelectUploadedReference(asset, kind, job) : null);
    else finishUploadJob(job, asset, true);
    return asset;
  } catch (error) { failUploadJob(job,error); toast(error.message); return null; }
}
async function processBrowserUploads(files, context) {
  const jobs=files.map(file=>createUploadJob(file,context,{ deferUpload:context==='reference' })); let completed=0; let selected=0;
  if (context === 'reference') {
    for (let index=0; index<files.length; index+=1) {
      const job=jobs[index];
      try {
        const { kind } = validateBrowserUpload(files[index], job, context);
        const added=autoSelectUploadedReference(pendingReferenceFile(job), kind, job);
        if (!added) throw new Error('参考素材数量已达到当前模型限制');
        job.selected=true; job.label='已加入，创作时上传'; projectPendingReferenceToCreation(job); completed+=1; selected+=1;
      } catch (error) { failUploadJob(job,error); toast(error.message); }
    }
    renderReferenceDialog(); resetReferenceDialogScroll(); renderReferences();
    if (completed) toast(`${completed} 个参考素材已加入，发起创作时上传`);
  } else {
    for (let index=0; index<files.length; index+=1) { const asset=await processBrowserUpload(files[index],jobs[index],context); if (!asset) continue; completed+=1; }
    await loadFiles();
    if (completed) toast(`${completed} 个文件上传完成`);
  }
  return jobs.map((job,index)=>({ job, asset:job.assetId ? state.files.find(file=>file.id===job.assetId) : null, file:files[index] }));
}
function pickAndUploadDramaImage({ context='professional' } = {}) { return new Promise((resolve,reject) => { const input=document.createElement('input'); input.type='file'; input.accept=imageAccept; input.onchange=async()=>{ const file=input.files?.[0]; if(!file)return resolve(null); const job=createUploadJob(file,context); const asset=await processBrowserUpload(file,job,context); if (!asset) return reject(new Error(job.error || '上传失败')); resolve(asset); }; input.click(); }); }
function pickAndUploadDramaAsset({ context='professional-project' } = {}) { return new Promise((resolve,reject) => { const input=document.createElement('input'); input.type='file'; input.accept=libraryAccept; input.onchange=async()=>{ const file=input.files?.[0]; if(!file)return resolve(null); const job=createUploadJob(file,context); const asset=await processBrowserUpload(file,job,context); if (!asset) return reject(new Error(job.error || '上传失败')); resolve(asset); }; input.click(); }); }
$('#uploadButton').onclick = () => openUploadPicker('library');
$('#fileInput').onchange = async event => { const files=[...event.target.files]; const context=state.uploadContext; event.target.value=''; if (!files.length) return; await processBrowserUploads(files,context); };
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
  state.refs.image = state.refs.image.filter(id => referenceFileById(id)?.kind === 'image');
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
  videoPromptMentionRequest = target === 'video' ? mentionRequest : null;
  state.referenceTarget = target; state.videoFrameTarget = ''; state.dialogSelection = [...state.refs[target]]; renderReferenceDialog(); $('#referenceDialog').showModal();
}
function openVideoFrameDialog(frame) {
  if (!supportsVideoFirstLast()) return;
  referenceDialogCommitted=false;
  referenceDialogOriginal={ target:'video-frame', frame, value:state.videoFrames[frame] || '' };
  videoPromptMentionRequest = null;
  state.referenceTarget = 'video-frame'; state.videoFrameTarget = frame; state.dialogSelection = state.videoFrames[frame] ? [state.videoFrames[frame]] : []; renderReferenceDialog(); $('#referenceDialog').showModal();
}
function closeReferenceDialog() { videoPromptMentionRequest = null; $('#referenceDialog').close(); }
$('#closeReference').onclick = $('#cancelReference').onclick = closeReferenceDialog;
$('#referenceDialog').addEventListener('close', () => { if (!referenceDialogCommitted) { restoreReferenceDialogOriginal(); cleanupUncommittedReferenceJobs(); renderReferences(); } referenceDialogCommitted=false; referenceDialogOriginal=null; videoPromptMentionRequest = null; });
$('#confirmReference').onclick = () => {
  const pendingCount = state.dialogSelection.filter(id => pendingReferenceJob(id)?.deferUpload).length;
  const mentionRequest = state.referenceTarget === 'video' ? videoPromptMentionRequest : null;
  if (state.referenceTarget === 'video-frame') state.videoFrames[state.videoFrameTarget] = state.dialogSelection[0] || '';
  else state.refs[state.referenceTarget] = [...state.dialogSelection];
  let insertion = null;
  if (mentionRequest) insertion = insertVideoPromptMentions(state.dialogSelection, mentionRequest);
  else videoPromptMentionRequest = null;
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
  const promptMentionMode = isVideo && Boolean(videoPromptMentionRequest);
  const limits = isFrame ? { image: 1, video: 0, audio: 0, total: 1 } : isVideo ? referenceLimits() : { image: 7, video: 0, audio: 0, total: 7 };
  const allowedKinds = isFrame ? new Set(['image']) : isVideo ? referenceFileKinds() : new Set(['image']);
  state.dialogSelection = state.dialogSelection.filter(id => { const file=referenceFileById(id); return file && allowedKinds.has(file.kind); });
  const selectedFiles = state.dialogSelection.map(id => referenceFileById(id)).filter(Boolean);
  const counts = Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, selectedFiles.filter(file => file.kind === kind).length]));
  const totalSelected = state.dialogSelection.length;
  $('#referenceDialog h2').textContent = isFrame ? `选择${state.videoFrameTarget === 'first' ? '首帧' : '尾帧'}图片` : promptMentionMode ? '选择要引用的素材' : '选择参考素材';
  $('#referenceDialog .dialog-help').textContent = isFrame ? '选择一张图片作为视频的当前帧，单张不超过 20 MB。' : `${promptMentionMode ? '所选素材会插入创作描述，并同步添加到下方参考素材区。' : ''}当前模型支持：${referenceCapabilityText(limits)}；单个图片不超过 20 MB，视频或音频不超过 25 MB。选择本地文件后会立即显示。`;
  $('#dialogUpload').innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg><span>${isFrame ? '上传首尾帧图片' : '上传素材'}</span>`;
  $('#selectionCount').textContent = isFrame ? `已选择 ${totalSelected} / 1` : `已选择 ${totalSelected} / ${limits.total}（图${counts.image} / 视${counts.video} / 音${counts.audio}）`;
  const confirmLabel = isFrame ? '使用此图片' : promptMentionMode ? '插入并使用所选素材' : '使用所选素材';
  $('#confirmReference').textContent = confirmLabel;
  const uploadJobs = state.uploadJobs.filter(job => job.context === 'reference');
  const pendingJobs = uploadJobs.filter(job => job.deferUpload && allowedKinds.has(job.kind));
  const uploadingAssetIds = new Set(uploadJobs.map(job => job.assetId).filter(Boolean));
  const pendingMarkup = pendingJobs.map(job => {
    const file=pendingReferenceFile(job); const selected=state.dialogSelection.includes(job.id); const status=job.status === 'failed' ? '素材不可用，请重新选择' : '已选择';
    return `<button class="reference-option pending-reference-option ${selected ? 'selected' : ''} ${job.status === 'failed' ? 'failed' : ''}" data-id="${esc(job.id)}" type="button">${referenceMediaMarkup(file, file.name)}<span>${esc(file.name)}<small>${esc(status)}</small></span><i>✓</i></button>`;
  }).join('');
  const uploadMarkup = uploadJobs.filter(job => !job.deferUpload).map(job => uploadJobCard(job, 'reference')).join('');
  const pendingLocalAssetIds = new Set(pendingJobs.map(job => job.localAssetId).filter(Boolean));
  const files = state.files.filter(file => allowedKinds.has(file.kind) && (file.localOnly ? Boolean(window.guguDesktop) && !pendingLocalAssetIds.has(file.localId || file.id) : !uploadingAssetIds.has(file.id)));
  const fileMarkup = files.map(file => `<button class="reference-option ${state.dialogSelection.includes(file.id) ? 'selected' : ''}" data-id="${file.id}" type="button">${referenceMediaMarkup(file, file.name)}<span>${esc(file.name)}</span><i>✓</i></button>`).join('');
  $('#referenceGrid').innerHTML = pendingMarkup + uploadMarkup + (fileMarkup || pendingMarkup || uploadMarkup ? fileMarkup : emptyState('没有可用参考素材', '先上传当前模型支持的素材类型。'));
  requestAnimationFrame(resetReferenceDialogScroll);
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
$$('.prompt-presets button').forEach(button => button.onclick = () => {
  const form = button.closest('form');
  const prompt = form.querySelector('[contenteditable="true"], textarea');
  if (form.dataset.panel === 'video') setVideoPromptText(button.dataset.preset);
  else prompt.value = button.dataset.preset;
  prompt.dispatchEvent(new Event('input', { bubbles:true }));
  prompt.focus();
});
const imagePromptMaxLength = 5000;
const videoPromptMaxLength = 4096;
function videoPromptLimit(modelId=$('#videoModel')?.value) { return modelId === 'minimax-h3-15s' ? 10000 : videoPromptMaxLength; }
const promptMaxHeight = 200;
function autoResizePrompt(prompt) { if (!prompt) return; prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, promptMaxHeight)}px`; }
function syncImagePromptState() { const prompt = $('#imagePrompt'); autoResizePrompt(prompt); const count = Array.from(prompt.value).length; const countElement = $('#imagePromptCount'); const overLimit = count > imagePromptMaxLength; countElement.textContent = count; countElement.classList.toggle('over-limit', overLimit); prompt.setCustomValidity(overLimit ? `图片提示词不能超过 ${imagePromptMaxLength} 个字符` : ''); $('#imageForm .generate').disabled = overLimit; }
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
$('#imagePrompt').oninput = syncImagePromptState;
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
  state.videoPromptMentions=state.videoPromptMentions.map(item => item.id === oldId ? { ...item, id:newId } : item);
  $('#videoPrompt')?.querySelectorAll(`[data-video-prompt-mention-id="${CSS.escape(oldId)}"]`).forEach(node => { node.dataset.videoPromptMentionId=newId; });
}
async function uploadPendingReferenceJob(job) {
  if (!job) throw new Error('参考素材不存在，请重新选择');
  const existing=job.assetId ? state.files.find(file => file.id === job.assetId) : null;
  if (existing && !existing.localOnly) return existing;
  if (job.localAssetId && window.guguDesktop?.media?.syncLocal) {
    updateUploadJob(job, 8, '正在同步到云端');
    const result=await window.guguDesktop.media.syncLocal({ assetId:job.localAssetId });
    const cloudAsset=result.cloudAsset || result.asset;
    if (!cloudAsset?.id) throw new Error('云端素材记录创建失败');
    const file={ ...cloudAsset, url:result.url, remoteUrl:cloudAsset.url, localStatus:'saved', localPath:result.relativePath, sha256:cloudAsset.sha256 };
    finishUploadJob(job, file, false);
    return file;
  }
  if (!job.file) throw new Error(`${job.name} 无法读取，请重新选择`);
  const asset=await processBrowserUpload(job.file, job, 'reference', { selectReference:false });
  if (!asset) throw new Error(job.error || `${job.name} 上传失败`);
  return asset;
}
async function resolveReferenceAssetIds(ids) {
  const resolved=[];
  for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
    const file=state.files.find(item => item.id === id && !item.localOnly);
    if (file) { resolved.push(file.id); continue; }
    const job=pendingReferenceJob(id);
    if (!job) throw new Error('参考素材不存在，请重新选择');
    const asset=await uploadPendingReferenceJob(job);
    replacePendingReferenceId(id, asset.id);
    resolved.push(asset.id);
  }
  renderReferences();
  return [...new Set(resolved)];
}
function cloudReferenceIds(ids) { return [...new Set((Array.isArray(ids) ? ids : []).filter(id => { const file = state.files.find(item => item.id === id); return file && !file.localOnly; }))]; }
async function submitGeneration(type, form, payload) {
  const button = form.querySelector('.generate');
  const original = button.innerHTML;
  const requestedReferenceIds = type === 'video' ? (payload.referenceAssetIds || []) : state.refs[type];
  const videoParameterControls = type === 'video' ? ['videoModel', 'videoAspect', 'videoDuration', 'videoResolution'] : [];
  button.disabled = true;
  videoParameterControls.forEach(id => setProductSelectEnabled(id, false));
  button.innerHTML = '<span class="button-spinner"></span><span>准备参考素材</span>';
  try {
    const referenceAssetIds = await resolveReferenceAssetIds(requestedReferenceIds);
    let expectedPriceVersion = '';
    if (type === 'video' && ['seedance-2.0','seedance-2.0-fast','seedance-2.5'].includes($('#videoModel').value)) {
      const quoteInput=currentVideoQuoteInput();
      if (!quoteInput) throw new Error('当前视频参数无效，请重新选择后重试');
      const quoteSignature=JSON.stringify(quoteInput);
      if (state.modelQuote?.signature !== quoteSignature) {
        button.innerHTML = '<span class="button-spinner"></span><span>正在确认价格</span>';
        const quote=await api('/api/model-quote', { method:'POST', body:JSON.stringify(quoteInput) });
        state.modelQuote={ ...quote, signature:quoteSignature };
      }
      expectedPriceVersion=state.modelQuote.priceVersion || '';
    }
    button.innerHTML = '<span class="button-spinner"></span><span>正在提交</span>';
    const result = await api('/api/generations', { method:'POST', body:JSON.stringify({ type, ...payload, referenceAssetIds, ...(expectedPriceVersion ? { expectedPriceVersion } : {}) }) });
    const tasks = Array.isArray(result.tasks) ? result.tasks : [result];
    setCreditBalance(result.balance);
    if (type === 'video') setVideoPromptText(''); else form.querySelector('textarea').value = '';
    (type === 'video' ? videoPromptEditor() : form.querySelector('textarea')).dispatchEvent(new Event('input', { bubbles:true }));
    state.refs[type] = [];
    if (type === 'video') { state.videoFrames = { first:'', last:'' }; state.modelQuote = null; }
    renderReferences();
    const totalCost = tasks.reduce((sum, task) => sum + (Number(task.creditCost) || 0), 0);
    toast(tasks.length > 1 ? `已提交 ${tasks.length} 个图像任务，预扣 ${creditText(totalCost)} 积分` : `已提交，扣除 ${tasks[0].creditCost} 积分`);
    await loadTasks();
  } catch (error) { renderReferences(); toast(error.message); await loadCredits(); }
  finally { button.innerHTML = original; videoParameterControls.forEach(id => setProductSelectEnabled(id, true)); if (type === 'image') { syncImagePromptState(); updateImageCost(); } else { syncVideoPromptState(); updateVideoCost(); } button.disabled = false; }
}
$('#imageForm').onsubmit = event => { event.preventDefault(); syncImagePromptState(); if (Array.from($('#imagePrompt').value).length > imagePromptMaxLength) return; const quantity = commitImageQuantity($('#imageQuantity').value); submitGeneration('image', event.currentTarget, { prompt:$('#imagePrompt').value, size:$('#imageSize').value, quality:$('#imageQuality').value, quantity }); };
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
  return input ? { ...input, referenceAssetIds:cloudReferenceIds(currentVideoReferenceIds()) } : null;
}
function updateVideoCost() {
  const cost = $('#videoCost'); const duration = $('#videoDuration'); if (!cost || !duration) return;
  clearTimeout(videoQuoteTimer);
  const sequence = ++videoQuoteSequence;
  const input = currentVideoQuoteInput();
  if (!input) { state.modelQuote = null; cost.textContent = '—'; return; }
  const routed = ['seedance-2.0','seedance-2.0-fast','seedance-2.5'].includes(input.modelId);
  if (routed) {
    const hasPendingReference = currentVideoReferenceIds().some(id => Boolean(pendingReferenceJob(id)));
    if (hasPendingReference) { state.modelQuote=null; cost.textContent='提交时计算'; return; }
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

function renderModelPrices(items = state.config?.modelPrices || []) {
  const body = $('#modelPriceBody');
  if (!body) return;
  const visibleItems = items.filter(item => item.available === true && item.enabled !== false && item.availability !== 'coming-soon' && Number.isFinite(Number(item.credits)) && Number.isFinite(Number(item.yuan)));
  const groups = [...new Set(visibleItems.map(item => item.modelId))];
  body.innerHTML = groups.length ? groups.map(modelId => {
    const rows = visibleItems.filter(item => item.modelId === modelId);
    const label = rows[0]?.label || modelId;
    return `<section class="price-model-group"><header><div class="price-model-heading">${modelIcon(modelId)}<h3>${esc(label)}</h3></div></header><div class="price-model-rows">${rows.map(item => { const unit = item.unit === 'request' ? '次' : '秒'; return `<div class="price-model-row"><b>${esc(item.quality)}</b><strong>¥${Number(item.yuan).toFixed(2)} / ${unit}<small>${creditText(item.credits)} 积分 / ${unit}</small></strong></div>`; }).join('')}</div></section>`;
  }).join('') : '<div class="price-catalog-empty">暂时没有可用的模型价格。</div>';
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
  try { const config = await api('/api/config'); state.config = { ...state.config, ...config }; renderModelPrices(config.modelPrices || []); }
  catch { if (!(state.config?.modelPrices || []).length) $('#modelPriceBody').innerHTML = '<div class="price-catalog-empty">价格获取失败，请稍后重试。</div>'; }
}
$('#modelPriceButton').onclick = () => { void openModelPriceDialog(); };
$('#closeModelPrice').onclick = () => $('#modelPriceDialog').close();
$('#modelPriceDialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

function renderPreviewMetaLegacy(file, width=file.width, height=file.height) { $('#previewDetailMeta').innerHTML = detailRow('素材类型', file.kind === 'image' ? '图片' : '视频') + detailRow('画面尺寸', width && height ? `${width} × ${height} px` : '读取中', 'previewDimensions') + detailRow('文件大小', formatBytes(file.size)) + detailRow('添加时间', fullDateText(file.createdAt)) + detailRow('原始文件名', file.name); }
function openPreviewLegacy(id) { const file = state.files.find(item => item.id === id); if (!file || !requireDesktopLocalAsset(file)) return; const displayName = assetDisplayName(file); state.previewFileId = id; $('#deletePreview').disabled = false; $('#deletePreview').textContent = '删除素材'; $('#previewMedia').innerHTML = file.kind === 'image' ? `<img src="${file.url}" alt="${esc(displayName)}">` : `<video src="${file.url}" controls autoplay></video>`; $('#previewName').textContent = displayName; $('#previewUseActions').classList.toggle('hidden', file.kind !== 'image'); renderPreviewMetaLegacy(file); if (file.kind === 'image') { const image = $('#previewMedia img'); const syncImage = () => { file.width = image.naturalWidth; file.height = image.naturalHeight; fitDetailMedia(image, file.width, file.height); renderPreviewMetaLegacy(file, file.width, file.height); }; if (image.complete) syncImage(); else image.onload = syncImage; } else { const video = $('#previewMedia video'); video.onloadedmetadata = () => { file.width = video.videoWidth; file.height = video.videoHeight; fitDetailMedia(video, file.width, file.height); renderPreviewMetaLegacy(file, file.width, file.height); }; } configureDownloadLink($('#previewDownload'), file); $('#previewDialog').showModal(); }
function usePreviewAsset(target) { const file = state.files.find(item => item.id === state.previewFileId); if (!file || file.kind !== 'image') return; if (target === 'video' && !$('#videoModel').value) return toast('请先选择视频模型'); if (target === 'video' && supportsVideoFirstLast() && state.videoGenerationType === 'FIRST&LAST') { const frame = state.videoFrames.first ? 'last' : 'first'; state.videoFrames[frame] = file.id; } else { const limit = target === 'video' ? videoReferenceLimit() : 7; if (!state.refs[target].includes(file.id)) state.refs[target] = [file.id, ...state.refs[target]].slice(0, limit); } $('#previewDialog').close(); navigate(target); renderReferences(); toast(`已将“${assetDisplayName(file)}”设为${target === 'video' && supportsVideoFirstLast() && state.videoGenerationType === 'FIRST&LAST' ? '视频帧图片' : '参考图'}`); }
function renderPreviewMeta(file, width=file.width, height=file.height) { $('#previewDetailMeta').innerHTML = detailRow('素材类型', file.kind === 'image' ? '图片' : file.kind === 'audio' ? '音频' : '视频') + detailRow('画面尺寸', file.kind === 'audio' ? '—' : width && height ? `${width} × ${height} px` : '读取中', 'previewDimensions') + detailRow('文件大小', formatBytes(file.size)) + detailRow('添加时间', fullDateText(file.createdAt)) + detailRow('原始文件名', file.name); }
function openPreview(id) { const file = state.files.find(item => item.id === id); if (!file || !requireDesktopLocalAsset(file)) return; const displayName = assetDisplayName(file); state.previewFileId = id; $('#deletePreview').disabled = false; $('#deletePreview').textContent = '删除素材'; $('#previewMedia').innerHTML = file.kind === 'image' ? `<img src="${file.url}" alt="${esc(displayName)}">` : file.kind === 'audio' ? `<audio src="${file.url}" controls autoplay></audio>` : `<video src="${file.url}" controls autoplay></video>`; $('#previewName').textContent = displayName; $('#previewUseActions').classList.toggle('hidden', file.kind !== 'image'); renderPreviewMeta(file); if (file.kind === 'image') { const image = $('#previewMedia img'); const syncImage = () => { file.width = image.naturalWidth; file.height = image.naturalHeight; fitDetailMedia(image, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; if (image.complete) syncImage(); else image.onload = syncImage; } else if (file.kind === 'video') { const video = $('#previewMedia video'); video.onloadedmetadata = () => { file.width = video.videoWidth; file.height = video.videoHeight; fitDetailMedia(video, file.width, file.height); renderPreviewMeta(file, file.width, file.height); }; } configureDownloadLink($('#previewDownload'), file); $('#previewDialog').showModal(); }
$('#usePreviewForImage').onclick = () => usePreviewAsset('image');
$('#usePreviewForVideo').onclick = () => usePreviewAsset('video');
$('#closePreview').onclick = () => $('#previewDialog').close();
$('#deletePreview').onclick = async () => { if ($('#deletePreview').disabled) return; const file = state.files.find(item => item.id === state.previewFileId); if (!file || !await confirmDelete({ title:'确认删除素材', message:'素材一旦删除，无法恢复。' })) return; const button = $('#deletePreview'); button.disabled = true; try { await removeFile(file); $('#previewDialog').close(); toast('文件已删除'); } catch (error) { toast(error.message); } finally { button.disabled = false; } };


$('#previewDialog').addEventListener('click', event => { if (event.target === event.currentTarget) $('#previewDialog').close(); });
$('#previewDialog').addEventListener('close', () => { resetDetailFit($('#previewDialog')); $('#previewMedia').innerHTML = ''; $('#deletePreview').disabled = false; state.previewFileId = null; });

async function bootstrap() {
  void initDesktopBridge().catch(error => console.warn('[desktop] 初始化工作区桥接失败', error));
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
  pollTimer = setTimeout(async () => { await Promise.all([loadTasks({ background:true }), loadNotifications()]); scheduleTaskPoll(); }, delay);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else if (state.user) { Promise.all([loadTasks({ background:true }), loadNotifications()]).finally(() => scheduleTaskPoll()); }
});
await bootstrap();
scheduleTaskPoll();
