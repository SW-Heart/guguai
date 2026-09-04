import { buildResourceImagePrompt } from './resource-prompt.js?v=1';
import { buildShotVideoPrompt } from './video-prompt.js?v=3';

const durations = [8,10,15,20];
const ratios = ['9:16','16:9','1:1','2:3','3:2'];
const imageRatios = ['1:1','3:4','4:3','9:16','16:9','3:2','2:3','1:2','2:1','5:4','4:5'];
const imageQualities = [['low','低'],['medium','中'],['high','高']];
const DEFAULT_SHOT_TITLE = '未命名分镜';
const LEGACY_GUGU_2_MODEL_ID = 'grok-15';
const MINIMAX_H3_15S_MODEL_ID = 'minimax-h3-15s';
const ROUTED_VIDEO_MODEL_IDS = new Set(['seedance-2.0','seedance-2.0-fast','seedance-2.5']);
const canonicalVideoModelId = value => String(value || '').trim().toLowerCase() === LEGACY_GUGU_2_MODEL_ID ? MINIMAX_H3_15S_MODEL_ID : String(value || '').trim();
const PREVIEW_PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5z"/></svg>';
const stepOrder = ['script','resources','storyboard','video'];
const stepNames = { script:'剧本设计', resources:'资源生成', storyboard:'分镜设计', video:'视频生成' };
const typeNames = { character:'角色', location:'场景', prop:'物品' };
const richEditorEmptyChar = '\u200B';

export function normalizeShotVideoParameters(shot, parameters) {
  if (!shot?.generation || !parameters) return false;
  let changed = false;
  const selectSupported = (current, supported, apply) => {
    if (!Array.isArray(supported) || !supported.length || supported.some(value => String(value) === String(current))) return;
    apply(supported[0]);
    changed = true;
  };
  selectSupported(shot.aspectRatio, parameters.aspectRatios, value => { shot.aspectRatio = String(value); });
  selectSupported(shot.generation.quality, parameters.qualityOptions, value => { shot.generation.quality = String(value); });
  selectSupported(shot.duration, parameters.durations, value => { shot.duration = Number(value); });
  return changed;
}

export function buildDramaVideoQuoteInput(shot, referenceKinds = []) {
  const referenceCounts = { image:0, video:0, audio:0 };
  for (const value of referenceKinds) {
    const kind = String(value || '');
    if (Object.hasOwn(referenceCounts, kind)) referenceCounts[kind] += 1;
  }
  return {
    modelId: canonicalVideoModelId(shot?.generation?.modelId),
    generationType: String(shot?.generation?.type || 'TEXT'),
    aspectRatio: String(shot?.aspectRatio || ''),
    duration: Number(shot?.duration),
    quality: String(shot?.generation?.quality || ''),
    referenceAssetIds: [],
    referenceCounts,
  };
}

export function dramaVideoQuoteSignature(input) {
  const counts = input?.referenceCounts || {};
  return JSON.stringify([
    canonicalVideoModelId(input?.modelId),
    String(input?.generationType || ''),
    String(input?.aspectRatio || ''),
    Number(input?.duration),
    String(input?.quality || ''),
    Number(counts.image || 0),
    Number(counts.video || 0),
    Number(counts.audio || 0),
  ]);
}

export function videoPreviewVersionState(task, { ready = false, syncing = false } = {}) {
  if (task?.status === 'failed') return 'failed';
  if (ready) return 'ready';
  if (syncing) return 'syncing';
  if (['queued', 'running'].includes(task?.status)) return 'pending';
  // Desktop startup can observe the completed task before its local library
  // recovery has materialized the asset. Keep that interval non-terminal.
  if (task?.status === 'completed' && task.assetId) return 'syncing';
  return 'missing';
}

export function generationNeedsLocalAssetSync(task, file, isAssetSyncing = () => false) {
  return task?.status === 'completed'
    && Boolean(task.assetId)
    // The cloud task may arrive before its local file metadata during startup.
    // Treat both that gap and an active transfer as recovery in progress.
    && (!file || isAssetSyncing(file));
}

function shotPreviewRenderSignatureFromMaps(shot, taskById, fileById, isAssetSyncing = () => false) {
  const ids = [...new Set([shot?.selectedVideoTaskId, ...(shot?.videoVersions || [])].filter(Boolean))];
  return [shot?.selectedVideoTaskId || '', ...ids.map(id => {
    const generation = taskById.get(id);
    const file = fileById.get(generation?.assetId);
    return `${id}:${generation?.status || ''}:${generation?.progress ?? ''}:${generation?.progressStage || ''}:${generation?.failure?.code || ''}:${generation?.error || ''}:${generation?.assetId || ''}:${file?.url || ''}:${file?.localStatus || ''}:${isAssetSyncing(file) ? 'syncing' : ''}`;
  })].join('|');
}

function shotPreviewContentSignatureFromMaps(shot, taskById, fileById, isAssetSyncing = () => false, previewTaskId = shot?.selectedVideoTaskId) {
  const ids = [...new Set([previewTaskId, shot?.selectedVideoTaskId, ...(shot?.videoVersions || [])].filter(Boolean))];
  const previewTask = taskById.get(previewTaskId);
  const progressMode = previewTask?.type === 'video'
    && ['queued', 'running'].includes(previewTask.status)
    && videoTaskProgress(previewTask) !== null
    ? 'progress'
    : 'empty';
  return [shot?.selectedVideoTaskId || '', previewTaskId || '', `progress:${progressMode}`, ...ids.map(id => {
    const generation = taskById.get(id);
    const file = fileById.get(generation?.assetId);
    return `${id}:${generation?.status || ''}:${generation?.failure?.code || ''}:${generation?.error || ''}:${generation?.assetId || ''}:${file?.url || ''}:${file?.localStatus || ''}:${isAssetSyncing(file) ? 'syncing' : ''}`;
  })].join('|');
}

export function shotPreviewRenderSignature(shot, tasks = [], files = [], isAssetSyncing = () => false) {
  return shotPreviewRenderSignatureFromMaps(shot, new Map(tasks.map(item => [item.id, item])), new Map(files.map(item => [item.id, item])), isAssetSyncing);
}

export function shotPreviewContentSignature(shot, tasks = [], files = [], isAssetSyncing = () => false, previewTaskId = shot?.selectedVideoTaskId) {
  return shotPreviewContentSignatureFromMaps(shot, new Map(tasks.map(item => [item.id, item])), new Map(files.map(item => [item.id, item])), isAssetSyncing, previewTaskId);
}

export function mergeDramaProjectList(projects, updatedProject) {
  if (!updatedProject?.id) return projects;
  const current = projects.find(item => item.id === updatedProject.id);
  if (!current) return [updatedProject, ...projects];
  const merged = { ...current, ...updatedProject };
  const changed = current.title !== merged.title || current.updatedAt !== merged.updatedAt;
  if (!changed) return projects;
  return [merged, ...projects.filter(item => item.id !== updatedProject.id)];
}

export function videoTaskProgress(task) {
  if (!Object.prototype.hasOwnProperty.call(task || {}, 'progress') || task.progress === null || task.progress === '') return null;
  const progress = Number(task.progress);
  return Number.isFinite(progress) && progress >= 0 && progress <= 100 ? Math.round(progress) : null;
}

export function mergeProjectResponseWithNewerKeys(serverProject, localProject, requestVersions, currentVersions) {
  const merged = { ...(serverProject || {}) };
  if (!localProject) return merged;
  for (const [key, version] of currentVersions || []) {
    if (Number(version) > Number(requestVersions?.get?.(key) || 0)) merged[key] = localProject[key];
  }
  return merged;
}

export function calculateVirtualShotRange(heights, scrollTop, viewportHeight, { overscan = 4, estimatedHeight = 430 } = {}) {
  const values = Array.isArray(heights) ? heights : [];
  const heightAt = index => Math.max(1, Number(values[index]) || estimatedHeight);
  const top = Math.max(0, Number(scrollTop) || 0);
  const bottom = top + Math.max(1, Number(viewportHeight) || 1);
  let offset = 0;
  let first = 0;
  while (first < values.length && offset + heightAt(first) <= top) {
    offset += heightAt(first);
    first += 1;
  }
  let last = first;
  while (last < values.length && offset < bottom) {
    offset += heightAt(last);
    last += 1;
  }
  return { start:Math.max(0, first - Math.max(0, overscan)), end:Math.min(values.length, last + Math.max(0, overscan)) };
}

export function createDramaStudio({ api, state, esc, toast, setCreditBalance, creditText, loadTasks, loadCredits, loadFiles, uploadImage, uploadAsset, confirmDelete, taskFailure, isAssetSyncing = () => false, showAssetInFolder = null, removeCloudAssets = null }) {
  const root = document.querySelector('#dramaStage');
  let projects = [];
  let project = null;
  let viewStep = null;
  let busy = false;
  let assetPickerShotId = '';
  let videoAssetPickerShotId = '';
  let scriptDraft = null;
  let taskRenderSignature = '';
  let fileRenderSignature = '';
  let assetPickerQuery = '';
  let professionalShotId = '';
  let professionalAssetKind = '';
  let professionalFrameField = '';
  let professionalAssetSelection = [];
  let professionalAssetGeneration = null;
  let professionalPendingImageGenerations = [];
  let professionalMediaPicker = { tab:'library', kind:'characters', frameField:'', prompt:'', size:'1:1', quality:'medium', referenceAssetIds:[], query:'' };
  let professionalGenerationReferenceSelection = [];
  let professionalRecentAssetIds = [];
  let professionalMediaPreview = null;
  let projectAssetIds = [];
  let projectAssetCategory = 'other';
  let projectAssetCategories = new Map();
  let projectAssetSelection = [];
  let projectAssetQuery = '';
  let projectAssetKindFilter = 'all';
  let projectAssetTargetShotId = '';
  let projectAssetSearchTimer = 0;
  let projectAssetMediaObserver = null;
  let professionalPreviewShotId = '';
  const professionalVideoQuoteCache = new Map();
  let mentionPicker = { shotId:'', editor:null, range:null, query:'' };
  let mentionDismissBound = false;
  let workbenchDropdownDismissBound = false;
  let workbenchVideoObserver = null;
  const shotPreviewSignatures = new Map();
  const professionalPreviewTaskIds = new Map();
  let virtualShotResizeObserver = null;
  let virtualScrollFrame = 0;
  let virtualRangeKey = '';
  let virtualStart = 0;
  let virtualEnd = 0;
  let deferredProfessionalRender = false;
  const virtualShotHeights = new Map();
  let virtualShotProjectId = '';
  const virtualEstimatedShotHeight = 430;
  const virtualOverscan = 4;
  const refreshProfessionalUploadSurfaces = () => {
    const assetDialog = document.querySelector('#professionalAssetDialog');
    const referenceDialog = document.querySelector('#professionalGenerationReferenceDialog');
    if (assetDialog?.open) paintProfessionalAssetDialog();
    if (referenceDialog?.open) paintProfessionalGenerationReferenceDialog();
  };
  window.addEventListener('gugu-upload-state-change', refreshProfessionalUploadSurfaces);
  let pendingKeys = new Set();
  let saveTimer = 0;
  let projectEpoch = 0;
  let projectLoadToken = 0;
  let projectMutationChain = Promise.resolve();
  const projectKeyVersions = new Map();
  const task = id => state.tasks.find(item => item.id === id);
  const generationFailureMarkup = generation => {
    const failure = taskFailure(generation);
    return failure ? `<span class="generation-failure-reason"><b>${esc(failure.message)}</b><small>${esc(failure.suggestion)}</small></span>` : '<span>生成失败</span>';
  };
  const generationFailureIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
  const generationFailurePromptMarkup = () => `<div class="wb-preview-empty wb-preview-failure-prompt"><span class="wb-preview-failure-prompt-icon" aria-hidden="true">${generationFailureIcon}</span><b>视频生成失败</b><small>点击下方叉号查看失败原因</small></div>`;
  const generationFailurePreviewMarkup = generation => {
    const failure = taskFailure(generation) || { message:'生成失败，服务未返回具体原因', suggestion:'请调整提示词或参考图片后重试。' };
    return `<div class="wb-preview-failure" role="alert" aria-live="polite"><span class="wb-preview-failure-icon" aria-hidden="true">${generationFailureIcon}</span><div class="wb-preview-failure-copy"><b>生成失败</b><strong>${esc(failure.message)}</strong><p>${esc(failure.suggestion)}</p></div></div>`;
  };
  document.querySelector('#closeCreateDramaProject').onclick=()=>document.querySelector('#createDramaProjectDialog').close();
  document.querySelector('#createDramaProjectDialog').addEventListener('close',resetCreateProjectDialog);
  document.querySelectorAll('[data-create-drama-mode]').forEach(button=>button.onclick=()=>chooseProjectMode(button.dataset.createDramaMode));
  const asset = id => state.files.find(item => item.id === id);
  const assetPreviewUrl = file => file?.kind === 'image' ? (String(file.url || '').startsWith('gugu-media://') ? file.url : (file.previewUrl || file.url || '')) : (file?.url || '');
  const assetImageMarkup = (file, alt = '', attributes = ' loading="lazy" decoding="async"') => {
    const preview = assetPreviewUrl(file);
    const original = String(file?.remoteUrl || file?.url || '');
    const fallback = preview && original && preview !== original ? ` data-original-src="${esc(original)}"` : '';
    return `<img src="${esc(preview)}" alt="${esc(alt)}"${fallback}${attributes}>`;
  };
  const taskAsset = id => asset(task(id)?.assetId);
  const assetSyncing = file => Boolean(isAssetSyncing?.(file));
  const taskSyncing = id => generationNeedsLocalAssetSync(task(id), taskAsset(id), assetSyncing);
  const taskLocallyReady = id => {
    const generation = task(id);
    const file = taskAsset(id);
    return generation?.status === 'completed'
      && Boolean(file)
      && file.localStatus === 'saved'
      && !assetSyncing(file);
  };
  function workbenchPreviewThumbMarkup(item,{selected=false,shotId='',shotTitle=''}={}){
    const ready=taskLocallyReady(item.id);
    const syncing=taskSyncing(item.id);
    const versionState=videoPreviewVersionState(item.task,{ready,syncing});
    const failed=versionState==='failed';
    const missing=versionState==='missing';
    const pending=versionState==='pending'||versionState==='syncing';
    const pendingLabel=pending?'视频生成中':'视频文件未找到';
    const failureLabel=failed?taskFailure(item.task)?.message||'生成失败':'';
    const canDelete=!pending;
    const thumb=failed?`<span class="wb-preview-thumb-failed" aria-hidden="true">${generationFailureIcon}</span><span class="sr-only">生成失败：${esc(failureLabel)}，点击查看失败原因</span>`:ready?workbenchVideoMarkup(item.file):missing?`<span class="wb-preview-thumb-missing" aria-hidden="true">${generationFailureIcon}</span><span class="sr-only">${pendingLabel}</span>`:`<i class="wb-preview-thumb-loader" aria-hidden="true"></i><span class="sr-only">${pendingLabel}</span>`;
    const title=shotTitle||item.shot?.title||'分镜';
    const previewLabel=`点击查看${esc(title)}视频版本${failed?'，生成失败，查看失败原因':ready?'':missing?'，视频文件未找到':`，${pendingLabel}`}`;
    return `<div class="wb-preview-thumb ${selected?'selected':''} ${failed?'is-failed':''} ${missing?'is-missing':''} ${pending?'is-pending':''}"><button type="button" class="wb-preview-thumb-view" data-wb-preview-video="${esc(item.id)}" data-wb-preview-shot="${esc(shotId||item.shot?.id||'')}" aria-label="${previewLabel}" title="${failed?'查看生成失败原因':ready?'点击查看大视频':missing?'视频文件未找到':pendingLabel}" ${missing?'disabled':''}><span class="${failed||ready||missing?'':'wb-preview-thumb-pending'}">${thumb}</span></button>${canDelete?`<button type="button" class="wb-preview-thumb-delete" data-wb-delete-preview-video="${esc(item.id)}" data-wb-delete-preview-shot="${esc(shotId||item.shot?.id||'')}" aria-label="删除${esc(title)}视频版本" title="删除视频版本"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>`:''}</div>`;
  }
  const desktopMedia = () => window.guguDesktop?.media;
  const requireDesktopMedia = (...capabilities) => {
    const media = desktopMedia();
    if (!media || capabilities.some(capability => typeof media[capability] !== 'function')) throw new Error('桌面媒体能力未就绪，请重启客户端后再试');
    return media;
  };
  const localAssetId = file => String(file?.localId || (file?.localOnly ? file.id : '') || '');
  const taskLocalAsset = taskId => {
    const file = taskAsset(taskId);
    const id = localAssetId(file);
    if (!id) throw new Error('该视频尚未保存到本机，无法进行本地处理');
    return { file, id };
  };
  async function ensureCloudReferenceIds(ids) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    const media = requireDesktopMedia('syncLocal');
    const resolved = [];
    for (const id of unique) {
      const file = asset(id);
      if (!file) throw new Error('参考素材不存在，请重新选择');
      if (!file.localOnly && (file.remoteStatus === 'ready' || file.referenceSourceAvailable)) {
        resolved.push(id);
        continue;
      }
      const sourceId = localAssetId(file);
      if (!sourceId) throw new Error('参考素材仅保存在原桌面设备，请重新上传后再创作');
      const result = await media.syncLocal({ assetId:sourceId, uploadForReference:true });
      const cloudAsset = result?.cloudAsset;
      if (!cloudAsset?.id || cloudAsset.remoteStatus === 'local_only') throw new Error('参考素材同步到云端失败，请重新上传后再试');
      const syncedFile = { ...cloudAsset, id:cloudAsset.id, url:result.url || cloudAsset.url, remoteUrl:cloudAsset.url, localId:sourceId, localStatus:'saved', localPath:result.relativePath || file.localPath, sha256:cloudAsset.sha256 || file.sha256 };
      state.files = [syncedFile, ...state.files.filter(item => item.id !== syncedFile.id)];
      resolved.push(syncedFile.id);
    }
    return resolved;
  }
  async function addLocalDramaAsset(result) {
    if (!result?.id) throw new Error('本地素材生成失败');
    state.files = [result, ...state.files.filter(item => item.id !== result.id)];
    await loadFiles({ background:true });
    return result;
  }
  async function extractDramaTailLocally(shot) {
    const source = taskLocalAsset(shot.selectedVideoTaskId);
    const result = await requireDesktopMedia('extractTail').extractTail({ assetId:source.id, name:`${project.title} · 分镜 ${shot.shotNumber}`, projectId:project.id });
    await addLocalDramaAsset(result);
    return result;
  }
  async function assembleDramaLocally() {
    const assetIds = project.shots.map(shot => taskLocalAsset(shot.selectedVideoTaskId).id);
    const result = await requireDesktopMedia('assembleVideos').assembleVideos({ assetIds, name:project.title, projectId:project.id });
    await addLocalDramaAsset(result);
    project.finalAssetId = result.id;
    project.status = 'completed';
    project.step = 'video';
    projects = mergeDramaProjectList(projects, project);
    state.dramaProject = project;
    return result;
  }
  function restoreLocalProjectOutputs(value) {
    if (!value?.finalAssetId) {
      const localFinal = state.files.find(file => file.localOnly && file.source === 'drama_final' && String(file.projectId || '') === String(value?.id || ''));
      if (localFinal) value.finalAssetId = localFinal.id;
    }
    return value;
  }
  const taskDisplayStatus = id => {
    const generation = task(id);
    const state = videoPreviewVersionState(generation, { ready:taskLocallyReady(id), syncing:taskSyncing(id) });
    return state === 'pending' || state === 'syncing' ? 'running' : generation?.status;
  };
  const taskDisplayLabel = id => {
    const generation = task(id);
    if (generation?.status === 'failed') return '视频生成失败，点击查看原因';
    if (taskSyncing(id)) return '视频生成中…';
    if (generation?.status === 'running') return '视频生成中…';
    if (generation?.status === 'queued') return '视频排队中…';
    if (generation?.status === 'completed' && generation.assetId) return '视频生成中…';
    return '生成后在这里预览';
  };
  const videoProgressStageLabel = generation => ({
    submitting: '正在提交视频',
    provider_processing: '正在生成视频',
    polling_retry: '正在恢复连接',
    archiving: '正在整理成品',
    awaiting_reconciliation: '正在确认任务',
  })[generation?.progressStage] || '正在生成视频';
  const workbenchVideoProgressMarkup = generation => {
    const progress = videoTaskProgress(generation);
    if (generation?.type !== 'video' || !['queued','running'].includes(generation.status) || progress === null) return '';
    return `<div class="wb-preview-empty wb-preview-progress" role="status" aria-live="polite" aria-label="视频生成进度 ${progress}%"><span class="wb-preview-progress-ring" style="--progress:${progress}%" aria-hidden="true"></span><b>${progress}%</b><small>${esc(videoProgressStageLabel(generation))}</small></div>`;
  };
  // Desktop-local videos can render freely; remote MP4 URLs stay detached from
  // list surfaces so a render never fans out into remote storage downloads.
  const workbenchVideoMarkup = file => String(file?.url || '').startsWith('gugu-media://')
    ? `<video src="${esc(file.url)}" preload="auto" muted playsinline></video><span class="wb-media-play">▶</span>`
    : '<span class="wb-video-placeholder" aria-hidden="true"><span class="wb-media-play">▶</span></span>';
  const resetWorkbenchVideoObserver = () => { workbenchVideoObserver?.disconnect(); workbenchVideoObserver = null; };
  const hydrateWorkbenchVideos = (scope = root) => {
    const videos = [...scope.querySelectorAll('[data-wb-video-src]')];
    if (!videos.length) return;
    const loadVideo = video => {
      const src = video.dataset.wbVideoSrc;
      if (!src) return;
      delete video.dataset.wbVideoSrc;
      video.src = src;
    };
    if (!('IntersectionObserver' in window)) { videos.forEach(loadVideo); return; }
    workbenchVideoObserver ||= new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      workbenchVideoObserver?.unobserve(entry.target);
      loadVideo(entry.target);
    }), { rootMargin:'320px 0px' });
    videos.forEach(video => workbenchVideoObserver.observe(video));
  };
  const resetProjectAssetMediaObserver = () => {
    projectAssetMediaObserver?.disconnect();
    projectAssetMediaObserver = null;
  };
  const projectAssetImageMarkup = (file, alt = '') => {
    const preview = assetPreviewUrl(file);
    if (!preview) return assetImageMarkup(file, alt);
    const original = String(file?.remoteUrl || file?.url || '');
    const fallback = original && preview !== original ? ` data-original-src="${esc(original)}"` : '';
    return `<img class="project-asset-thumb" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" data-project-asset-src="${esc(preview)}" alt="${esc(alt)}"${fallback} loading="lazy" decoding="async">`;
  };
  const projectAssetVideoMarkup = file => String(file?.url || '').startsWith('gugu-media://')
    ? `<video class="project-asset-thumb" data-project-asset-src="${esc(file.url)}" preload="none" muted playsinline></video><span class="wb-media-play">▶</span>`
    : workbenchVideoMarkup(file);
  const hydrateProjectAssetMedia = scope => {
    const grid = scope.querySelector('.project-asset-dialog-grid');
    const media = [...scope.querySelectorAll('[data-project-asset-src]')];
    if (!grid || !media.length) return;
    const loadMedia = element => {
      const src = element.dataset.projectAssetSrc;
      if (!src) return;
      delete element.dataset.projectAssetSrc;
      if (element.tagName === 'VIDEO') element.preload = 'metadata';
      element.src = src;
    };
    if (!('IntersectionObserver' in window)) { media.forEach(loadMedia); return; }
    resetProjectAssetMediaObserver();
    projectAssetMediaObserver = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      projectAssetMediaObserver?.unobserve(entry.target);
      loadMedia(entry.target);
    }), { root: grid, rootMargin: '160px 0px' });
    media.forEach(element => projectAssetMediaObserver.observe(element));
  };
  const resetVirtualShotWindow = () => {
    if (virtualScrollFrame) cancelAnimationFrame(virtualScrollFrame);
    virtualScrollFrame = 0;
    virtualShotResizeObserver?.disconnect();
    virtualShotResizeObserver = null;
    virtualRangeKey = '';
    virtualStart = 0;
    virtualEnd = 0;
  };
  const virtualShotHeight = index => {
    const shot = project?.shots?.[index];
    return Math.max(220, Number(virtualShotHeights.get(shot?.id)) || virtualEstimatedShotHeight);
  };
  const virtualHeightBefore = index => {
    let total = 0;
    for (let cursor = 0; cursor < index; cursor += 1) total += virtualShotHeight(cursor);
    return total;
  };
  const virtualRangeFor = (scrollTop, viewportHeight) => {
    return calculateVirtualShotRange(project?.shots?.map((_, index) => virtualShotHeight(index)) || [], scrollTop, viewportHeight, { overscan:virtualOverscan, estimatedHeight:virtualEstimatedShotHeight });
  };
  const updateVirtualSpacers = scroll => {
    if (!scroll) return;
    const top = scroll.querySelector('[data-wb-virtual-spacer="top"]');
    const bottom = scroll.querySelector('[data-wb-virtual-spacer="bottom"]');
    if (top) top.style.height = `${virtualHeightBefore(virtualStart)}px`;
    if (bottom) bottom.style.height = `${Math.max(0, virtualHeightBefore(project.shots.length) - virtualHeightBefore(virtualEnd))}px`;
  };
  const observeVirtualShotHeights = scroll => {
    if (!('ResizeObserver' in window)) return;
    virtualShotResizeObserver ||= new ResizeObserver(entries => {
      let changed = false;
      entries.forEach(entry => {
        const card = entry.target;
        const index = Number(card.dataset.wbShotIndex);
        const shot = project?.shots?.[index];
        if (!shot || !Number.isFinite(index)) return;
        const style = getComputedStyle(card);
        const next = entry.contentRect.height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        const previous = virtualShotHeight(index);
        if (Math.abs(next - previous) < 1) return;
        virtualShotHeights.set(shot.id, next);
        changed = true;
        if (index < virtualStart) scroll.scrollTop += next - previous;
      });
      if (changed) updateVirtualSpacers(scroll);
    });
    scroll.querySelectorAll('[data-wb-shot]').forEach(card => virtualShotResizeObserver.observe(card));
  };
  const scheduleVirtualShotWindow = () => {
    if (virtualScrollFrame) return;
    virtualScrollFrame = requestAnimationFrame(() => {
      virtualScrollFrame = 0;
      const scroll = root.querySelector('.wb-shot-scroll');
      const active = document.activeElement;
      if (active && root.contains(active) && active.closest('[data-wb-shot]') && active.matches('textarea,input,select,[contenteditable="true"]')) return;
      renderProfessionalShotWindow({ scroll });
    });
  };
  const workbenchInteractiveSelector = 'textarea,input,select,[contenteditable="true"]';
  const workbenchHasActiveInteraction = () => {
    const active = document.activeElement;
    return Boolean(
      document.querySelector('#wbDropdownPortal, dialog#projectAssetDialog[open], dialog#professionalAssetDialog[open], dialog#professionalGenerationReferenceDialog[open], dialog#professionalMediaPreviewDialog[open]')
      || (root.contains(active) && active?.matches(workbenchInteractiveSelector))
    );
  };
  const flushDeferredProfessionalRender = () => {
    if (!deferredProfessionalRender || !project || workbenchHasActiveInteraction()) return;
    deferredProfessionalRender = false;
    render(true, { focus:false });
  };
  const scheduleFlushDeferredProfessionalRender = () => window.setTimeout(flushDeferredProfessionalRender, 0);
  const deferProfessionalRender = () => { deferredProfessionalRender = true; };
  const imageAssets = () => state.files.filter(file=>file.kind==='image'&&!assetSyncing(file));
  const frameOptions = current => `<option value="">未指定</option>${imageAssets().map(file=>`<option value="${file.id}" ${file.id===current?'selected':''}>${esc(file.name)}</option>`).join('')}`;
  const generationModeName = value => ({TEXT:'文本生成','FIRST&LAST':'首尾帧','REFERENCE':'参考元素'}[value] || '文本生成');
  const optionList = (values,current,suffix='') => values.map(value => `<option value="${value}" ${String(value)===String(current)?'selected':''}>${value}${suffix}</option>`).join('');
  const selectedResourceAssetIds = shot => [...new Set([...(shot.resourceIds || []).map(id => project.resources.find(item => item.id === id)).map(item => taskAsset(item?.selectedTaskId)?.id).filter(id => id && !assetSyncing(asset(id))), ...(shot.referenceAssetIds || []).filter(id => !assetSyncing(asset(id)))])];
  const saveLabel = () => {};
  const professional = () => project?.mode !== 'smart';
  const scroller = () => {
    if (!professional()) return document.querySelector('#workspaceMain');
    const editorScroller = root.querySelector('.professional-shot-editor-scroll');
    return editorScroller && editorScroller.scrollHeight > editorScroller.clientHeight ? editorScroller : document.querySelector('#workspaceMain');
  };
  const dropFocus = () => { const active=document.activeElement; if(root.contains(active)&&typeof active.blur==='function')active.blur(); };
  const beatSeconds = beat => beat?.kind==='dialogue' ? Math.max(0.5,Math.round(Array.from(String(beat.text||'').replace(/\s+/g,'')).length/4.5*10)/10) : 2.5;
  const cloneProjectValue = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const markProjectKeys = keys => keys.forEach(key=>projectKeyVersions.set(key,(projectKeyVersions.get(key)||0)+1));
  function queueSave(...keys){ markProjectKeys(keys);keys.forEach(key=>pendingKeys.add(key));clearTimeout(saveTimer);saveLabel('未保存…');saveTimer=setTimeout(()=>{void flushSave().catch(()=>{});},800); }
  async function flushSave(){
    clearTimeout(saveTimer);
    const targetProjectId=project?.id||'';
    if(!pendingKeys.size){await projectMutationChain.catch(()=>{});return project;}
    const keys=[...pendingKeys];
    const changes=Object.fromEntries(keys.map(key=>[key,project?.[key]]));
    keys.forEach(key=>pendingKeys.delete(key));
    if(!project)return null;
    try{return await patch(changes,{quiet:true,keysAlreadyMarked:true});}
    catch(error){if(project?.id===targetProjectId)keys.forEach(key=>pendingKeys.add(key));throw error;}
  }
  function normalizeProjectData(value){
    if(!value||typeof value!=='object')return value;
    value.settings={shotCount:5,totalDuration:100,shotDuration:20,aspectRatio:'9:16',...(value.settings||{})};
    value.projectAssetIds=Array.isArray(value.projectAssetIds)?[...new Set(value.projectAssetIds.map(String).filter(Boolean))]:[];
    value.projectAssetCategories=value.projectAssetCategories&&typeof value.projectAssetCategories==='object'&&!Array.isArray(value.projectAssetCategories)?value.projectAssetCategories:{};
    value.scenes=Array.isArray(value.scenes)?value.scenes:[];
    value.resources=(Array.isArray(value.resources)?value.resources:[]).map(item=>({...item,id:item.id||crypto.randomUUID(),type:['character','location','prop'].includes(item.type)?item.type:'prop',name:String(item.name||'未命名资源'),description:String(item.description||''),prompt:String(item.prompt||''),bible:{identity:String(item.bible?.identity||item.description||''),dramaticGoal:String(item.bible?.dramaticGoal||''),appearance:String(item.bible?.appearance||''),costume:String(item.bible?.costume||''),canonicalViews:String(item.bible?.canonicalViews||''),stateNotes:String(item.bible?.stateNotes||'')},lifecycle:{status:String(item.lifecycle?.status||(item.selectedTaskId?'approved':'draft')),revision:Math.max(1,Number(item.lifecycle?.revision)||1),approvedAt:String(item.lifecycle?.approvedAt||'')},versions:Array.isArray(item.versions)?item.versions:[],selectedTaskId:String(item.selectedTaskId||'')}));
    value.shots=(Array.isArray(value.shots)?value.shots:[]).map((shot,index)=>{
      const professionalAssets={characters:[...new Set(Array.isArray(shot.professionalAssets?.characters)?shot.professionalAssets.characters.map(String):[])],locations:[...new Set(Array.isArray(shot.professionalAssets?.locations)?shot.professionalAssets.locations.map(String):[])]};
      const categorizedIds=[...professionalAssets.characters,...professionalAssets.locations];
      const assetMentions=Array.isArray(shot.assetMentions)?shot.assetMentions.map(item=>({id:String(item?.id||''),label:String(item?.label||'').replace(/^@/,'').trim().slice(0,120),kind:['image','video','audio'].includes(item?.kind)?item.kind:'image'})).filter(item=>item.id&&item.label).slice(0,40):[];
      const mentionedIds=assetMentions.map(item=>item.id);
      const referenceAssetIds=[...new Set([...(Array.isArray(shot.referenceAssetIds)?shot.referenceAssetIds.map(String):[]),...categorizedIds,...mentionedIds])];
      const requestedType=['TEXT','FIRST&LAST','REFERENCE'].includes(shot.generation?.type)?shot.generation.type:(referenceAssetIds.length?'REFERENCE':'TEXT');
      const type=requestedType;
      const firstFrameAssetId=String(shot.generation?.firstFrameAssetId||'');
      const lastFrameAssetId=String(shot.generation?.lastFrameAssetId||'');
      const explicit=Array.isArray(shot.generation?.referenceAssetIds)?shot.generation.referenceAssetIds.map(String):[];
      const generationReferences=type==='TEXT'?[]:type==='FIRST&LAST'?[firstFrameAssetId,lastFrameAssetId].filter(Boolean):[...new Set([...explicit,...referenceAssetIds])];
      const pendingImageGenerations=Array.isArray(shot.pendingImageGenerations)?shot.pendingImageGenerations.map(item=>({...item,id:String(item.id||item.taskId||crypto.randomUUID()),taskId:String(item.taskId||'')})):[];
      return {...shot,id:shot.id||crypto.randomUUID(),shotNumber:index+1,sceneNumber:Math.max(1,Number(shot.sceneNumber)||1),sceneId:String(shot.sceneId||''),title:String(shot.title||'').trim()||DEFAULT_SHOT_TITLE,sourceBeatIds:Array.isArray(shot.sourceBeatIds)?shot.sourceBeatIds:[],script:String(shot.script||''),assetMentions,prompt:String(shot.prompt||shot.visualDirection||''),promptOverride:String(shot.promptOverride||''),visualDirection:String(shot.visualDirection||shot.prompt||''),narrativeFunction:String(shot.narrativeFunction||''),shotSize:String(shot.shotSize||'中景'),cameraMovement:String(shot.cameraMovement||'固定'),framing:String(shot.framing||''),startStateId:String(shot.startStateId||''),startState:String(shot.startState||''),action:String(shot.action||shot.script||''),endStateId:String(shot.endStateId||''),endState:String(shot.endState||''),continuityNotes:String(shot.continuityNotes||''),sound:String(shot.sound||''),negativePrompt:String(shot.negativePrompt||'禁止人物变脸、服装变化、道具消失、空间轴线跳变'),duration:Number(shot.duration)||value.settings.shotDuration,aspectRatio:String(shot.aspectRatio||value.settings.aspectRatio),resourceIds:Array.isArray(shot.resourceIds)?shot.resourceIds:[],referenceAssetIds,professionalAssets,pendingImageGenerations,generation:{type,modelId:canonicalVideoModelId(shot.generation?.modelId),firstFrameAssetId,lastFrameAssetId,referenceAssetIds:generationReferences,quality:['480p','720p','1080p','4k','768p','2k'].includes(shot.generation?.quality)?shot.generation.quality:'720p',count:[1,2,4].includes(Number(shot.generation?.count))?Number(shot.generation.count):1},lifecycle:{status:String(shot.lifecycle?.status||(shot.selectedVideoTaskId?'generated':'draft')),revision:Math.max(1,Number(shot.lifecycle?.revision)||1),staleReasons:Array.isArray(shot.lifecycle?.staleReasons)?shot.lifecycle.staleReasons:[]},videoVersions:Array.isArray(shot.videoVersions)?shot.videoVersions:[],selectedVideoTaskId:String(shot.selectedVideoTaskId||''),tailFrameAssetId:String(shot.tailFrameAssetId||'')};
    });
    return value;
  }

  function modelState() {
    const badge=document.querySelector('#dramaLlmState'); if(!badge)return; const ready=Boolean(state.config.llm); badge.classList.toggle('ready',ready); badge.classList.toggle('bad',!ready); badge.querySelector('b').textContent=ready?'导演模型已连接':'导演模型未配置';
  }
  function syncProjectHeader(){
    const open=Boolean(project);
    document.querySelector('#appView')?.classList.toggle('drama-project-open',open&&state.route==='drama');
    document.querySelector('#appView')?.classList.toggle('drama-professional-open',open&&state.route==='drama'&&project?.mode==='professional');
    const routeTitle=document.querySelector('#routeTitle');
    const titleInput=document.querySelector('#dramaProjectTitle');
    routeTitle.textContent=open?project.title:'短剧创作';
    document.title=`${routeTitle.textContent} · GuGu AI`;
    if(titleInput)titleInput.value=open?project.title:'';
  }
  function setStudioVisible(open) { document.querySelector('#dramaProjects')?.classList.toggle('hidden',open); document.querySelector('#dramaStudio')?.classList.toggle('hidden',!open); }
  function projectProgress(item) { const count=(item.shots||[]).filter(shot=>taskLocallyReady(shot.selectedVideoTaskId)).length; return { count,total:(item.shots||[]).length }; }

  function renderProjects() {
    const projectsRoot = document.querySelector('#dramaProjects');
    if (!projectsRoot) return;
    setStudioVisible(false);
    projectsRoot.innerHTML=`<div class="project-library-grid"><button type="button" class="create-project-card" id="openCreateDramaProject"><span><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><b>创建项目</b></button>${projects.map(item=>{const progress=projectProgress(item);return `<button class="project-card" data-project-id="${item.id}"><span>${item.mode==='smart'?'智能导演 · 内测':'专业编辑'} · ${stepNames[item.step]||'剧本设计'}</span><h2>${esc(item.title)}</h2><p>${esc(item.synopsis||item.input||'尚未填写故事内容')}</p><footer><b>${progress.count}/${progress.total} 镜头完成</b><time>${new Date(item.updatedAt||item.createdAt).toLocaleDateString('zh-CN')}</time></footer></button>`}).join('')}</div>`;
    projectsRoot.querySelector('#openCreateDramaProject').onclick=openCreateProjectDialog;
    projectsRoot.querySelectorAll('[data-project-id]').forEach(button=>button.onclick=()=>openProject(button.dataset.projectId));
  }
  function resetCreateProjectDialog(){document.querySelectorAll('[data-create-drama-mode]').forEach(button=>{button.disabled=button.hasAttribute('data-unavailable');button.classList.remove('creating');});}
  function openCreateProjectDialog(){const dialog=document.querySelector('#createDramaProjectDialog');resetCreateProjectDialog();dialog.showModal();requestAnimationFrame(()=>dialog.querySelector('[data-create-drama-mode]:not(:disabled)')?.focus());}
  async function chooseProjectMode(mode){const dialog=document.querySelector('#createDramaProjectDialog');const selected=dialog.querySelector(`[data-create-drama-mode="${mode}"]`);dialog.querySelectorAll('[data-create-drama-mode]').forEach(button=>button.disabled=true);selected?.classList.add('creating');const created=await createProject(mode);if(created)dialog.close();else resetCreateProjectDialog();}
  async function load(force=false) {
    if(busy)return;
    busy=true;
    const loadToken=++projectLoadToken;
    try {
      if(project&&!force)await flushSave();
      const activeProjectId=project?.id||'';
      const result=await api('/api/drama/projects');
      if(loadToken!==projectLoadToken)return;
      projects=result.projects;
      if(project&&!force&&project.id===activeProjectId){
        const fresh=projects.find(item=>item.id===project.id);
        if(fresh)project=restoreLocalProjectOutputs(normalizeProjectData(fresh));
        state.dramaProject=project;
        await loadTasks();
        if(loadToken!==projectLoadToken||project?.id!==activeProjectId)return;
        render();
      }else renderProjects();
    }catch(error){if(loadToken===projectLoadToken)toast(error.message);}
    finally{busy=false;}
  }
  async function createProject(mode) { try { const result=await api('/api/drama/projects',{method:'POST',body:JSON.stringify({title:mode==='smart'?'未命名智能短剧':'未命名剧本',mode,settings:{shotCount:5,totalDuration:100,shotDuration:20,aspectRatio:'9:16'}})}); projects=[result.project,...projects]; return await openProject(result.project.id); }catch(error){toast(error.message);return false;} }
  async function openProject(id) {
    const loadToken=++projectLoadToken;
    try {
      requireDesktopMedia('listLocal');
      await loadFiles({background:true});
      const result=await api(`/api/drama/projects/${id}`);
      if(loadToken!==projectLoadToken)return false;
      projectEpoch+=1;
      pendingKeys.clear();
      projectKeyVersions.clear();
      professionalPreviewTaskIds.clear();
      professionalVideoQuoteCache.clear();
      project=restoreLocalProjectOutputs(normalizeProjectData(result.project));
      projectAssetIds=[...project.projectAssetIds];
      projectAssetCategories=new Map(Object.entries(project.projectAssetCategories||{}));
      viewStep=project.step;
      scriptDraft=null;
      state.dramaProject=project;
      await loadTasks();
      if(loadToken!==projectLoadToken||project?.id!==id)return false;
      setStudioVisible(true);syncProjectHeader();modelState();render();return true;
    }catch(error){if(loadToken===projectLoadToken)toast(error.message);return false;}
  }
  async function closeProject(){
    await flushSave();
    projectLoadToken+=1;projectEpoch+=1;
    document.querySelector('#professionalAssemblyDialog')?.close();
    resetWorkbenchVideoObserver();resetVirtualShotWindow();virtualShotHeights.clear();virtualShotProjectId='';professionalPreviewTaskIds.clear();professionalVideoQuoteCache.clear();deferredProfessionalRender=false;pendingKeys.clear();projectKeyVersions.clear();project=null;viewStep=null;scriptDraft=null;assetPickerShotId='';state.dramaProject=null;syncProjectHeader();renderProjects();
  }
  async function patch(changes,{quiet=false,keysAlreadyMarked=false}={}) {
    if(!project)return null;
    const targetProjectId=project.id;
    const targetEpoch=projectEpoch;
    const keys=Object.keys(changes);
    if(!keysAlreadyMarked)markProjectKeys(keys);
    keys.forEach(key=>pendingKeys.delete(key));
    const payload=cloneProjectValue(changes);
    const requestVersions=new Map(projectKeyVersions);
    saveLabel('保存中…');
    const run=async()=>{
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return null;
      const send=revision=>api(`/api/drama/projects/${targetProjectId}`,{method:'PATCH',body:JSON.stringify({...payload,revision})});
      try {
        let result;
        try{result=await send(project.revision);}
        catch(error){if(error.code!=='PROJECT_VERSION_CONFLICT'||!error.project)throw error;result=await send(error.project.revision);}
        if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return null;
        const localProject=project;
        const serverProject=restoreLocalProjectOutputs(normalizeProjectData(result.project));
        project=mergeProjectResponseWithNewerKeys(serverProject,localProject,requestVersions,projectKeyVersions);
        projects=mergeDramaProjectList(projects,project);state.dramaProject=project;saveLabel('已保存');if(!quiet)render(true);return project;
      }catch(error){if(projectEpoch===targetEpoch&&project?.id===targetProjectId){saveLabel('保存失败');toast(error.message);}throw error;}
    };
    const request=projectMutationChain.catch(()=>{}).then(run);
    projectMutationChain=request.catch(()=>{});
    return request;
  }
  async function navigateStep(step){ await flushSave(); const frontier=professional()?stepOrder.length-1:stepOrder.indexOf(project.maxStep||project.step); if(stepOrder.indexOf(step)>frontier)return; viewStep=step; assetPickerShotId=''; dropFocus(); render(true); const host=scroller(); if(host)host.scrollTop=0; }
  async function advanceStep(step){ await flushSave(); const result=await patch({step},{quiet:true}); project=result; viewStep=step; assetPickerShotId=''; dropFocus(); render(true); const host=scroller(); if(host)host.scrollTop=0; }

  function stepNav(){ document.querySelectorAll('[data-drama-step]').forEach(button=>{ const index=stepOrder.indexOf(button.dataset.dramaStep); const current=stepOrder.indexOf(viewStep||project.step); const reached=stepOrder.indexOf(project.maxStep||project.step); const frontier=professional()?stepOrder.length-1:reached; button.classList.toggle('active',index===current); button.classList.toggle('done',index<reached&&index!==current); button.disabled=index>frontier; button.onclick=index<=frontier?()=>navigateStep(button.dataset.dramaStep):null; }); }
  function minimizeStageHead(){
    root.querySelectorAll('.stage-head').forEach(head=>{
      const actions=head.querySelector('.stage-head-actions');
      if(!actions){head.remove();return;}
      head.className='stage-toolbar';
      head.replaceChildren(actions);
    });
  }
  function pinStageAction(){
    const primary=root.querySelector('#runSmartDirector,#saveProfessionalScript,#confirmScriptReview');
    if(!primary)return;
    const bar=document.createElement('footer');
    bar.className='stage-action-bar script-action-bar';
    const actions=document.createElement('div');
    actions.append(primary);
    bar.append(actions);
    root.append(bar);
  }
  function render(force=false,{focus=true}={}){
    if(!project)return renderProjects();
    const active=document.activeElement;
    const focusedField=root.contains(active)&&active?.matches('textarea,input,select,[contenteditable="true"]') ? { id:active.id, start:active.selectionStart, end:active.selectionEnd } : null;
    if(!force&&focusedField)return;
    const host=scroller(); const offset=host?.scrollTop||0;
    project=normalizeProjectData(project);viewStep||=project.step;state.dramaProject=project;syncProjectHeader();
    if(professional()){
      renderProfessionalWorkspace({focus:focus&&!focusedField});
      const nextHost=scroller();
      if(nextHost){nextHost.scrollTop=offset;if(offset)renderProfessionalShotWindow({scroll:nextHost,force:true});}
      // Restore focus only after the preserved scroll window is mounted. A field
      // edited in a non-first virtual window is not present until this point.
      if(focusedField){const next=document.getElementById(focusedField.id);if(next&&root.contains(next)){next.focus();if(typeof focusedField.start==='number'&&typeof next.setSelectionRange==='function')next.setSelectionRange(focusedField.start,focusedField.end);}}
      return;
    }
    stepNav();({script:renderScript,resources:renderResources,storyboard:renderStoryboard,video:renderVideo}[viewStep]||renderScript)(); minimizeStageHead(); if(viewStep==='script')pinStageAction();
    const nextHost=scroller();
    if(nextHost)nextHost.scrollTop=offset;
  }
  function refreshTasks(){
    if(!project)return;
    const signature=state.tasks.map(item=>`${item.id}:${item.status}:${item.progress ?? ''}:${item.progressStage || ''}:${item.failure?.code || ''}:${item.error || ''}:${item.assetId||''}`).sort().join('|');
    const fileSignature=state.files.map(item=>`${item.id}:${item.name}:${item.kind}:${item.url||''}:${item.localStatus||''}:${item.localPath||''}`).sort().join('|');
    const changed=signature!==taskRenderSignature||fileSignature!==fileRenderSignature;
    taskRenderSignature=signature;
    fileRenderSignature=fileSignature;
    if(professional()){
      let pendingChanged=false;
      project.shots.forEach(shot=>{
        const pending=Array.isArray(shot.pendingImageGenerations)?shot.pendingImageGenerations:[];
        const remaining=[];
        let shotChanged=false;
        pending.forEach(item=>{
          const generated=task(item.taskId);
          if(!generated||['queued','running'].includes(generated.status)){remaining.push(item);return;}
          if(generated.status==='failed'){remaining.push(item);return;}
          if(generated.status!=='completed'||!generated.assetId||!taskLocallyReady(item.taskId)){remaining.push(item);return;}
          pendingChanged=true;
          shotChanged=true;
          const id=generated.assetId;
          if(item.targetType==='frame') setProfessionalFrameValue(shot,item.frameField,id);
          else { shot.professionalAssets[item.kind]=[...new Set([...(shot.professionalAssets[item.kind]||[]),id])]; syncProfessionalReferences(shot); }
          rememberProfessionalAsset(id);
          toast(`${item.label||'图片'}已生成并添加到分镜`);
        });
        shot.pendingImageGenerations=remaining;
        if(shotChanged)invalidateProfessionalShot(shot,'图片素材已更新');
      });
      if(pendingChanged){
        queueProfessionalSave();
        if(workbenchHasActiveInteraction()){
          deferProfessionalRender();
          patchProfessionalTaskSurfaces();
        }else render(true,{focus:false});
        return;
      }
    }
    if(!changed||(!professional()&&(viewStep==='script'||viewStep==='storyboard')))return;
    const active=document.activeElement;
    if(!professional()&&root.contains(active)&&active?.matches('textarea,input,select,[contenteditable="true"]')){
      deferProfessionalRender();
      active.addEventListener('blur',scheduleFlushDeferredProfessionalRender,{once:true});
      return;
    }
    const dialog=document.querySelector('#professionalAssetDialog');
    if(professional()&&dialog?.open){patchProfessionalTaskSurfaces();return;}
    if(professional()){
      if(workbenchHasActiveInteraction()){
        deferProfessionalRender();
        patchProfessionalTaskSurfaces();
      }else patchProfessionalTaskSurfaces();
      return;
    }
    if(workbenchHasActiveInteraction()){
      deferProfessionalRender();
      active?.addEventListener?.('blur',scheduleFlushDeferredProfessionalRender,{once:true});
      return;
    }
    render(true,{focus:false});
  }

  function renderProfessionalShotWindow({scroll=root.querySelector('.wb-shot-scroll'), force=false}={}){
    if (!scroll || !project?.shots?.length) return;
    const range = virtualRangeFor(scroll.scrollTop, scroll.clientHeight || window.innerHeight || 800);
    const active = document.activeElement;
    const activeCard = active?.closest?.('[data-wb-shot]');
    const activeIndex = activeCard ? Number(activeCard.dataset.wbShotIndex) : -1;
    if (Number.isInteger(activeIndex) && activeIndex >= 0) {
      range.start = Math.min(range.start, activeIndex);
      range.end = Math.max(range.end, activeIndex + 1);
    }
    const key = `${range.start}:${range.end}`;
    if (!force && key === virtualRangeKey) {
      updateVirtualSpacers(scroll);
      return;
    }
    const previousScrollTop = scroll.scrollTop;
    virtualStart = range.start;
    virtualEnd = range.end;
    virtualRangeKey = key;
    const locked = Boolean(project.finalAssetId);
    const cards = project.shots.slice(range.start, range.end).map((shot, offset) => workbenchShotCard(shot, range.start + offset, locked)).join('');
    // Window replacement detaches the previous cards. Stop observing those nodes
    // before replacing them so long scroll sessions do not retain stale DOM/media.
    virtualShotResizeObserver?.disconnect();
    virtualShotResizeObserver = null;
    scroll.querySelectorAll('[data-wb-video-src]').forEach(video => workbenchVideoObserver?.unobserve(video));
    const finalCut=locked&&range.end===project.shots.length?workbenchFinalCut(project.finalAssetId):'';
    scroll.innerHTML = `<div data-wb-virtual-spacer="top" aria-hidden="true"></div><div data-wb-virtual-items>${cards}</div><div data-wb-virtual-spacer="bottom" aria-hidden="true"></div>${finalCut}`;
    // Set the spacer geometry before restoring scrollTop; otherwise the browser
    // can clamp a deep position to the short, newly-mounted window.
    updateVirtualSpacers(scroll);
    scroll.scrollTop = previousScrollTop;
    const taskById = new Map(state.tasks.map(item => [item.id, item]));
    const fileById = new Map(state.files.map(item => [item.id, item]));
    project.shots.slice(range.start, range.end).forEach(shot => {
      const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
      shotPreviewSignatures.set(shot.id, shotPreviewContentSignatureFromMaps(shot, taskById, fileById, assetSyncing, previewTaskId));
    });
    bindStoryboardWorkbench({ focus:false, cardsOnly:true });
    updateVirtualSpacers(scroll);
    observeVirtualShotHeights(scroll);
    project.shots.slice(range.start, range.end).forEach(scheduleProfessionalVideoQuote);
  }

  function renderProfessionalWorkspace({focus=true}={}){
    if (virtualShotProjectId !== project.id) {
      virtualShotHeights.clear();
      virtualShotProjectId = project.id;
    }
    professionalShotId=project.shots.some(shot=>shot.id===professionalShotId)?professionalShotId:project.shots[0]?.id||'';
    professionalPreviewShotId=project.shots.some(shot=>shot.id===professionalPreviewShotId)?professionalPreviewShotId:professionalShotId;
    seedProjectAssets();
    const locked=Boolean(project.finalAssetId);
    const completed=project.shots.filter(item=>taskLocallyReady(item.selectedVideoTaskId)).length;
    const previewShot=project.shots.find(item=>item.id===professionalPreviewShotId)||project.shots[0];
    resetWorkbenchVideoObserver();
    resetVirtualShotWindow();
    root.innerHTML=`<section class="professional-workspace storyboard-workbench ${locked?'is-locked':''}" aria-label="短剧分镜创作工作台">
      ${projectAssetsPanel(locked)}
      <main class="professional-shot-editor wb-editor-panel">
        <div class="professional-shot-editor-scroll wb-shot-scroll"><div data-wb-virtual-spacer="top" aria-hidden="true"></div><div data-wb-virtual-items></div><div data-wb-virtual-spacer="bottom" aria-hidden="true"></div></div>
        <footer class="wb-action-bar"><button type="button" class="wb-add-shot secondary-button" ${locked?'disabled':''}>＋ 添加分镜</button>${project.shots.length>2&&!locked?`<button type="button" class="wb-assemble stage-next" ${completed===project.shots.length?'':'disabled'}>分镜合成 <span>${completed}/${project.shots.length}</span></button>`:''}${locked?'<span class="wb-locked-note">成片已生成，后续不可继续添加分镜和编辑</span>':''}</footer>
      </main>
    </section>`;
    shotPreviewSignatures.clear();
    const taskById=new Map(state.tasks.map(item=>[item.id,item]));const fileById=new Map(state.files.map(item=>[item.id,item]));
    project.shots.forEach(shot=>{
      const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
      shotPreviewSignatures.set(shot.id, shotPreviewContentSignatureFromMaps(shot, taskById, fileById, assetSyncing, previewTaskId));
    });
    bindStoryboardWorkbench({focus:false});
    renderProfessionalShotWindow({ force:true });
    if(focus)root.querySelector('.wb-shot-card:not(.is-locked) .wb-rich-input[contenteditable="true"]')?.focus();
  }

  function createProfessionalShot(index){
    const last=project.shots[project.shots.length-1];
    return {id:crypto.randomUUID(),shotNumber:index,sceneNumber:index,title:`分镜 ${index}`,script:'',assetMentions:[],prompt:'',promptOverride:'',visualDirection:'',action:'',duration:project.settings.shotDuration,aspectRatio:project.settings.aspectRatio,resourceIds:last?[...(last.resourceIds||[])]:[],referenceAssetIds:[],professionalAssets:{characters:[],locations:[]},pendingImageGenerations:[],generation:{type:'TEXT',modelId:'',firstFrameAssetId:'',lastFrameAssetId:'',referenceAssetIds:[],quality:'720p',count:1},lifecycle:{status:'draft',revision:1,staleReasons:[]},videoVersions:[],selectedVideoTaskId:'',tailFrameAssetId:''};
  }

  function seedProjectAssets(){
    const related=[...project.shots.flatMap(shot=>[...(shot.referenceAssetIds||[]),...(shot.assetMentions||[]).map(item=>item.id),...(shot.professionalAssets?.characters||[]),...(shot.professionalAssets?.locations||[]),shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId]),...project.resources.map(resource=>taskAsset(resource.selectedTaskId)?.id)].filter(Boolean);
    projectAssetIds=[...new Set([...projectAssetIds,...(project.projectAssetIds||[]),...related])].filter(id=>asset(id));project.projectAssetIds=[...projectAssetIds];project.projectAssetCategories=Object.fromEntries(projectAssetCategories);
  }

  function projectAssetKind(file){
    if(projectAssetCategories.has(file?.id))return projectAssetCategories.get(file.id);
    if(file?.kind==='image'){
      const characterIds=new Set(project.shots.flatMap(shot=>shot.professionalAssets?.characters||[]));
      const locationIds=new Set(project.shots.flatMap(shot=>shot.professionalAssets?.locations||[]));
      const resourceTypeByAsset=new Map(project.resources.map(resource=>[taskAsset(resource.selectedTaskId)?.id,resource.type]));
      if(characterIds.has(file.id))return 'characters';
      if(locationIds.has(file.id))return 'locations';
      if(resourceTypeByAsset.get(file.id)==='character')return 'characters';
      if(resourceTypeByAsset.get(file.id)==='location')return 'locations';
      if(resourceTypeByAsset.get(file.id)==='prop')return 'props';
      if(project.shots.some(shot=>shot.generation?.firstFrameAssetId===file.id||shot.generation?.lastFrameAssetId===file.id))return 'props';
    }
    return 'other';
  }

  function projectAssetMedia(file,{lazy=false}={}){
    if(assetSyncing(file))return '<span class="wb-asset-syncing">素材保存中…</span>';
    if(file.kind==='image')return lazy?projectAssetImageMarkup(file, file.name):assetImageMarkup(file, file.name);
    if(file.kind==='video')return lazy?projectAssetVideoMarkup(file):workbenchVideoMarkup(file);
    return '<span class="wb-audio-mark">♫</span>';
  }

  function projectAssetsPanel(locked){
    const groups=[['characters','人物'],['locations','场景'],['props','物品'],['other','其他']];
    return `<aside class="professional-shot-directory wb-assets-panel"><header><h2>项目资产</h2><button type="button" class="gradient-button wb-add-asset" ${locked?'disabled':''}>＋ 添加资产</button></header><div class="wb-assets-scroll">${groups.map(([key,label])=>{const files=projectAssetIds.map(id=>asset(id)).filter(file=>file&&projectAssetKind(file)===key);return `<section class="wb-asset-group"><header><b>${label}</b><span>${files.length}</span></header><div class="wb-asset-grid">${files.map(file=>`<div class="wb-asset-tile ${projectAssetIds.includes(file.id)?'is-project':''} ${locked?'is-locked':''}"><button type="button" class="wb-asset-apply" data-project-asset="${esc(file.id)}" data-project-asset-kind="${key}" ${locked||assetSyncing(file)?'disabled':''}>${projectAssetMedia(file)}<span class="wb-asset-name">${esc(file.name)}</span></button>${locked?'':`<button type="button" class="wb-asset-remove" data-project-asset-remove="${esc(file.id)}" aria-label="从项目中移除 ${esc(file.name)}" title="从项目中移除"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`}</div>`).join('')}<button type="button" class="wb-asset-add-tile" data-project-asset-add="${key}" aria-label="添加${label}" ${locked?'disabled':''}><b>＋</b><span>添加</span></button></div></section>`;}).join('')}</div><footer class="wb-assets-footer"><span>${projectAssetIds.length} 个素材已加入项目</span><small>支持图片、视频、音频</small></footer></aside>`;
  }

  function patchProfessionalAssetSurfaces(){
    root.querySelectorAll('.wb-asset-apply[data-project-asset]').forEach(button=>{
      const file=asset(button.dataset.projectAsset);
      const name=button.querySelector('.wb-asset-name');
      if(!file||!name)return;
      while(button.firstChild&&button.firstChild!==name)button.firstChild.remove();
      name.insertAdjacentHTML('beforebegin',projectAssetMedia(file));
      name.textContent=file.name;
      button.disabled=Boolean(project.finalAssetId||assetSyncing(file));
    });
  }

  function mentionKindLabel(kind){return ({image:'图片',video:'视频',audio:'音频'}[kind]||'素材');}
  function mentionLabel(mention,file){return String(mention?.label||file?.name||'未命名素材').replace(/^@/,'').trim()||'未命名素材';}
  function mentionChipMarkup(mention){
    const file=asset(mention.id); if(!file)return esc(`@${mentionLabel(mention)}`);
    const label=mentionLabel(mention,file);
    const preview=file.kind==='image'?assetImageMarkup(file, label):file.kind==='video'?workbenchVideoMarkup(file):'<b>♫</b>';
    return `<span class="wb-mention-chip" data-mention-id="${esc(file.id)}" data-mention-label="${esc(label)}" data-mention-kind="${esc(file.kind)}" contenteditable="false" aria-label="引用${esc(label)}，${mentionKindLabel(file.kind)}"><span class="wb-mention-thumb">${preview}</span><span class="wb-mention-name">${esc(label)}</span></span>`;
  }
  function renderMentionEditorContent(shot){
    let html=esc(shot.script||'');
    const mentions=(shot.assetMentions||[]).filter(mention=>mention?.id&&mention?.label).sort((a,b)=>mentionLabel(b).length-mentionLabel(a).length);
    mentions.forEach(mention=>{const token=esc(`@${mentionLabel(mention)}`);if(!html.includes(token))return;const escapedToken=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');html=html.replace(new RegExp(escapedToken,'g'),mentionChipMarkup(mention));});
    return html;
  }
  function serializeRichEditor(editor){
    const visit=node=>{
      if(node.nodeType===Node.TEXT_NODE)return node.nodeValue||'';
      if(node.nodeType!==Node.ELEMENT_NODE)return '';
      if(node.classList.contains('wb-input-reference-row'))return '';
      if(node.classList.contains('wb-mention-chip'))return `@${node.dataset.mentionLabel||node.textContent.trim()}`;
      return [...node.childNodes].map(visit).join('');
    };
    return visit(editor).replace(/\u00a0/g,' ').replace(/\u200B/g,'');
  }
  function normalizeEmptyRichEditor(editor){
    if(!editor||serializeRichEditor(editor).trim())return;
    [...editor.childNodes].forEach(node=>{
      if(node.nodeType===Node.TEXT_NODE&&!node.nodeValue.replace(/\u200B/g,'').trim()){node.remove();return;}
      if(node.nodeType===Node.ELEMENT_NODE&&!node.classList.contains('wb-input-reference-row')&&!node.querySelector('.wb-mention-chip')&&!node.textContent.trim())node.remove();
    });
    if(![...editor.childNodes].some(node=>node.nodeType===Node.TEXT_NODE&&node.nodeValue.includes(richEditorEmptyChar)))editor.append(document.createTextNode(richEditorEmptyChar));
  }
  function mentionsFromEditor(editor){
    return [...editor.querySelectorAll('.wb-mention-chip[data-mention-id]')].map(node=>({id:String(node.dataset.mentionId),label:String(node.dataset.mentionLabel||'').replace(/^@/,'').trim(),kind:['image','video','audio'].includes(node.dataset.mentionKind)?node.dataset.mentionKind:'image'})).filter(item=>item.id&&item.label).filter((item,index,list)=>list.findIndex(other=>other.id===item.id&&other.label===item.label)===index).slice(0,40);
  }
  function previousTextPosition(range){
    let node=range.startContainer; let offset=range.startOffset;
    if(node.nodeType===Node.TEXT_NODE)return {node,offset};
    const child=node.childNodes[offset-1]; if(!child)return null;
    node=child; while(node.lastChild)node=node.lastChild;
    return node.nodeType===Node.TEXT_NODE?{node,offset:node.nodeValue.length}:null;
  }
  function mentionTriggerAtCaret(editor){
    const selection=window.getSelection(); if(!selection?.rangeCount||!selection.isCollapsed||!editor.contains(selection.anchorNode))return false;
    const previous=previousTextPosition(selection.getRangeAt(0));
    return Boolean(previous&&previous.offset>0&&previous.node.nodeValue[previous.offset-1]==='@');
  }
  function removeTriggerAt(range){
    const previous=previousTextPosition(range); if(!previous||previous.offset<1||previous.node.nodeValue[previous.offset-1]!=='@')return;
    previous.node.deleteData(previous.offset-1,1); range.setStart(previous.node,previous.offset-1); range.collapse(true);
  }
  function mentionAtCaret(editor,direction){
    const selection=window.getSelection(); if(!editor||!selection?.rangeCount||!selection.isCollapsed||!editor.contains(selection.anchorNode))return null;
    const range=selection.getRangeAt(0); const container=range.startContainer; const offset=range.startOffset; const element=container.nodeType===Node.ELEMENT_NODE?container:container.parentElement; const inside=element?.closest('.wb-mention-chip'); if(inside&&editor.contains(inside))return inside;
    const isMention=node=>node?.nodeType===Node.ELEMENT_NODE&&node.classList.contains('wb-mention-chip');
    if(container.nodeType===Node.TEXT_NODE){const value=container.nodeValue||'';if(direction==='backward'&&offset===0&&isMention(container.previousSibling))return container.previousSibling;if(direction==='backward'&&offset===value.length&&value===' '&&isMention(container.previousSibling))return container.previousSibling;if(direction==='forward'&&offset===value.length&&isMention(container.nextSibling))return container.nextSibling;}
    else if(container.nodeType===Node.ELEMENT_NODE){const adjacent=container.childNodes[direction==='backward'?offset-1:offset];if(isMention(adjacent))return adjacent;}
    return null;
  }
  function setRichEditorCaret(editor,node=null,offset=0){
    if(!editor?.isConnected)return;
    editor.focus({preventScroll:true}); const range=document.createRange();
    if(node?.isConnected&&editor.contains(node)){range.setStart(node,Math.max(0,Math.min(offset,node.nodeValue?.length||0)));range.collapse(true);}else{range.selectNodeContents(editor);range.collapse(false);}
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  }
  function removeMentionAtCaret(id,editor,event){
    if(!['Backspace','Delete'].includes(event.key)||event.isComposing||editor?.dataset.composing==='true')return false;
    const mention=mentionAtCaret(editor,event.key==='Backspace'?'backward':'forward'); if(!mention)return false;
    event.preventDefault(); const after=mention.nextSibling; const before=mention.previousSibling; mention.remove(); normalizeEmptyRichEditor(editor); updateShotScriptFromEditor(id,editor);
    if(after?.isConnected&&after.nodeType===Node.TEXT_NODE)setRichEditorCaret(editor,after,0);else if(before?.isConnected&&before.nodeType===Node.TEXT_NODE)setRichEditorCaret(editor,before,before.nodeValue.length);else setRichEditorCaret(editor);
    return true;
  }
  function restoreRichEditorFocus(editor,range){
    if(!editor?.isConnected)return;
    requestAnimationFrame(()=>{
      if(!editor.isConnected)return;
      editor.focus({preventScroll:true});
      if(!range||!editor.contains(range.startContainer))return;
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    });
  }
  function closeMentionPicker({restoreFocus=false,range=null}={}){
    const editor=mentionPicker.editor;
    document.querySelector('#wbMentionPicker')?.remove();
    mentionPicker={shotId:'',editor:null,range:null,query:''};
    if(restoreFocus)restoreRichEditorFocus(editor,range);
  }
  function mentionPickerFiles(){
    const query=mentionPicker.query.trim().toLocaleLowerCase('zh-CN');
    return projectAssetIds.map(id=>asset(id)).filter(file=>file&&['image','video','audio'].includes(file.kind)&&!assetSyncing(file)&&(!query||String(file.name).toLocaleLowerCase('zh-CN').includes(query)));
  }
  function paintMentionPicker(){
    const editor=mentionPicker.editor; if(!editor)return;
    let picker=document.querySelector('#wbMentionPicker'); if(!picker){picker=document.createElement('div');picker.id='wbMentionPicker';picker.className='wb-mention-picker';document.body.append(picker);}
    const files=mentionPickerFiles();
    picker.innerHTML=`<header><div><b>引用项目素材</b><small>选择后会显示为素材卡片</small></div><button type="button" data-mention-close aria-label="关闭素材选择器"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></header><label class="wb-mention-search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/></svg><input type="search" value="${esc(mentionPicker.query)}" placeholder="搜索项目素材" aria-label="搜索项目素材"></label><div class="wb-mention-options" role="listbox">${files.map(file=>`<button type="button" role="option" data-mention-option="${esc(file.id)}"><span class="wb-mention-option-media">${projectAssetMedia(file)}</span><span><b>${esc(file.name)}</b><small>${mentionKindLabel(file.kind)} · 项目资产</small></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button>`).join('')||'<div class="wb-mention-empty"><b>没有匹配的项目素材</b><small>先将图片、视频或音频添加到左侧项目资产</small><button type="button" data-mention-add-asset>添加项目资产</button></div>'}</div>`;
    const editorRect=editor.getBoundingClientRect();let anchor=mentionPicker.range?.getBoundingClientRect?.();if(!anchor||(!anchor.width&&!anchor.height))anchor={left:editorRect.left+16,right:editorRect.left+16,top:editorRect.top+38,bottom:editorRect.top+38,width:0,height:0};
    positionWorkbenchFloatingPanel(picker,{getBoundingClientRect:()=>anchor},{width:340,preferAbove:false});
    picker.querySelector('[data-mention-close]').onclick=()=>closeMentionPicker({restoreFocus:true});
    picker.querySelector('input')?.addEventListener('input',event=>{mentionPicker.query=event.target.value;paintMentionPicker();requestAnimationFrame(()=>document.querySelector('#wbMentionPicker input')?.focus());});
    picker.querySelectorAll('[data-mention-option]').forEach(button=>button.addEventListener('click',()=>insertMention(button.dataset.mentionOption)));
    picker.querySelector('[data-mention-add-asset]')?.addEventListener('click',()=>{closeMentionPicker();root.querySelector('.wb-add-asset')?.click();});
    picker.onkeydown=event=>{const options=[...picker.querySelectorAll('[data-mention-option]')];const index=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeMentionPicker({restoreFocus:true});return;}if(!['ArrowDown','ArrowUp'].includes(event.key)||!options.length)return;event.preventDefault();options[(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus();};
  }
  function openMentionPicker(shotId,editor){
    if(project.finalAssetId)return;
    const selection=window.getSelection(); mentionPicker={shotId,editor,range:selection?.rangeCount?selection.getRangeAt(0).cloneRange():null,query:''}; paintMentionPicker();
  }
  function insertMention(assetId){
    const shot=project.shots.find(item=>item.id===mentionPicker.shotId); const file=asset(assetId); const editor=mentionPicker.editor; if(!shot||!file||!editor)return;
    const range=mentionPicker.range||document.createRange(); if(!mentionPicker.range){range.selectNodeContents(editor);range.collapse(false);} editor.focus(); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range); removeTriggerAt(range);
    const mention={id:file.id,label:file.name,kind:file.kind}; const holder=document.createElement('span'); holder.innerHTML=mentionChipMarkup(mention); const chip=holder.firstElementChild; range.insertNode(chip); const spacer=document.createTextNode(' '); chip.after(spacer); /* Keep the caret inside the editable spacer so the next IME composition includes its first key. */ range.setStart(spacer,spacer.nodeValue.length); range.collapse(true); selection.removeAllRanges();selection.addRange(range); bindMentionChipInteractions(editor);
    projectAssetIds=[...new Set([...projectAssetIds,file.id])]; project.projectAssetIds=[...projectAssetIds]; project.projectAssetCategories=Object.fromEntries(projectAssetCategories); updateShotScriptFromEditor(shot.id,editor); closeMentionPicker({restoreFocus:true,range:range.cloneRange()});
  }
  function updateShotScriptFromEditor(id,editor){
    const shot=project.shots.find(item=>item.id===id); if(!shot||project.finalAssetId)return;
    const previousReferenceIds=shotReferenceIds(shot);
    const previousMentionIds=new Set((shot.assetMentions||[]).map(item=>item.id));
    const mentions=mentionsFromEditor(editor);
    shot.script=serializeRichEditor(editor); shot.assetMentions=mentions;
    shot.referenceAssetIds=[...(shot.referenceAssetIds||[])].filter(id=>!previousMentionIds.has(id));
    shot.generation.referenceAssetIds=[...(shot.generation.referenceAssetIds||[])].filter(id=>!previousMentionIds.has(id));
    shot.referenceAssetIds=[...new Set([...shot.referenceAssetIds,...mentions.map(item=>item.id)])];
    if(mentions.length&&shot.generation.type==='TEXT')shot.generation.type='REFERENCE';
    syncProfessionalReferences(shot);
    // 专业工作台的输入框就是用户最终提交给视频模型的 Prompt。
    // 同步保存 promptOverride，避免服务端回读项目时用结构化字段覆盖用户输入。
    shot.promptOverride=shot.script.trim(); shot.action=shot.script; shot.visualDirection=shot.script; invalidateProfessionalShot(shot,'分镜内容已修改'); queueProfessionalSave();
    const card=root.querySelector(`[data-wb-shot="${id}"]`); const editorEmpty=!shot.script.trim(); if(editor){editor.dataset.empty=editorEmpty?'true':'false';} const modeSelect=card?.querySelector('[data-wb-field="generation.type"]'); if(modeSelect){modeSelect.value=shot.generation.type;syncWorkbenchDropdown(modeSelect.closest('.wb-dropdown'));}
    refreshWorkbenchShotStatus(card,shot);
    const nextReferenceIds=shotReferenceIds(shot); if(previousReferenceIds.length!==nextReferenceIds.length||previousReferenceIds.some(assetId=>!nextReferenceIds.includes(assetId)))refreshWorkbenchReferenceRow(id,shot);
  }
  function bindMentionChipInteractions(editor){
    editor?.querySelectorAll('.wb-mention-chip').forEach(chip=>{chip.dataset.mentionBound='1';});
  }
  function workbenchReferenceRow(shot){
    const refs=shotReferenceIds(shot).map(id=>asset(id)).filter(Boolean);
    if(!refs.length)return '';
    return `<div class="wb-input-reference-row" contenteditable="false" aria-label="当前分镜参考素材">${refs.map(file=>`<span class="wb-reference-chip"><span>${projectAssetMedia(file)}</span><em>${esc(file.name)}</em><button type="button" class="wb-reference-remove" data-wb-remove-reference="${file.id}" contenteditable="false" aria-label="删除参考素材 ${esc(file.name)}" title="删除参考素材"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></span>`).join('')}</div>`;
  }
  function refreshWorkbenchReferenceRow(shotId,shot){
    const editor=root.querySelector(`[data-wb-shot="${shotId}"] .wb-rich-input`); if(!editor)return;
    const selection=window.getSelection(); const range=selection?.rangeCount&&editor.contains(selection.anchorNode)?selection.getRangeAt(0).cloneRange():null;
    const markup=workbenchReferenceRow(shot); const current=editor.querySelector('.wb-input-reference-row');
    if(markup){if(current)current.outerHTML=markup;else editor.insertAdjacentHTML('afterbegin',markup);}else current?.remove();
    editor.classList.toggle('has-reference',Boolean(markup));
    editor.querySelectorAll('[data-wb-remove-reference]').forEach(button=>{if(button.dataset.wbReferenceBound==='1')return;button.dataset.wbReferenceBound='1';button.addEventListener('click',event=>{event.stopPropagation();removeWorkbenchReference(shotId,button.dataset.wbRemoveReference);});});
    if(range&&editor.isConnected){selection.removeAllRanges();selection.addRange(range);}
  }

  function workbenchDropdownMarkup(key,label,options,current,{disabled=false,sourceAttrs=''}={}){
    const choices=options.map(option=>{
      if(typeof option==='object'&&option!==null)return {...option,value:String(option.value),label:String(option.label)};
      return {value:String(option),label:String(option)};
    });
    const currentValue=String(current??'');
    const selected=choices.find(option=>option.value===currentValue)||choices.find(option=>!option.disabled)||choices[0];
    const selectedValue=selected?.value||currentValue;
    const sourceOptions=choices.map(option=>`<option value="${esc(option.value)}" data-meta="${esc(option.meta||'')}" ${option.value===selectedValue?'selected':''} ${option.disabled?'disabled':''}>${esc(option.label)}</option>`).join('');
    const kind=key==='generation.modelId'?'model':'mode';
    const icon=kind==='model'?professionalModelIcon(selectedValue):'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="13" height="12" rx="2"/><path d="m7 10 2 2 4-4"/></svg>';
    const meta=kind==='model'&&selected?.meta?`<small>${esc(selected.meta)}</small>`:'';
    return `<div class="wb-dropdown ${disabled?'is-disabled':''}" data-wb-dropdown="${esc(key)}" data-wb-dropdown-kind="${kind}"><select class="wb-dropdown-source" data-wb-dropdown-source="${esc(key)}" ${sourceAttrs} aria-label="${esc(label)}" aria-hidden="true" tabindex="-1" ${disabled?'disabled':''}>${sourceOptions||`<option value="">暂无可用选项</option>`}</select><button type="button" class="wb-dropdown-trigger" data-wb-dropdown-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}：${esc(selected?.label||'暂无可用选项')}" ${disabled?'disabled':''}><span class="wb-control-icon">${icon}</span><span class="wb-dropdown-value"><b>${esc(selected?.label||'暂无可用选项')}</b>${meta}</span><svg class="wb-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg></button></div>`;
  }

  function syncWorkbenchDropdown(dropdown){
    if(!dropdown)return;
    const source=dropdown.matches('select')?dropdown:dropdown.querySelector('[data-wb-dropdown-source]');
    if(!source)return;
    const selectedValue=String(source.value??'');
    const selectedOption=source.options?.[source.selectedIndex];
    const label=dropdown.querySelector('.wb-dropdown-value b'); if(label)label.textContent=selectedOption?.textContent||'暂无可用选项';
  }

  function positionWorkbenchFloatingPanel(panel,trigger,{width=280,preferAbove=true}={}){
    const rect=trigger.getBoundingClientRect(); const gutter=12; const gap=8;
    const panelWidth=Math.min(width,window.innerWidth-gutter*2); panel.style.width=`${panelWidth}px`; panel.style.maxHeight=''; panel.style.visibility='hidden'; panel.style.left='0';panel.style.top='0';
    const panelHeight=Math.min(panel.getBoundingClientRect().height||panel.scrollHeight,window.innerHeight-gutter*2); const above=Math.max(0,rect.top-gap-gutter); const below=Math.max(0,window.innerHeight-rect.bottom-gap-gutter);
    const fitsAbove=above>=panelHeight; const fitsBelow=below>=panelHeight; let openAbove;
    if(fitsAbove&&fitsBelow)openAbove=above>below||(above===below&&preferAbove);else if(fitsAbove)openAbove=true;else if(fitsBelow)openAbove=false;else openAbove=above>below;
    const availableSpace=openAbove?above:below; panel.style.maxHeight=`${Math.max(0,Math.round(availableSpace))}px`;
    const positionedHeight=panel.getBoundingClientRect().height||panelHeight;
    let left=Math.min(rect.left,window.innerWidth-panelWidth-gutter); left=Math.max(gutter,left);
    const top=openAbove?rect.top-positionedHeight-gap:rect.bottom+gap;
    panel.dataset.placement=openAbove?'top':'bottom'; panel.style.left=`${Math.round(left)}px`;panel.style.top=`${Math.round(top)}px`;panel.style.visibility='visible';
  }

  function closeWorkbenchDropdowns({focusTrigger=false}={}){
    const trigger=root.querySelector('.wb-dropdown.is-open [data-wb-dropdown-trigger],.wb-spec-control.is-open [data-wb-specs-trigger]');
    root.querySelectorAll('.wb-dropdown.is-open,.wb-spec-control.is-open').forEach(control=>{control.classList.remove('is-open');control.querySelector('[aria-expanded="true"]')?.setAttribute('aria-expanded','false');});
    document.querySelector('#wbDropdownPortal')?.remove(); if(focusTrigger)trigger?.focus();
    scheduleFlushDeferredProfessionalRender();
  }

  function workbenchPortalKeyboard(panel,trigger){
    panel.addEventListener('keydown',event=>{const options=[...panel.querySelectorAll('button:not(:disabled)')];const current=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeWorkbenchDropdowns({focusTrigger:true});return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,current+(event.key==='ArrowDown'?1:-1)));options[next]?.focus();});
  }

  function openWorkbenchDropdown(dropdown,{focusOption=false}={}){
    const source=dropdown.querySelector('[data-wb-dropdown-source]'); const trigger=dropdown.querySelector('[data-wb-dropdown-trigger]'); if(!source||!trigger||trigger.disabled)return;
    if(dropdown.classList.contains('is-open')){closeWorkbenchDropdowns();return;} closeWorkbenchDropdowns(); dropdown.classList.add('is-open');trigger.setAttribute('aria-expanded','true');
    const kind=dropdown.dataset.wbDropdownKind||'mode'; const panel=document.createElement('div');panel.id='wbDropdownPortal';panel.className=`wb-floating-panel wb-select-popover is-${kind}`;panel.setAttribute('role','listbox');panel.setAttribute('aria-label',trigger.getAttribute('aria-label')||'选择');
    const options=[...source.options]; panel.innerHTML=`<header><b>${esc(trigger.getAttribute('aria-label')||'请选择')}</b>${kind==='model'?'<small>仅显示当前模式可用的模型</small>':''}</header><div class="wb-select-option-list">${options.map(option=>{const promo=kind==='model'&&option.value==='minimax-h3-15s'?'<em class="wb-model-promo">限时特惠 ¥0.05/s</em>':'';return `<button type="button" role="option" data-wb-portal-value="${esc(option.value)}" aria-selected="${String(option.value===source.value)}" ${option.disabled?'disabled':''}>${kind==='model'?`<span class="wb-select-option-icon">${professionalModelIcon(option.value)}</span>`:''}<span class="wb-select-option-copy"><span class="wb-model-option-title"><b>${esc(option.textContent)}</b>${promo}</span>${option.dataset.meta?`<small>${esc(option.dataset.meta)}</small>`:''}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-6"/></svg></button>`;}).join('')}</div>`;
    document.body.append(panel); positionWorkbenchFloatingPanel(panel,trigger,{width:kind==='model'?340:260}); workbenchPortalKeyboard(panel,trigger);
    panel.querySelectorAll('[data-wb-portal-value]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();if(button.disabled)return;source.value=button.dataset.wbPortalValue;syncWorkbenchDropdown(dropdown);closeWorkbenchDropdowns();source.dispatchEvent(new Event('change',{bubbles:true}));}));
    if(focusOption)requestAnimationFrame(()=>panel.querySelector(`[data-wb-portal-value="${CSS.escape(source.value)}"]:not(:disabled)`)?.focus()||panel.querySelector('button:not(:disabled)')?.focus());
  }

  function workbenchSpecsMarkup(shot,ratioOptions,qualityOptions,durationOptions,countOptions,locked){
    const hiddenSelect=(attr,label,values,current,format=value=>String(value))=>{const choices=[...new Set([current,...values].filter(value=>value!==undefined&&value!==null&&value!==''))];return `<select class="wb-dropdown-source" ${attr} aria-label="${label}" aria-hidden="true" tabindex="-1" ${locked?'disabled':''}>${choices.map(value=>{const supported=values.some(item=>String(item)===String(value));return `<option value="${esc(value)}" ${String(value)===String(current)?'selected':''} ${!supported?'disabled':''}>${esc(format(value))}</option>`;}).join('')}</select>`;};
    return `<div class="wb-spec-control ${locked?'is-disabled':''}" data-wb-spec-control="${esc(shot.id)}">${hiddenSelect(`data-wb-spec="${esc(shot.id)}"`,'画幅',ratioOptions,shot.aspectRatio)}${hiddenSelect(`data-wb-quality="${esc(shot.id)}"`,'清晰度',qualityOptions,shot.generation.quality)}${hiddenSelect(`data-wb-duration="${esc(shot.id)}"`,'时长',durationOptions,shot.duration,value=>`${value}s`)}${hiddenSelect(`data-wb-count="${esc(shot.id)}"`,'生成数量',countOptions,shot.generation.count||1,value=>String(value))}<button type="button" class="wb-spec-trigger" data-wb-specs-trigger aria-haspopup="dialog" aria-expanded="false" aria-label="生成参数" ${locked?'disabled':''}><span class="wb-control-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="M7 15v2m6-2v2"/></svg></span><span class="wb-spec-summary"><b>${esc(shot.aspectRatio)}</b><i></i><b>${esc(shot.generation.quality)}</b><i></i><b>${esc(`${shot.duration}s`)}</b><i></i><b>${esc(`${shot.generation.count||1}`)}</b></span><svg class="wb-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg></button></div>`;
  }

  function syncWorkbenchSpecs(control){
    if(!control)return; const ratio=control.querySelector('[data-wb-spec]')?.value;const quality=control.querySelector('[data-wb-quality]')?.value;const duration=control.querySelector('[data-wb-duration]')?.value;const count=control.querySelector('[data-wb-count]')?.value;const labels=control.querySelectorAll('.wb-spec-summary b');if(labels[0])labels[0].textContent=ratio||'—';if(labels[1])labels[1].textContent=quality||'—';if(labels[2])labels[2].textContent=duration?`${duration}s`:'—';if(labels[3])labels[3].textContent=count||'—';
  }

  function openWorkbenchSpecs(control,{focusOption=false}={}){
    const trigger=control.querySelector('[data-wb-specs-trigger]');if(!trigger||trigger.disabled)return;if(control.classList.contains('is-open')){closeWorkbenchDropdowns();return;}closeWorkbenchDropdowns();control.classList.add('is-open');trigger.setAttribute('aria-expanded','true');
    const ratio=control.querySelector('[data-wb-spec]');const quality=control.querySelector('[data-wb-quality]');const duration=control.querySelector('[data-wb-duration]');const count=control.querySelector('[data-wb-count]');const optionButtons=(source,field,format=value=>value)=>[...source.options].map(option=>`<button type="button" data-wb-spec-option="${field}" data-value="${esc(option.value)}" aria-pressed="${String(option.value===source.value)}" ${option.disabled?'disabled':''}>${field==='ratio'?`<i class="wb-mini-ratio" style="${ratioIconStyle(option.value)}"></i>`:''}<span>${esc(format(option.value))}</span></button>`).join('');
    const panel=document.createElement('div');panel.id='wbDropdownPortal';panel.className='wb-floating-panel wb-spec-popover';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','生成参数');panel.innerHTML=`<section><header><b>画幅比例</b><span>${esc(ratio.value)}</span></header><div class="wb-spec-ratio-grid">${optionButtons(ratio,'ratio')}</div></section><section><header><b>清晰度</b><span>${esc(quality.value)}</span></header><div class="wb-spec-segments">${optionButtons(quality,'quality',value=>String(value).toUpperCase())}</div></section><section><header><b>视频时长</b><span>${esc(`${duration.value}s`)}</span></header><div class="wb-spec-duration-grid">${optionButtons(duration,'duration',value=>`${value} 秒`)}</div></section><section><header><b>生成数量</b><span>${esc(count.value)} 个</span></header><div class="wb-spec-count-grid">${optionButtons(count,'count',value=>`${value} 个`)}</div></section>`;
    document.body.append(panel);positionWorkbenchFloatingPanel(panel,trigger,{width:330});workbenchPortalKeyboard(panel,trigger);
    panel.querySelectorAll('[data-wb-spec-option]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();if(button.disabled)return;const map={ratio,quality,duration,count};const source=map[button.dataset.wbSpecOption];source.value=button.dataset.value;panel.querySelectorAll(`[data-wb-spec-option="${button.dataset.wbSpecOption}"]`).forEach(item=>item.setAttribute('aria-pressed',String(item===button)));const section=button.closest('section');if(section?.querySelector('header span'))section.querySelector('header span').textContent=button.dataset.wbSpecOption==='duration'?`${button.dataset.value}s`:button.dataset.wbSpecOption==='count'?`${button.dataset.value} 个`:button.dataset.value;syncWorkbenchSpecs(control);source.dispatchEvent(new Event('change',{bubbles:true}));}));
    if(focusOption)requestAnimationFrame(()=>panel.querySelector('[aria-pressed="true"]:not(:disabled)')?.focus());
  }

  function bindWorkbenchDropdowns(){
    root.querySelectorAll('[data-wb-dropdown]').forEach(dropdown=>{const trigger=dropdown.querySelector('[data-wb-dropdown-trigger]');if(!trigger)return;syncWorkbenchDropdown(dropdown);trigger.addEventListener('click',event=>{event.stopPropagation();openWorkbenchDropdown(dropdown);});trigger.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Enter',' '].includes(event.key))return;event.preventDefault();openWorkbenchDropdown(dropdown,{focusOption:true});});});
    root.querySelectorAll('[data-wb-spec-control]').forEach(control=>{const trigger=control.querySelector('[data-wb-specs-trigger]');if(!trigger)return;syncWorkbenchSpecs(control);trigger.addEventListener('click',event=>{event.stopPropagation();openWorkbenchSpecs(control);});trigger.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Enter',' '].includes(event.key))return;event.preventDefault();openWorkbenchSpecs(control,{focusOption:true});});});
  }

  function workbenchShotPreview(shot){
    const previewTaskId=professionalPreviewTaskIds.get(shot?.id)||shot?.selectedVideoTaskId;
    const selectedTask=task(previewTaskId);
    const selectedReady=taskLocallyReady(previewTaskId);
    const selectedSyncing=taskSyncing(previewTaskId);
    const selectedFile=selectedReady?taskAsset(previewTaskId):null;
    const selectedState=videoPreviewVersionState(selectedTask,{ready:selectedReady,syncing:selectedSyncing});
    const showFailureDetails=selectedTask?.status==='failed'&&professionalPreviewTaskIds.get(shot?.id)===previewTaskId;
    const versions=(shot?.videoVersions||[]).map(id=>({id,file:taskAsset(id),task:task(id)}));
    const media=selectedFile?`<button type="button" class="wb-preview-media" data-wb-preview-file="${esc(selectedFile.id)}" aria-label="点击查看${esc(shot?.title||'分镜')}大视频">${workbenchVideoMarkup(selectedFile)}<span class="wb-preview-expand">点击查看大视频</span></button>`:showFailureDetails?generationFailurePreviewMarkup(selectedTask):selectedState==='failed'?generationFailurePromptMarkup():selectedState==='syncing'?`<div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>视频生成中…</b></div>`:selectedState==='pending'?workbenchVideoProgressMarkup(selectedTask)||`<div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>${taskDisplayLabel(previewTaskId)}</b></div>`:previewTaskId?`<div class="wb-preview-empty wb-preview-missing"><span class="wb-preview-missing-icon" aria-hidden="true">${generationFailureIcon}</span><b>${selectedTask?.status==='completed'&&selectedTask?.assetId?'视频文件未找到':'任务记录不可用'}</b><small>请刷新后重试，或重新生成此版本</small></div>`:`<div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>生成后在这里预览</b></div>`;
    const versionStrip=versions.length?`<div class="wb-preview-versions" aria-label="视频版本">${versions.map(item=>workbenchPreviewThumbMarkup(item,{selected:item.id===previewTaskId,shotId:shot.id,shotTitle:shot.title})).join('')}</div>`:'';
    return `<section class="wb-shot-preview" aria-label="${esc(shot?.title||'分镜')}预览"><header><b>预览</b><span>${versions.length?`${versions.length} 个版本`:'暂无视频'}</span></header><div class="wb-preview-stage" style="--video-ratio:${ratioCss(shot?.aspectRatio||'9:16')}">${media}</div>${versionStrip}</section>`;
  }

  function workbenchTitleWidth(value){
    const title=String(value||'');
    const units=Array.from(title).reduce((total,char)=>total+(char.charCodeAt(0)>255?1:0.58),0);
    return Math.min(320,Math.max(26,Math.ceil(units*16+10)));
  }
  function fitWorkbenchTitle(input){
    if(!input)return;
    const width=workbenchTitleWidth(input.value);
    input.style.width=`${width}px`;
  }
  function workbenchShotCard(shot,index,locked){
    const status=taskDisplayStatus(shot.selectedVideoTaskId);
    const active=shot.id===professionalShotId;
    const {models,parameters,modelId}=ensureProfessionalVideoSettings(shot);
    const modelOptions=models.map(model=>({...model,value:model.id,label:model.label,meta:model.description||'',disabled:!professionalModelIsAvailable(model)}));
    const modelSelect=workbenchDropdownMarkup('generation.modelId','模型',modelOptions,modelId,{disabled:locked||!models.some(professionalModelIsAvailable),sourceAttrs:'data-wb-field="generation.modelId"'});
    const ratioOptions=parameters?.aspectRatios||ratios;
    const durationOptions=parameters?.durations?.filter(value=>Number(value)!==30)||durations;
    const qualityOptions=parameters?.qualityOptions||['720p'];
    const countOptions=[1,2,4];
    const activeModel=models.find(model=>model.id===modelId);
    const modeDescriptions={TEXT:'只使用文字提示词',REFERENCE:'使用项目素材保持人物与场景一致','FIRST&LAST':'使用首帧与尾帧控制镜头'};
    const modeOptions=[['TEXT','文本生成'],['REFERENCE','全能参考'],['FIRST&LAST','首尾帧']].map(([value,label])=>{const supported=Boolean(activeModel?.modes?.some(mode=>mode.generationType===value));const blockedByRefs=(value==='TEXT'||value==='FIRST&LAST')&&shotReferenceIds(shot).length>0;return {value,label,meta:modeDescriptions[value],disabled:!supported||blockedByRefs};});
    const modeSelect=workbenchDropdownMarkup('generation.type','模式',modeOptions,shot.generation.type,{disabled:locked,sourceAttrs:'data-wb-field="generation.type"'});
    const specs=workbenchSpecsMarkup(shot,ratioOptions,qualityOptions,durationOptions,countOptions,locked);
    const capability=professionalCapabilityState(shot);
    const cost=professionalVideoCostState(shot);
    const placeholder='描述当前分镜的内容，可使用 @ 引用项目资产中的素材';
    const references=workbenchReferenceRow(shot);
    const editorContent=shot.script.trim()?renderMentionEditorContent(shot):richEditorEmptyChar;
    const tooltip=capability.message||cost.message||'';
    return `<article class="wb-shot-card ${active?'is-active':''} ${status==='completed'?'is-generated':''} ${status==='failed'?'is-failed':''}" data-wb-shot="${shot.id}" data-wb-shot-index="${index}">
      <div class="wb-shot-legend"><input class="wb-shot-title" data-wb-field="title" value="${esc(shot.title)}" maxlength="120" aria-label="分镜${index+1}名称" title="${esc(shot.title)}" style="width:${workbenchTitleWidth(shot.title)}px" ${locked?'disabled':''}></div><button type="button" class="wb-shot-delete" data-wb-delete-shot="${shot.id}" aria-label="删除${esc(shot.title)}" title="删除分镜" ${locked?'disabled':''}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
      <div class="wb-shot-layout"><section class="wb-shot-edit-column"><label class="wb-prompt-label" for="wb-script-${shot.id}">输入分镜内容</label><div id="wb-script-${shot.id}" class="wb-rich-input ${references?'has-reference':''}" data-wb-rich-editor="script" data-shot-id="${shot.id}" data-empty="${shot.script.trim()?'false':'true'}" data-placeholder="${esc(placeholder)}" contenteditable="${locked?'false':'true'}" role="textbox" aria-multiline="true" aria-label="分镜${index+1}内容">${references}${editorContent}</div><footer class="wb-shot-controls"><button type="button" class="wb-control-plus" data-wb-add-reference="${shot.id}" aria-label="添加分镜参考素材" ${locked?'disabled':''}>＋</button><div class="wb-control-select wb-model-select">${modelSelect}</div><div class="wb-dropdown-control wb-mode-control">${modeSelect}</div><div class="wb-dropdown-control wb-specs-control">${specs}</div><button type="button" class="wb-generate-button" data-wb-generate="${shot.id}" ${locked||!capability.ok||!cost.ready?'disabled':''} title="${esc(tooltip)}"><span class="wb-credit-pill">◈ ${cost.label}</span><span>${status==='completed'?'再次生成':'生成'}</span></button></footer></section>${workbenchShotPreview(shot)}</div>
    </article>`;
  }

  function workbenchFinalCut(assetId){
    const file=asset(assetId);if(!file)return '';
    if(assetSyncing(file))return `<section class="wb-final-cut" aria-label="最终成片"><header><div><b>最终成片</b><span>正在合成所选分镜视频</span></div><span class="wb-lock-mark">生成中</span></header><div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>完整成片生成中…</b></div></section>`;
    return `<section class="wb-final-cut" aria-label="最终成片"><header><div><b>最终成片</b><span>已按当前选中版本完成合成</span></div><span class="wb-lock-mark">已锁定</span></header><button type="button" class="wb-final-media" data-wb-preview-file="${esc(file.id)}" aria-label="点击查看最终成片">${workbenchVideoMarkup(file)}<span class="wb-preview-expand">点击查看最终成片</span></button></section>`;
  }

  function workbenchPreviewPanel(shot,locked,completed){
    const finalFile=project.finalAssetId?asset(project.finalAssetId):null;
    const versions=project.shots.flatMap(item=>(item.videoVersions||[]).map(id=>({shot:item,task:task(id),file:taskAsset(id),id}))).filter(item=>item.file||item.task);
    const selectedTask=shot?task(shot.selectedVideoTaskId):null;
    const selectedReady=taskLocallyReady(shot?.selectedVideoTaskId);
    const selectedSyncing=taskSyncing(shot?.selectedVideoTaskId);
    const selectedState=videoPreviewVersionState(selectedTask,{ready:selectedReady,syncing:selectedSyncing});
    const selectedVideoFile=selectedReady?taskAsset(shot?.selectedVideoTaskId):null;
    const selectedFile=finalFile&&!assetSyncing(finalFile)?finalFile:selectedVideoFile;
    const fallbackRatio=ratioCss(shot?.aspectRatio||'9:16');
    const media=selectedFile?`<button type="button" class="wb-preview-media" data-wb-preview-file="${esc(selectedFile.id)}" aria-label="点击查看${esc(shot?.title||'分镜')}大视频">${workbenchVideoMarkup(selectedFile)}<span class="wb-preview-expand">点击查看大视频</span></button>`:selectedState==='failed'?generationFailurePreviewMarkup(selectedTask):selectedState==='pending'?workbenchVideoProgressMarkup(selectedTask)||`<div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>${taskDisplayLabel(shot?.selectedVideoTaskId)}</b><small>${shot?esc(shot.title):'选择一个分镜'}</small></div>`:selectedState==='syncing'?`<div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>视频生成中…</b><small>${shot?esc(shot.title):'选择一个分镜'}</small></div>`:`<div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>${finalFile&&assetSyncing(finalFile)?'成片生成中…':taskDisplayLabel(shot?.selectedVideoTaskId)}</b><small>${shot?esc(shot.title):'选择一个分镜'}</small></div>`;
    return `<header class="wb-preview-head"><div><span class="wb-eyebrow">PREVIEW</span><h2>预览</h2></div><span class="wb-preview-count">${completed}/${project.shots.length} 已生成</span></header><div class="wb-preview-stage" style="--video-ratio:${fallbackRatio}">${media}</div><section class="wb-preview-strip"><header><b>视频版本</b><span>点击查看大视频</span></header><div>${versions.length?versions.map(item=>workbenchPreviewThumbMarkup(item,{selected:item.shot.id===shot?.id&&item.id===shot?.selectedVideoTaskId,shotId:item.shot.id,shotTitle:item.shot.title})).join(''):'<p>生成视频后，缩略图会显示在这里</p>'}</div></section>${finalFile&&!assetSyncing(finalFile)?`<section class="wb-final-cut"><header><div><b>完整成片</b><span>已合成 ${project.shots.length} 个分镜</span></div><span class="wb-lock-mark">⌁ 已锁定</span></header><button type="button" class="wb-final-media" data-wb-preview-file="${esc(finalFile.id)}" aria-label="点击查看完整成片">${workbenchVideoMarkup(finalFile)}<span class="wb-preview-expand">点击查看完整成片</span></button></section>`:`<section class="wb-preview-tip"><span>⌁</span><p>${finalFile&&assetSyncing(finalFile)?'完整成片正在生成中，请稍后预览。':project.shots.length>2&&!locked?'所有分镜视频完成后，可点击缩略图查看大视频。':'生成多个分镜后，可点击缩略图查看大视频。'}</p></section>`}`;
  }

  function refreshWorkbenchShotStatus(card,shot){
    if(!card||!shot)return;const capability=professionalCapabilityState(shot);const cost=professionalVideoCostState(shot);const generate=card.querySelector('[data-wb-generate]');if(generate){generate.disabled=Boolean(project.finalAssetId||!capability.ok||!cost.ready);generate.title=capability.message||cost.message||'';const credits=generate.querySelector('.wb-credit-pill');if(credits)credits.textContent=`◈ ${cost.label}`;}const editor=card.querySelector('.wb-rich-input');if(editor)editor.dataset.empty=shot.script.trim()?'false':'true';
  }
  function patchProfessionalQuoteSurfaces(){
    if(!project)return;
    root.querySelectorAll('[data-wb-shot]').forEach(card=>refreshWorkbenchShotStatus(card,project.shots.find(shot=>shot.id===card.dataset.wbShot)));
    const selected=currentProfessionalShot();const selectedCost=selected?professionalVideoCostState(selected):null;const costLabel=root.querySelector('.professional-cost');if(costLabel&&selectedCost)costLabel.textContent=selectedCost.ready?`本次消耗 ${selectedCost.label} 积分`:`本次消耗 ${selectedCost.label}`;refreshProfessionalProductionValidation(selected);
    root.querySelectorAll('[data-video-shot]').forEach(card=>{const shot=project.shots.find(item=>item.id===card.dataset.videoShot);const button=shot?card.querySelector('[data-generate-shot-video]'):null;if(!shot||!button)return;const capability=professionalCapabilityState(shot);const cost=professionalVideoCostState(shot);const ready=capability.ok&&shotGenerationReady(shot)&&cost.ready;button.disabled=!ready;button.title=capability.message||cost.message||'';button.textContent=ready?`${shot.videoVersions.length?'再生成一版':'生成视频'} · ${cost.label} 积分`:capability.message?'请先完成策略配置':cost.label;});
  }

  async function deletePreviewVideo(shotId,taskId,button){
    const id=String(taskId||'');
    const shot=project.shots.find(item=>item.id===shotId);
    const generation=task(id);
    if(!shot||!(shot.videoVersions||[]).includes(id))return;
    if(['queued','running'].includes(generation?.status))return toast('视频生成中，完成后才能删除');
    if(!await confirmDelete({title:generation?.status==='failed'?'确认删除失败版本':'确认删除视频版本',message:generation?.status==='failed'?'失败版本删除后无法恢复。':'该视频版本、云端文件和本机副本删除后无法恢复。'}))return;
    if(generation?.status!=='failed'&&!await confirmDelete({title:'再次确认删除视频版本',message:'这是已生成的视频内容。确认永久删除，并从所有关联短剧分镜中移除吗？'}))return;
    button.disabled=true;
    try{
      const result=await api(`/api/drama/projects/${encodeURIComponent(project.id)}/shots/${encodeURIComponent(shot.id)}/videos/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});
      project=restoreLocalProjectOutputs(normalizeProjectData(result.project));
      projects=mergeDramaProjectList(projects,project);
      state.dramaProject=project;
      if(professionalPreviewTaskIds.get(shotId)===id)professionalPreviewTaskIds.delete(shotId);
      state.tasks=state.tasks.filter(item=>item.id!==id);
      const deletedAssetId = result?.deletedAssetId || generation?.assetId;
      if(deletedAssetId) {
        if (removeCloudAssets) await removeCloudAssets([deletedAssetId]);
        else state.files=state.files.filter(file=>file.id!==deletedAssetId);
      }
      // Confirm the deletion against the shared generation list as well. If a
      // polling request was already in flight, its older response must not
      // resurrect this task on the video-generation page.
      await loadTasks();
      render(true,{focus:false});
      toast('视频版本及关联文件已删除');
    }catch(error){button.disabled=false;toast(error.message);}
  }

  async function refreshProject({ quiet = false } = {}) {
    if (!project?.id) return project;
    const targetProjectId=project.id;
    const targetEpoch=projectEpoch;
    try {
      await flushSave();
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return project;
      const result=await api(`/api/drama/projects/${encodeURIComponent(targetProjectId)}`);
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return project;
      project=restoreLocalProjectOutputs(normalizeProjectData(result.project));
      projects=mergeDramaProjectList(projects,project);
      state.dramaProject=project;
      if(!quiet)render(true,{focus:false});
      return project;
    }catch(error){
      if(!quiet)toast(error.message);
      throw error;
    }
  }

  function bindWorkbenchPreviewActions(scope=root){
    scope.querySelectorAll('[data-wb-preview-file]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const file=asset(button.dataset.wbPreviewFile);if(file&&assetSyncing(file))return toast('素材正在保存到本地，请稍后再预览');openProfessionalMediaPreview(button.dataset.wbPreviewFile);}));
    scope.querySelectorAll('[data-wb-delete-preview-video]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();void deletePreviewVideo(button.dataset.wbDeletePreviewShot,button.dataset.wbDeletePreviewVideo,button);}));
    scope.querySelectorAll('[data-wb-preview-video]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();professionalPreviewShotId=button.dataset.wbPreviewShot;professionalShotId=button.dataset.wbPreviewShot;const previewTaskId=button.dataset.wbPreviewVideo;const shot=project.shots.find(item=>item.id===professionalShotId);const generation=task(previewTaskId);const selectedFile=taskAsset(previewTaskId);const canPreview=taskLocallyReady(previewTaskId);activateProfessionalShot(professionalPreviewShotId);if(!shot)return;if(canPreview&&selectedFile){professionalPreviewTaskIds.delete(shot.id);shot.selectedVideoTaskId=previewTaskId;queueProfessionalSave();patchProfessionalTaskSurfaces();openProfessionalMediaPreview(selectedFile.id);return;}
      // Failed and still-generating versions both stay clickable: the click only moves the
      // large preview onto that task so the user can watch its progress or failure reason.
      if(videoPreviewVersionState(generation,{ready:canPreview,syncing:taskSyncing(previewTaskId)})==='missing')return;
      professionalPreviewTaskIds.set(shot.id,previewTaskId);
      patchProfessionalTaskSurfaces();}));
  }

  function patchWorkbenchPreviewProgress(card, shot){
    const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
    const generation = task(previewTaskId);
    const progress = videoTaskProgress(generation);
    const progressNode = card?.querySelector('.wb-shot-preview .wb-preview-progress');
    if (!progressNode || progress === null) return;
    progressNode.querySelector('.wb-preview-progress-ring')?.style.setProperty('--progress', `${progress}%`);
    const value = progressNode.querySelector('.wb-preview-progress b');
    if (value) value.textContent = `${progress}%`;
    const stage = progressNode.querySelector('.wb-preview-progress small');
    if (stage) stage.textContent = videoProgressStageLabel(generation);
    progressNode.setAttribute('aria-label', `视频生成进度 ${progress}%`);
  }

  function patchProfessionalTaskSurfaces(){
    let completed=0;
    const taskById=new Map(state.tasks.map(item=>[item.id,item]));const fileById=new Map(state.files.map(item=>[item.id,item]));
    patchProfessionalAssetSurfaces();
    project.shots.forEach(shot=>{
    const selectedStatus=taskDisplayStatus(shot.selectedVideoTaskId);
      if(taskLocallyReady(shot.selectedVideoTaskId))completed+=1;
      const card=root.querySelector(`[data-wb-shot="${CSS.escape(shot.id)}"]`);
      if(!card)return;
      card.classList.toggle('is-generated',selectedStatus==='completed');
      card.classList.toggle('is-failed',selectedStatus==='failed');
      const generateLabel=card.querySelector('[data-wb-generate] span:last-child');
      if(generateLabel)generateLabel.textContent=selectedStatus==='completed'?'再次生成':'生成';
      const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
      const signature=shotPreviewContentSignatureFromMaps(shot,taskById,fileById,assetSyncing,previewTaskId);
      if(signature===shotPreviewSignatures.get(shot.id)){
        patchWorkbenchPreviewProgress(card, shot);
        return;
      }
      shotPreviewSignatures.set(shot.id,signature);
      const current=card.querySelector('.wb-shot-preview');
      if(!current)return;
      current.querySelectorAll('[data-wb-video-src]').forEach(video=>workbenchVideoObserver?.unobserve(video));
      const template=document.createElement('template');
      template.innerHTML=workbenchShotPreview(shot);
      const next=template.content.firstElementChild;
      current.replaceWith(next);
      bindWorkbenchPreviewActions(next);
      bindWorkbenchVideoRatios(next);
      hydrateWorkbenchVideos(next);
    });
    const assemble=root.querySelector('.wb-assemble');
    if(assemble){assemble.disabled=completed!==project.shots.length;const count=assemble.querySelector('span');if(count)count.textContent=`${completed}/${project.shots.length}`;}
  }

  function activateProfessionalShot(id){
    if(!project.shots.some(shot=>shot.id===id))return;
    professionalShotId=id;
    professionalPreviewShotId=id;
    root.querySelectorAll('[data-wb-shot]').forEach(item=>item.classList.toggle('is-active',item.dataset.wbShot===id));
  }

  function bindStoryboardWorkbench({focus=true,cardsOnly=false}={}){
    const updateShot=(id,field,value)=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return false;let target=shot;if(field==='generation.type'){if(value==='TEXT'&&shotReferenceIds(target).length){toast('当前分镜已有参考素材，不能切换为文本生成');return false;}if(value==='FIRST&LAST'&&shotReferenceIds(target).length){toast('当前分镜已有参考素材，请先移除后再使用首尾帧');return false;}const model=state.config?.videoCapabilities?.models?.find(item=>item.id===target.generation.modelId);if(!model?.modes?.some(mode=>mode.generationType===value)){toast('当前模型不支持该生成模式，请先切换模型');return false;}target.generation.type=value;target.generation.referenceAssetIds=value==='TEXT'||value==='FIRST&LAST'?[]:target.generation.referenceAssetIds;ensureProfessionalVideoSettings(target);}else if(field==='generation.modelId'){const models=professionalVideoModels(target);if(!models.some(model=>model.id===value&&professionalModelIsAvailable(model))){toast('当前模型不可用或不支持此模式');return false;}target.generation.modelId=value;ensureProfessionalVideoSettings(target);}else target[field]=field==='duration'?Number(value):value;target.action=field==='script'?value:target.action;target.visualDirection=field==='script'?value:target.visualDirection;invalidateProfessionalShot(target,'分镜参数已修改');queueProfessionalSave();return true;};
    bindWorkbenchDropdowns();
    root.querySelectorAll('[data-wb-shot]').forEach(card=>{
      const id=card.dataset.wbShot;
      const selectShot=event=>{if(event.target.closest('[data-wb-delete-shot]'))return;activateProfessionalShot(id);};
      card.addEventListener('focusin',selectShot);
      card.addEventListener('click',selectShot);
      card.querySelectorAll('[data-wb-field]').forEach(field=>{const syncTitleUi=value=>{fitWorkbenchTitle(field);if(field.dataset.wbField==='title')field.setAttribute('title',value||DEFAULT_SHOT_TITLE);root.querySelector(`[data-professional-shot="${id}"] b`)?.replaceChildren(document.createTextNode(value));const deleteButton=card.querySelector('[data-wb-delete-shot]');if(deleteButton)deleteButton.setAttribute('aria-label',`删除${value||DEFAULT_SHOT_TITLE}`);};const commitTitle=()=>{const value=field.value.trim()||DEFAULT_SHOT_TITLE;if(field.value!==value)field.value=value;const shot=project.shots.find(item=>item.id===id);if(shot?.title!==value)updateShot(id,'title',value);syncTitleUi(value);};field.addEventListener('input',()=>{const key=field.dataset.wbField;if(key==='generation.type')return;updateShot(id,key,field.value);if(key==='title')syncTitleUi(field.value);const generate=card.querySelector('[data-wb-generate]');if(generate)generate.disabled=Boolean(project.finalAssetId||professionalProductionWarning(project.shots.find(item=>item.id===id)));});if(field.dataset.wbField==='title')field.addEventListener('blur',commitTitle);});
      const richEditor=card.querySelector('[data-wb-rich-editor]');
      const syncRichEditorInput=()=>{if(!richEditor?.isConnected||richEditor.dataset.composing==='true')return;normalizeEmptyRichEditor(richEditor);updateShotScriptFromEditor(id,richEditor);if(mentionTriggerAtCaret(richEditor))openMentionPicker(id,richEditor);};
      richEditor?.addEventListener('compositionstart',()=>{richEditor.dataset.composing='true';});
      richEditor?.addEventListener('compositionend',()=>{richEditor.dataset.composing='false';requestAnimationFrame(syncRichEditorInput);});
      richEditor?.addEventListener('input',event=>{if(event.isComposing||event.inputType==='insertCompositionText'||richEditor.dataset.composing==='true')return;syncRichEditorInput();});
      richEditor?.addEventListener('keydown',event=>{if(removeMentionAtCaret(id,richEditor,event))return;if(event.key==='Escape')closeMentionPicker();if(event.key==='ArrowDown'&&document.querySelector('#wbMentionPicker')){event.preventDefault();document.querySelector('#wbMentionPicker [data-mention-option]')?.focus();}});
      bindMentionChipInteractions(richEditor);
      card.querySelectorAll('[data-wb-field="generation.modelId"]').forEach(field=>field.addEventListener('change',event=>{updateShot(id,'generation.modelId',event.target.value);render(true,{focus:false});}));
      card.querySelector('[data-wb-field="generation.type"]')?.addEventListener('change',event=>{if(!updateShot(id,'generation.type',event.target.value))return;render(true,{focus:false});});
      card.querySelector('[data-wb-spec]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.aspectRatio=event.target.value;invalidateProfessionalShot(shot,'画幅已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);scheduleProfessionalVideoQuote(shot);});
      card.querySelector('[data-wb-quality]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.generation.quality=event.target.value;invalidateProfessionalShot(shot,'清晰度已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);scheduleProfessionalVideoQuote(shot);});
      card.querySelector('[data-wb-duration]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.duration=Number(event.target.value);invalidateProfessionalShot(shot,'时长已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);scheduleProfessionalVideoQuote(shot);});
      card.querySelector('[data-wb-count]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.generation.count=Math.max(1,Math.min(4,Number(event.target.value)||1));invalidateProfessionalShot(shot,'生成数量已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);});
      card.querySelectorAll('[data-wb-add-reference],[data-wb-shot-assets]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();professionalShotId=id;professionalPreviewShotId=id;openProjectAssetDialog('other',id);}));
      card.querySelector('[data-wb-delete-shot]')?.addEventListener('click',async event=>{event.stopPropagation();await deleteShot(id);});
      card.querySelectorAll('[data-wb-remove-reference]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();removeWorkbenchReference(id,button.dataset.wbRemoveReference);}));
      card.querySelector('[data-wb-generate]')?.addEventListener('click',async event=>{event.stopPropagation();professionalShotId=id;professionalPreviewShotId=id;await generateProfessionalVideo();});
    });
    bindWorkbenchPreviewActions();
    bindWorkbenchVideoRatios();
    hydrateWorkbenchVideos();
    if(cardsOnly){
      if(focus)root.querySelector('.wb-shot-card:not(.is-locked) .wb-rich-input[contenteditable="true"]')?.focus();
      return;
    }
    root.querySelector('.wb-add-asset')?.addEventListener('click',()=>openProjectAssetDialog('other'));
    root.querySelectorAll('[data-project-asset-add]').forEach(button=>button.addEventListener('click',()=>openProjectAssetDialog(button.dataset.projectAssetAdd)));
    root.querySelectorAll('[data-project-asset]').forEach(tile=>{const activate=()=>{if(tile.disabled||tile.getAttribute('aria-disabled')==='true')return;projectAssetCategory=tile.dataset.projectAssetKind||'other';applyProjectAssetToShot(tile.dataset.projectAsset,professionalShotId);};tile.addEventListener('click',event=>{if(event.target.closest?.('[data-project-asset-remove]'))return;activate();});tile.addEventListener('keydown',event=>{if(event.target.closest?.('[data-project-asset-remove]'))return;if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();activate();});});
    root.querySelectorAll('[data-project-asset-remove]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();await removeProjectAsset(button.dataset.projectAssetRemove);}));
    root.querySelector('.wb-add-shot')?.addEventListener('click',addProfessionalShot);
    root.querySelector('.wb-assemble')?.addEventListener('click',assembleProfessionalProject);
    root.querySelector('.wb-shot-scroll')?.addEventListener('scroll',()=>{closeWorkbenchDropdowns();closeMentionPicker();scheduleVirtualShotWindow();},{passive:true});
    if(!mentionDismissBound||!workbenchDropdownDismissBound){document.addEventListener('pointerdown',event=>{if(!event.target.closest('#wbMentionPicker,.wb-rich-input'))closeMentionPicker();if(!event.target.closest('#wbDropdownPortal,.wb-dropdown,.wb-spec-control'))closeWorkbenchDropdowns();scheduleFlushDeferredProfessionalRender();});document.addEventListener('focusout',event=>{if(root.contains(event.target))scheduleFlushDeferredProfessionalRender();});window.addEventListener('resize',()=>{closeWorkbenchDropdowns();closeMentionPicker();scheduleVirtualShotWindow();},{passive:true});mentionDismissBound=true;workbenchDropdownDismissBound=true;}
  }

  function applyProjectAssetToShot(assetId,shotId){
    const shot=project.shots.find(item=>item.id===shotId);const file=asset(assetId);if(!shot||!file||assetSyncing(file)||project.finalAssetId)return;
    projectAssetIds=[...new Set([...projectAssetIds,assetId])];project.projectAssetIds=[...projectAssetIds];projectAssetCategories.set(assetId,projectAssetCategory);project.projectAssetCategories=Object.fromEntries(projectAssetCategories);
    if(file.kind==='image'&&projectAssetCategory==='characters'){shot.professionalAssets.characters=[...new Set([...(shot.professionalAssets.characters||[]),assetId])];}
    else if(file.kind==='image'&&projectAssetCategory==='locations'){shot.professionalAssets.locations=[...new Set([...(shot.professionalAssets.locations||[]),assetId])];}
    addReferenceAssetToShot(shot,assetId);ensureProfessionalVideoSettings(shot);
    invalidateProfessionalShot(shot,'项目资产已加入本镜');queueProfessionalSave();queueSave('projectAssetIds','projectAssetCategories');professionalPreviewShotId=shot.id;render(true,{focus:false});
  }

  function addReferenceAssetToShot(shot,assetId){if(!shot||!asset(assetId))return;shot.referenceAssetIds=[...new Set([...(shot.referenceAssetIds||[]),assetId])];shot.generation.referenceAssetIds=[...new Set([...(shot.generation.referenceAssetIds||[]),assetId])];if(shot.generation.type==='TEXT')shot.generation.type='REFERENCE';syncProfessionalReferences(shot);}

  async function removeProjectAsset(assetId){
    const id=String(assetId||'');
    const file=asset(id);
    if(!file||project?.finalAssetId)return;
    const referencedShots=project.shots.filter(shot=>shotReferenceIds(shot).includes(id)||[shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId,shot.tailFrameAssetId].some(value=>String(value||'')===id)).length;
    const message=referencedShots?`将从当前项目移除「${file.name}」，并解除 ${referencedShots} 个分镜中的引用。文件库中的原始素材不会被删除。`:'仅从当前项目移除该资产，文件库中的原始素材不会被删除。';
    if(!await confirmDelete({title:'确认移除项目资产',message}))return;
    const previousIds=[...projectAssetIds];
    const previousCategories=new Map(projectAssetCategories);
    const previousResources=project.resources;
    const previousShots=project.shots;
    const withoutAsset=values=>(Array.isArray(values)?values:[]).filter(value=>String(value)!==id);
    const nextResources=project.resources.map(resource=>taskAsset(resource.selectedTaskId)?.id===id?{...resource,selectedTaskId:'',lifecycle:{...resource.lifecycle,status:'draft',approvedAt:''}}:resource);
    const nextShots=project.shots.map(shot=>{
      const professionalAssets={...(shot.professionalAssets||{}),characters:withoutAsset(shot.professionalAssets?.characters),locations:withoutAsset(shot.professionalAssets?.locations)};
      const generation={...(shot.generation||{}),referenceAssetIds:withoutAsset(shot.generation?.referenceAssetIds),firstFrameAssetId:String(shot.generation?.firstFrameAssetId||'')===id?'':String(shot.generation?.firstFrameAssetId||''),lastFrameAssetId:String(shot.generation?.lastFrameAssetId||'')===id?'':String(shot.generation?.lastFrameAssetId||'')};
      const referenceAssetIds=withoutAsset(shot.referenceAssetIds);
      const removedMentionLabels=(Array.isArray(shot.assetMentions)?shot.assetMentions:[]).filter(item=>String(item?.id||'')===id).map(item=>String(item?.label||'').replace(/^@/,'').trim()).filter(Boolean);
      const script=removedMentionLabels.reduce((value,label)=>value.split(`@${label}`).join(''),String(shot.script||''));
      const assetMentions=(Array.isArray(shot.assetMentions)?shot.assetMentions:[]).filter(item=>String(item?.id||'')!==id);
      const changed=professionalAssets.characters.length!==(shot.professionalAssets?.characters||[]).length||professionalAssets.locations.length!==(shot.professionalAssets?.locations||[]).length||generation.referenceAssetIds.length!==(shot.generation?.referenceAssetIds||[]).length||generation.firstFrameAssetId!==String(shot.generation?.firstFrameAssetId||'')||generation.lastFrameAssetId!==String(shot.generation?.lastFrameAssetId||'')||referenceAssetIds.length!==(shot.referenceAssetIds||[]).length||assetMentions.length!==(shot.assetMentions||[]).length||script!==String(shot.script||'')||String(shot.tailFrameAssetId||'')===id;
      return changed?{...shot,script,action:script,visualDirection:script,professionalAssets,generation,referenceAssetIds,assetMentions,tailFrameAssetId:String(shot.tailFrameAssetId||'')===id?'':shot.tailFrameAssetId,lifecycle:{...shot.lifecycle,status:'draft',revision:(shot.lifecycle?.revision||1)+1,staleReasons:[...new Set([...(shot.lifecycle?.staleReasons||[]),'项目资产已移除'])]}}:shot;
    });
    projectAssetIds=projectAssetIds.filter(value=>String(value)!==id);
    projectAssetCategories.delete(id);
    project.projectAssetIds=[...projectAssetIds];
    project.projectAssetCategories=Object.fromEntries(projectAssetCategories);
    project.resources=nextResources;
    project.shots=nextShots;
    try{
      await patch({projectAssetIds:project.projectAssetIds,projectAssetCategories:project.projectAssetCategories,resources:project.resources,shots:project.shots},{quiet:true});
      render(true,{focus:false});
      toast('已从项目移除资产');
    }catch(error){
      projectAssetIds=previousIds;
      projectAssetCategories=previousCategories;
      project.projectAssetIds=previousIds;
      project.projectAssetCategories=Object.fromEntries(previousCategories);
      project.resources=previousResources;
      project.shots=previousShots;
      render(true,{focus:false});
    }
  }
  function resetProjectAssetDialogLifecycle(){
    clearTimeout(projectAssetSearchTimer);
    projectAssetSearchTimer=0;
    resetProjectAssetMediaObserver();
    projectAssetTargetShotId='';
  }
  function closeProjectAssetDialog(){
    const dialog=document.querySelector('dialog#projectAssetDialog');
    if(dialog?.open)dialog.close();
    else resetProjectAssetDialogLifecycle();
    scheduleFlushDeferredProfessionalRender();
  }
  function ensureProjectAssetDialog(){
    const dialogs=[...document.querySelectorAll('dialog#projectAssetDialog')];
    let dialog=dialogs.find(item=>item.open)||dialogs[0];
    dialogs.filter(item=>item!==dialog).forEach(item=>item.remove());
    if(!dialog){dialog=document.createElement('dialog');dialog.id='projectAssetDialog';document.body.append(dialog);}
    dialog.classList.add('project-asset-dialog');
    dialog.setAttribute('aria-labelledby','projectAssetDialogTitle');
    if(dialog.dataset.projectAssetLifecycleBound!=='true'){
      dialog.dataset.projectAssetLifecycleBound='true';
      dialog.addEventListener('close',()=>{resetProjectAssetDialogLifecycle();scheduleFlushDeferredProfessionalRender();});
    }
    return dialog;
  }
  function openProjectAssetDialog(category='other',shotId=''){
    clearTimeout(projectAssetSearchTimer);projectAssetSearchTimer=0;projectAssetCategory=category;projectAssetTargetShotId=shotId;projectAssetSelection=[];projectAssetQuery='';projectAssetKindFilter='all';const dialog=ensureProjectAssetDialog();paintProjectAssetDialog();if(!dialog.open)dialog.showModal();
  }
  function paintProjectAssetDialog({restoreSearchFocus=false}={}){
    const dialog=document.querySelector('#projectAssetDialog');if(!dialog)return;
    const query=projectAssetQuery.trim().toLocaleLowerCase('zh-CN');
    const assetKinds=['image','video','audio'];
    const kindLabels={all:'全部',image:'图片',video:'视频',audio:'音频'};
    const availableFiles=state.files.filter(file=>assetKinds.includes(file.kind)&&!assetSyncing(file));
    const kindCounts=availableFiles.reduce((counts,file)=>{counts[file.kind]=(counts[file.kind]||0)+1;return counts;},{image:0,video:0,audio:0});
    const files=availableFiles.filter(file=>(projectAssetKindFilter==='all'||file.kind===projectAssetKindFilter)&&(!query||String(file.name).toLocaleLowerCase('zh-CN').includes(query)));
    const chosen=new Set(projectAssetSelection);
    const categoryLabel={characters:'人物',locations:'场景',props:'物品',other:'其他'}[projectAssetCategory]||'其他';
    const totalCount=assetKinds.reduce((sum,kind)=>sum+kindCounts[kind],0);
    const iconUpload='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>';
    const iconClose='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    const iconSearch='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
    resetProjectAssetMediaObserver();
    dialog.innerHTML=`<div class="dialog-head"><div><h2 id="projectAssetDialogTitle">添加${categoryLabel}资产</h2><p>上传本地素材，或从文件库选择图片、视频、音频。</p></div><button type="button" class="project-asset-close" data-project-asset-close aria-label="关闭">${iconClose}</button></div><div class="project-asset-dialog-toolbar"><label class="project-asset-search">${iconSearch}<input id="projectAssetSearch" type="search" value="${esc(projectAssetQuery)}" placeholder="搜索文件名" aria-label="搜索文件名"></label><button type="button" class="secondary-button project-asset-upload" data-project-asset-upload>${iconUpload}<span>上传素材</span></button><div class="project-asset-kind-filter" role="tablist" aria-label="按素材类型筛选">${[['all','全部'],...assetKinds.map(kind=>[kind,kindLabels[kind]])].map(([kind,label])=>`<button type="button" role="tab" class="${projectAssetKindFilter===kind?'active':''}" data-project-asset-kind-filter="${kind}" aria-selected="${projectAssetKindFilter===kind}"><span>${label}</span><small>${kind==='all'?totalCount:kindCounts[kind]}</small></button>`).join('')}</div></div><div class="project-asset-dialog-grid">${files.map(file=>`<button type="button" class="${chosen.has(file.id)?'selected':''}" data-project-asset-option="${esc(file.id)}" aria-pressed="${chosen.has(file.id)}" aria-label="${esc(file.name)}">${projectAssetMedia(file,{lazy:true})}<span>${esc(file.name)}</span><i aria-hidden="true">✓</i></button>`).join('')||`<p>${query||projectAssetKindFilter!=='all'?'没有匹配的素材。':'文件库中还没有可用素材。'}</p>`}</div><footer><button type="button" class="secondary-button" data-project-asset-close>取消</button><button type="button" class="gradient-button" data-project-asset-confirm ${chosen.size?'':'disabled'}>加入项目</button></footer>`;
    hydrateProjectAssetMedia(dialog);
    dialog.querySelectorAll('[data-project-asset-kind-filter]').forEach(button=>button.onclick=()=>{projectAssetKindFilter=button.dataset.projectAssetKindFilter;paintProjectAssetDialog();});
    dialog.querySelectorAll('[data-project-asset-close]').forEach(button=>button.onclick=closeProjectAssetDialog);
    dialog.querySelector('#projectAssetSearch')?.addEventListener('input',event=>{projectAssetQuery=event.target.value;clearTimeout(projectAssetSearchTimer);projectAssetSearchTimer=window.setTimeout(()=>{projectAssetSearchTimer=0;if(dialog.open)paintProjectAssetDialog({restoreSearchFocus:true});},120);});
    dialog.querySelectorAll('[data-project-asset-option]').forEach(button=>button.onclick=()=>{const id=button.dataset.projectAssetOption;const selected=projectAssetSelection.includes(id);projectAssetSelection=selected?projectAssetSelection.filter(value=>value!==id):[...projectAssetSelection,id];button.classList.toggle('selected',!selected);button.setAttribute('aria-pressed',String(!selected));const confirm=dialog.querySelector('[data-project-asset-confirm]');if(confirm)confirm.disabled=projectAssetSelection.length===0;});
    dialog.querySelector('[data-project-asset-upload]')?.addEventListener('click',async()=>{try{const file=uploadAsset?await uploadAsset({context:'professional-project'}):await uploadImage?.({context:'professional-project'});if(file){projectAssetSelection=[...new Set([...projectAssetSelection,file.id])];projectAssetCategories.set(file.id,projectAssetCategory);state.files=[file,...state.files.filter(item=>item.id!==file.id)];paintProjectAssetDialog();}}catch(error){toast(error.message);}});
    dialog.querySelector('[data-project-asset-confirm]')?.addEventListener('click',()=>{const selected=[...projectAssetSelection];const targetShot=projectAssetTargetShotId?project.shots.find(item=>item.id===projectAssetTargetShotId):null;selected.forEach(id=>projectAssetCategories.set(id,projectAssetCategory));projectAssetIds=[...new Set([...projectAssetIds,...selected])];project.projectAssetIds=[...projectAssetIds];project.projectAssetCategories=Object.fromEntries(projectAssetCategories);if(targetShot){selected.forEach(id=>addReferenceAssetToShot(targetShot,id));ensureProfessionalVideoSettings(targetShot);invalidateProfessionalShot(targetShot,'参考素材已加入本镜');queueProfessionalSave();professionalPreviewShotId=targetShot.id;}projectAssetTargetShotId='';queueSave('projectAssetIds','projectAssetCategories');closeProjectAssetDialog();render(true,{focus:false});toast(targetShot?`已添加 ${selected.length} 个分镜参考`:`已添加 ${selected.length} 个项目资产`);});
    if(restoreSearchFocus)requestAnimationFrame(()=>{if(!dialog.open)return;const search=dialog.querySelector('#projectAssetSearch');search?.focus({preventScroll:true});search?.setSelectionRange(projectAssetQuery.length,projectAssetQuery.length);});
  }

  function professionalPendingCards(shot,{kind='',frameField=''}={}){
    const persisted=(shot.pendingImageGenerations||[]).filter(item=>kind?item.targetType==='category'&&item.kind===kind:item.targetType==='frame'&&item.frameField===frameField);
    const transient=professionalPendingImageGenerations.filter(item=>item.shotId===shot.id&&(kind?item.targetType==='category'&&item.kind===kind:item.targetType==='frame'&&item.frameField===frameField));
    return [...transient,...persisted].map(item=>{const generation=item.taskId?task(item.taskId):null;const failed=generation?.status==='failed';const missing=Boolean(item.taskId&&!generation);const syncing=Boolean(item.taskId&&taskSyncing(item.taskId));const unavailable=Boolean(generation?.status==='completed'&&!generation.assetId);const terminal=failed||missing||unavailable;const status=failed?generationFailureMarkup(generation):missing?'任务记录不可用':unavailable?'生成结果不可用':syncing?'图片保存中':generation?.status==='running'?'图像生成中':generation?.status==='queued'?'图像排队中':'正在提交';const visual=terminal?`<span class="professional-pending-failure" aria-hidden="true">${generationFailureIcon}</span>`:'<span class="loader-ring"></span>';return `<article class="professional-pending-image ${failed?'failed':''} ${missing||unavailable?'missing':''}"><div class="professional-pending-visual">${visual}</div><div><b>${esc(item.label||'图片')}</b><span>${status}</span></div>${terminal?`<button type="button" data-professional-dismiss-pending="${item.id}" data-professional-pending-shot="${shot.id}" aria-label="关闭${failed?'失败':missing?'缺失':'不可用'}任务">×</button>`:''}</article>`;}).join('');
  }

  function professionalShotEditor(shot){
    const filesById=id=>state.files.find(file=>file.id===id);
    const mode=shot.generation.type;
    const modeSelector=`<section class="professional-editor-mode"><header><b>视频生成模式</b><span>不同模式使用不同的画面输入</span></header><div class="professional-mode-grid">${[['TEXT','文生视频','只使用分镜脚本'],['REFERENCE','参考图','添加角色与场景'],['FIRST&LAST','首尾帧','上传首帧与尾帧']].map(([value,label,note])=>`<button type="button" data-professional-mode="${value}" class="${mode===value?'active':''}" aria-pressed="${mode===value}"><b>${label}</b><small>${note}</small></button>`).join('')}</div></section>`;
    const category=(key,label)=>{const ids=shot.professionalAssets?.[key]||[];const cards=ids.map((id,index)=>{const file=filesById(id);return file?`<figure draggable="true" data-professional-drag-asset="${id}" data-professional-drag-kind="${key}" data-professional-drag-index="${index}"><button type="button" class="professional-asset-preview" data-professional-preview-file="${id}" aria-label="放大查看${esc(file.name)}"><img src="${file.url}" alt="${esc(file.name)}"><span>放大查看</span></button><figcaption><i aria-hidden="true">⠿</i>${esc(file.name)}</figcaption><button type="button" class="professional-asset-remove" data-professional-remove-asset="${id}" data-professional-asset-kind="${key}" aria-label="移除${label}">×</button></figure>`:'';}).join('');const pending=professionalPendingCards(shot,{kind:key});return `<section class="professional-asset-section"><header><div><span>${label}</span><b>${ids.length} 张 · 可拖动排序</b></div><button type="button" class="secondary-button" data-professional-assets="${key}">＋ 添加${label}</button></header><div class="professional-asset-strip">${cards}${pending}${!cards&&!pending?`<button type="button" class="professional-asset-empty" data-professional-assets="${key}">从本地、文件库或图像生成添加${label}</button>`:''}</div></section>`;};
    const frame=(key,label,optional=false)=>{const id=shot.generation[key];const file=filesById(id);const pending=professionalPendingCards(shot,{frameField:key});return `<section class="professional-frame-slot ${file?'has-image':''}"><header><div><b>${label}</b>${optional?'<span>可选</span>':'<span>必选</span>'}</div>${file?`<button type="button" class="text-button" data-professional-clear-frame="${key}">删除</button>`:''}</header>${file?`<div class="professional-frame-media"><button type="button" data-professional-preview-file="${id}" aria-label="放大查看${esc(file.name)}"><img src="${file.url}" alt="${esc(file.name)}"><span>放大查看</span></button><button type="button" class="text-button" data-professional-frame="${key}">更换图片</button></div>`:`<button type="button" class="professional-frame-picker" data-professional-frame="${key}"><i>＋</i><b>添加${label}图</b><span>${optional?'不设置时仅锁定首帧':'本地上传、文件库或图像生成'}</span></button>`}${pending}</section>`;};
    const modeInputs=mode==='REFERENCE'?`<div class="professional-assets-block"><h3>参考画面</h3><p>角色与场景图片会按下方顺序作为本镜视频的视觉参考，合计最多使用 7 张。</p>${category('characters','角色')}${category('locations','场景')}</div>`:mode==='FIRST&LAST'?`<div class="professional-assets-block professional-frame-assets"><h3>首尾帧图片</h3><p>首帧必选、尾帧可选；实际时长以当前视频模型的支持范围为准。</p><div class="professional-frame-grid">${frame('firstFrameAssetId','首帧')}${frame('lastFrameAssetId','尾帧',true)}</div></div>`:'<div class="professional-text-mode-note"><b>文生视频</b><p>当前模式只根据下面的分镜内容生成，不上传角色、场景或帧图片。</p></div>';
    return `<div class="professional-script-block"><label for="professionalShotTitle">分镜名称</label><input id="professionalShotTitle" data-professional-field="title" value="${esc(shot.title)}" maxlength="120">${modeSelector}<label for="professionalShotScript">分镜内容 / 脚本语言</label><textarea id="professionalShotScript" data-professional-field="script" maxlength="120000" placeholder="输入动作、台词、镜头语言和画面细节……">${esc(shot.script)}</textarea><small class="professional-field-help">你写下的内容会直接作为本镜视频提示词基础，系统不会自动改写。</small></div>${modeInputs}`;
  }

  function professionalDurationWarning(shot){
    const parameters=professionalVideoParameters(shot);
    const duration=Number(shot?.duration);
    if(!parameters||!Number.isFinite(duration)||parameters.durations.includes(duration))return '';
    return `当前视频模型不支持 ${duration} 秒，请选择 ${parameters.durations.join('、')} 秒后再生成。`;
  }
  function professionalCapabilityState(shot){
    if(!shot?.generation)return {ok:false,message:'当前分镜生成参数不完整。'};
    if(!String(shot.script||'').trim())return {ok:false,message:'请先填写分镜内容。'};
    const configuredModel=state.config?.videoCapabilities?.models?.find(model=>model.id===shot.generation.modelId);
    if(!configuredModel)return {ok:false,message:'请选择可用的视频模型。'};
    if(!professionalModelIsAvailable(configuredModel))return {ok:false,message:`${configuredModel.label||'当前模型'}暂不可用。`};
    const parameters=professionalVideoParameters(shot);
    if(!parameters)return {ok:false,message:`${configuredModel.label||'当前模型'}不支持${generationModeName(shot.generation.type)}模式。`};
    if(!parameters.aspectRatios.includes(shot.aspectRatio))return {ok:false,message:`${configuredModel.label}不支持 ${shot.aspectRatio} 画幅，请切换为 ${parameters.aspectRatios.join('、')}。`};
    if(!parameters.qualityOptions.includes(shot.generation.quality))return {ok:false,message:`${configuredModel.label}不支持 ${shot.generation.quality} 清晰度，请选择 ${parameters.qualityOptions.join('、')}。`};
    if(!parameters.durations.includes(Number(shot.duration)))return {ok:false,message:`${configuredModel.label}不支持 ${shot.duration} 秒，请选择 ${parameters.durations.join('、')} 秒。`};
    const allReferenceIds=shotReferenceIds(shot);
    const availableReferenceIds=availableShotReferenceIds(shot);
    if(allReferenceIds.length!==availableReferenceIds.length)return {ok:false,message:'有参考素材已失效，请重新选择或移除后再生成。'};
    if(shot.generation.type==='TEXT'&&allReferenceIds.length)return {ok:false,message:'文本生成模式不能添加参考素材，请切换为全能参考或移除素材。'};
    if(shot.generation.type==='FIRST&LAST'){
      if(allReferenceIds.length)return {ok:false,message:'首尾帧模式不能同时使用普通参考素材，请先移除角色、场景或 @ 引用。'};
      const frames=[shot.generation.firstFrameAssetId,shot.generation.lastFrameAssetId].filter(Boolean);
      if(!frames.length)return {ok:false,message:'首尾帧模式至少需要选择一张首帧图片。'};
      if(frames.some(id=>asset(id)?.kind!=='image'))return {ok:false,message:'首尾帧只能使用图片素材。'};
      if(frames.length>professionalMaxImages(shot))return {ok:false,message:`当前模型最多支持 ${professionalMaxImages(shot)} 张首尾帧图片。`};
      return {ok:true,message:'',parameters,model:configuredModel};
    }
    if(shot.generation.type==='REFERENCE'){
      const max=professionalMaxImages(shot);
      if(!availableReferenceIds.length)return {ok:false,message:'全能参考模式至少需要添加 1 个参考素材。'};
      if(availableReferenceIds.length>max)return {ok:false,message:`当前模型最多支持 ${max} 个参考素材，已添加 ${availableReferenceIds.length} 个。请移除多余素材或切换模型。`};
      const limits=professionalReferenceLimit(shot);
      const counts={image:0,video:0,audio:0};
      availableReferenceIds.forEach(id=>{const kind=asset(id)?.kind;if(Object.hasOwn(counts,kind))counts[kind]++;});
      for(const kind of Object.keys(counts))if(counts[kind]>Number(limits[kind]||0))return {ok:false,message:`当前模型最多支持 ${limits[kind]||0} 个${kind==='image'?'图片':kind==='video'?'视频':'音频'}参考，当前为 ${counts[kind]} 个。`};
    }
    return {ok:true,message:'',parameters,model:configuredModel};
  }
  function professionalProductionWarning(shot){
    // Resolve the same defaults used by the controls before checking readiness.
    // This keeps the first render's visible values and the submit payload aligned.
    ensureProfessionalVideoSettings(shot);
    return professionalCapabilityState(shot).message;
  }
  function refreshProfessionalProductionValidation(shot){
    if(!shot)return;
    const settings=root.querySelector('.professional-video-settings');
    const warningText=professionalProductionWarning(shot);
    let warning=settings?.querySelector('.professional-mode-warning');
    if(warningText){
      if(!warning){warning=document.createElement('p');warning.className='professional-mode-warning';settings?.append(warning);}
      if(warning)warning.textContent=warningText;
    }else warning?.remove();
    const button=root.querySelector('[data-professional-generate]');
    if(button){const cost=professionalVideoCostState(shot);button.disabled=Boolean(warningText)||!shotGenerationReady(shot)||!cost.ready;button.title=warningText||cost.message||'';}
  }
  const ratioCss = value => { const [width,height]=String(value||'').split(':').map(Number); return width>0&&height>0?`${width} / ${height}`:'9 / 16'; };
  const ratioIconStyle = value => { const [width,height]=String(value||'').split(':').map(Number); const safeWidth=width>0?width:9; const safeHeight=height>0?height:16; const scale=Math.min(24/safeWidth,16/safeHeight); return `--ratio:${safeWidth} / ${safeHeight};width:${(safeWidth*scale).toFixed(2)}px;height:${(safeHeight*scale).toFixed(2)}px`; };
  function bindProfessionalVideoRatios(){
    root.querySelectorAll('.professional-video-preview video,.professional-version-preview video').forEach(video=>{
      const host=video.closest('.professional-video-preview,.professional-version-preview');
      const sync=()=>{if(host&&video.videoWidth&&video.videoHeight)host.style.setProperty('--video-ratio',`${video.videoWidth} / ${video.videoHeight}`);};
      if(video.readyState>=1)sync();else video.addEventListener('loadedmetadata',sync,{once:true});
    });
  }
  function bindWorkbenchVideoRatios(scope=root){
    scope.querySelectorAll('.wb-preview-stage video').forEach(video=>{
      const stage=video.closest('.wb-preview-stage');
      const sync=()=>{if(stage&&video.videoWidth&&video.videoHeight)stage.style.setProperty('--video-ratio',`${video.videoWidth} / ${video.videoHeight}`);};
      if(video.readyState>=1)sync();else video.addEventListener('loadedmetadata',sync,{once:true});
    });
  }
  const professionalModelIconUrls=Object.freeze({grok:'/favicon.svg?v=2','minimax-h3-15s':'/favicon.svg?v=2',veo:'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg',oai:'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg','veo-31':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/gemini-color.svg','minimax-h3':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/minimax-color.svg','seedance-2.0':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg','seedance-2.5':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg','seedance-2.0-fast':'https://unpkg.com/@lobehub/icons-static-svg@1.94.0/icons/bytedance-color.svg'});
  const professionalModelIsAvailable=model=>model?.enabled!==false&&model?.availability!=='coming-soon';
  function professionalModelIcon(modelId){const src=professionalModelIconUrls[modelId];return src?`<img class="select-model-icon" src="${src}" alt="" aria-hidden="true">`:'<span class="select-clock" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3.5 2"></path></svg></span>';}
  function professionalSelectIcon(kind,value){
    if(kind==='model')return professionalModelIcon(value);
    if(kind==='ratio'){
      const [width,height]=String(value).split(':').map(Number); const scale=Math.min(23/Math.max(width,1),20/Math.max(height,1));
      return `<span class="select-ratio-icon" aria-hidden="true"><i style="width:${Math.round(width*scale)}px;height:${Math.round(height*scale)}px"></i></span>`;
    }
    return '<span class="select-clock" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3.5 2"></path></svg></span>';
  }
  function professionalSelectMarkup(key,kind,options,selected,{disabled=false}={}){
    const current=String(selected??'');
    const choices=options.map(option=>{
      const choice=typeof option==='object'?{...option,value:String(option.value),label:String(option.label)}:{value:String(option),label:kind==='duration'?`${option} 秒`:String(option)};
      return {...choice,disabled:Boolean(choice.disabled)||(kind==='model'&&(choice.enabled===false||choice.availability==='coming-soon'))};
    });
    if(current&&!choices.some(option=>option.value===current))choices.unshift({value:current,label:kind==='duration'?`${current} 秒（当前模型不支持）`:`${current}（当前模型不支持）`,disabled:true});
    const chosen=choices.find(option=>option.value===current)||choices.find(option=>!option.disabled)||choices[0]; const selectedValue=chosen?.value||'';
    const label=kind==='model'?'视频模型':kind==='ratio'?'画幅':kind==='quality'?'分辨率':'时长';
    return `<div class="product-select professional-video-select ${disabled?'is-disabled':''}" data-for="professional-${key}" data-dynamic-options="true" data-professional-select="${key}"><button class="product-select-trigger" data-professional-select-trigger type="button" aria-label="选择${label}" aria-haspopup="listbox" aria-expanded="false" ${disabled?'disabled':''}>${chosen?professionalSelectIcon(kind,chosen.value):''}<span><b>${chosen?esc(chosen.label):'暂无可用选项'}</b>${kind==='model'&&chosen?.description?`<small class="select-model-description">${esc(chosen.description)}</small>`:''}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5-5 5"></path></svg></button><div class="product-select-menu hidden" role="listbox" aria-label="${label}">${choices.map(option=>`<button type="button" role="option" aria-selected="${option.value===selectedValue}" data-professional-select-option="${key}" data-value="${esc(option.value)}" ${option.disabled?'disabled':''} ${option.availability?`data-availability="${esc(option.availability)}"`:''}>${professionalSelectIcon(kind,option.value)}<span class="${kind==='model'?'select-option-label':''}"><b>${esc(option.label)}</b>${kind==='model'&&option.description?`<small class="select-model-description">${esc(option.description)}</small>`:''}${option.availability==='coming-soon'?'<small>即将上线</small>':''}</span><i>✓</i></button>`).join('')}</div></div>`;
  }
  function closeProfessionalVideoSelects(except=null){root.querySelectorAll('.professional-video-select').forEach(select=>{if(select===except)return;select.querySelector('.product-select-menu')?.classList.add('hidden');select.querySelector('.product-select-trigger')?.setAttribute('aria-expanded','false');});}
  document.addEventListener('click',event=>{if(!event.target.closest('.professional-video-select'))closeProfessionalVideoSelects();});
  function professionalProductionPanel(shot,selected,selectedFile,versions,canAssemble,completed){
    if(!shot)return '<div class="professional-empty">选择或新建一个分镜后，这里会显示视频预览。</div>';
    const visibleVersions=versions.filter(item=>item.task?.status!=='failed');
    const {models,parameters,modelId}=ensureProfessionalVideoSettings(shot);
    const warning=professionalProductionWarning(shot);
    const cost=professionalVideoCostState(shot);
    const ready=Boolean(String(shot.script||'').trim())&&Boolean(modelId)&&shotGenerationReady(shot)&&!professionalDurationWarning(shot)&&cost.ready;
    const supportedRatios=parameters?.aspectRatios||ratios;
    const supportedDurations=parameters?.durations?.filter(value=>Number(value)!==30)||durations;
    const supportedQualities=parameters?.qualityOptions||['720p'];
    const modelSelect=professionalSelectMarkup('modelId','model',models.map(model=>({...model,value:model.id,label:model.label,disabled:!professionalModelIsAvailable(model)})),modelId,{disabled:!models.some(professionalModelIsAvailable)});
    const ratioSelect=professionalSelectMarkup('aspectRatio','ratio',supportedRatios,shot.aspectRatio);
    const qualitySelect=professionalSelectMarkup('quality','quality',supportedQualities,shot.generation.quality);
    const durationSelect=`${professionalSelectMarkup('duration','duration',supportedDurations,shot.duration)}</label><label>分辨率${qualitySelect}`;
    const fallbackRatio=ratioCss(selected?.aspectRatio||shot.aspectRatio);
    const versionButtons=visibleVersions.map(item=>{const versionRatio=ratioCss(item.task?.aspectRatio||shot.aspectRatio);return `<article class="professional-version ${item.id===shot.selectedVideoTaskId?'selected':''}">${item.file?`<button type="button" class="professional-version-preview" style="--video-ratio:${versionRatio}" data-professional-preview-file="${item.file.id}" aria-label="放大播放此版本">${workbenchVideoMarkup(item.file)}<span>放大播放</span></button>`:`<div class="professional-version-status" style="--video-ratio:${versionRatio}">${item.task?.status==='failed'?generationFailureMarkup(item.task):item.task?.status==='running'?'生成中…':'排队中…'}</div>`}<button type="button" class="professional-version-select" data-professional-select-video="${item.id}" ${item.task?.status==='completed'?'':'disabled'}>${item.id===shot.selectedVideoTaskId?'当前版本':item.task?.status==='completed'?'选择此版':'等待完成'}</button></article>`;}).join('');
    const finalFile=project.finalAssetId?asset(project.finalAssetId):null;
    return `<header class="professional-panel-head"><div><span>VIDEO PREVIEW</span><h2>生成与预览</h2></div><span class="professional-cost">${cost.ready?`本次消耗 ${cost.label} 积分`:`本次消耗 ${cost.label}`}</span></header><div class="professional-production-scroll"><div class="professional-video-settings"><label class="professional-model-field">视频模型${modelSelect}</label><label>画幅${ratioSelect}</label><label>时长${durationSelect}</label>${warning?`<p class="professional-mode-warning">${warning}</p>`:''}</div><div class="professional-production-actions"><button type="button" class="gradient-button" data-professional-generate ${ready?'':'disabled'} title="${esc(warning||cost.message||'')}">${selectedFile?'再次生成':'生成分镜视频'} <span>→</span></button>${selectedFile?`<button type="button" class="secondary-button" data-professional-tail>提取尾帧</button>`:''}</div><div class="professional-video-preview" style="--video-ratio:${fallbackRatio}">${selectedFile?`${workbenchVideoMarkup(selectedFile)}<button type="button" class="professional-expand-video" data-professional-preview-file="${selectedFile.id}">放大播放</button>`:`<div><span>▶</span><p>${selected?.status==='running'||selected?.status==='queued'?'视频生成中…':selected?.status==='failed'?generationFailureMarkup(selected):'填写脚本并生成本镜视频'}</p></div>`}</div><section class="professional-versions"><header><b>视频版本</b><span>${visibleVersions.length} 版</span></header><div>${versionButtons||'<p>还没有生成版本</p>'}</div></section><section class="professional-assembly"><header><div><b>完整成片</b><span>${completed}/${project.shots.length} 个分镜已完成</span></div><button type="button" class="stage-next" data-professional-assemble ${canAssemble?'':'disabled'}>一键拼接</button></header>${finalFile?`<div class="professional-final-video">${workbenchVideoMarkup(finalFile)}<button type="button" data-professional-preview-file="${finalFile.id}">放大播放完整成片</button></div>`:'<p>至少完成 3 个分镜，并为每个分镜选择已保存到本机的完成版本后，可按目录顺序拼接。</p>'}</section></div>`;
  }

  function bindProfessionalWorkspace({focus=true}={}){
    root.querySelectorAll('[data-professional-shot]').forEach(button=>button.onclick=()=>{professionalShotId=button.dataset.professionalShot;render(true);});
    root.querySelector('#professionalAddShot')?.addEventListener('click',addProfessionalShot);
    root.querySelectorAll('[data-professional-field]').forEach(field=>field.addEventListener('input',()=>{const shot=currentProfessionalShot();if(!shot)return;shot[field.dataset.professionalField]=field.value;if(field.dataset.professionalField==='script'){shot.action=field.value;shot.visualDirection=field.value;shot.promptOverride=field.value;refreshProfessionalProductionValidation(shot);}invalidateProfessionalShot(shot,'分镜内容已修改');queueProfessionalSave();if(field.dataset.professionalField==='title')root.querySelectorAll('[data-professional-shot]').forEach(item=>{if(item.dataset.professionalShot===shot.id)item.querySelector('b').textContent=field.value||`分镜 ${shot.shotNumber}`;});}));
    root.querySelectorAll('[data-professional-assets]').forEach(button=>button.onclick=()=>openProfessionalAssetPicker(button.dataset.professionalAssets));
    root.querySelectorAll('[data-professional-remove-asset]').forEach(button=>button.onclick=()=>removeProfessionalAsset(button.dataset.professionalAssetKind,button.dataset.professionalRemoveAsset));
    root.querySelectorAll('[data-professional-frame]').forEach(button=>button.onclick=()=>openProfessionalFramePicker(button.dataset.professionalFrame));
    root.querySelectorAll('[data-professional-clear-frame]').forEach(button=>button.onclick=()=>clearProfessionalFrame(button.dataset.professionalClearFrame));
    root.querySelectorAll('[data-professional-preview-file]').forEach(button=>button.onclick=event=>{event.stopPropagation();openProfessionalMediaPreview(button.dataset.professionalPreviewFile);});
    bindProfessionalAssetSorting();
    root.querySelectorAll('[data-professional-dismiss-pending]').forEach(button=>button.onclick=()=>dismissProfessionalPending(button.dataset.professionalPendingShot,button.dataset.professionalDismissPending));
    root.querySelectorAll('[data-professional-select-trigger]').forEach(trigger=>trigger.onclick=event=>{event.stopPropagation();const select=trigger.closest('.professional-video-select');const menu=select?.querySelector('.product-select-menu');if(!menu||trigger.disabled)return;const opening=menu.classList.contains('hidden');closeProfessionalVideoSelects(opening?select:null);menu.classList.toggle('hidden',!opening);trigger.setAttribute('aria-expanded',String(opening));if(opening)menu.querySelector('[role="option"][aria-selected="true"]:not(:disabled)')?.focus();});
    root.querySelectorAll('[data-professional-select-option]').forEach(option=>option.onclick=()=>{if(option.disabled||option.dataset.availability==='coming-soon')return;const shot=currentProfessionalShot();const key=option.dataset.professionalSelectOption;if(!shot)return;const value=option.dataset.value;if(key==='modelId')shot.generation.modelId=value;else if(key==='quality')shot.generation.quality=value;else shot[key]=key==='duration'?Number(value):value;closeProfessionalVideoSelects();ensureProfessionalVideoSettings(shot);invalidateProfessionalShot(shot,'视频参数已修改');queueProfessionalSave();render(true);});
    root.querySelectorAll('[data-professional-select-trigger]').forEach(trigger=>trigger.onkeydown=event=>{const select=trigger.closest('.professional-video-select');const menu=select?.querySelector('.product-select-menu');if(!menu||trigger.disabled)return;if(event.key==='Escape'){closeProfessionalVideoSelects();return;}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();closeProfessionalVideoSelects(select);menu.classList.remove('hidden');trigger.setAttribute('aria-expanded','true');const options=[...menu.querySelectorAll('[role="option"]:not(:disabled)')];(event.key==='ArrowDown'?options[0]:options.at(-1))?.focus();return;}if(!['Enter',' '].includes(event.key))return;event.preventDefault();trigger.click();});
    root.querySelectorAll('.professional-video-select .product-select-menu').forEach(menu=>menu.onkeydown=event=>{const select=menu.closest('.professional-video-select');const trigger=select?.querySelector('[data-professional-select-trigger]');const options=[...menu.querySelectorAll('[role="option"]:not(:disabled)')];const index=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeProfessionalVideoSelects();trigger?.focus();return;}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();options[(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus();return;}if((event.key==='Enter'||event.key===' ')&&index>=0){event.preventDefault();options[index].click();}});
    root.querySelectorAll('[data-professional-mode]').forEach(button=>button.onclick=()=>setProfessionalMode(button.dataset.professionalMode));
    root.querySelector('[data-professional-generate]')?.addEventListener('click',generateProfessionalVideo);
    root.querySelector('[data-professional-tail]')?.addEventListener('click',extractProfessionalTail);
    root.querySelectorAll('[data-professional-select-video]').forEach(button=>button.onclick=()=>selectProfessionalVideo(button.dataset.professionalSelectVideo));
    root.querySelector('[data-professional-assemble]')?.addEventListener('click',assembleProfessionalProject);
    bindProfessionalVideoRatios();
    if(focus)root.querySelector('#professionalShotScript')?.focus();
  }

  function currentProfessionalShot(){return project.shots.find(shot=>shot.id===professionalShotId)||null;}
  function queueProfessionalSave(){queueSave('shots');}
  async function addProfessionalShot(){if(project.finalAssetId)return toast('成片已合成，不能继续添加分镜');const shot=createProfessionalShot(project.shots.length+1);project.shots.push(shot);professionalShotId=shot.id;professionalPreviewShotId=shot.id;ensureProfessionalVideoSettings(shot);await patch({shots:project.shots},{quiet:true});render(true);}
  function invalidateProfessionalShot(shot,reason){shot.lifecycle={...shot.lifecycle,status:'draft',revision:(shot.lifecycle?.revision||1)+1,staleReasons:[...new Set([...(shot.lifecycle?.staleReasons||[]),reason])]};}
  function setProfessionalMode(mode){const shot=currentProfessionalShot();if(!shot)return;const ids=shotReferenceIds(shot);if((mode==='TEXT'||mode==='FIRST&LAST')&&ids.length)return toast(mode==='TEXT'?'当前分镜已有参考素材，不能切换为文本生成':'当前分镜已有参考素材，请先移除后再使用首尾帧');const model=state.config?.videoCapabilities?.models?.find(item=>item.id===shot.generation.modelId);if(!model?.modes?.some(item=>item.generationType===mode))return toast('当前模型不支持该生成模式，请先切换模型');shot.generation.type=mode;if(mode==='TEXT'||mode==='FIRST&LAST'){shot.generation.referenceAssetIds=[];}if(mode==='FIRST&LAST'){shot.generation.firstFrameAssetId='';shot.generation.lastFrameAssetId='';}if(mode==='REFERENCE')shot.generation.referenceAssetIds=[...ids];ensureProfessionalVideoSettings(shot);invalidateProfessionalShot(shot,'生成模式已修改');queueProfessionalSave();render(true);}
  function professionalAssetIds(shot){return [...new Set([...(shot.professionalAssets?.characters||[]),...(shot.professionalAssets?.locations||[])])];}
  function syncProfessionalReferences(shot){const ids=[...new Set([...professionalAssetIds(shot),...(shot.referenceAssetIds||[]),...(shot.assetMentions||[]).map(item=>item.id)])].filter(Boolean);shot.referenceAssetIds=ids;if(shot.generation.type==='REFERENCE')shot.generation.referenceAssetIds=[...new Set([...(shot.generation.referenceAssetIds||[]),...ids])];}
  function removeWorkbenchReference(shotId,assetId){
    const shot=project.shots.find(item=>item.id===shotId); if(!shot||project.finalAssetId)return;
    const id=String(assetId||''); if(!id)return;
    ['characters','locations'].forEach(kind=>{shot.professionalAssets[kind]=(shot.professionalAssets?.[kind]||[]).filter(value=>String(value)!==id);});
    shot.referenceAssetIds=(shot.referenceAssetIds||[]).filter(value=>String(value)!==id);
    shot.generation.referenceAssetIds=(shot.generation.referenceAssetIds||[]).filter(value=>String(value)!==id);
    const editor=root.querySelector(`[data-wb-shot="${shotId}"] .wb-rich-input`);
    const mention=editor?.querySelector(`[data-mention-id="${CSS.escape(id)}"]`);
    const selection=window.getSelection(); let restoreCaret=false;
    if(mention&&selection?.rangeCount&&editor?.contains(selection.anchorNode)){try{restoreCaret=Boolean(selection.getRangeAt(0).intersectsNode(mention));}catch{}}
    const after=mention?.nextSibling; const before=mention?.previousSibling;
    if(mention)mention.remove();
    if(mention){updateShotScriptFromEditor(shotId,editor);if(restoreCaret){if(after?.isConnected&&after.nodeType===Node.TEXT_NODE)setRichEditorCaret(editor,after,0);else if(before?.isConnected&&before.nodeType===Node.TEXT_NODE)setRichEditorCaret(editor,before,before.nodeValue.length);else setRichEditorCaret(editor);}}else{syncProfessionalReferences(shot);invalidateProfessionalShot(shot,'参考素材已移除');queueProfessionalSave();render(true,{focus:false});}
  }
  function removeProfessionalAsset(kind,id){const shot=currentProfessionalShot();if(!shot)return;shot.professionalAssets[kind]=shot.professionalAssets[kind].filter(value=>value!==id);shot.referenceAssetIds=(shot.referenceAssetIds||[]).filter(value=>value!==id);shot.generation.referenceAssetIds=(shot.generation.referenceAssetIds||[]).filter(value=>value!==id);syncProfessionalReferences(shot);invalidateProfessionalShot(shot,'参考图片已修改');queueProfessionalSave();render(true);}
  function reorderProfessionalAssets(kind,sourceId,targetId){const shot=currentProfessionalShot();if(!shot||sourceId===targetId)return;const ids=[...(shot.professionalAssets?.[kind]||[])];const from=ids.indexOf(sourceId);const to=ids.indexOf(targetId);if(from<0||to<0)return;const [moved]=ids.splice(from,1);ids.splice(to,0,moved);shot.professionalAssets[kind]=ids;syncProfessionalReferences(shot);invalidateProfessionalShot(shot,'参考图顺序已修改');queueProfessionalSave();render(true);}
  function bindProfessionalAssetSorting(){let dragging=null;root.querySelectorAll('[data-professional-drag-asset]').forEach(card=>{card.ondragstart=event=>{dragging={id:card.dataset.professionalDragAsset,kind:card.dataset.professionalDragKind};card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragging.id);};card.ondragover=event=>{if(dragging?.kind!==card.dataset.professionalDragKind)return;event.preventDefault();card.classList.add('drag-over');};card.ondragleave=()=>card.classList.remove('drag-over');card.ondrop=event=>{event.preventDefault();card.classList.remove('drag-over');if(dragging)reorderProfessionalAssets(dragging.kind,dragging.id,card.dataset.professionalDragAsset);};card.ondragend=()=>{dragging=null;root.querySelectorAll('.professional-asset-strip figure').forEach(item=>item.classList.remove('dragging','drag-over'));};});}
  function dismissProfessionalPending(shotId,id){const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;shot.pendingImageGenerations=(shot.pendingImageGenerations||[]).filter(item=>item.id!==id);professionalPendingImageGenerations=professionalPendingImageGenerations.filter(item=>item.id!==id);queueProfessionalSave();render(true);}
  function openProfessionalMediaPreview(id){const file=asset(id);if(!file)return;if(window.guguDesktop&&!file.localOnly&&file.localStatus!=='saved'&&!String(file.url||'').startsWith('gugu-media://'))return toast('素材正在保存到本地，请稍后再预览');let dialog=document.querySelector('#professionalMediaPreviewDialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='professionalMediaPreviewDialog';dialog.className='professional-media-preview-dialog';dialog.addEventListener('close',()=>{const video=dialog.querySelector('video');video?.pause();dialog.innerHTML='';professionalMediaPreview=null;scheduleFlushDeferredProfessionalRender();});document.body.append(dialog);}professionalMediaPreview=id;const media=file.kind==='video'?`<video src="${file.url}" controls autoplay playsinline></video>`:`<img src="${file.url}" alt="${esc(file.name)}">`;dialog.innerHTML=`<button type="button" class="professional-media-close" aria-label="关闭">×</button><div class="professional-media-preview-stage">${media}</div><footer><b>${esc(file.name)}</b><span>${file.kind==='video'?'视频播放':'图片预览'}</span></footer>`;dialog.querySelector('.professional-media-close').onclick=()=>dialog.close();dialog.showModal();}
  function rememberProfessionalAsset(id){if(!id)return;professionalRecentAssetIds=[id,...professionalRecentAssetIds.filter(value=>value!==id)].slice(0,24);}
  function professionalRecentAssets(){
    const used=project.shots.flatMap(shot=>[...(shot.professionalAssets?.characters||[]),...(shot.professionalAssets?.locations||[]),shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId]).filter(Boolean);
    const generated=state.tasks.filter(item=>item.type==='image'&&taskLocallyReady(item.id)).sort((a,b)=>String(b.finishedAt||b.updatedAt||b.createdAt).localeCompare(String(a.finishedAt||a.updatedAt||a.createdAt))).map(item=>item.assetId);
    const ids=[...professionalRecentAssetIds,...used.reverse(),...generated];
    return [...new Set(ids)].map(id=>asset(id)).filter(file=>file?.kind==='image'&&!assetSyncing(file)).slice(0,12);
  }
  function professionalPickerLabel(){if(professionalMediaPicker.frameField)return professionalMediaPicker.frameField==='firstFrameAssetId'?'首帧':'尾帧';return professionalMediaPicker.kind==='characters'?'角色':'场景';}
  function openProfessionalAssetPicker(kind){const shot=currentProfessionalShot();professionalAssetKind=kind;professionalFrameField='';professionalAssetSelection=[...(shot?.professionalAssets?.[kind]||[])];professionalMediaPicker={...professionalMediaPicker,tab:'library',kind,frameField:'',prompt:'',referenceAssetIds:[],query:''};paintProfessionalAssetDialog();}
  function openProfessionalFramePicker(field){const shot=currentProfessionalShot();professionalFrameField=field;professionalAssetKind='';professionalAssetSelection=shot?.generation?.[field]?[shot.generation[field]]:[];professionalMediaPicker={...professionalMediaPicker,tab:'library',kind:'',frameField:field,prompt:'',referenceAssetIds:[],query:''};paintProfessionalAssetDialog();}
  function setProfessionalFrameValue(shot,field,id){if(!shot)return;shot.generation[field]=id;if(field==='firstFrameAssetId'&&shot.generation.lastFrameAssetId===id)shot.generation.lastFrameAssetId='';if(field==='lastFrameAssetId'&&shot.generation.firstFrameAssetId===id)shot.generation.firstFrameAssetId='';}
  function setProfessionalFrame(field,id){const shot=currentProfessionalShot();if(!shot||!asset(id)||asset(id).kind!=='image')return toast('请选择有效的文件库图片');setProfessionalFrameValue(shot,field,id);rememberProfessionalAsset(id);invalidateProfessionalShot(shot,'首尾帧图片已修改');queueProfessionalSave();render(true);}
  async function clearProfessionalFrame(field){const shot=currentProfessionalShot();if(!shot||!shot.generation[field]||!await confirmDelete({title:'确认删除图片',message:'图片一旦删除，无法恢复。'}))return;shot.generation[field]='';invalidateProfessionalShot(shot,'首尾帧图片已修改');queueProfessionalSave();render(true);}

  function professionalPickerCard(file,{recent=false}={}){
    const selected=professionalAssetSelection.includes(file.id);
    const action=recent?'data-professional-recent-asset':'data-professional-pick-asset';
    return `<button type="button" class="${selected?'selected':''}" ${action}="${file.id}">${assetImageMarkup(file, file.name)}<span>${esc(file.name)}</span></button>`;
  }
  function professionalUploadJobCard(job){
    const failed=job.status==='failed'; const completed=job.status==='completed'; const progress=Math.max(0,Math.min(100,Math.round(job.progress||0))); const percent=failed?'失败':`${progress}%`; const label=failed?job.error:completed?(job.selected?'上传完成，已选中':'上传完成'):(job.label||'准备上传');
    const media=job.kind==='image'&&job.previewUrl?`<img src="${esc(job.previewUrl)}" alt="${esc(job.name)}" decoding="async">`:job.kind==='video'&&job.previewUrl?`<video src="${esc(job.previewUrl)}" muted preload="metadata"></video>`:'<span class="audio-file-mark">♫</span>';
    const ring=failed?'<span class="upload-progress-ring upload-progress-error"><b>!</b></span>':`<span class="upload-progress-ring" style="--upload-progress:${progress}%"><b>${percent}</b></span>`;
    return `<article class="professional-upload-job ${failed?'failed':''} ${completed?'completed':''}" aria-live="polite" aria-label="${esc(job.name)}，${esc(label)}"><div>${media}<span class="professional-upload-job-status">${ring}</span>${job.selected?'<i aria-label="已选中">✓</i>':''}</div><span title="${esc(job.name)}">${esc(job.name)}</span></article>`;
  }
  function professionalUploadJobs(context='professional'){ return (state.uploadJobs||[]).filter(job=>job.context===context); }
  function captureProfessionalPickerDraft(dialog){
    if(!dialog)return;
    const prompt=dialog.querySelector('#professionalAssetPrompt');
    const size=dialog.querySelector('[name="professionalImageSize"]:checked');
    const quality=dialog.querySelector('[name="professionalImageQuality"]:checked');
    const query=dialog.querySelector('#professionalAssetSearch');
    if(prompt)professionalMediaPicker.prompt=prompt.value;
    if(size)professionalMediaPicker.size=size.value;
    if(quality)professionalMediaPicker.quality=quality.value;
    if(query)professionalMediaPicker.query=query.value;
  }
  function openProfessionalGenerationReferenceDialog(outerDialog){
    captureProfessionalPickerDraft(outerDialog);
    professionalGenerationReferenceSelection=professionalMediaPicker.referenceAssetIds.filter(id=>asset(id)?.kind==='image').slice(0,7);
    paintProfessionalGenerationReferenceDialog();
  }
  function paintProfessionalGenerationReferenceDialog(){
    let dialog=document.querySelector('#professionalGenerationReferenceDialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='professionalGenerationReferenceDialog';dialog.className='professional-generation-reference-dialog';dialog.addEventListener('close',()=>{professionalGenerationReferenceSelection=[];scheduleFlushDeferredProfessionalRender();});document.body.append(dialog);}
    const images=imageAssets();
    const uploadJobs=professionalUploadJobs('professional-reference');
    dialog.innerHTML=`<div class="dialog-head"><div><h2>选择参考图片</h2><p>参考图会帮助生成结果保持主体、材质与画面风格一致。</p></div><button type="button" data-professional-reference-close aria-label="关闭">×</button></div><p class="professional-dialog-help">最多选择 7 张图片，单张不超过 20 MB。新上传图片会自动选中。</p><div class="professional-reference-actions"><button type="button" class="secondary-button" data-professional-reference-upload>↑ 上传图片</button><span>已选择 ${professionalGenerationReferenceSelection.length} / 7</span></div><div class="professional-reference-grid">${uploadJobs.map(professionalUploadJobCard).join('')}${images.length?images.map(file=>`<button type="button" class="${professionalGenerationReferenceSelection.includes(file.id)?'selected':''}" data-professional-reference-option="${file.id}">${assetImageMarkup(file, file.name)}<span>${esc(file.name)}</span><i>✓</i></button>`).join(''):(uploadJobs.length?'':'<div class="professional-reference-empty"><b>没有可用图片</b><p>先上传一张图片到文件库。</p></div>')}</div><footer><button type="button" class="secondary-button" data-professional-reference-close>取消</button><button type="button" class="gradient-button" data-professional-reference-confirm>使用所选图片</button></footer>`;
    dialog.querySelectorAll('[data-professional-reference-close]').forEach(button=>button.onclick=()=>dialog.close());
    dialog.querySelectorAll('[data-professional-reference-option]').forEach(button=>button.onclick=()=>{const id=button.dataset.professionalReferenceOption;if(professionalGenerationReferenceSelection.includes(id))professionalGenerationReferenceSelection=professionalGenerationReferenceSelection.filter(value=>value!==id);else if(professionalGenerationReferenceSelection.length<7)professionalGenerationReferenceSelection=[...professionalGenerationReferenceSelection,id];else return toast('生图参考图最多选择 7 张');paintProfessionalGenerationReferenceDialog();});
    dialog.querySelector('[data-professional-reference-upload]')?.addEventListener('click',()=>{uploadImage?.({context:'professional-reference'}).then(file=>{if(!file)return;rememberProfessionalAsset(file.id);if(professionalGenerationReferenceSelection.length<7)professionalGenerationReferenceSelection=[...new Set([...professionalGenerationReferenceSelection,file.id])];else toast('已上传到文件库，参考图选择数量已满');paintProfessionalGenerationReferenceDialog();}).catch(error=>toast(error.message));});
    dialog.querySelector('[data-professional-reference-confirm]')?.addEventListener('click',()=>{professionalMediaPicker.referenceAssetIds=[...professionalGenerationReferenceSelection];professionalMediaPicker.referenceAssetIds.forEach(rememberProfessionalAsset);dialog.close();paintProfessionalAssetDialog();});
    if(!dialog.open)dialog.showModal();
  }
  function paintProfessionalAssetDialog(){
    let dialog=document.querySelector('#professionalAssetDialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='professionalAssetDialog';dialog.className='professional-asset-dialog';dialog.addEventListener('cancel',()=>{professionalAssetSelection=[];});dialog.addEventListener('close',scheduleFlushDeferredProfessionalRender);document.body.append(dialog);}
    captureProfessionalPickerDraft(dialog);
    const label=professionalPickerLabel();
    const isFrame=Boolean(professionalMediaPicker.frameField);
    const images=imageAssets();
    const query=professionalMediaPicker.query.trim().toLocaleLowerCase('zh-CN');
    const filtered=query?images.filter(file=>String(file.name||'').toLocaleLowerCase('zh-CN').includes(query)):images;
    const recent=professionalRecentAssets();
    const tab=professionalMediaPicker.tab;
    const recentCards=recent.map(file=>professionalPickerCard(file,{recent:true})).join();
    const uploadJobs=professionalUploadJobs('professional');
    const uploadPanel=`<section class="professional-picker-panel professional-upload-panel"><div class="professional-upload-jobs">${uploadJobs.map(professionalUploadJobCard).join('')}</div><div class="professional-upload-drop"><span>↑</span><h3>从本地上传${label}图片</h3><p>支持 PNG、JPEG、WebP，单张不超过 20 MB。上传后自动加入本次选择并保存到文件库。</p><button type="button" class="gradient-button" data-professional-upload-asset>选择本地图片</button></div></section>`;
    const libraryPanel=`<section class="professional-picker-panel professional-library-panel"><section class="professional-recent-assets"><header><b>最近使用</b><span>包含近期使用和生成的图片</span></header><div>${recentCards||'<p>暂无最近使用图片</p>'}</div></section><div class="professional-library-controls"><label class="professional-asset-search"><span>⌕</span><input id="professionalAssetSearch" type="search" value="${esc(professionalMediaPicker.query)}" placeholder="搜索图片"></label><span>已选择 ${professionalAssetSelection.length}${isFrame?'':' / 7'} 张</span></div><header class="professional-library-all-head"><b>全部图片</b><span>${filtered.length} 张</span></header><div class="professional-asset-dialog-grid">${filtered.map(file=>professionalPickerCard(file)).join('')||'<p>文件库中没有匹配的图片。</p>'}</div></section>`;
    const selectedReferences=professionalMediaPicker.referenceAssetIds.map(id=>asset(id)).filter(file=>file?.kind==='image');
    const referenceSummary=selectedReferences.length?selectedReferences.map(file=>`<span class="professional-generation-reference-thumb">${assetImageMarkup(file, file.name)}<button type="button" data-professional-remove-generation-reference="${file.id}" aria-label="移除参考图片 ${esc(file.name)}">×</button></span>`).join(''):'<p>尚未选择参考图片，可不添加。</p>';
    const generationPanel=`<section class="professional-picker-panel professional-image-generation"><label for="professionalAssetPrompt">创作描述</label><textarea id="professionalAssetPrompt" maxlength="4000" placeholder="描述${label}的主体、环境、光线、构图和风格……">${esc(professionalMediaPicker.prompt)}</textarea><div class="professional-generation-field"><header><b>参考图片</b><span>${selectedReferences.length} / 7</span></header><div class="professional-generation-reference-summary"><div>${referenceSummary}</div><button type="button" class="secondary-button" data-professional-open-generation-references>${selectedReferences.length?'调整参考图片':'选择参考图片'}</button></div></div><fieldset><legend>画布比例</legend><div class="professional-generation-ratios">${imageRatios.map(value=>`<label><input type="radio" name="professionalImageSize" value="${value}" ${professionalMediaPicker.size===value?'checked':''}><span>${value}</span></label>`).join('')}</div></fieldset><fieldset><legend>质量</legend><div class="professional-generation-quality">${imageQualities.map(([value,text])=>`<label><input type="radio" name="professionalImageQuality" value="${value}" ${professionalMediaPicker.quality===value?'checked':''}><span>${text}</span></label>`).join('')}</div></fieldset><div class="professional-generation-submit"><span>生成后自动加入当前${label} · ${state.pricing.image} 积分</span><button type="button" class="gradient-button" data-professional-generate-asset>开始生成</button></div></section>`;
    const confirmAction=tab==='library'?`<button type="button" class="gradient-button" data-professional-confirm-assets ${!professionalAssetSelection.length?'disabled':''}>${isFrame?'使用此图片':`使用所选图片（${professionalAssetSelection.length}）`}</button>`:'';
    dialog.innerHTML=`<div class="dialog-head"><div><h2>添加${label}图片</h2><p>${isFrame?'选择一张图片作为当前帧。':'可选择多张图片，确认后按选择顺序添加。'}</p></div><button type="button" data-professional-close aria-label="关闭">×</button></div><nav class="professional-picker-tabs" aria-label="图片来源">${[['library','文件库'],['upload','本地上传'],['generate','图像生成']].map(([value,text])=>`<button type="button" class="${tab===value?'active':''}" data-professional-picker-tab="${value}">${text}</button>`).join('')}</nav>${tab==='upload'?uploadPanel:tab==='generate'?generationPanel:libraryPanel}<footer><button type="button" class="secondary-button" data-professional-close>取消</button>${confirmAction}</footer>`;
    dialog.querySelectorAll('[data-professional-close]').forEach(button=>button.onclick=()=>dialog.close());
    dialog.querySelectorAll('[data-professional-picker-tab]').forEach(button=>button.onclick=()=>{captureProfessionalPickerDraft(dialog);professionalMediaPicker.tab=button.dataset.professionalPickerTab;paintProfessionalAssetDialog();});
    const select=id=>{if(isFrame)professionalAssetSelection=[id];else if(professionalAssetSelection.includes(id))professionalAssetSelection=professionalAssetSelection.filter(value=>value!==id);else if(professionalAssetSelection.length<7)professionalAssetSelection=[...professionalAssetSelection,id];else return toast('参考图最多选择 7 张');rememberProfessionalAsset(id);paintProfessionalAssetDialog();};
    dialog.querySelectorAll('[data-professional-pick-asset],[data-professional-recent-asset]').forEach(button=>button.onclick=()=>select(button.dataset.professionalPickAsset||button.dataset.professionalRecentAsset));
    dialog.querySelector('#professionalAssetSearch')?.addEventListener('input',event=>{professionalMediaPicker.query=event.target.value;paintProfessionalAssetDialog();});
    dialog.querySelector('[data-professional-upload-asset]')?.addEventListener('click',()=>{captureProfessionalPickerDraft(dialog);professionalMediaPicker.tab='upload';paintProfessionalAssetDialog();uploadImage?.({context:'professional'}).then(file=>{if(!file)return;rememberProfessionalAsset(file.id);professionalAssetSelection=isFrame?[file.id]:[...new Set([...professionalAssetSelection,file.id])].slice(0,7);professionalMediaPicker.tab='library';paintProfessionalAssetDialog();}).catch(error=>toast(error.message));});
    dialog.querySelector('[data-professional-open-generation-references]')?.addEventListener('click',()=>openProfessionalGenerationReferenceDialog(dialog));
    dialog.querySelectorAll('[data-professional-remove-generation-reference]').forEach(button=>button.onclick=()=>{captureProfessionalPickerDraft(dialog);professionalMediaPicker.referenceAssetIds=professionalMediaPicker.referenceAssetIds.filter(id=>id!==button.dataset.professionalRemoveGenerationReference);paintProfessionalAssetDialog();});
    dialog.querySelector('[data-professional-generate-asset]')?.addEventListener('click',()=>openProfessionalAssetGeneration(dialog,label));
    dialog.querySelector('[data-professional-confirm-assets]')?.addEventListener('click',()=>{const shot=currentProfessionalShot();if(!shot)return;if(isFrame)setProfessionalFrame(professionalMediaPicker.frameField,professionalAssetSelection[0]);else{const previous=new Set(shot.professionalAssets[professionalMediaPicker.kind]||[]);shot.referenceAssetIds=(shot.referenceAssetIds||[]).filter(id=>!previous.has(id));shot.generation.referenceAssetIds=(shot.generation.referenceAssetIds||[]).filter(id=>!previous.has(id));shot.professionalAssets[professionalMediaPicker.kind]=[...professionalAssetSelection];professionalAssetSelection.forEach(rememberProfessionalAsset);syncProfessionalReferences(shot);invalidateProfessionalShot(shot,'参考图片已修改');queueProfessionalSave();render(true);}dialog.close();});
    if(!dialog.open)dialog.showModal();
  }
  function openProfessionalAssetGeneration(dialog,label){captureProfessionalPickerDraft(dialog);const prompt=professionalMediaPicker.prompt.trim();if(!prompt){dialog.querySelector('#professionalAssetPrompt')?.focus();return;}const targetType=professionalMediaPicker.frameField?'frame':'category';professionalAssetGeneration={id:crypto.randomUUID(),prompt,label,kind:professionalMediaPicker.kind||'characters',frameField:professionalMediaPicker.frameField||'firstFrameAssetId',targetType,shotId:professionalShotId,taskId:'',size:professionalMediaPicker.size,quality:professionalMediaPicker.quality,referenceAssetIds:[...professionalMediaPicker.referenceAssetIds]};dialog.close();generateProfessionalAsset();}
  async function generateProfessionalAsset(){if(!professionalAssetGeneration)return;const pending={...professionalAssetGeneration};professionalPendingImageGenerations=[pending,...professionalPendingImageGenerations];render(true);try{const referenceAssetIds=await ensureCloudReferenceIds(pending.referenceAssetIds);const result=await api('/api/generations',{method:'POST',body:JSON.stringify({type:'image',prompt:pending.prompt,size:pending.size,quality:pending.quality,referenceAssetIds})});setCreditBalance(result.balance);state.tasks=[result,...state.tasks.filter(item=>item.id!==result.id)];professionalPendingImageGenerations=professionalPendingImageGenerations.filter(item=>item.id!==pending.id);const shot=project.shots.find(item=>item.id===pending.shotId);if(shot){shot.pendingImageGenerations=[...(shot.pendingImageGenerations||[]),{...pending,taskId:result.id}];await patch({shots:project.shots},{quiet:true});}professionalAssetGeneration=null;render(true);toast(`${pending.label}图已提交，完成后会自动添加到当前分镜`);}catch(error){professionalPendingImageGenerations=professionalPendingImageGenerations.filter(item=>item.id!==pending.id);professionalAssetGeneration=null;render(true);toast(error.message);await loadCredits();}}
  async function generateProfessionalVideo(){
    let shot=currentProfessionalShot();
    if(!shot||!shot.script.trim())return;
    const targetProjectId=project.id;
    const targetEpoch=projectEpoch;
    const targetShotId=shot.id;
    ensureProfessionalVideoSettings(shot);
    if(!shot.generation.modelId)return toast('当前没有可用的视频模型，请稍后再试。');
    let warning=professionalProductionWarning(shot);
    if(warning)return toast(warning);
    if(!shotGenerationReady(shot))return;
    await flushSave();
    shot=currentProfessionalShot();
    if(!shot)return;
    ensureProfessionalVideoSettings(shot);
    if(!shot.generation.modelId)return toast('当前没有可用的视频模型，请稍后再试。');
    warning=professionalProductionWarning(shot);
    if(warning){render(true);return toast(warning);}
    if(!shotGenerationReady(shot)){render(true);return;}
    const refs=shotGenerationAssetIds(shot); const requestShot=videoRequestShot(shot,refs); const count=Math.max(1,Math.min(4,Number(shot.generation.count)||1));
    const button=root.querySelector(`[data-wb-generate="${shot.id}"]`);
    if(button){button.disabled=true;button.title='正在提交生成请求';button.querySelector('span:last-child').textContent=`提交 ${count} 个请求…`;}
    try{
      const cloudRefs=await ensureCloudReferenceIds(refs);
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return;
      const quote=professionalVideoUsesDynamicQuote(shot)?await requestProfessionalVideoQuote(shot,{force:true}):null;
      if(professionalVideoUsesDynamicQuote(shot)&&!quote?.priceVersion)throw new Error('当前价格确认失败，请稍后重试');
      const payload={type:'video',quantity:count,prompt:shotVideoPrompt(requestShot),dramaProjectId:targetProjectId,dramaShotId:targetShotId,modelId:shot.generation.modelId,aspectRatio:shot.aspectRatio,duration:shot.duration,quality:shot.generation.quality,generationType:requestShot.generation.type,referenceAssetIds:cloudRefs,...(quote?.priceVersion?{expectedPriceVersion:quote.priceVersion}:{})};
      const response=await api('/api/generations',{method:'POST',body:JSON.stringify(payload)});
      const results=Array.isArray(response.tasks)?response.tasks:[response];
      setCreditBalance(response.balance);
      state.tasks=[...results,...state.tasks.filter(item=>!results.some(result=>result.id===item.id))];
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return;
      if(response.project){project=restoreLocalProjectOutputs(normalizeProjectData(response.project));projects=mergeDramaProjectList(projects,project);state.dramaProject=project;professionalPreviewTaskIds.delete(targetShotId);}
      // Refresh once after the atomically charged batch has been attached.
      await loadTasks();
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId)return;
      render(true);toast(`已提交 ${results.length} 个分镜视频请求`);
    }catch(error){toast(error.message);await loadCredits();render(true,{focus:false});}
  }
  async function selectProfessionalVideo(taskId){const shot=currentProfessionalShot();if(!shot||!taskLocallyReady(taskId))return taskSyncing(taskId)?toast('视频正在保存到本地，请稍后选择'):undefined;shot.selectedVideoTaskId=taskId;await patch({shots:project.shots});}
  async function extractProfessionalTail(){const shot=currentProfessionalShot();if(!shot)return;try{const result=await extractDramaTailLocally(shot);shot.tailFrameAssetId=result.id;await patch({shots:project.shots},{quiet:true});render(true);toast('尾帧已保存到本地文件库');}catch(error){toast(error.message);}}
  function professionalAssemblyItems(){
    return project.shots.map((shot,index)=>{const source=taskLocalAsset(shot.selectedVideoTaskId);return {shot,index,file:source.file,localId:source.id,taskId:shot.selectedVideoTaskId};});
  }
  function closeProfessionalAssemblyDialog(){const dialog=document.querySelector('#professionalAssemblyDialog');if(dialog?.open)dialog.close();}
  function openProfessionalAssemblyDialog(){
    let items;
    try{items=professionalAssemblyItems();}catch(error){return toast(error.message);}
    let dialog=document.querySelector('#professionalAssemblyDialog');
    if(!dialog){
      dialog=document.createElement('dialog');dialog.id='professionalAssemblyDialog';dialog.className='professional-assembly-dialog';
      dialog.addEventListener('close',()=>{const video=dialog.querySelector('video');video?.pause();});
      document.body.append(dialog);
    }
    const first=items[0];
    dialog.innerHTML=`<div class="dialog-head"><div><span class="dialog-kicker">FINAL CUT</span><h2>确认本次分镜合成</h2><p>以下是每个分镜当前预览选中的视频。请逐镜播放确认，合成将严格按此顺序执行。</p></div><button type="button" data-assembly-close aria-label="关闭">×</button></div><div class="professional-assembly-body"><section class="professional-assembly-preview"><video src="${esc(first.file.url)}" controls preload="metadata" playsinline></video><div><b data-assembly-preview-title>${esc(first.shot.title)}</b><span data-assembly-preview-file>${esc(first.file.name)}</span></div></section><ol class="professional-assembly-list">${items.map(item=>`<li><button type="button" class="${item.index===0?'active':''}" data-assembly-item="${item.index}" aria-pressed="${item.index===0}"><span>${String(item.index+1).padStart(2,'0')}</span><div><b>${esc(item.shot.title)}</b><small>${esc(item.file.name)}</small></div><i>预览</i></button></li>`).join('')}</ol></div><footer><span>共 ${items.length} 个分镜 · 合成后进入最终成片状态</span><div><button type="button" class="secondary-button" data-assembly-close>返回检查</button><button type="button" class="gradient-button" data-assembly-confirm>确认并开始合成</button></div></footer>`;
    const video=dialog.querySelector('video');
    dialog.querySelectorAll('[data-assembly-close]').forEach(button=>button.onclick=closeProfessionalAssemblyDialog);
    dialog.querySelectorAll('[data-assembly-item]').forEach(button=>button.onclick=()=>{
      const item=items[Number(button.dataset.assemblyItem)];if(!item)return;
      video.pause();video.src=item.file.url;video.load();
      dialog.querySelector('[data-assembly-preview-title]').textContent=item.shot.title;
      dialog.querySelector('[data-assembly-preview-file]').textContent=item.file.name;
      dialog.querySelectorAll('[data-assembly-item]').forEach(candidate=>{const active=candidate===button;candidate.classList.toggle('active',active);candidate.setAttribute('aria-pressed',String(active));});
    });
    dialog.querySelector('[data-assembly-confirm]').onclick=event=>void performProfessionalAssembly(event.currentTarget);
    dialog.showModal();
  }
  async function performProfessionalAssembly(button){
    if(!project||project.finalAssetId)return closeProfessionalAssemblyDialog();
    try{professionalAssemblyItems();}catch(error){return toast(error.message);}
    button.disabled=true;button.textContent='正在拼接成片…';
    try{await assembleDramaLocally();closeProfessionalAssemblyDialog();render(true,{focus:false});toast('分镜已在本机合成，最终成片已生成');}
    catch(error){toast(error.message);button.disabled=false;button.textContent='确认并重新合成';}
  }
  async function assembleProfessionalProject(){const completed=project.shots.filter(item=>taskLocallyReady(item.selectedVideoTaskId)).length;if(project.finalAssetId)return toast('完整成片已生成，编辑已锁定');if(project.shots.length<=2)return toast('至少需要 3 个分镜才能合成');if(completed!==project.shots.length)return toast('请先等待所有分镜视频保存到本机');await flushSave();openProfessionalAssemblyDialog();}

  function renderScript(){
    const smart=project.mode==='smart'; const generated=Boolean(project.script||project.resources.length||project.shots.length);
    const modeLabel=smart?'智能导演<i class="beta-tag">内测</i>':'专业编辑';
    const draft=scriptDraft?.projectId===project.id?scriptDraft:null;
    const settings=draft?.settings||project.settings;
    if(smart&&generated){root.innerHTML=`<section class="stage-head focused"><div><span>STEP 1 / DIRECTOR PLAN</span><h2>审阅导演方案</h2><p>原剧本已保留；导演方案通过节拍覆盖、时长与连续性质量门后才会进入生产。</p></div><span class="project-mode-badge">${modeLabel}</span></section><section class="script-focus-card review director-review"><header><div><span>${project.productionQuality?.passed?'✓ 生产质量门通过':'⚠ 旧版方案需复核'}</span><h3>${esc(project.title)}</h3><p>本次拆出 ${project.scenes.reduce((n,scene)=>n+(scene.beats?.length||0),0)} 个剧本节拍、${project.resources.length} 个视觉资源和 ${project.shots.length} 个连续镜头。</p></div><dl><div><dt>场次</dt><dd>${project.scenes.length}</dd></div><div><dt>节拍</dt><dd>${project.scenes.reduce((n,scene)=>n+(scene.beats?.length||0),0)}</dd></div><div><dt>资源</dt><dd>${project.resources.length}</dd></div><div><dt>分镜</dt><dd>${project.shots.length}</dd></div></dl></header><section class="review-block story-review"><div class="review-block-title"><span>01</span><div><h4>故事与剧本</h4><p>完整剧本输入会原样保留；故事梗概由智能导演提炼。</p></div></div><label>故事梗概<textarea id="reviewSynopsis">${esc(project.synopsis)}</textarea></label><label for="reviewScript">剧本正文<textarea id="reviewScript" maxlength="120000">${esc(draft?.review??project.script)}</textarea></label></section><section class="review-block"><div class="review-block-title"><span>02</span><div><h4>场次与视觉资源</h4><p>这些定义将直接用于下一步生成角色、场景和物品底图。</p></div></div><div class="review-scene-list">${project.scenes.map((scene,index)=>`<article data-review-scene="${scene.id}"><b>${String(index+1).padStart(2,'0')}</b><input data-review-scene-field="heading" value="${esc(scene.heading)}"><textarea data-review-scene-field="dramaticFunction" placeholder="本场戏剧任务">${esc(scene.dramaticFunction)}</textarea><small>${(scene.beats||[]).map(beat=>`${beat.id} ${beat.text}`).join(' · ')}</small></article>`).join('')}</div><div class="review-resource-list">${project.resources.map(resource=>`<article data-review-resource="${resource.id}"><span>${typeNames[resource.type]}</span><input data-review-resource-field="name" value="${esc(resource.name)}"><textarea data-review-resource-field="description" placeholder="资源核心定义">${esc(resource.description)}</textarea><textarea data-review-resource-field="prompt" placeholder="视觉生成提示词">${esc(resource.prompt)}</textarea></article>`).join('')}</div></section><section class="review-block"><div class="review-block-title"><span>03</span><div><h4>分镜初稿</h4><p>每镜认领连续剧本节拍；这里编辑导演意图，实际模型 Prompt 在生成时编译。</p></div></div><div class="review-shot-list">${project.shots.map((shot,index)=>`<article data-review-shot="${shot.id}"><header><b>SHOT ${String(index+1).padStart(2,'0')}</b><span>${shot.duration} 秒 · ${esc(shot.shotSize)} · ${esc(shot.cameraMovement)}</span></header><input data-review-shot-field="title" value="${esc(shot.title)}"><label>动作与台词<textarea data-review-shot-field="script">${esc(shot.script)}</textarea></label><label>构图与光线补充<textarea data-review-shot-field="visualDirection">${esc(shot.visualDirection)}</textarea></label><small>${(shot.sourceBeatIds||[]).join(' → ')||'旧版分镜未绑定剧本节拍'} · ${shot.resourceIds.map(id=>project.resources.find(item=>item.id===id)?.name).filter(Boolean).join(' · ')||'未关联视觉资源'}</small></article>`).join('')}</div></section><p class="review-save-note">以上修改将在确认时统一保存。下一步只负责生成和选择视觉底图。</p><div id="scriptActionStatus" class="script-action-status" aria-live="polite"></div><button id="confirmScriptReview" class="script-primary-action" type="button">确认方案，进入资源生成 <span>→</span></button></section>`;}
    else{root.innerHTML=`<section class="stage-head focused"><div><span>STEP 1 / STORY BLUEPRINT</span><h2>${smart?'告诉导演，你想拍什么':'编写项目剧本'}</h2><p>${smart?'输入一句话创意或完整剧本，导演会一次完成剧本整理、资源拆分和分镜初稿。':'先写下剧本正文，再在下方拆出场次与节拍——场次是第三步分镜的挂靠单位。四个步骤可随时来回修改。'}</p></div><span class="project-mode-badge">${modeLabel}</span></section><section class="script-focus-card brief"><label for="projectInput">${smart?'创意或剧本':'剧本正文'}</label><textarea id="projectInput" maxlength="120000" placeholder="${smart?'例如：被裁员的程序员突然能看见每个人说谎时头顶出现的倒计时……':'按你的格式编写分场、动作和对白……'}">${esc(draft?.input??(smart?project.input:project.script))}</textarea><p class="field-help">${smart?'可以只写一句话，也可以粘贴完整剧本。内容越具体，角色和分镜越准确。':'剧本会作为项目资产保存。'}</p><fieldset class="production-settings"><legend>制作规格</legend><label>分镜数量<input id="settingShotCount" type="number" min="1" max="120" value="${settings.shotCount}"></label><label>视频总长<input id="settingTotalDuration" type="number" min="6" max="3600" value="${settings.totalDuration}"><small>秒</small></label><label>单镜时长<select id="settingShotDuration">${optionList(durations,settings.shotDuration,' 秒')}</select></label><label>画面比例<select id="settingAspectRatio">${optionList(ratios,settings.aspectRatio)}</select></label></fieldset><div id="scriptActionStatus" class="script-action-status" aria-live="polite"></div><button id="${smart?'runSmartDirector':'saveProfessionalScript'}" class="script-primary-action" type="button" ${smart&&!state.config.llm?'disabled':''}>${smart?'生成完整导演方案':'保存剧本，进入资源生成'} <span>→</span></button></section>${smart?'':sceneBoard()}`;}
    document.querySelector('#projectInput')?.addEventListener('input',event=>{const current=scriptDraft?.projectId===project.id?scriptDraft:{projectId:project.id};scriptDraft={...current,input:event.target.value,settings:inputSettings()};});
    document.querySelector('#reviewScript')?.addEventListener('input',event=>{const current=scriptDraft?.projectId===project.id?scriptDraft:{projectId:project.id};scriptDraft={...current,review:event.target.value};});
    document.querySelector('.production-settings')?.addEventListener('input',()=>{const current=scriptDraft?.projectId===project.id?scriptDraft:{projectId:project.id,input:document.querySelector('#projectInput')?.value||''};scriptDraft={...current,settings:inputSettings()};});
    document.querySelector('.production-settings')?.addEventListener('change',()=>{const current=scriptDraft?.projectId===project.id?scriptDraft:{projectId:project.id,input:document.querySelector('#projectInput')?.value||''};scriptDraft={...current,settings:inputSettings()};});
    document.querySelector('#runSmartDirector')?.addEventListener('click',runDirector);
    document.querySelector('#saveProfessionalScript')?.addEventListener('click',continueProfessionalScript);
    document.querySelector('#confirmScriptReview')?.addEventListener('click',confirmScriptReview);
    bindSceneBoard();
  }
  const beatsToText = scene => (scene.beats||[]).map(beat=>beat.kind==='dialogue'?`${beat.speaker||'角色'}：${beat.text}`:beat.text).join('\n');
  const beatKey = beat => `${beat.kind}|${beat.speaker||''}|${beat.text}`;
  function textToBeats(text,previous=[]){
    const pool=(previous||[]).filter(beat=>beat.id).map(beat=>({id:beat.id,key:beatKey(beat),used:false}));
    return String(text||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
      const match=line.match(/^([^：:，。！？、\s]{1,10})[：:]\s*(\S.*)$/);
      return match?{kind:'dialogue',speaker:match[1],text:match[2],delivery:''}:{kind:'action',text:line,speaker:'',delivery:''};
    }).map(beat=>{
      const hit=pool.find(item=>!item.used&&item.key===beatKey(beat));
      if(hit){hit.used=true;return {...beat,id:hit.id};}
      return {...beat,id:`B${crypto.randomUUID().slice(0,8)}`};
    });
  }
  function sceneSummary(scene){ const beats=scene.beats||[]; const seconds=beats.reduce((sum,beat)=>sum+(Number(beat.estimatedSeconds)||beatSeconds(beat)),0); const lines=beats.filter(beat=>beat.kind==='dialogue').length; return `${beats.length} 拍 · ${lines} 句台词 · 约 ${Math.round(seconds*10)/10} 秒`; }
  function sceneBoard(){
    const total=project.scenes.reduce((sum,scene)=>sum+(scene.beats||[]).reduce((n,beat)=>n+(Number(beat.estimatedSeconds)||beatSeconds(beat)),0),0);
    return `<section class="scene-board"><header><div><b>场次与节拍</b><p>节拍每行一条：写成「角色名：台词」记为台词，其余记为动作。秒数按语速自动折算，作为分镜时长的参考。</p></div><div class="scene-board-meta"><span>${project.scenes.length} 场 · 约 ${Math.round(total)} 秒</span><button id="addScene" class="secondary-button" type="button">＋ 添加场次</button></div></header><div class="scene-board-list">${project.scenes.map((scene,index)=>`<article class="scene-card" data-scene-id="${scene.id}"><header><b>S${String(index+1).padStart(2,'0')}</b><input data-scene-field="heading" value="${esc(scene.heading||'')}" placeholder="场次标题，例如：出租屋 · 夜 · 内景"><span data-scene-summary>${sceneSummary(scene)}</span><button data-delete-scene="${scene.id}" type="button" title="删除场次" aria-label="删除场次">×</button></header><div class="scene-card-grid"><label>地点<input data-scene-field="location" value="${esc(scene.location||'')}" placeholder="出租屋客厅"></label><label>时间<input data-scene-field="timeOfDay" value="${esc(scene.timeOfDay||'')}" placeholder="深夜"></label><label>光线氛围<input data-scene-field="lighting" value="${esc(scene.lighting||'')}" placeholder="只有电视机的冷光"></label></div><label>本场戏剧任务<textarea data-scene-field="dramaticFunction" rows="2" placeholder="这场戏要推进什么？观众看完知道了什么？">${esc(scene.dramaticFunction||'')}</textarea></label><label>节拍（每行一条）<textarea data-scene-beats rows="6" placeholder="林晚推开门，屋里一片漆黑。&#10;林晚：你还在等我？&#10;男人没有回答，只把遥控器放下。">${esc(beatsToText(scene))}</textarea></label></article>`).join('')||'<div class="scene-board-empty"><b>还没有场次</b><p>添加第一场，第三步的每个分镜就能挂到具体场次上。</p></div>'}</div></section>`;
  }
  function bindSceneBoard(){
    document.querySelector('#addScene')?.addEventListener('click',addScene);
    document.querySelectorAll('[data-delete-scene]').forEach(button=>button.onclick=()=>deleteScene(button.dataset.deleteScene));
    document.querySelectorAll('[data-scene-id]').forEach(card=>card.addEventListener('input',()=>{
      const scene=collectSceneCard(card.dataset.sceneId);
      const summary=card.querySelector('[data-scene-summary]'); if(summary&&scene)summary.textContent=sceneSummary(scene);
      queueSave('scenes');
    }));
  }
  function collectSceneCard(id){ const card=document.querySelector(`[data-scene-id="${id}"]`); const scene=project.scenes.find(item=>item.id===id); if(!card||!scene)return scene; card.querySelectorAll('[data-scene-field]').forEach(field=>scene[field.dataset.sceneField]=field.value); const beats=card.querySelector('[data-scene-beats]'); if(beats)scene.beats=textToBeats(beats.value,scene.beats); return scene; }
  async function addScene(){ const index=project.scenes.length+1; project.scenes.push({id:crypto.randomUUID(),sceneNumber:index,heading:`第 ${index} 场`,location:'',timeOfDay:'',lighting:'',dramaticFunction:'',beats:[]}); await patch({scenes:project.scenes}); const cards=document.querySelectorAll('[data-scene-id]'); cards[cards.length-1]?.querySelector('[data-scene-field="heading"]')?.focus(); }
  async function deleteScene(id){ const scene=project.scenes.find(item=>item.id===id); if(!scene||!await confirmDelete({title:'确认删除场次',message:'场次一旦删除，无法恢复。'}))return; project.scenes=project.scenes.filter(item=>item.id!==id); project.shots.forEach(shot=>{if(shot.sceneId===id)shot.sceneId='';}); await patch({scenes:project.scenes,shots:project.shots}); }
  function inputSettings(){ return {shotCount:Number(document.querySelector('#settingShotCount').value),totalDuration:Number(document.querySelector('#settingTotalDuration').value),shotDuration:Number(document.querySelector('#settingShotDuration').value),aspectRatio:document.querySelector('#settingAspectRatio').value}; }
  async function saveScriptInputs(smart=true){ const value=document.querySelector('#projectInput').value.trim(); const settings=inputSettings(); await patch({[smart?'input':'script']:value,settings},{quiet:true}); return {value,settings}; }
  async function runDirector(){ const button=document.querySelector('#runSmartDirector'); const status=document.querySelector('#scriptActionStatus'); const value=document.querySelector('#projectInput').value.trim(); if(!value){status.textContent='先输入一句话创意或剧本。';document.querySelector('#projectInput').focus();return;} const settings=inputSettings(); button.disabled=true;button.innerHTML='<span class="button-spinner"></span> 正在生成并校验导演方案';status.textContent='导演正在拆解故事并校验制作方案；若分镜缺失或质量不合格，系统会自动补全或校正，最多进行 4 次模型调用。请不要关闭页面。';try{await patch({input:value,settings},{quiet:true});const result=await api(`/api/drama/projects/${project.id}/direct`,{method:'POST',body:JSON.stringify({input:value,settings})});project=normalizeProjectData(result.project);projects=mergeDramaProjectList(projects,project);scriptDraft=null;state.dramaProject=project;setCreditBalance(result.balance);document.querySelector('#dramaProjectTitle').value=project.title;const completed=Number(result.usage.completionCount)||0;const repairs=Number(result.usage.recoveryAttempts)||0;const corrected=Number(result.usage.correctedProblemCount)||0;const outcome=result.usage.autoRegenerated?`导演方案已生成，经 ${repairs} 轮自动重建与校正`:result.usage.autoCorrected?`导演方案已生成，经 ${repairs} 轮自动校正${corrected?`修复 ${corrected} 项问题`:''}`:completed?`导演方案已生成，自动补全 ${completed} 个分镜`:'导演方案已生成';toast(`${outcome}，${result.usage.attemptCount||1} 次调用实扣 ${creditText(result.usage.chargedCredits)} 积分`);render();}catch(error){if(error.balance!==undefined)setCreditBalance(error.balance);else await loadCredits();const charged=Number(error.usage?.chargedCredits)||0;const billed=charged?` 已完成的模型调用实扣 ${creditText(charged)} 积分。`:'';const rounds=Number(error.directorRecovery?.round)||0;const recovery=error.directorRecovery?.attempted&&rounds?(error.directorRecovery?.history?.includes('regenerate')?`系统已自动重建并校正 ${rounds} 轮，但仍未形成可制作方案。`:error.directorRecovery?.history?.includes('replace')||error.directorRecovery?.mode==='replace'?`系统已自动校正 ${rounds} 轮，但仍未形成可制作方案。`:`系统已自动补全 ${rounds} 轮，但仍未形成可制作方案。`):'';const message=recovery||error.message;status.textContent=`生成失败：${message}${billed}你可以重新生成完整导演方案。`;button.disabled=false;button.innerHTML='重新生成完整导演方案 <span>→</span>';} }
  async function continueProfessionalScript(){const button=document.querySelector('#saveProfessionalScript');const status=document.querySelector('#scriptActionStatus');const value=document.querySelector('#projectInput').value.trim();if(!value){status.textContent='先填写剧本正文。';document.querySelector('#projectInput').focus();return;}project.scenes.forEach(scene=>collectSceneCard(scene.id));if(!project.scenes.length)project.scenes.push({id:crypto.randomUUID(),sceneNumber:1,heading:'第 1 场',location:'',timeOfDay:'',lighting:'',dramaticFunction:'',beats:[]});pendingKeys.delete('scenes');clearTimeout(saveTimer);button.disabled=true;button.innerHTML='<span class="button-spinner"></span> 正在保存';try{const settings=inputSettings();const result=await patch({script:value,settings,scenes:project.scenes,step:'resources'},{quiet:true});project=result;viewStep='resources';scriptDraft=null;dropFocus();render(true);const host=scroller();if(host)host.scrollTop=0;}catch(error){status.textContent=`保存失败：${error.message}`;button.disabled=false;button.innerHTML='保存剧本，进入资源生成 <span>→</span>';}}
  function collectDirectorReview(){
    project.synopsis=document.querySelector('#reviewSynopsis')?.value.trim()||project.synopsis;
    document.querySelectorAll('[data-review-scene]').forEach(card=>{const scene=project.scenes.find(item=>item.id===card.dataset.reviewScene);card.querySelectorAll('[data-review-scene-field]').forEach(field=>scene[field.dataset.reviewSceneField]=field.value);});
    document.querySelectorAll('[data-review-resource]').forEach(card=>{const resource=project.resources.find(item=>item.id===card.dataset.reviewResource);card.querySelectorAll('[data-review-resource-field]').forEach(field=>resource[field.dataset.reviewResourceField]=field.value);});
    document.querySelectorAll('[data-review-shot]').forEach(card=>{const shot=project.shots.find(item=>item.id===card.dataset.reviewShot);card.querySelectorAll('[data-review-shot-field]').forEach(field=>shot[field.dataset.reviewShotField]=field.value);});
  }
  async function confirmScriptReview(){const button=document.querySelector('#confirmScriptReview');const status=document.querySelector('#scriptActionStatus');const value=document.querySelector('#reviewScript').value.trim();if(!value){status.textContent='剧本正文不能为空。';document.querySelector('#reviewScript').focus();return;}collectDirectorReview();button.disabled=true;button.innerHTML='<span class="button-spinner"></span> 正在保存并进入下一步';try{const result=await patch({script:value,synopsis:project.synopsis,scenes:project.scenes,resources:project.resources,shots:project.shots,step:'resources'},{quiet:true});project=result;viewStep='resources';scriptDraft=null;render();}catch(error){status.textContent=`保存失败：${error.message}`;button.disabled=false;button.innerHTML='确认方案，进入资源生成 <span>→</span>';}}

  function resourceVersionCard(resource,taskId){ const generation=task(taskId); const file=taskAsset(taskId); const selected=resource.selectedTaskId===taskId; const syncing=taskSyncing(taskId); const ready=taskLocallyReady(taskId); const missing=generation?.status==='completed'&&Boolean(generation.assetId)&&!file; const status=generation?.status==='failed'?generationFailureMarkup(generation):syncing?'保存中…':missing?'成品文件未找到':generation?({queued:'排队中',running:'生成中'}[generation.status]||generation.status):'记录缺失'; return `<button class="resource-version ${selected?'selected':''}" data-select-resource="${resource.id}" data-task-id="${taskId}" ${ready?'':'disabled'}>${ready?`<img src="${file.url}" alt="${esc(resource.name)}">`:`<span class="version-state">${status}</span>`}<i>${selected&&ready?'✓ 已选':ready?'选择此版':syncing?'保存中…':missing?'文件未保存到本机':'等待完成'}</i></button>`; }
  function renderResources(){
    const groups=['character','location','prop']; const missing=project.resources.filter(item=>!item.selectedTaskId||!taskLocallyReady(item.selectedTaskId)).length;
    root.innerHTML=`<section class="stage-head"><div><span>STEP 2 / VISUAL BIBLE</span><h2>资源生成</h2><p>页面设定就是图片模型的输入。修改身份、外观、服装或标准视图后，下方实际 Prompt 会同步更新。</p></div><div class="stage-head-actions"><span class="readiness-badge">${project.resources.length-missing}/${project.resources.length} 已定稿</span><button id="addResource" class="secondary-button">＋ 添加资源</button><button id="generateAllResources" class="gradient-button" ${!project.resources.length?'disabled':''}>一键生成${missing?` · ${missing} 项`:''}</button></div></section><div class="resource-tabs">${groups.map(type=>`<button data-resource-filter="${type}">${typeNames[type]} ${project.resources.filter(x=>x.type===type).length}</button>`).join('')}</div><div class="resource-board">${groups.map(type=>`<section class="resource-group" data-resource-group="${type}"><header><b>${typeNames[type]}资源</b><span>${project.resources.filter(x=>x.type===type).length} 项</span><button data-add-resource-type="${type}" class="text-button" type="button">＋ 添加${typeNames[type]}</button></header>${project.resources.filter(x=>x.type===type).map(resource=>`<article class="resource-editor professional" data-resource-id="${resource.id}"><div class="resource-definition"><div class="resource-card-status"><span class="lifecycle-chip ${resource.lifecycle.status}">${resource.selectedTaskId?(taskLocallyReady(resource.selectedTaskId)?'已选定':'生成中'):'待定稿'}</span><small>REV ${resource.lifecycle.revision}</small></div><div class="resource-name-row"><label>类型<select data-resource-field="type">${Object.entries(typeNames).map(([value,label])=>`<option value="${value}" ${resource.type===value?'selected':''}>${label}</option>`).join('')}</select></label><label>资产名称<input data-resource-field="name" value="${esc(resource.name)}"></label></div><label>核心定义<textarea data-resource-field="description">${esc(resource.description)}</textarea></label><div class="bible-grid"><label>身份 / 空间锚点<textarea data-bible-field="identity">${esc(resource.bible.identity)}</textarea></label><label>外观 / 固定陈设<textarea data-bible-field="appearance">${esc(resource.bible.appearance)}</textarea></label><label>服装 / 材质状态<textarea data-bible-field="costume">${esc(resource.bible.costume)}</textarea></label><label>标准视图 / 标准机位<textarea data-bible-field="canonicalViews">${esc(resource.bible.canonicalViews)}</textarea></label></div><label>连续性补充备注<textarea data-bible-field="stateNotes">${esc(resource.bible.stateNotes)}</textarea></label><section class="compiled-resource-prompt"><header><b>实际提交给图片模型的 Prompt</b><span>由上方全部设定实时合成</span></header><textarea data-compiled-resource-prompt readonly>${esc(buildResourceImagePrompt(resource,{aspectRatio:project.settings.aspectRatio}))}</textarea></section><div><span><button data-delete-resource="${resource.id}" class="text-button danger-link">删除</button><button data-save-resource="${resource.id}" class="text-button">保存并升版</button></span><button data-generate-resource="${resource.id}" class="resource-generate">${resource.versions.length?'生成候选版本':'生成资源图'} · ${state.pricing.image} 积分</button></div></div><div class="resource-versions"><header><b>视觉候选</b><span>可多次生成，选择一版作为后续一致性底图</span></header><div>${resource.versions.length?resource.versions.map(id=>resourceVersionCard(resource,id)).join(''):'<div class="version-empty">尚未生成视觉版本</div>'}</div></div></article>`).join('')||'<div class="resource-group-empty">还没有这类资源，点上方「添加」新建一个。</div>'}</section>`).join('')}</div><footer class="stage-action-bar"><div><button id="resourceBack" class="secondary-button">← 剧本设计</button></div><div><button id="resourceNext" class="stage-next">确认资源，进入分镜设计 →</button></div></footer>`;
    document.querySelector('#addResource').onclick=()=>addResource('character');
    document.querySelectorAll('[data-add-resource-type]').forEach(button=>button.onclick=()=>addResource(button.dataset.addResourceType));
    document.querySelector('#generateAllResources').onclick=generateAllResources;
    document.querySelectorAll('[data-save-resource]').forEach(button=>button.onclick=()=>saveResource(button.dataset.saveResource));
    document.querySelectorAll('[data-delete-resource]').forEach(button=>button.onclick=()=>deleteResource(button.dataset.deleteResource));
    document.querySelectorAll('[data-generate-resource]').forEach(button=>button.onclick=()=>generateResource(button.dataset.generateResource,button));
    document.querySelectorAll('[data-select-resource]').forEach(button=>button.onclick=()=>selectResourceVersion(button.dataset.selectResource,button.dataset.taskId));
    document.querySelectorAll('[data-resource-id]').forEach(card=>card.addEventListener('input',()=>{refreshCompiledResourcePrompt(card.dataset.resourceId);queueSave('resources');}));
    document.querySelectorAll('[data-resource-id] select').forEach(field=>field.addEventListener('change',()=>{const card=field.closest('[data-resource-id]');refreshCompiledResourcePrompt(card.dataset.resourceId);queueSave('resources');}));
    document.querySelector('#resourceBack').onclick=()=>navigateStep('script'); document.querySelector('#resourceNext').onclick=async()=>{project.resources.forEach(item=>collectResourceCard(item.id));await flushSave();advanceStep('storyboard');};
  }
  async function addResource(type='character'){ const label={character:'新角色',location:'新场景',prop:'新物品'}[type]||'新资源'; const id=crypto.randomUUID(); project.resources.push({id,type,name:label,description:'',prompt:'真人短剧角色定妆照，9:16，正面、侧面与全身标准视图，保持身份特征一致',bible:{identity:'',dramaticGoal:'',appearance:'',costume:'',canonicalViews:'正面、左右侧面、全身标准视图',stateNotes:''},lifecycle:{status:'draft',revision:1,approvedAt:''},versions:[],selectedTaskId:''}); await patch({resources:project.resources}); const field=document.querySelector(`[data-resource-id="${id}"] [data-resource-field="name"]`); if(field){field.focus();field.select();} }
  function collectResourceCard(id){const card=document.querySelector(`[data-resource-id="${id}"]`);const item=project.resources.find(x=>x.id===id);if(!card||!item)return item;card.querySelectorAll('[data-resource-field]').forEach(field=>item[field.dataset.resourceField]=field.value);card.querySelectorAll('[data-bible-field]').forEach(field=>item.bible[field.dataset.bibleField]=field.value);return item;}
  function refreshCompiledResourcePrompt(id){const card=document.querySelector(`[data-resource-id="${id}"]`);const item=collectResourceCard(id);const output=card?.querySelector('[data-compiled-resource-prompt]');if(output&&item)output.value=buildResourceImagePrompt(item,{aspectRatio:project.settings.aspectRatio});}
  async function saveResource(id,{quiet=false,notify=true}={}){const item=collectResourceCard(id);item.lifecycle={...item.lifecycle,status:item.selectedTaskId?'approved':'draft',revision:(item.lifecycle?.revision||1)+1};project.shots.filter(shot=>shot.resourceIds.includes(id)).forEach(shot=>{shot.lifecycle.staleReasons=[...new Set([...(shot.lifecycle.staleReasons||[]),`${item.name} 定义已更新`])];});await patch({resources:project.resources,shots:project.shots},{quiet});if(notify)toast('资源定义已升版，相关分镜已标记待复核');}
  async function deleteResource(id){ const resource=project.resources.find(item=>item.id===id); if(!resource||!await confirmDelete({title:'确认删除资源',message:'资源一旦删除，无法恢复。'}))return; project.resources=project.resources.filter(item=>item.id!==id); project.shots.forEach(shot=>shot.resourceIds=shot.resourceIds.filter(resourceId=>resourceId!==id)); await patch({resources:project.resources,shots:project.shots}); }
  async function generateResource(id,button){if(!project.resources.find(x=>x.id===id))return;await saveResource(id,{quiet:true,notify:false});const resource=project.resources.find(x=>x.id===id);const finalPrompt=buildResourceImagePrompt(resource,{aspectRatio:project.settings.aspectRatio});button=document.querySelector(`[data-generate-resource="${id}"]`)||button;button.disabled=true;button.textContent='正在提交…';try{const generation=await api('/api/generations',{method:'POST',body:JSON.stringify({type:'image',prompt:finalPrompt,size:project.settings.aspectRatio,quality:'medium',referenceAssetIds:[]})});setCreditBalance(generation.balance);state.tasks=[generation,...state.tasks.filter(x=>x.id!==generation.id)];const result=await api(`/api/drama/projects/${project.id}/resources/${id}/versions`,{method:'POST',body:JSON.stringify({taskId:generation.id})});project=result.project;state.dramaProject=project;render();toast(`资源图已提交，预扣 ${generation.creditCost} 积分`);}catch(error){toast(error.message);await loadCredits();button.disabled=false;button.textContent='重新生成';} }
  async function generateAllResources(){ const targets=project.resources.filter(item=>!item.selectedTaskId); if(!targets.length)return toast('所有资源都已有选中版本'); const button=document.querySelector('#generateAllResources');button.disabled=true;for(const item of targets){const card=document.querySelector(`[data-resource-id="${item.id}"]`);if(card)await generateResource(item.id,card.querySelector('[data-generate-resource]'));}toast('资源任务已全部提交'); }
  async function selectResourceVersion(resourceId,taskId){ const result=await api(`/api/drama/projects/${project.id}/resources/${resourceId}/select`,{method:'PATCH',body:JSON.stringify({taskId})});project=result.project;state.dramaProject=project;render(); }

  function shotReferences(shot){ return selectedResourceAssetIds(shot).map(id=>asset(id)).filter(Boolean); }
  function shotReadiness(shot){const reasons=[];if(!shot.narrativeFunction)reasons.push('缺少叙事功能');if(!shot.startState||!shot.endState)reasons.push('起止状态未定义');if(project.workflowVersion>=2&&!(shot.sourceBeatIds||[]).length)reasons.push('没有认领剧本节拍');if(project.workflowVersion>=3&&!(shot.motionPlan||[]).length)reasons.push('缺少逐秒运动时间轴');if((shot.resourceIds||[]).some(id=>!project.resources.find(item=>item.id===id)?.selectedTaskId))reasons.push('引用资源未定稿');return [...new Set([...(shot.lifecycle?.staleReasons||[]),...reasons])];}
  function motionTimelineEditor(shot){if(!(shot.motionPlan||[]).length)return '<div class="motion-timeline-empty">旧版分镜：生成视频时将根据起止状态自动拆成逐秒时间轴。</div>';return `<div class="motion-timeline-editor"><h4>逐秒运动时间轴</h4>${shot.motionPlan.map((item,index)=>`<div class="motion-timeline-row" data-motion-index="${index}"><span>${item.startSecond}–${item.endSecond}s</span><input data-motion-field="subjectMotion" value="${esc(item.subjectMotion)}" aria-label="主体动作"><select data-motion-field="amplitude">${['静止','微小','小','中','大'].map(value=>`<option ${value===item.amplitude?'selected':''}>${value}</option>`).join('')}</select><select data-motion-field="speed">${['静止','极慢','慢','中','快'].map(value=>`<option ${value===item.speed?'selected':''}>${value}</option>`).join('')}</select><input data-motion-field="cameraMotion" value="${esc(item.cameraMotion)}" aria-label="摄影机动作"></div>`).join('')}</div>`;}
  function renderStoryboard(){
    const ready=project.shots.filter(shot=>!shotReadiness(shot).length).length;
    root.innerHTML=`<section class="stage-head"><div><span>STEP 3 / DIRECTOR'S BOARD</span><h2>分镜设计</h2><p>每一镜都要明确“为什么切、从哪里开始、在哪里结束”，再锁定人物、空间和道具连续性。</p></div><div class="stage-head-actions"><span class="readiness-badge">${ready}/${project.shots.length} 可生产</span><button id="addShot" class="secondary-button">＋ 添加分镜</button></div></section><div class="storyboard-editor-list">${project.shots.map((shot,index)=>{const risks=shotReadiness(shot);return `<article class="storyboard-editor director-board ${risks.length?'has-risk':'ready'}" data-shot-id="${shot.id}"><header><span>SHOT ${String(index+1).padStart(2,'0')}</span><input data-shot-field="title" value="${esc(shot.title)}"><div class="shot-header-meta"><span class="shot-readiness ${risks.length?'needs-review':'ready'}">${risks.length?`${risks.length} 项待处理`:'可生产'}</span><small>REV ${shot.lifecycle.revision}</small><button data-delete-shot="${shot.id}" title="删除分镜">×</button></div></header><div class="shot-editor-grid professional"><section class="narrative-panel"><h3>01 · 叙事任务</h3><label>本镜新增的信息 / 情绪变化<textarea data-shot-field="narrativeFunction">${esc(shot.narrativeFunction)}</textarea></label><label>动作与台词<textarea data-shot-field="script">${esc(shot.script)}</textarea></label><label>声音设计<textarea data-shot-field="sound">${esc(shot.sound)}</textarea></label><div data-beat-claim>${beatClaimList(shot)}</div></section><section class="camera-panel"><h3>02 · 镜头执行</h3><div class="shot-controls three"><label>景别<input data-shot-field="shotSize" value="${esc(shot.shotSize)}"></label><label>运镜<input data-shot-field="cameraMovement" value="${esc(shot.cameraMovement)}"></label><label>场次<select data-shot-field="sceneId"><option value="">未分场</option>${project.scenes.map(scene=>`<option value="${scene.id}" ${scene.id===shot.sceneId?'selected':''}>${scene.sceneNumber}. ${esc(scene.heading)}</option>`).join('')}</select></label></div><div class="state-transition"><label>起始状态<textarea data-shot-field="startState">${esc(shot.startState)}</textarea></label><i>→</i><label>结束状态<textarea data-shot-field="endState">${esc(shot.endState)}</textarea></label></div><label>视频画面补充<small>实际 Prompt 由系统编译</small><textarea data-shot-field="visualDirection" placeholder="镜头之外仍需强调的构图、光线、材质">${esc(shot.visualDirection)}</textarea></label><details><summary>禁止变化项</summary><textarea data-shot-field="negativePrompt">${esc(shot.negativePrompt)}</textarea></details></section><aside class="continuity-panel"><h3>03 · 连续性锁定</h3>${risks.length?`<div class="continuity-warning"><b>${risks.length} 项待处理</b>${risks.map(reason=>`<span>${esc(reason)}</span>`).join('')}</div>`:'<div class="continuity-pass">✓ 连续性检查通过</div>'}<b>引用底图</b><div class="shot-reference-grid">${shotReferences(shot).map(file=>`<figure><img src="${file.url}" alt="${esc(file.name)}"><button data-remove-shot-asset="${file.id}">×</button></figure>`).join('')}<button class="add-shot-reference" data-pick-shot-assets="${shot.id}">＋<span>添加素材</span></button></div><div class="resource-match-list">${project.resources.map(resource=>`<label><input type="checkbox" data-shot-resource="${resource.id}" ${shot.resourceIds.includes(resource.id)?'checked':''}><span><b>${typeNames[resource.type]} · ${esc(resource.name)}</b><small>${resource.selectedTaskId?'已定稿':'缺少视觉版本'}</small></span></label>`).join('')}</div><label>服装 / 站位 / 道具 / 视线<textarea data-shot-field="continuityNotes">${esc(shot.continuityNotes)}</textarea></label><div class="shot-controls"><label>时长<select data-shot-field="duration">${optionList(durations,shot.duration,' 秒')}</select></label><label>画幅<select data-shot-field="aspectRatio">${optionList(ratios,shot.aspectRatio)}</select></label></div></aside></div><section class="compiled-shot-prompt"><header><b>实际提交给视频模型的 Prompt</b><span>由本镜全部设定实时合成</span></header><textarea data-compiled-shot-prompt readonly>${esc(shotVideoPrompt(shot))}</textarea></section><footer><span>${risks.length?'修改会自动保存；点右侧按钮重新检查连续性':'镜头已具备生产条件'}</span><button data-save-shot="${shot.id}" class="secondary-button">保存并检查</button></footer></article>`}).join('')||'<div class="project-library-empty"><b>还没有分镜</b><p>点右上角「＋ 添加分镜」建立第一镜：先选场次，再勾选这一镜要拍的剧本节拍，最后写起止状态和镜头语言。</p></div>'}</div><footer class="stage-action-bar"><div><button id="storyboardBack" class="secondary-button">← 资源生成</button><button id="saveAllShots" class="secondary-button">保存全部修改</button></div><div><button id="storyboardNext" class="stage-next">确认分镜，进入视频生成 →</button></div></footer>`;
    root.querySelectorAll('[data-shot-id]').forEach(card=>{const shot=project.shots.find(item=>item.id===card.dataset.shotId);const target=card.querySelector('.camera-panel .state-transition');if(shot&&target)target.insertAdjacentHTML('afterend',motionTimelineEditor(shot));});
    document.querySelector('#addShot').onclick=addShot;document.querySelector('#storyboardBack').onclick=()=>navigateStep('resources');document.querySelector('#saveAllShots').onclick=saveAllShots;document.querySelector('#storyboardNext').onclick=async()=>{await saveAllShots(true);advanceStep('video');};
    document.querySelectorAll('[data-save-shot]').forEach(button=>button.onclick=()=>saveShot(button.dataset.saveShot));document.querySelectorAll('[data-delete-shot]').forEach(button=>button.onclick=()=>deleteShot(button.dataset.deleteShot));document.querySelectorAll('[data-pick-shot-assets]').forEach(button=>button.onclick=()=>{const id=button.dataset.pickShotAssets;assetPickerShotId=assetPickerShotId===id?'':id;assetPickerQuery='';paintAssetPicker(id,true);});document.querySelectorAll('[data-remove-shot-asset]').forEach(button=>button.onclick=()=>removeAssetFromShot(button.closest('[data-shot-id]').dataset.shotId,button.dataset.removeShotAsset));
    root.querySelectorAll('[data-shot-id]').forEach(card=>{
      const id=card.dataset.shotId;
      const sync=()=>{readShotCard(id);refreshCompiledShotPrompt(id);refreshBeatTotal(id);queueSave('shots');};
      card.addEventListener('input',sync);
      card.addEventListener('change',event=>{ sync(); if(event.target.matches('[data-shot-field="sceneId"]'))paintBeatClaim(id); });
    });
    if(assetPickerShotId)paintAssetPicker(assetPickerShotId);
  }
  function beatClaimList(shot){
    const scene=project.scenes.find(item=>item.id===shot.sceneId);
    if(!scene)return '<div class="beat-claim empty">在「镜头执行」里选择场次后，可在此勾选本镜要拍的剧本节拍。</div>';
    const beats=scene.beats||[];
    if(!beats.length)return '<div class="beat-claim empty">这一场还没有节拍，回到第一步「剧本设计」补写。</div>';
    const claimed=new Set(shot.sourceBeatIds||[]);
    const seconds=beats.filter(beat=>claimed.has(beat.id)).reduce((sum,beat)=>sum+(Number(beat.estimatedSeconds)||beatSeconds(beat)),0);
    return `<div class="beat-claim"><header><b>本镜认领的剧本节拍</b><span data-beat-total class="${seconds>shot.duration?'over':''}">${Math.round(seconds*10)/10} / ${shot.duration} 秒</span></header><div>${beats.map(beat=>`<label><input type="checkbox" data-shot-beat="${beat.id}" ${claimed.has(beat.id)?'checked':''}><span><i>${beat.kind==='dialogue'?'台词':'动作'}</i>${esc(beat.kind==='dialogue'?`${beat.speaker||'角色'}：${beat.text}`:beat.text)}</span></label>`).join('')}</div></div>`;
  }
  function paintBeatClaim(id){ const card=document.querySelector(`[data-shot-id="${id}"]`); const shot=project.shots.find(item=>item.id===id); const host=card?.querySelector('[data-beat-claim]'); if(host&&shot)host.innerHTML=beatClaimList(shot); }
  function refreshBeatTotal(id){ const card=document.querySelector(`[data-shot-id="${id}"]`); const shot=project.shots.find(item=>item.id===id); const node=card?.querySelector('[data-beat-total]'); if(!node||!shot)return; const scene=project.scenes.find(item=>item.id===shot.sceneId); const claimed=new Set(shot.sourceBeatIds||[]); const seconds=(scene?.beats||[]).filter(beat=>claimed.has(beat.id)).reduce((sum,beat)=>sum+(Number(beat.estimatedSeconds)||beatSeconds(beat)),0); node.textContent=`${Math.round(seconds*10)/10} / ${shot.duration} 秒`; node.classList.toggle('over',seconds>shot.duration); }
  function refreshCompiledShotPrompt(id){ const card=document.querySelector(`[data-shot-id="${id}"]`); const shot=project.shots.find(item=>item.id===id); const output=card?.querySelector('[data-compiled-shot-prompt]'); if(output&&shot)output.value=shotVideoPrompt(shot); }
  function assetPickerItems(shot){ const query=assetPickerQuery.trim().toLowerCase(); const images=state.files.filter(file=>file.kind==='image'&&(!query||String(file.name).toLowerCase().includes(query))); const chosen=new Set(shot.referenceAssetIds||[]); return images.length?images.map(file=>`<button type="button" class="${chosen.has(file.id)?'chosen':''}" data-add-asset="${file.id}" data-shot-id="${shot.id}"><img src="${file.url}" alt="${esc(file.name)}" loading="lazy"><span>${esc(file.name)}</span></button>`).join(''):`<p>${query?'没有匹配的图片':'素材库还没有图片'}</p>`; }
  function assetPicker(shot){ return `<div class="shot-asset-picker"><header><b>素材库图片</b><input data-asset-search type="search" placeholder="搜索文件名" value="${esc(assetPickerQuery)}"><button data-close-asset-picker type="button" aria-label="关闭">×</button></header><div class="shot-asset-picker-grid">${assetPickerItems(shot)}</div></div>`; }
  function paintAssetPicker(shotId,focus=false){
    const card=document.querySelector(`[data-shot-id="${shotId}"]`); if(!card)return;
    card.querySelector('.shot-asset-picker')?.remove();
    if(assetPickerShotId!==shotId)return;
    const shot=project.shots.find(item=>item.id===shotId); const anchor=card.querySelector('.shot-reference-grid'); if(!shot||!anchor)return;
    anchor.insertAdjacentHTML('afterend',assetPicker(shot));
    const bind=()=>card.querySelectorAll('[data-add-asset]').forEach(button=>button.onclick=()=>toggleAssetOnShot(shotId,button.dataset.addAsset));
    const search=card.querySelector('[data-asset-search]');
    search?.addEventListener('input',()=>{assetPickerQuery=search.value;const grid=card.querySelector('.shot-asset-picker-grid');if(grid)grid.innerHTML=assetPickerItems(project.shots.find(item=>item.id===shotId));bind();});
    card.querySelector('[data-close-asset-picker]')?.addEventListener('click',()=>{assetPickerShotId='';paintAssetPicker(shotId);});
    bind(); if(focus)search?.focus();
  }
  function readShotCard(id){ const card=document.querySelector(`[data-shot-id="${id}"]`);const shot=project.shots.find(x=>x.id===id);if(!card||!shot)return;card.querySelectorAll('[data-shot-field]').forEach(field=>shot[field.dataset.shotField]=field.dataset.shotField==='duration'?Number(field.value):field.value);card.querySelectorAll('[data-motion-index]').forEach(row=>row.querySelectorAll('[data-motion-field]').forEach(field=>shot.motionPlan[Number(row.dataset.motionIndex)][field.dataset.motionField]=field.value));shot.sceneNumber=Math.max(1,project.scenes.findIndex(scene=>scene.id===shot.sceneId)+1);shot.resourceIds=[...card.querySelectorAll('[data-shot-resource]:checked')].map(input=>input.dataset.shotResource);if(card.querySelector('[data-shot-beat]'))shot.sourceBeatIds=[...card.querySelectorAll('[data-shot-beat]:checked')].map(input=>input.dataset.shotBeat);return shot; }
  function collectShot(id){ const shot=readShotCard(id); if(shot)shot.lifecycle={...shot.lifecycle,status:'reviewed',revision:(shot.lifecycle?.revision||1)+1,staleReasons:[]}; return shot; }
  async function saveShot(id){collectShot(id);await patch({shots:project.shots});toast('分镜已保存');}
  async function saveAllShots(quiet=false){project.shots.forEach(shot=>collectShot(shot.id));await patch({shots:project.shots},{quiet:true});if(!quiet){render(true);toast('全部分镜已保存');}}
  async function addShot(){const id=crypto.randomUUID();const last=project.shots[project.shots.length-1];project.shots.push({id,shotNumber:project.shots.length+1,sceneNumber:1,sceneId:last?.sceneId||project.scenes[0]?.id||'',title:`分镜 ${project.shots.length+1}`,sourceBeatIds:[],script:'',prompt:'',visualDirection:'',narrativeFunction:'',shotSize:'中景',cameraMovement:'固定',framing:'',startStateId:'',startState:last?.endState||'',action:'',endStateId:'',endState:'',continuityNotes:'',sound:'',negativePrompt:'禁止人物变脸、服装变化、道具消失、空间轴线跳变',duration:project.settings.shotDuration,aspectRatio:project.settings.aspectRatio,resourceIds:last?[...(last.resourceIds||[])]:[],referenceAssetIds:[],generation:{type:'TEXT',firstFrameAssetId:'',lastFrameAssetId:'',referenceAssetIds:[],quality:'720p'},lifecycle:{status:'draft',revision:1,staleReasons:[]},videoVersions:[],selectedVideoTaskId:'',tailFrameAssetId:''});await patch({shots:project.shots});const card=document.querySelector(`[data-shot-id="${id}"]`);card?.scrollIntoView({block:'center'});card?.querySelector('[data-shot-field="title"]')?.focus();}
  async function deleteShot(id){
    const shot=project.shots.find(item=>item.id===id);
    if(!shot)return;
    if(!professional()){
      if(!await confirmDelete({title:'确认删除分镜',message:'分镜一旦删除，无法恢复。'}))return;
      project.shots=project.shots.filter(item=>item.id!==id);
      await patch({shots:project.shots});
      return;
    }
    const generationIds=[...new Set([...(shot.videoVersions||[]),shot.selectedVideoTaskId,...(shot.pendingImageGenerations||[]).map(item=>item?.taskId)].filter(Boolean))];
    const generations=generationIds.map(task).filter(Boolean);
    if(generations.some(item=>['queued','running'].includes(item.status)))return toast('该分镜仍有任务正在生成，请等待完成后再删除');
    const hasGeneratedContent=generations.some(item=>item.status!=='failed');
    const firstMessage=hasGeneratedContent?'将删除该分镜、全部历史视频版本、关联云端文件和本机副本。':'分镜删除后无法恢复。';
    if(!await confirmDelete({title:'确认删除分镜',message:firstMessage}))return;
    if(hasGeneratedContent&&!await confirmDelete({title:'再次确认永久删除',message:'该分镜包含已生成内容。确认永久删除分镜及其全部视频文件吗？'}))return;
    await flushSave();
    const targetProjectId=project.id;
    try{
      const result=await api(`/api/drama/projects/${encodeURIComponent(targetProjectId)}/shots/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});
      if(project?.id!==targetProjectId)return;
      project=restoreLocalProjectOutputs(normalizeProjectData(result.project));
      projects=mergeDramaProjectList(projects,project);
      state.dramaProject=project;
      const deletedTaskIds=new Set(result.deletedTaskIds||generationIds);
      state.tasks=state.tasks.filter(item=>!deletedTaskIds.has(item.id));
      if(result.deletedAssetIds?.length&&removeCloudAssets)await removeCloudAssets(result.deletedAssetIds);
      professionalPreviewTaskIds.delete(id);
      professionalShotId=project.shots[0]?.id||'';
      professionalPreviewShotId=professionalShotId;
      render(true,{focus:false});
      toast('分镜及关联内容已删除');
    }catch(error){toast(error.message);}
  }
  async function toggleAssetOnShot(shotId,assetId){const shot=project.shots.find(x=>x.id===shotId);if(!shot)return;if(shot.referenceAssetIds.includes(assetId)){shot.referenceAssetIds=shot.referenceAssetIds.filter(id=>id!==assetId);}else{shot.referenceAssetIds.push(assetId);}await patch({shots:project.shots});}
  async function removeAssetFromShot(shotId,assetId){const shot=project.shots.find(x=>x.id===shotId);shot.referenceAssetIds=shot.referenceAssetIds.filter(id=>id!==assetId);for(const resource of project.resources){if(taskAsset(resource.selectedTaskId)?.id===assetId)shot.resourceIds=shot.resourceIds.filter(id=>id!==resource.id);}await patch({shots:project.shots});}

  function videoVersion(shot,id){const generation=task(id);const file=taskAsset(id);const selected=shot.selectedVideoTaskId===id;const syncing=taskSyncing(id);const ready=taskLocallyReady(id);const versionState=videoPreviewVersionState(generation,{ready,syncing});const pending=versionState==='pending'||versionState==='syncing';const missing=versionState==='missing';const status=generation?.status==='failed'?generationFailureMarkup(generation):pending?'生成中…':missing?'暂不可用':generation?({queued:'排队中',running:'生成中'}[generation.status]||generation.status):'记录缺失';return `<div class="video-version-wrap ${pending?'is-pending':''}"><button class="video-version ${selected?'selected':''}" data-select-video="${id}" data-shot-id="${shot.id}" ${ready?'':'disabled'}>${ready?workbenchVideoMarkup(file):`<span>${status}</span>`}<i>${selected&&ready?'✓ 当前版本':ready?'选择此版':pending?'生成中…':missing?'暂不可用':'等待完成'}</i></button>${pending?'':`<button type="button" class="video-version-delete" data-wb-delete-preview-video="${esc(id)}" data-wb-delete-preview-shot="${esc(shot.id)}" aria-label="删除${esc(shot.title)}视频版本" title="删除视频版本">×</button>`}</div>`;}
  function videoRoute(shot){
    const routing=state.config?.videoCapabilities?.routing||[];
    const firstLast=shot.generation.type==='FIRST&LAST'&&shot.duration===8;
    const route=routing.find(item=>firstLast
      ? item.mode==='FIRST&LAST'&&item.duration===shot.duration
      : item.mode==='TEXT|REFERENCE'&&(item.duration===shot.duration||item.durations?.includes(shot.duration)));
    return {engine:route?.label||(firstLast?'Veo 3.1 Fast':'GuGu 1.5'),note:firstLast?'首尾帧连续性':'标准视频生成'};
  }
  function shotVideoPrompt(shot){const scene=project.scenes.find(item=>item.id===shot.sceneId);const resources=(shot.resourceIds||[]).map(id=>project.resources.find(item=>item.id===id)).filter(Boolean);return buildShotVideoPrompt({project,shot,scene,resources});}
  function compiledShotVideoPrompt(shot){return shotVideoPrompt({...shot,promptOverride:''});}
  function videoRequestShot(shot,referenceAssetIds){if(shot?.generation?.type!=='TEXT'||!referenceAssetIds?.length)return shot;return {...shot,generation:{...shot.generation,type:'REFERENCE'}};}
  function shotReferenceIds(shot){return [...new Set([...professionalAssetIds(shot),...(shot.referenceAssetIds||[]),...(shot.generation?.referenceAssetIds||[]),...(shot.assetMentions||[]).map(item=>item.id)])].filter(Boolean);}
  function availableShotReferenceIds(shot){return shotReferenceIds(shot).filter(id=>asset(id));}
  function shotPreviewAssetIds(shot){return [...new Set([...shotReferenceIds(shot),shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId].filter(Boolean))];}
  function shotGenerationAssetIds(shot){if(shot.generation.type==='TEXT')return [];if(shot.generation.type==='FIRST&LAST')return [shot.generation.firstFrameAssetId,shot.generation.lastFrameAssetId].filter(id=>asset(id));return availableShotReferenceIds(shot);}
  function shotGenerationReady(shot){const count=shotGenerationAssetIds(shot).length;if(shot.generation.type==='TEXT')return true;if(shot.generation.type==='FIRST&LAST')return count>=1&&count<=professionalMaxImages(shot);return count>=1&&count<=professionalMaxImages(shot);}
  function professionalVideoModels(shot){const models=state.config?.videoCapabilities?.models;return Array.isArray(models)?models.filter(model=>{const supportsMode=Array.isArray(model.modes)&&model.modes.some(mode=>mode.generationType===shot.generation.type);return (model.enabled!==false||model.availability==='coming-soon')&&(supportsMode||model.availability==='coming-soon');}).map(model=>model.id==='grok'?{...model,modes:model.modes?.map(mode=>({...mode,durations:mode.durations?.filter(value=>Number(value)!==30)}))}:model).sort((a,b)=>{const aIsGugu2=a.id==='minimax-h3-15s';const bIsGugu2=b.id==='minimax-h3-15s';if(aIsGugu2!==bIsGugu2)return Number(bIsGugu2)-Number(aIsGugu2);return Number(a.availability==='coming-soon')-Number(b.availability==='coming-soon');}):[];}
  function professionalVideoParameters(shot){return professionalVideoModels(shot).find(model=>model.id===shot.generation.modelId)?.modes?.find(mode=>mode.generationType===shot.generation.type)||null;}
  function professionalMaxImages(shot){const parameters=professionalVideoParameters(shot);return parameters?.maxImages||parameters?.referenceLimits?.total||7;}
  function professionalReferenceLimit(shot){const parameters=professionalVideoParameters(shot);return parameters?.referenceLimits||{image:7,video:0,audio:0,total:professionalMaxImages(shot)};}
  function professionalVideoUsesDynamicQuote(shot){return ROUTED_VIDEO_MODEL_IDS.has(canonicalVideoModelId(shot?.generation?.modelId));}
  function professionalVideoQuoteInput(shot){const refs=shotGenerationAssetIds(shot);const requestShot=videoRequestShot(shot,refs);return buildDramaVideoQuoteInput(requestShot,refs.map(id=>asset(id)?.kind).filter(Boolean));}
  function professionalVideoQuoteEntry(shot){if(!professionalVideoUsesDynamicQuote(shot))return null;const input=professionalVideoQuoteInput(shot);return professionalVideoQuoteCache.get(dramaVideoQuoteSignature(input))||null;}
  function professionalVideoCostState(shot){
    const count=Math.max(1,Math.min(4,Number(shot.generation?.count)||1));
    if(professionalVideoUsesDynamicQuote(shot)){
      const entry=professionalVideoQuoteEntry(shot);
      if(entry?.status==='ready')return {ready:true,credits:Number(entry.quote.credits)*count,label:creditText(Number(entry.quote.credits)*count),message:'',priceVersion:entry.quote.priceVersion||''};
      if(entry?.status==='error')return {ready:false,credits:null,label:'暂不可用',message:entry.error||'当前参数暂时无法获取价格',priceVersion:''};
      return {ready:false,credits:null,label:'…',message:'正在获取当前价格',priceVersion:''};
    }
    const billable=videoRequestShot(shot,shotGenerationAssetIds(shot));const parameters=professionalVideoParameters(billable);const selectedPricing=parameters?.pricingByQuality?.[shot.generation?.quality]||parameters?.pricing;
    const credits=selectedPricing?.unit==='request'?Number(selectedPricing.amount)/Number(state.pricing.yuanPerCredit||0.1)*count:selectedPricing?.unit==='second'?shot.duration*Number(selectedPricing.amount)*count:shot.duration*state.pricing.videoPerSecond*count;
    return {ready:true,credits,label:creditText(credits),message:'',priceVersion:''};
  }
  async function requestProfessionalVideoQuote(shot,{force=false}={}){
    if(!professionalVideoUsesDynamicQuote(shot))return null;
    const input=professionalVideoQuoteInput(shot);const signature=dramaVideoQuoteSignature(input);const current=professionalVideoQuoteCache.get(signature);
    if(current?.status==='loading')return current.promise;
    if(!force&&current?.status==='ready')return current.quote;
    if(!force&&current?.status==='error')return null;
    const entry={status:'loading',quote:null,error:'',promise:null};professionalVideoQuoteCache.set(signature,entry);patchProfessionalQuoteSurfaces();
    entry.promise=api('/api/model-quote',{method:'POST',body:JSON.stringify(input)}).then(quote=>{if(professionalVideoQuoteCache.get(signature)!==entry)return quote;entry.status='ready';entry.quote=quote;patchProfessionalQuoteSurfaces();return quote;}).catch(error=>{if(professionalVideoQuoteCache.get(signature)===entry){entry.status='error';entry.error=error.message||'当前参数暂时无法获取价格';patchProfessionalQuoteSurfaces();}throw error;});
    return entry.promise;
  }
  function scheduleProfessionalVideoQuote(shot){if(!professionalVideoUsesDynamicQuote(shot))return;void requestProfessionalVideoQuote(shot).catch(()=>{});}
  function ensureProfessionalVideoSettings(shot){
    if(!shot?.generation)return {models:[],parameters:null,modelId:''};
    const models=professionalVideoModels(shot);
    const current=String(shot.generation.modelId||'');
    const currentModel=models.find(model=>model.id===current&&professionalModelIsAvailable(model));
    const compatibleModel=models.find(model=>professionalModelIsAvailable(model)&&model.modes?.some(mode=>mode.generationType===shot.generation.type&&mode.aspectRatios.includes(shot.aspectRatio)&&mode.durations.includes(Number(shot.duration))&&mode.qualityOptions.includes(shot.generation.quality)));
    const selected=currentModel||compatibleModel||models.find(model=>shot.generation.type==='FIRST&LAST'&&['veo','veo-31'].includes(model.id)&&professionalModelIsAvailable(model))||models.find(professionalModelIsAvailable);
    const modelId=selected?.id||'';
    const parameters=selected?.modes?.find(mode=>mode.generationType===shot.generation.type)||null;
    shot.generation.modelId=modelId;
    normalizeShotVideoParameters(shot,parameters);
    return {models,parameters,modelId};
  }
  function videoReferencePicker(shot){const selected=new Set(shot.generation.referenceAssetIds||[]);const images=imageAssets().filter(file=>!selected.has(file.id));return `<div class="video-reference-picker"><header><b>添加控制图</b><button type="button" data-close-video-assets="${shot.id}" aria-label="关闭素材选择">×</button></header>${images.length?`<div>${images.map(file=>`<button type="button" data-add-video-asset="${file.id}" data-shot-id="${shot.id}"><img src="${file.url}" alt="${esc(file.name)}"><span>${esc(file.name)}</span></button>`).join('')}</div>`:'<p>没有其他可添加的图片</p>'}</div>`;}
  function enhanceVideoReferenceEditor(card,shot){if(shot.generation.type!=='REFERENCE')return;const strip=card.querySelector('.video-ref-strip');if(!strip)return;const ids=shotGenerationAssetIds(shot);const refs=ids.map(id=>asset(id)).filter(Boolean);strip.classList.add('editable');strip.dataset.videoReferenceList=shot.id;strip.innerHTML=`${refs.map((file,index)=>`<figure draggable="true" tabindex="0" data-video-reference-id="${file.id}"><img src="${file.url}" alt="${esc(file.name)}"><figcaption>参考 ${index+1}</figcaption><button type="button" data-remove-video-asset="${file.id}" data-shot-id="${shot.id}" aria-label="删除参考 ${index+1}">×</button><i aria-hidden="true">⋮⋮</i></figure>`).join('')}${refs.length<professionalMaxImages(shot)?`<button type="button" class="add-video-reference" data-pick-video-assets="${shot.id}">＋<span>添加</span></button>`:''}`;if(videoAssetPickerShotId===shot.id)strip.insertAdjacentHTML('afterend',videoReferencePicker(shot));}
  async function updateVideoReferenceIds(shotId,ids){const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;shot.generation.referenceAssetIds=[...new Set(ids)].filter(id=>asset(id)?.kind==='image').slice(0,professionalMaxImages(shot));await patch({shots:project.shots});}
  async function addVideoReference(shotId,assetId){const shot=project.shots.find(item=>item.id===shotId);if(!shot||shot.generation.referenceAssetIds.includes(assetId))return;const maxImages=professionalMaxImages(shot);if(shot.generation.referenceAssetIds.length>=maxImages)return toast(`参考元素最多使用 ${maxImages} 张图片`);shot.generation.referenceAssetIds.push(assetId);await patch({shots:project.shots});}
  async function removeVideoReference(shotId,assetId){const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;shot.generation.referenceAssetIds=shot.generation.referenceAssetIds.filter(id=>id!==assetId);await patch({shots:project.shots});}
  function bindVideoReferenceEditors(){document.querySelectorAll('[data-video-shot]').forEach(card=>enhanceVideoReferenceEditor(card,project.shots.find(item=>item.id===card.dataset.videoShot)));document.querySelectorAll('[data-pick-video-assets]').forEach(button=>button.onclick=()=>{videoAssetPickerShotId=videoAssetPickerShotId===button.dataset.pickVideoAssets?'':button.dataset.pickVideoAssets;render();});document.querySelectorAll('[data-close-video-assets]').forEach(button=>button.onclick=()=>{videoAssetPickerShotId='';render();});document.querySelectorAll('[data-add-video-asset]').forEach(button=>button.onclick=()=>addVideoReference(button.dataset.shotId,button.dataset.addVideoAsset));document.querySelectorAll('[data-remove-video-asset]').forEach(button=>button.onclick=()=>removeVideoReference(button.dataset.shotId,button.dataset.removeVideoAsset));document.querySelectorAll('[data-video-reference-list]').forEach(list=>{let dragged=null;list.querySelectorAll('[data-video-reference-id]').forEach(item=>{item.ondragstart=event=>{dragged=item;item.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',item.dataset.videoReferenceId);};item.ondragend=()=>{item.classList.remove('dragging');dragged=null;};item.ondragover=event=>{event.preventDefault();if(!dragged||dragged===item)return;const before=event.clientX<item.getBoundingClientRect().left+item.offsetWidth/2;list.insertBefore(dragged,before?item:item.nextSibling);};item.ondrop=event=>{event.preventDefault();updateVideoReferenceIds(list.dataset.videoReferenceList,[...list.querySelectorAll('[data-video-reference-id]')].map(node=>node.dataset.videoReferenceId));};item.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const ordered=[...list.querySelectorAll('[data-video-reference-id]')];const index=ordered.indexOf(item);const next=event.key==='ArrowLeft'?index-1:index+1;if(next<0||next>=ordered.length)return;const ids=ordered.map(node=>node.dataset.videoReferenceId);[ids[index],ids[next]]=[ids[next],ids[index]];updateVideoReferenceIds(list.dataset.videoReferenceList,ids);};});});}
  function renderVideo(){const completed=project.shots.filter(shot=>taskLocallyReady(shot.selectedVideoTaskId)).length;const final=asset(project.finalAssetId);const finalReady=Boolean(final&&!assetSyncing(final));const finalActionLabel='在文件夹中显示';root.innerHTML=`<section class="stage-head"><div><span>STEP 4 / VIDEO RUN</span><h2>视频生成</h2><p>先为每个镜头选择生成策略。首尾帧适合动作衔接；参考元素适合锁定人物、场景和物品。</p></div><div class="stage-head-actions"><span class="completion-count">${completed}<small> / ${project.shots.length} 镜头就绪</small></span></div></section><div class="video-shot-list">${project.shots.map(shot=>{const ids=shotGenerationAssetIds(shot);const refs=ids.map(id=>asset(id)).filter(Boolean);const selected=task(shot.selectedVideoTaskId);const mode=shot.generation.type;const incompatible=mode==='REFERENCE'&&shot.aspectRatio==='9:16';const capabilityWarning=professionalProductionWarning(shot);const cost=professionalVideoCostState(shot);const productionReady=!capabilityWarning&&shotGenerationReady(shot)&&cost.ready;return `<article class="video-shot production-card ${productionReady?'':'has-risk'}" data-video-shot="${shot.id}"><header><span>${String(shot.shotNumber).padStart(2,'0')}</span><div><b>${esc(shot.title)}</b><p>${generationModeName(mode)} · ${shot.duration} 秒 · ${shot.aspectRatio} · ${refs.length} 张控制图</p></div><button data-generate-shot-video="${shot.id}" ${productionReady?'':'disabled'} title="${esc(capabilityWarning||cost.message||'')}">${productionReady?(shot.videoVersions.length?'再生成一版':'生成视频'):capabilityWarning?'请先完成策略配置':cost.label}${productionReady?` · ${cost.label} 积分`:''}</button></header><div class="video-production-grid"><section class="generation-strategy"><h3>生成策略</h3><div class="generation-mode-switch">${['TEXT','FIRST&LAST','REFERENCE'].map(value=>`<button data-generation-mode="${value}" data-shot-id="${shot.id}" class="${mode===value?'active':''}"><b>${generationModeName(value)}</b><small>${value==='TEXT'?'只使用镜头提示词':value==='FIRST&LAST'?'1～2 张图，固定 8 秒':'1～3 张元素图，可选时长与画幅'}</small></button>`).join('')}</div><div class="generation-config">${mode==='FIRST&LAST'?`<label>首帧<select data-generation-field="firstFrameAssetId">${frameOptions(shot.generation.firstFrameAssetId)}</select></label><label>尾帧（可选）<select data-generation-field="lastFrameAssetId">${frameOptions(shot.generation.lastFrameAssetId)}</select></label>${capabilityWarning?`<div class="mode-warning">${esc(capabilityWarning)}</div>`:''}`:mode==='REFERENCE'?`<p>使用分镜中已锁定的角色、场景与物品底图，模型最多取当前能力范围内的参考素材。</p>${capabilityWarning?`<div class="mode-warning">${esc(capabilityWarning)}</div>`:incompatible?'<div class="mode-warning">参考元素暂不支持 9:16，请使用 16:9。</div>':''}`:`<p>不上传控制图，模型根据镜头执行提示词自由生成。</p>${capabilityWarning?`<div class="mode-warning">${esc(capabilityWarning)}</div>`:''}`}<label>清晰度<select data-generation-field="quality"><option ${shot.generation.quality==='720p'?'selected':''}>720p</option><option ${shot.generation.quality==='1080p'?'selected':''}>1080p</option><option ${shot.generation.quality==='4k'?'selected':''}>4k</option></select></label><button data-save-generation="${shot.id}" class="secondary-button">保存策略</button></div></section><section class="generation-inputs"><h3>控制画面</h3><div class="video-ref-strip large">${refs.map((file,index)=>`<figure><img src="${file.url}" alt="${esc(file.name)}"><figcaption>${mode==='FIRST&LAST'?(index?'尾帧':'首帧'):'参考 '+(index+1)}</figcaption></figure>`).join('')||'<span>当前没有可用的控制图片</span>'}</div><h3>镜头执行提示词</h3><p>${esc(shot.prompt)}</p><details><summary>连续性约束</summary><p>${esc([shot.continuityNotes,shot.negativePrompt].filter(Boolean).join('；'))}</p></details></section><section class="generation-results"><h3>生成版本</h3><div class="video-versions">${shot.videoVersions.length?shot.videoVersions.map(id=>videoVersion(shot,id)).join(''):'<div class="version-empty">还没有视频版本</div>'}</div>${taskLocallyReady(shot.selectedVideoTaskId)?`<footer><button data-tail-frame="${shot.id}" class="secondary-button">提取尾帧</button>${shot.tailFrameAssetId?'<span>✓ 已保存，可设为下一镜首帧</span>':''}</footer>`:''}</section></div></article>`}).join('')}</div><section class="final-cut"><div><span>FINAL CUT</span><b>${finalReady?'成片已生成':final?'成片生成中…':'所有分镜确认后，一键拼接成片'}</b><p>${finalReady?'完整视频已保存到素材库，可以预览或在文件夹中查看。':final?'完整视频正在生成中，请稍后预览。':'按分镜顺序拼接选中的视频版本，不重复产生模型费用。'}</p></div>${finalReady?`${workbenchVideoMarkup(final)}<button type="button" class="secondary-button">${finalActionLabel}</button>`:final?'<div class="wb-preview-empty"><span class="wb-preview-play">⌁</span><b>完整成片生成中…</b></div>':`<button id="assembleProject" class="stage-next" ${completed!==project.shots.length||!project.shots.length?'disabled':''}>一键成片</button>`}</section><footer class="stage-action-bar"><div><button id="videoBack" class="secondary-button">← 分镜设计</button></div><div><button id="generateAllVideos" class="gradient-button">一键生成未完成镜头</button></div></footer>`;
    const finalDownload = root.querySelector('.final-cut button.secondary-button');
    if (finalDownload && final && showAssetInFolder) {
      finalDownload.textContent = '在文件夹中显示';
      finalDownload.onclick = event => { event.preventDefault(); void showAssetInFolder(final, finalDownload); };
    }
    document.querySelectorAll('[data-generation-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
    document.querySelectorAll('[data-video-shot]').forEach(card=>{const shot=project.shots.find(item=>item.id===card.dataset.videoShot);const mode=shot.generation.type;const route=videoRoute(shot);const summary=card.querySelector(':scope > header p');if(summary)summary.textContent+=` · ${route.engine}`;const modeHints=card.querySelectorAll('[data-generation-mode] small');if(modeHints[0])modeHints[0].textContent='仅提示词，可选时长与画幅';if(modeHints[1])modeHints[1].textContent='1～2 张图，固定 8 秒';if(modeHints[2])modeHints[2].textContent='1～7 张元素图，可选时长与画幅';const config=card.querySelector('.generation-config');if(mode==='REFERENCE'){config.querySelector('p').textContent='使用分镜中锁定的角色、场景与物品底图，最多取 7 张。';config.querySelectorAll('.mode-warning').forEach(node=>{if(node.textContent.includes('暂不支持 9:16'))node.remove();});}const quality=config.querySelector('[data-generation-field="quality"]');const qualityOptions=professionalVideoParameters(shot)?.qualityOptions||['720p'];const selectedQuality=qualityOptions.some(value=>String(value)===String(shot.generation.quality))?shot.generation.quality:qualityOptions[0];quality.innerHTML=qualityOptions.map(value=>`<option value="${esc(value)}" ${String(value)===String(selectedQuality)?'selected':''}>${esc(value)}</option>`).join('');quality.disabled=false;quality.closest('label').insertAdjacentHTML('beforebegin',`<div class="video-route-card"><span>自动匹配</span><b>${route.engine}</b><small>${route.note}</small></div><div class="video-parameter-grid"><label>时长<select data-video-field="duration" ${mode==='FIRST&LAST'?'disabled':''}>${optionList(mode==='FIRST&LAST'?[8]:durations,shot.duration,' 秒')}</select></label><label>画幅<select data-video-field="aspectRatio">${optionList(mode==='FIRST&LAST'?['9:16','16:9']:ratios,shot.aspectRatio)}</select></label></div>`);const promptPanel=card.querySelector('.generation-inputs');const promptTitle=promptPanel.querySelectorAll('h3')[1];const promptText=promptTitle?.nextElementSibling;if(promptTitle)promptTitle.textContent='实际提交给视频模型的 Prompt';if(promptText){promptText.textContent=shotVideoPrompt(shot);promptText.classList.add('compiled-video-prompt');}});
    document.querySelectorAll('[data-video-shot]').forEach(card=>{const shot=project.shots.find(item=>item.id===card.dataset.videoShot);const preview=card.querySelector('.compiled-video-prompt');if(!shot||!preview)return;const systemPrompt=compiledShotVideoPrompt(shot);const editor=document.createElement('textarea');editor.className='compiled-video-prompt editable-video-prompt';editor.dataset.promptOverride=shot.id;editor.dataset.systemPrompt=systemPrompt;editor.value=shot.promptOverride||systemPrompt;preview.replaceWith(editor);const hint=document.createElement('small');hint.className='prompt-edit-hint';hint.textContent=shot.promptOverride?'当前使用手动版本；清空并保存可恢复系统版本。':'可直接修改；保存后将按此内容提交。';editor.insertAdjacentElement('afterend',hint);const save=card.querySelector('[data-save-generation]');if(save)save.textContent='保存本镜设置';});
    bindVideoReferenceEditors();document.querySelector('#videoBack').onclick=()=>navigateStep('storyboard');document.querySelector('#generateAllVideos').onclick=generateAllVideos;document.querySelector('#assembleProject')?.addEventListener('click',assemble);document.querySelectorAll('[data-generation-mode]').forEach(button=>button.onclick=()=>setGenerationMode(button.dataset.shotId,button.dataset.generationMode));document.querySelectorAll('[data-save-generation]').forEach(button=>button.onclick=()=>saveGenerationConfig(button.dataset.saveGeneration));document.querySelectorAll('[data-generate-shot-video]').forEach(button=>button.onclick=()=>generateShotVideo(button.dataset.generateShotVideo,button));document.querySelectorAll('[data-select-video]').forEach(button=>button.onclick=()=>selectVideo(button.dataset.shotId,button.dataset.selectVideo));document.querySelectorAll('[data-wb-delete-preview-video]').forEach(button=>button.onclick=event=>{event.stopPropagation();void deletePreviewVideo(button.dataset.wbDeletePreviewShot,button.dataset.wbDeletePreviewVideo,button);});document.querySelectorAll('[data-tail-frame]').forEach(button=>button.onclick=()=>extractTail(button.dataset.tailFrame,button));project.shots.forEach(scheduleProfessionalVideoQuote);
  }
  async function setGenerationMode(id,mode){const shot=project.shots.find(x=>x.id===id);shot.generation.type=mode;videoAssetPickerShotId='';if(mode==='FIRST&LAST')shot.duration=8;if(mode==='FIRST&LAST'&&!shot.generation.firstFrameAssetId)shot.generation.firstFrameAssetId=selectedResourceAssetIds(shot)[0]||'';if(mode==='REFERENCE'&&!shot.generation.referenceAssetIds.length)shot.generation.referenceAssetIds=selectedResourceAssetIds(shot).slice(0,professionalMaxImages(shot));await patch({shots:project.shots});}
  async function saveGenerationConfig(id){const card=document.querySelector(`[data-video-shot="${id}"]`);const shot=project.shots.find(x=>x.id===id);if(!card||!shot)return null;card.querySelectorAll('[data-generation-field]').forEach(field=>shot.generation[field.dataset.generationField]=field.value);card.querySelectorAll('[data-video-field]').forEach(field=>shot[field.dataset.videoField]=field.dataset.videoField==='duration'?Number(field.value):field.value);const promptEditor=card.querySelector('[data-prompt-override]');if(promptEditor){const value=promptEditor.value.trim().slice(0,4000);shot.promptOverride=value&&value!==promptEditor.dataset.systemPrompt?value:'';}ensureProfessionalVideoSettings(shot);const updated=await patch({shots:project.shots});toast('本镜设置已保存');return updated?.shots?.find(item=>item.id===id)||null;}
  async function generateShotVideo(id,button){let shot=project.shots.find(x=>x.id===id);if(!shot)return;shot=await saveGenerationConfig(id)||project.shots.find(x=>x.id===id);if(!shot)return;ensureProfessionalVideoSettings(shot);if(!shot.generation.modelId)return toast('当前没有可用的视频模型，请稍后再试。');const warning=professionalProductionWarning(shot);if(warning)return toast(warning);const referenceAssetIds=shotGenerationAssetIds(shot);const requestShot=videoRequestShot(shot,referenceAssetIds);const finalPrompt=shotVideoPrompt(requestShot);button=document.querySelector(`[data-generate-shot-video="${id}"]`)||button;button.disabled=true;button.textContent='正在提交…';try{const cloudRefs=await ensureCloudReferenceIds(referenceAssetIds);const quote=professionalVideoUsesDynamicQuote(shot)?await requestProfessionalVideoQuote(shot,{force:true}):null;if(professionalVideoUsesDynamicQuote(shot)&&!quote?.priceVersion)throw new Error('当前线路价格确认失败，请稍后重试');const generation=await api('/api/generations',{method:'POST',body:JSON.stringify({type:'video',prompt:finalPrompt,dramaProjectId:project.id,dramaShotId:id,modelId:shot.generation.modelId,aspectRatio:shot.aspectRatio,duration:shot.duration,quality:shot.generation.quality,generationType:requestShot.generation.type,referenceAssetIds:cloudRefs,...(quote?.priceVersion?{expectedPriceVersion:quote.priceVersion}:{})})});setCreditBalance(generation.balance);state.tasks=[generation,...state.tasks.filter(x=>x.id!==generation.id)];const result=await api(`/api/drama/projects/${project.id}/shots/${id}/videos`,{method:'POST',body:JSON.stringify({taskId:generation.id})});project=result.project;state.dramaProject=project;render();toast(`分镜视频已提交，预扣 ${generation.creditCost} 积分`);}catch(error){toast(error.message);button.disabled=false;button.textContent='重新生成';}}
  async function generateAllVideos(){const pending=project.shots.filter(shot=>task(shot.selectedVideoTaskId)?.status!=='completed');const targets=pending.filter(shot=>{ensureProfessionalVideoSettings(shot);return !professionalProductionWarning(shot)&&shotGenerationReady(shot);});if(!pending.length)return toast('所有分镜都已完成');if(!targets.length)return toast('请先完成镜头的生成策略配置');for(const shot of targets){const button=document.querySelector(`[data-generate-shot-video="${shot.id}"]`);if(button)await generateShotVideo(shot.id,button);}toast(targets.length===pending.length?'未完成镜头已全部提交':`已提交 ${targets.length} 个镜头，其余镜头需要补充控制图`);}
  async function selectVideo(shotId,taskId){const shot=project.shots.find(x=>x.id===shotId);if(!shot||!taskLocallyReady(taskId))return taskSyncing(taskId)?toast('视频正在保存到本地，请稍后选择'):undefined;shot.selectedVideoTaskId=taskId;await patch({shots:project.shots});}
  async function extractTail(shotId,button){button.disabled=true;button.textContent='正在提取…';try{const shot=project.shots.find(item=>item.id===shotId);if(!shot)throw new Error('分镜不存在');const result=await extractDramaTailLocally(shot);shot.tailFrameAssetId=result.id;const index=project.shots.findIndex(x=>x.id===shotId);if(index>=0&&index<project.shots.length-1){const next=project.shots[index+1];next.generation.type='FIRST&LAST';next.generation.firstFrameAssetId=result.id;next.duration=8;next.lifecycle.staleReasons=[...new Set([...(next.lifecycle.staleReasons||[]),'已接入上一镜尾帧，请确认结束状态'])];await patch({shots:project.shots},{quiet:true});}render();toast(index<project.shots.length-1?'尾帧已保存，并设为下一镜首帧':'尾帧已保存到本地文件库');}catch(error){toast(error.message);button.disabled=false;}}
  async function assemble(){const button=document.querySelector('#assembleProject');button.disabled=true;button.textContent='正在拼接成片…';try{await assembleDramaLocally();render();toast('完整成片已生成并保存在本地文件库');}catch(error){toast(error.message);button.disabled=false;button.textContent='重新一键成片';}}

  document.querySelector('#dramaTopBack').onclick=closeProject;
  async function saveProjectTitle(input=document.querySelector('#dramaProjectTitle')){if(!project||!input)return;const title=input.value.trim()||'未命名剧本';input.value=title;if(title===project.title){syncProjectHeader();return;}try{await patch({title},{quiet:true});syncProjectHeader();}catch(error){syncProjectHeader();}}
  const projectTitleInput=document.querySelector('#dramaProjectTitle');
  projectTitleInput.onchange=()=>{void saveProjectTitle(projectTitleInput);};
  projectTitleInput.onkeydown=event=>{if(event.key!=='Enter')return;event.preventDefault();event.stopPropagation();void saveProjectTitle(projectTitleInput);};
  return { load, render, refreshTasks, refreshProject, modelState, get project(){return project;} };
}
