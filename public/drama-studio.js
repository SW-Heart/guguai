import { createDramaStyleDialog } from './features/drama/style-dialog.js?v=2';
import { imageThumbnailUrl } from './features/media/thumbnail-url.js?v=2';
import { createWorkbenchMediaController } from './features/drama/workbench-media.js?v=1';
import { defaultVideoDuration } from './features/generation/video-defaults.js?v=2';
import { createRecordIndexes } from './state/records.js?v=2';
import { modelLogoUrls, modelLogoMarkup } from './components/model-logo.js?v=5';
import { isRemoteReferenceReady, withoutSupersededLocalFiles } from './desktop-media-sync.js?v=15';
import { createDirectorWorkspace } from './features/drama/director-workspace.js?v=175';
import { canvasSnapshotKey, readCanvasSnapshot, writeCanvasSnapshot, deleteCanvasSnapshot } from './features/drama/local-snapshot.js?v=1';
import { buildResourceImagePrompt } from './resource-prompt.js?v=4';
import { buildShotVideoPrompt, orderedShotReferenceMentions, videoPromptMaxLength } from './video-prompt.js?v=6';
import {
  buildDramaVideoQuoteInput,
  calculateVirtualShotRange,
  clampVirtualScrollOffset,
  dramaVideoQuoteSignature,
  generationNeedsLocalAssetSync,
  isMountedVirtualShotScroll,
  mergeDramaProjectList,
  mergeProjectResponseWithNewerKeys,
  normalizeShotVideoParameters,
  removeAssemblyVideoAssets,
  shotPreviewContentSignatureFromMaps,
  shotPreviewContentSignature,
  shotPreviewRenderSignature,
  videoPreviewVersionState as resolveVideoPreviewVersionState,
  videoTaskProgress,
} from './features/drama/pure.js?v=4';
import { mergeProjectThreeWay, projectConflictChoiceMap } from './features/drama/merge.js?v=2';
import { createPromptOptimizationDialog, promptOptimizationButton } from './features/drama/prompt-optimization.js?v=4';
import { createVideoGenerationLoadingController, renderVideoGenerationLoading, updateVideoGenerationProgress } from './features/drama/video-generation-loading.js?v=1';

export {
  buildDramaVideoQuoteInput,
  calculateVirtualShotRange,
  clampVirtualScrollOffset,
  dramaVideoQuoteSignature,
  generationNeedsLocalAssetSync,
  isMountedVirtualShotScroll,
  mergeDramaProjectList,
  mergeProjectResponseWithNewerKeys,
  normalizeShotVideoParameters,
  removeAssemblyVideoAssets,
  shotPreviewContentSignatureFromMaps,
  shotPreviewContentSignature,
  shotPreviewRenderSignature,
  resolveVideoPreviewVersionState as videoPreviewVersionState,
  videoTaskProgress,
  mergeProjectThreeWay,
  projectConflictChoiceMap,
};

const durations = [8,10,15,20];
const ratios = ['9:16','16:9','1:1','2:3','3:2'];
const imageRatios = ['1:1','3:4','4:3','9:16','16:9','3:2','2:3','1:2','2:1','5:4','4:5'];
const imageQualities = [['low','低'],['medium','中'],['high','高']];
const DEFAULT_SHOT_TITLE = '未命名分镜';
const LEGACY_GUGU_2_MODEL_ID = 'grok-15';
const MINIMAX_H3_15S_MODEL_ID = 'minimax-h3-15s';
const ROUTED_VIDEO_MODEL_IDS = new Set(['seedance-2.0','seedance-2.0-mini','seedance-2.0-fast','seedance-2.5','seedance-2.0-value','seedance-2.5-value']);
const canonicalVideoModelId = value => String(value || '').trim().toLowerCase() === LEGACY_GUGU_2_MODEL_ID ? MINIMAX_H3_15S_MODEL_ID : String(value || '').trim();
const PREVIEW_PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5z"/></svg>';
const stepOrder = ['script','resources','storyboard','video'];
const stepNames = { script:'剧本设计', resources:'素材生成', storyboard:'分镜设计', video:'视频生成' };
const typeNames = { character:'角色', location:'场景', prop:'物品' };
const richEditorEmptyChar = '\u200B';

export function createDramaStudio({ api: requestApi, promptPrecheck = { check:async ({ prompts }) => ({ action:'submit', prompts, fields:{} }) }, state, esc, toast, setCreditBalance, creditText, loadTasks, scheduleTaskPoll = () => {}, loadCredits, loadFiles, uploadImage, uploadAsset, importCanvasAsset = null, registerCanvasFile, importLocalMedia = async () => null, loadReferenceFiles, confirmDelete, taskFailure, isAssetSyncing = () => false, localDeliveryMarkup = () => '', localDeliverySignature = () => '', retryLocalDownload = () => {}, showAssetInFolder = null, removeCloudAssets = null, syncDesktopDeliveries = null, accountSnapshot = () => null, isAccountCurrent = () => true, getDesktopSyncInfo = () => ({}), renderProjectList = () => {}, onProjectViewChange = () => {} }) {
  const root = document.querySelector('#dramaStage');
  let directorWorkspaceView;
  let projects = [];
  let renameProjectId = '';
  // A newly created project is shown even when creation started on another page.
  let openingCreatedProject = false;
  let renameProjectRestoreFocus = null;
  const deletingProjectIds = new Set();
  let project = null;
  // Bind every image/video submission made by this short-drama controller,
  // including its embedded canvas. Other creation modules keep their own API.
  const api = (url, options = {}) => {
    if(url === '/api/generations' && options.method === 'POST' && project){
      const body=JSON.parse(options.body || '{}');
      if(!body.dramaProjectId)body.dramaProjectId=project.id;
      if(body.dramaProjectId===project.id && body.dramaStyleRevision===undefined)body.dramaStyleRevision=project.style?.revision || 0;
      return requestApi(url,{...options,body:JSON.stringify(body)});
    }
    return requestApi(url,options);
  };
  let projectBaseSnapshot = null;
  let canvasChangeVersion=0;
  const snapshotKey = (id, kind='project', account=accountSnapshot()) => canvasSnapshotKey({ userId:account?.userId, deviceId:getDesktopSyncInfo()?.deviceId, workspaceId:getDesktopSyncInfo()?.workspaceId, projectId:id, kind });
  const cacheProject = (value, account=accountSnapshot()) => { if(value?.mode==='smart') void writeCanvasSnapshot(snapshotKey(value.id,'project',account),value); };
  let projectTitleEditing = false;
  let projectTitleDraft = '';
  let viewStep = null;
  let busy = false;
  let busyAccount = null;
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
  let mentionPicker = { shotId:'', editor:null, range:null, query:'' };
  let mentionDismissBound = false;
  let workbenchDropdownDismissBound = false;
  const workbenchMedia = createWorkbenchMediaController();
  const videoGenerationLoading = createVideoGenerationLoadingController();
  const shotPreviewSignatures = new Map();
  const professionalPreviewTaskIds = new Map();
  // Keep the short request hand-off state on the shot. The preview can react
  // immediately without turning the generate button into a progress label.
  let priceRefreshTimer = 0;
  let priceRefreshPromise = null;
  let priceRefreshAt = 0;
  let priceRefreshEpoch = 0;
  function refreshProfessionalPrices({force=false}={}){
    if(state.route!=='drama')return Promise.resolve();
    if(priceRefreshPromise)return priceRefreshPromise;
    if(!force&&Date.now()-priceRefreshAt<30000)return Promise.resolve();
    const epoch=priceRefreshEpoch;
    const account=accountSnapshot();
    priceRefreshAt=Date.now();
    let timeout;
    priceRefreshPromise=Promise.race([
      api('/api/config'),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Price refresh timeout')),10000);}),
    ]).then(config=>{
      if(epoch!==priceRefreshEpoch||!isAccountCurrent(account)||state.route!=='drama')return;
      // Keep the last usable catalog on failed/incomplete refreshes. Never clear the button.
      if(Array.isArray(config.modelPrices)&&config.modelPrices.length){
        state.config={...state.config,...config,modelPrices:config.modelPrices};
      }
      if(config.pricing)state.pricing={...state.pricing,image:config.pricing.imagePerRequest,videoPerSecond:config.pricing.videoPerSecond};
      root.querySelectorAll('[data-wb-shot]').forEach(card=>refreshWorkbenchShotStatus(card,project?.shots.find(shot=>shot.id===card.dataset.wbShot)));
    }).catch(()=>{}).finally(()=>{
      clearTimeout(timeout);
      if(epoch===priceRefreshEpoch)priceRefreshPromise=null;
    });
    return priceRefreshPromise;
  }
  function startProfessionalPriceRefresh(){
    if(priceRefreshTimer)return;
    void refreshProfessionalPrices({force:true});
    priceRefreshTimer=setInterval(()=>{void refreshProfessionalPrices();},30000);
  }
  const professionalGenerationPending = new Set();
  let virtualShotResizeObserver = null;
  let virtualScrollFrame = 0;
  let virtualRangeKey = '';
  let virtualStart = 0;
  let virtualEnd = 0;
  let deferredProfessionalRender = false;
  const virtualShotHeights = new Map();
  let virtualShotProjectId = '';
  const virtualEstimatedShotHeight = 430;
  const virtualOverscan = 1;
  const workbenchAssetSurfaceSignatures = new WeakMap();
  const workbenchCardSignatures = new WeakMap();
  const workbenchReferenceSignatures = new WeakMap();
  let deferredFlushTimer = 0;
  const refreshProfessionalUploadSurfaces = () => {
    if (state.route !== 'drama') return;
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
  const projectAcknowledgedVersions = new Map();
  const projectRequest = () => ({ account:accountSnapshot(), epoch:projectEpoch, projectId:String(project?.id || '') });
  const isProjectRequestCurrent = request => Boolean(request)
    && request.epoch === projectEpoch
    && request.projectId === String(project?.id || '')
    && isAccountCurrent(request.account);
  const assertProjectRequest = request => {
    if (isProjectRequestCurrent(request)) return;
    throw Object.assign(new Error('账号已切换，已取消旧操作'), { stale:true });
  };
  const styleDialog=createDramaStyleDialog({api,esc,toast,isCurrent:isProjectRequestCurrent,
    onCreate:async(style,request)=>{assertProjectRequest(request);return createProject('professional',style);},
    onChange:async(style,request)=>{
      await flushSave();assertProjectRequest(request);
      const saved=await patch({style});
      if(!saved)return false;
      assertProjectRequest(request);syncProjectHeader();toast('画面风格已更新');return true;
    },
  });
  const styleButton=document.querySelector('#dramaProjectStyle');
  if(styleButton)styleButton.onclick=()=>{if(project)void styleDialog.open({style:project.style,edit:true,request:projectRequest()});};
  const recordIndexes=createRecordIndexes({getFiles:()=>state.files,getTasks:()=>state.tasks});
  const task = id => recordIndexes.taskById(id);
  const generationFailureMarkup = generation => {
    const failure = taskFailure(generation);
    return failure ? `<span class="generation-failure-reason"><b>${esc(failure.message)}</b><small>${esc(failure.suggestion)}</small></span>` : '<span>生成失败</span>';
  };
  const generationFailureIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
  const generationFailurePromptMarkup = () => `<div class="wb-preview-empty wb-preview-failure-prompt"><span class="wb-preview-failure-prompt-icon" aria-hidden="true">${generationFailureIcon}</span><b>视频生成失败</b><small>点击下方叉号查看失败原因</small></div>`;
  const generationFailurePreviewMarkup = generation => {
    const failure = taskFailure(generation) || { message:'生成失败，服务未返回具体原因', suggestion:'请调整创作描述或参考图片后重试。' };
    return `<div class="wb-preview-failure" role="alert" aria-live="polite"><span class="wb-preview-failure-icon" aria-hidden="true">${generationFailureIcon}</span><div class="wb-preview-failure-copy"><b>生成失败</b><strong>${esc(failure.message)}</strong><p>${esc(failure.suggestion)}</p></div></div>`;
  };
  const assetMissing = id => recordIndexes.fileById(id)?.localStatus === 'missing';
  const asset = id => {const file=recordIndexes.fileById(id);return file?.localStatus==='missing'?undefined:file;};
  const videoPreviewVersionState = (generation, options = {}) => {
    if (assetMissing(generation?.assetId)) return 'missing';
    return resolveVideoPreviewVersionState(generation, options);
  };
  const assetPreviewUrl = file => file?.kind === 'image' ? (String(file.url || '').startsWith('gugu-media://') ? file.url : (file.previewUrl || file.url || '')) : (file?.url || '');
  const assetImageMarkup = (file, alt = '', attributes = ' loading="lazy" decoding="async"') => {
    const preview = imageThumbnailUrl(assetPreviewUrl(file));
    const original = String(file?.url || file?.remoteUrl || '');
    const fallback = preview && original && preview !== original ? ` data-original-src="${esc(original)}"` : '';
    return `<img src="${esc(preview)}" alt="${esc(alt)}"${fallback}${attributes}>`;
  };
  const taskAsset = id => asset(task(id)?.assetId);
  const assetSyncing = file => Boolean(isAssetSyncing?.(file));
  const taskSyncing = id => !assetMissing(task(id)?.assetId) && generationNeedsLocalAssetSync(task(id), taskAsset(id), assetSyncing);
  const taskLocallyReady = id => {
    const generation = task(id);
    const file = taskAsset(id);
    return generation?.status === 'completed'
      && Boolean(file)
      && file.localStatus === 'saved'
      && !assetSyncing(file);
  };
  const projectEditingLocked = value => Boolean(value?.finalAssetId && value?.mode !== 'professional');
  function normalizeAssemblyHistory(value) {
    if (!value || typeof value !== 'object') return value;
    const source = Array.isArray(value.assemblyVideos) ? [...value.assemblyVideos] : [];
    const legacyId = String(value.finalAssetId || '').trim();
    if (legacyId && !source.some(item => String(item?.assetId || item?.id || '') === legacyId)) {
      source.unshift({ id:legacyId, assetId:legacyId, name:'完整成片', createdAt:value.updatedAt || value.createdAt || new Date().toISOString(), shotCount:value.shots?.length || 0, shotIds:[] });
    }
    value.assemblyVideos = source.map(item => {
      const assetId = String(item?.assetId || item?.id || '').trim();
      if (!assetId) return null;
      return {
        id:String(item?.id || assetId).trim() || assetId,
        assetId,
        name:String(item?.name || '完整成片').trim() || '完整成片',
        createdAt:String(item?.createdAt || value.updatedAt || value.createdAt || new Date().toISOString()),
        shotCount:Math.max(0, Math.min(120, Number(item?.shotCount) || 0)),
        shotIds:[...new Set((Array.isArray(item?.shotIds) ? item.shotIds : []).map(String).filter(Boolean))].slice(0, 120),
      };
    }).filter(Boolean).slice(0, 50);
    return value;
  }
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
    return `<div data-wb-version="${esc(item.id)}" data-wb-thumb-content="${esc(JSON.stringify([versionState,item.file?.url||'',failureLabel,canDelete]))}" class="wb-preview-thumb ${selected?'selected':''} ${failed?'is-failed':''} ${missing?'is-missing':''} ${pending?'is-pending':''}"><button type="button" class="wb-preview-thumb-view" data-wb-preview-video="${esc(item.id)}" data-wb-preview-shot="${esc(shotId||item.shot?.id||'')}" aria-label="${previewLabel}" title="${failed?'查看生成失败原因':ready?'点击查看大视频':missing?'视频文件未找到':pendingLabel}" ${missing?'disabled':''}><span class="${failed||ready||missing?'':'wb-preview-thumb-pending'}">${thumb}</span></button>${canDelete?`<button type="button" class="wb-preview-thumb-delete" data-wb-delete-preview-video="${esc(item.id)}" data-wb-delete-preview-shot="${esc(shotId||item.shot?.id||'')}" aria-label="删除${esc(title)}视频版本" title="删除视频版本"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>`:''}</div>`;
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
    if (!id) throw new Error('该视频暂时无法处理，请先保存后再试');
    return { file, id };
  };
  // Local files upload when a generation first needs them. Recent results are
  // remembered briefly so repeated generations skip the round trip, while
  // cloud copies that later expire are checked again.
  const cloudReferenceCache = new Map();
  const cloudReferenceCacheMs = 30 * 60 * 1000;
  async function mapWithLimit(items, limit, run) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length:Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const index = next++; results[index] = await run(items[index], index); }
    }));
    return results;
  }
  async function ensureCloudReferenceIds(ids) {
    const request = projectRequest();
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    const files = unique.map(id => {
      if (assetMissing(id)) throw new Error('参考素材不存在，请重新选择');
      const file = asset(id);
      if (!file) throw new Error('参考素材不存在，请重新选择');
      return file;
    });
    const media = files.some(file => !isRemoteReferenceReady(file)) ? requireDesktopMedia('syncLocal') : null;
    // At most two uploads at once: the server allows only a few unfinished uploads per account.
    return mapWithLimit(files, 2, async file => {
      if (isRemoteReferenceReady(file)) return file.id;
      const sourceId = localAssetId(file);
      if (!sourceId) throw new Error('这份参考素材暂时无法使用，请重新上传后再试');
      const cacheKey = `${sourceId}:${file.sha256 || ''}`;
      const cached = cloudReferenceCache.get(cacheKey);
      if (cached && Date.now() - cached.at < cloudReferenceCacheMs && asset(cached.id)) return cached.id;
      const result = await media.syncLocal({ assetId:sourceId, uploadForReference:true });
      assertProjectRequest(request);
      const cloudAsset = result?.cloudAsset;
      if (!cloudAsset?.id || cloudAsset.remoteStatus === 'local_only') throw new Error('参考素材上传失败，请重新上传后再试');
      const syncedFile = { ...cloudAsset, id:cloudAsset.id, url:result.url || cloudAsset.url, remoteUrl:cloudAsset.url, localId:sourceId, localStatus:'saved', localPath:result.relativePath || file.localPath, sha256:cloudAsset.sha256 || file.sha256 };
      state.files = [syncedFile, ...state.files.filter(item => item.id !== syncedFile.id)];
      cloudReferenceCache.set(cacheKey, { id:syncedFile.id, at:Date.now() });
      return syncedFile.id;
    });
  }
  async function addLocalDramaAsset(result, request = projectRequest()) {
    assertProjectRequest(request);
    if (!result?.id) throw new Error('素材生成失败');
    state.files = [result, ...state.files.filter(item => item.id !== result.id)];
    await loadFiles({ background:true });
    assertProjectRequest(request);
    return result;
  }
  async function extractDramaTailLocally(shot) {
    const request = projectRequest();
    const source = taskLocalAsset(shot.selectedVideoTaskId);
    const result = await requireDesktopMedia('extractTail').extractTail({ assetId:source.id, name:`${project.title} · 分镜 ${shot.shotNumber}`, projectId:project.id });
    assertProjectRequest(request);
    await addLocalDramaAsset(result, request);
    return result;
  }
  async function assembleDramaLocally(selectedItems=null) {
    const request = projectRequest();
    const items = Array.isArray(selectedItems)
      ? selectedItems
      : professional() ? professionalAssemblyItems() : project.shots.map((shot,index) => ({ shot, index, ...taskLocalAsset(shot.selectedVideoTaskId) }));
    if (items.length < 2) throw new Error('至少需要 2 个已完成的视频才能合成');
    const assetIds = items.map(item => item.id);
    const result = await requireDesktopMedia('assembleVideos').assembleVideos({ assetIds, name:project.title, projectId:project.id });
    assertProjectRequest(request);
    await addLocalDramaAsset(result, request);
    assertProjectRequest(request);
    if (professional()) {
      const record = { id:`assembly_${crypto.randomUUID()}`, assetId:result.id, name:result.name || `${project.title} · 完整成片.mp4`, createdAt:new Date().toISOString(), shotCount:items.length, shotIds:items.map(item => item.shot.id) };
      // Do not collapse records by asset ID: repeated assembly of the same
      // shots is an intentional new deliverable and must remain in history.
      project.assemblyVideos = [record, ...(project.assemblyVideos || [])].slice(0, 50);
      project.status = 'completed';
      project.step = 'video';
      await patch({ assemblyVideos:project.assemblyVideos }, { quiet:true });
      assertProjectRequest(request);
    } else {
      project.finalAssetId = result.id;
      project.status = 'completed';
      project.step = 'video';
    }
    projects = mergeDramaProjectList(projects, project);
    state.dramaProject = project;
    return result;
  }
  function restoreLocalProjectOutputs(value) {
    normalizeAssemblyHistory(value);
    if (!value) return value;
    const localFinals = state.files.filter(file => file.localStatus !== 'missing' && file.localOnly && file.source === 'drama_final' && String(file.projectId || '') === String(value.id || ''));
    const known = new Set(value.assemblyVideos.map(item => item.assetId));
    localFinals.forEach(file => {
      if (known.has(file.id)) return;
      value.assemblyVideos.push({ id:file.id, assetId:file.id, name:file.name || '完整成片', createdAt:file.createdAt || file.updatedAt || value.updatedAt || new Date().toISOString(), shotCount:value.shots?.length || 0, shotIds:[] });
      known.add(file.id);
    });
    value.assemblyVideos = value.assemblyVideos.slice(0, 50);
    // Professional projects now keep every output in assemblyVideos and stay
    // editable. Clear the legacy single-output lock after migrating it into
    // the history list; the classic video workflow still uses finalAssetId.
    if (value.mode === 'professional') value.finalAssetId = '';
    if (!value.finalAssetId && value.mode !== 'professional') {
      const latest = value.assemblyVideos[0];
      if (latest) value.finalAssetId = latest.assetId;
    }
    return value;
  }
  async function removeAssemblyVideosForAssets(assetIds, projectId = '') {
    const targetProjectId = String(projectId || '').trim();
    if (project && (!targetProjectId || String(project.id) === targetProjectId)) {
      const previousFinalAssetId = String(project.finalAssetId || '');
      const result = removeAssemblyVideoAssets(project, assetIds);
      if (!result.changed) return false;
      project = result.project;
      projects = projects.map(item => item.id === project.id ? project : item);
      state.dramaProject = project;
      const saveKeys = ['assemblyVideos'];
      if (previousFinalAssetId !== String(project.finalAssetId || '')) saveKeys.push('finalAssetId');
      queueSave(...saveKeys);
      await flushSave();
      if (state.route === 'drama') render(true, { focus:false });
      return true;
    }
    if (!targetProjectId) return false;
    const requestAccount = accountSnapshot();
    const response = await api(`/api/drama/projects/${encodeURIComponent(targetProjectId)}`);
    if (!isAccountCurrent(requestAccount)) return false;
    const remoteProject = normalizeProjectData(response.project);
    const previousFinalAssetId = String(remoteProject.finalAssetId || '');
    const result = removeAssemblyVideoAssets(remoteProject, assetIds);
    if (!result.changed) return false;
    const payload = { assemblyVideos:result.project.assemblyVideos, revision:remoteProject.revision };
    if (previousFinalAssetId !== String(result.project.finalAssetId || '')) payload.finalAssetId = result.project.finalAssetId;
    await api(`/api/drama/projects/${encodeURIComponent(targetProjectId)}`, { method:'PATCH', body:JSON.stringify(payload) });
    return true;
  }
  const taskDisplayStatus = id => {
    const generation = task(id);
    const state = videoPreviewVersionState(generation, { ready:taskLocallyReady(id), syncing:taskSyncing(id) });
    return state === 'pending' ? 'running' : generation?.status;
  };
  const workbenchVideoProgressMarkup = generation => {
    const progress = videoTaskProgress(generation);
    return renderVideoGenerationLoading({ progress });
  };
  // Desktop-local videos can render freely; remote MP4 URLs stay detached from
  // list surfaces so a render never fans out into remote storage downloads.
  const workbenchVideoMarkup = file => String(file?.url || '').startsWith('gugu-media://')
    ? `<video data-wb-video-src="${esc(file.url)}" preload="metadata" muted playsinline></video><span class="wb-media-play">▶</span>`
    : '<span class="wb-video-placeholder" aria-hidden="true"><span class="wb-media-play">▶</span></span>';
  const resetWorkbenchVideoObserver = () => { workbenchMedia.reset(); videoGenerationLoading.reset(); };
  const hydrateWorkbenchVideos = (scope=root) => { workbenchMedia.hydrate(scope); videoGenerationLoading.hydrate(scope); };
  const releaseWorkbenchVideos = scope => { workbenchMedia.release(scope); videoGenerationLoading.release(scope); };
  const resetProjectAssetMediaObserver = () => {
    projectAssetMediaObserver?.disconnect();
    projectAssetMediaObserver = null;
  };
  const projectAssetImageMarkup = (file, alt = '') => {
    const preview = imageThumbnailUrl(assetPreviewUrl(file));
    if (!preview) return assetImageMarkup(file, alt);
    const original = String(file?.url || file?.remoteUrl || '');
    const fallback = original && preview !== original ? ` data-original-src="${esc(original)}"` : '';
    return `<img class="project-asset-thumb" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" data-project-asset-src="${esc(preview)}" alt="${esc(alt)}"${fallback} loading="lazy" decoding="async">`;
  };
  const projectAssetVideoMarkup = file => String(file?.url || '').startsWith('gugu-media://')
    ? `<video class="project-asset-thumb" data-preview-src="${esc(file.url)}" preload="none" muted playsinline></video><span class="wb-media-play">▶</span>`
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
    if(deferredFlushTimer){clearTimeout(deferredFlushTimer);deferredFlushTimer=0;}
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
    return Math.max(1, Number(virtualShotHeights.get(shot?.id)) || virtualEstimatedShotHeight);
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
      if(!isMountedVirtualShotScroll(root,scroll))return;
      let changed = false;
      let correction = 0;
      const anchorIndex=calculateVirtualShotRange(project.shots.map((_,index)=>virtualShotHeight(index)),scroll.scrollTop,1,{overscan:0,estimatedHeight:virtualEstimatedShotHeight}).start;
      entries.forEach(entry => {
        const card = entry.target;
        const index = Number(card.dataset.wbShotIndex);
        const shot = project?.shots?.[index];
        if (!shot || shot.id!==card.dataset.wbShot || !Number.isFinite(index)) return;
        const style = getComputedStyle(card);
        const next = (entry.borderBoxSize?.[0]?.blockSize || card.offsetHeight) + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        const previous = virtualShotHeight(index);
        if (Math.abs(next - previous) < 1) return;
        virtualShotHeights.set(shot.id, next);
        changed = true;
        if (index < anchorIndex) correction += next - previous;
      });
      if (changed) { updateVirtualSpacers(scroll); if(correction)scroll.scrollTop+=correction; scheduleVirtualShotWindow(); }
    });
    scroll.querySelectorAll('[data-wb-shot]').forEach(card => virtualShotResizeObserver.observe(card));
  };
  const scheduleVirtualShotWindow = () => {
    if (virtualScrollFrame) return;
    virtualScrollFrame = requestAnimationFrame(() => {
      virtualScrollFrame = 0;
      if (state.route !== 'drama') return;
      const scroll = root.querySelector('.wb-shot-scroll');
      renderProfessionalShotWindow({ scroll });
    });
  };
  const workbenchInteractiveSelector = 'textarea,input,select,[contenteditable="true"]';
  const workbenchHasActiveInteraction = () => {
    const active = document.activeElement;
    return Boolean(
      document.querySelector('#wbDropdownPortal, dialog#shotPromptOptimizationDialog[open], dialog#projectAssetDialog[open], dialog#professionalAssetDialog[open], dialog#professionalGenerationReferenceDialog[open], dialog#professionalMediaPreviewDialog[open], dialog#professionalAssemblyDialog[open], dialog#professionalAssemblyLibraryDialog[open]')
      || (root.contains(active) && active?.matches(workbenchInteractiveSelector))
    );
  };
  const flushDeferredProfessionalRender = () => {
    if (state.route !== 'drama' || !deferredProfessionalRender || !project || workbenchHasActiveInteraction() || document.activeElement?.closest?.('.wb-action-bar')) return;
    deferredProfessionalRender = false;
    render(true, { focus:false });
  };
  const scheduleFlushDeferredProfessionalRender = () => {
    if(deferredFlushTimer)return;
    deferredFlushTimer=window.setTimeout(()=>{deferredFlushTimer=0;flushDeferredProfessionalRender();},0);
  };
  const promptOptimization = createPromptOptimizationDialog({ api, esc, setCreditBalance, onClose:scheduleFlushDeferredProfessionalRender });
  const deferProfessionalRender = () => { deferredProfessionalRender = true; };
  const fileRecency = file => {
    const generation = file?.sourceGenerationId ? task(file.sourceGenerationId) : state.tasks.find(item=>item.assetId===file?.id);
    return String(generation?.finishedAt||generation?.updatedAt||generation?.createdAt||file?.createdAt||file?.updatedAt||'');
  };
  const compareFilesByRecency = (left,right) => {
    const leftTime=Date.parse(fileRecency(left));
    const rightTime=Date.parse(fileRecency(right));
    if(Number.isFinite(leftTime)||Number.isFinite(rightTime)){
      const timeOrder=(Number.isFinite(rightTime)?rightTime:-Infinity)-(Number.isFinite(leftTime)?leftTime:-Infinity);
      if(timeOrder)return timeOrder;
    }
    return String(right?.id||'').localeCompare(String(left?.id||''));
  };
  const sortFilesByRecency = files => [...files].sort(compareFilesByRecency);
  // Hide local copies already uploaded for reference, but keep an explicitly chosen id visible.
  const imageAssets = (keepId='') => { const listed=new Set(withoutSupersededLocalFiles(state.files).map(file=>file.id)); return sortFilesByRecency(state.files.filter(file=>(listed.has(file.id)||(keepId&&file.id===keepId))&&file.kind==='image'&&file.localStatus!=='missing'&&!assetSyncing(file))); };
  const frameOptions = current => `<option value="">未指定</option>${imageAssets(current).map(file=>`<option value="${file.id}" ${file.id===current?'selected':''}>${esc(file.name)}</option>`).join('')}`;
  const generationModeName = value => ({TEXT:'文本生成','FIRST&LAST':'首尾帧','REFERENCE':'参考图片'}[value] || '文本生成');
  const optionList = (values,current,suffix='') => values.map(value => `<option value="${value}" ${String(value)===String(current)?'selected':''}>${value}${suffix}</option>`).join('');
  const selectedResourceAssetIds = shot => [...new Set([...(shot.resourceIds || []).map(id => project.resources.find(item => item.id === id)).map(item => taskAsset(item?.selectedTaskId)?.id).filter(id => id && !assetSyncing(asset(id))), ...(shot.referenceAssetIds || []).filter(id => !assetSyncing(asset(id)))])];
  const saveLabel = () => {};
  const professional = () => project?.mode !== 'smart';
  // The professional virtualizer owns only its inner shot scroller. Falling
  // back to #workspaceMain here would let a post-delete rerender replace every
  // route surface when the shortened shot list no longer overflows.
  const scroller = () => professional()
    ? root.querySelector('.professional-shot-editor-scroll')
    : document.querySelector('#workspaceMain');
  const dropFocus = () => { const active=document.activeElement; if(root.contains(active)&&typeof active.blur==='function')active.blur(); };
  const beatSeconds = beat => beat?.kind==='dialogue' ? Math.max(0.5,Math.round(Array.from(String(beat.text||'').replace(/\s+/g,'')).length/4.5*10)/10) : 2.5;
  const cloneProjectValue = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const markProjectKeys = keys => keys.forEach(key=>projectKeyVersions.set(key,(projectKeyVersions.get(key)||0)+1));
  function queueSave(...keys){ markProjectKeys(keys);keys.forEach(key=>pendingKeys.add(key));clearTimeout(saveTimer);saveLabel('未保存…');saveTimer=setTimeout(()=>{void flushSave().catch(()=>{});},800); }
  async function flushSave(){
    clearTimeout(saveTimer);
    const targetProjectId=project?.id||'';
    const targetEpoch=projectEpoch;
    while(project?.id===targetProjectId&&projectEpoch===targetEpoch){
      if(!pendingKeys.size){
        const waiting=projectMutationChain;
        await waiting;
        if(project?.id===targetProjectId&&projectEpoch===targetEpoch&&waiting!==projectMutationChain)continue;
        if(project?.id!==targetProjectId||projectEpoch!==targetEpoch||!pendingKeys.size)return project;
      }
      const keys=[...pendingKeys];
      const changes=Object.fromEntries(keys.map(key=>[key,project?.[key]]));
      try{await patch(changes,{quiet:true,keysAlreadyMarked:true});}
      catch(error){if(project?.id===targetProjectId&&projectEpoch===targetEpoch)keys.forEach(key=>pendingKeys.add(key));throw error;}
    }
    return project;
  }
  function normalizeProjectData(value){
    if(!value||typeof value!=='object')return value;
    normalizeAssemblyHistory(value);
    if (value.mode === 'professional') value.finalAssetId = '';
    value.settings={shotCount:5,totalDuration:100,shotDuration:20,aspectRatio:'9:16',...(value.settings||{})};
    value.projectAssetIds=Array.isArray(value.projectAssetIds)?[...new Set(value.projectAssetIds.map(String).filter(Boolean))]:[];
    value.projectAssetCategories=value.projectAssetCategories&&typeof value.projectAssetCategories==='object'&&!Array.isArray(value.projectAssetCategories)?value.projectAssetCategories:{};
    value.scenes=Array.isArray(value.scenes)?value.scenes:[];
    value.resources=(Array.isArray(value.resources)?value.resources:[]).map(item=>({...item,id:item.id||crypto.randomUUID(),type:['character','location','prop'].includes(item.type)?item.type:'prop',name:String(item.name||'未命名素材'),description:String(item.description||''),prompt:String(item.prompt||''),bible:{identity:String(item.bible?.identity||item.description||''),dramaticGoal:String(item.bible?.dramaticGoal||''),appearance:String(item.bible?.appearance||''),costume:String(item.bible?.costume||''),canonicalViews:String(item.bible?.canonicalViews||''),stateNotes:String(item.bible?.stateNotes||'')},lifecycle:{status:String(item.lifecycle?.status||(item.selectedTaskId?'approved':'draft')),revision:Math.max(1,Number(item.lifecycle?.revision)||1),approvedAt:String(item.lifecycle?.approvedAt||'')},versions:Array.isArray(item.versions)?item.versions:[],selectedTaskId:String(item.selectedTaskId||'')}));
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
    const badge=document.querySelector('#dramaLlmState'); if(!badge)return; const ready=Boolean(state.config.llm); badge.classList.toggle('ready',ready); badge.classList.toggle('bad',!ready); badge.querySelector('b').textContent=ready?'导演助手已就绪':'导演助手暂不可用';
  }
  function syncProjectHeader(){
    const open=Boolean(project);
    const routeActive=state.route==='drama';
    document.querySelector('#appView')?.classList.toggle('drama-project-open',open&&routeActive);
    document.querySelector('#appView')?.classList.toggle('drama-director-open',open&&routeActive&&project?.mode==='smart');
    document.querySelector('#appView')?.classList.toggle('drama-professional-open',open&&routeActive&&project?.mode==='professional');
    if(styleButton){styleButton.classList.toggle('hidden',!open||!routeActive);styleButton.textContent=project?.style?.name||'选择风格';styleButton.setAttribute('aria-label',`修改画面风格：${project?.style?.name||'未选择'}`);styleButton.title=`修改画面风格：${project?.style?.name||'未选择'}`;}
    if(!routeActive)return;
    const routeTitle=document.querySelector('#routeTitle');
    const titleDisplay=document.querySelector('#dramaProjectTitleDisplay');
    const titleInput=document.querySelector('#dramaProjectTitle');
    routeTitle.textContent=open?project.title:'短剧创作';
    document.title=`${routeTitle.textContent} · GuGu AI`;
    if(titleDisplay){
      const title=open?project.title:'';
      titleDisplay.textContent=title;
      titleDisplay.setAttribute('aria-label',title?`修改项目名称：${title}`:'修改项目名称');
    }
    if(titleInput&&!projectTitleEditing)titleInput.value=open?project.title:'';
  }
  function setStudioVisible(open) { document.querySelector('#dramaProjects')?.classList.toggle('hidden',open); document.querySelector('#dramaStudio')?.classList.toggle('hidden',!open); }
  const projectForId = id => projects.find(item => String(item.id) === String(id));
  function setRenameProjectError(message = '') {
    const error = document.querySelector('#renameDramaProjectError');
    if (!error) return;
    error.textContent = message;
    error.classList.toggle('hidden', !message);
  }
  function openRenameProjectDialog(id, restoreFocus = null) {
    const item = projectForId(id);
    const dialog = document.querySelector('#renameDramaProjectDialog');
    const input = document.querySelector('#renameDramaProjectInput');
    if (!item || !dialog || !input) return;
    renameProjectId = String(id);
    renameProjectRestoreFocus = restoreFocus || document.activeElement;
    input.value = item.title || '';
    setRenameProjectError();
    dialog.showModal();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  function closeRenameProjectDialog() {
    const dialog = document.querySelector('#renameDramaProjectDialog');
    if (dialog?.open) dialog.close();
  }
  // The project page lists every kind of project, so the list itself is drawn
  // by the shared project library; this module only owns the open project.
  function renderProjects() {
    const projectsRoot = document.querySelector('#dramaProjects');
    if (!projectsRoot) return;
    setStudioVisible(false);
    renderProjectList(projectsRoot);
  }
  async function deleteProject(id) {
    const targetId = String(id || '');
    const item = projectForId(targetId);
    if (!item || deletingProjectIds.has(targetId)) return;
    if (typeof confirmDelete !== 'function') { toast('删除确认暂不可用，请稍后重试'); return; }
    const confirmed = await confirmDelete({ title:'确认删除短剧项目', message:`删除“${item.title}”后，项目记录、剧本和分镜配置将无法恢复。已生成的视频和素材不会删除。` });
    if (!confirmed || !projectForId(targetId)) return;
    const requestAccount = accountSnapshot();
    deletingProjectIds.add(targetId);
    try {
      await api(`/api/drama/projects/${encodeURIComponent(targetId)}`, { method:'DELETE', body:'{}' });
      if (!isAccountCurrent(requestAccount)) return;
      void deleteCanvasSnapshot(snapshotKey(targetId,'project',requestAccount));
      void deleteCanvasSnapshot(snapshotKey(targetId,'agent',requestAccount));
      projects = projects.filter(value => String(value.id) !== targetId);
      renderProjects();
      toast('短剧项目已删除，生成的视频和素材已保留');
      return true;
    } catch (error) {
      if (isAccountCurrent(requestAccount)) toast(error.message);
    } finally {
      deletingProjectIds.delete(targetId);
    }
  }
  document.querySelector('#closeRenameDramaProject')?.addEventListener('click', closeRenameProjectDialog);
  document.querySelector('#cancelRenameDramaProject')?.addEventListener('click', closeRenameProjectDialog);
  document.querySelector('#renameDramaProjectDialog')?.addEventListener('cancel', event => { event.preventDefault(); closeRenameProjectDialog(); });
  document.querySelector('#renameDramaProjectDialog')?.addEventListener('close', () => {
    const restore = renameProjectRestoreFocus;
    renameProjectId = '';
    renameProjectRestoreFocus = null;
    setRenameProjectError();
    const button = document.querySelector('#saveRenameDramaProject');
    if (button) { button.disabled = false; button.textContent = '保存名称'; }
    requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); });
  });
  document.querySelector('#renameDramaProjectForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const item = projectForId(renameProjectId);
    const input = document.querySelector('#renameDramaProjectInput');
    const button = document.querySelector('#saveRenameDramaProject');
    if (!item || !input || !button) return;
    const name = input.value.trim();
    if (!name) { setRenameProjectError('请输入项目名称。'); input.focus(); return; }
    const requestAccount = accountSnapshot();
    button.disabled = true;
    button.textContent = '保存中…';
    setRenameProjectError();
    try {
      const result = await api(`/api/drama/projects/${encodeURIComponent(item.id)}`, { method:'PATCH', body:JSON.stringify({ title:name, revision:item.revision }) });
      if (!isAccountCurrent(requestAccount)) return;
      const updated = result.project || { ...item, title:name, revision:Number(item.revision || 1) + 1 };
      projects = projects.map(value => String(value.id) === String(item.id) ? updated : value);
      if (project?.id === item.id) { project = { ...project, ...updated }; state.dramaProject = project; syncProjectHeader(); }
      closeRenameProjectDialog();
      renderProjects();
      toast('短剧项目已重命名');
    } catch (error) {
      if (isAccountCurrent(requestAccount)) { setRenameProjectError(error.message); button.disabled = false; button.textContent = '保存名称'; input.focus(); input.select(); }
    }
  });
  async function openCreateProjectDialog(){await styleDialog.open({request:projectRequest()});}
  async function load(force=false) {
    const requestAccount=accountSnapshot();
    if(busy){
      if(isAccountCurrent(busyAccount))return;
      projectLoadToken+=1;
    }
    busy=true;
    busyAccount=requestAccount;
    const loadToken=++projectLoadToken;
    try {
      if(!isAccountCurrent(requestAccount))return;
      if(project&&!force)await flushSave();
      if(!isAccountCurrent(requestAccount))return;
      const activeProjectId=project?.id||'';
      if(!project&&projects.length)renderProjects();
      const result=await api('/api/drama/projects');
      if(loadToken!==projectLoadToken||!isAccountCurrent(requestAccount))return;
      projects=result.projects;
      if(project&&!force&&project.id===activeProjectId){
        const fresh=projects.find(item=>item.id===project.id);
        if(fresh)acceptProjectResponse(fresh);
        state.dramaProject=project;
        if(loadToken!==projectLoadToken||project?.id!==activeProjectId)return;
        render();
        void loadTasks({background:true,projectOnly:true});
      // A project opened while the list was loading stays on screen.
      }else if(!project)renderProjects();
    }catch(error){if(loadToken===projectLoadToken&&isAccountCurrent(requestAccount))toast(error.message);}
    finally{if(loadToken===projectLoadToken){busy=false;busyAccount=null;}}
  }
  async function createProject(mode, style) { const request=projectRequest(); try { const result=await api('/api/drama/projects',{method:'POST',body:JSON.stringify({title:mode==='smart'?'未命名智能短剧':'未命名剧本',mode,style,settings:{shotCount:5,totalDuration:100,shotDuration:20,aspectRatio:'9:16'}})}); assertProjectRequest(request); projects=[result.project,...projects]; openingCreatedProject=true; try { return await openProject(result.project.id); } finally { openingCreatedProject=false; } }catch(error){if(error.stale)return false;toast(error.message);return false;} }
  async function openProject(id) {
    const loadToken=++projectLoadToken;
    const requestAccount=accountSnapshot();
    const current=()=>loadToken===projectLoadToken&&isAccountCurrent(requestAccount);
    const remoteRequest=api(`/api/drama/projects/${id}`).then(result=>({result}),error=>({error}));
    let shownCached=false;
    let cachedCanvasVersion=canvasChangeVersion;
    const activate=value=>{
      if(!shownCached){
        projectEpoch+=1;
        pendingKeys.clear();projectKeyVersions.clear();projectAcknowledgedVersions.clear();professionalPreviewTaskIds.clear();professionalGenerationPending.clear();
        projectMutationChain=Promise.resolve();
      }
      project=restoreLocalProjectOutputs(normalizeProjectData(value));
      projectTitleEditing=false;projectTitleDraft='';projectBaseSnapshot=cloneProjectValue(project);
      projectAssetIds=[...project.projectAssetIds];projectAssetCategories=new Map(Object.entries(project.projectAssetCategories||{}));
      viewStep=project.step;scriptDraft=null;state.dramaProject=project;
      setStudioVisible(true);syncProjectHeader();modelState();render();
      onProjectViewChange(project.id,{created:openingCreatedProject});
    };
    try {
      const cached=await readCanvasSnapshot(snapshotKey(id,'project',requestAccount));
      if(!current())return false;
      if(cached?.id===id&&cached.mode==='smart'){
        activate(cached);shownCached=true;
        cachedCanvasVersion=canvasChangeVersion;
      }
      const response=await remoteRequest;
      if(!current())return false;
      if(response.error)throw response.error;
      const {result}=response;
      const canRefresh=!shownCached||(!pendingKeys.size&&!projectKeyVersions.size&&canvasChangeVersion===cachedCanvasVersion);
      if(canRefresh&&(!shownCached||Number(result.project.revision)>Number(project.revision))){
        activate(result.project);
      }
      if(canRefresh)cacheProject(result.project,requestAccount);
      void loadTasks({background:true,projectOnly:true});
      // The app boot already hydrates the first local-library page. Only warm
      // it here when the in-memory library is genuinely empty; opening a
      // project must not rescan 200 unrelated local files on every visit.
      if(!state.files.length)void loadFiles({background:true});
      return true;
    }catch(error){
      if(!current())return false;
      if(error.status===404&&shownCached){
        void deleteCanvasSnapshot(snapshotKey(id,'project',requestAccount));
        void deleteCanvasSnapshot(snapshotKey(id,'agent',requestAccount));
        directorWorkspaceView?.dispose();project=null;projectBaseSnapshot=null;state.dramaProject=null;syncProjectHeader();renderProjects();onProjectViewChange('',{replace:true});
        return false;
      }
      toast(error.message);return shownCached;
    }
  }
  async function closeProject(){
    promptOptimization.close();
    const request=projectRequest();
    try{
      await flushSave();
      assertProjectRequest(request);
    }catch(error){
      if(error.stale)return;
      throw error;
    }
    projectLoadToken+=1;projectEpoch+=1;
    document.querySelector('#professionalAssemblyDialog')?.close();document.querySelector('#professionalAssemblyLibraryDialog')?.close();
    resetWorkbenchVideoObserver();resetVirtualShotWindow();virtualShotHeights.clear();virtualShotProjectId='';professionalPreviewTaskIds.clear();professionalGenerationPending.clear();deferredProfessionalRender=false;pendingKeys.clear();projectKeyVersions.clear();projectAcknowledgedVersions.clear();projectTitleEditing=false;projectTitleDraft='';document.querySelector('#dramaProjectTitle')?.classList.add('hidden');document.querySelector('#dramaProjectTitleDisplay')?.classList.remove('hidden');directorWorkspaceView?.dispose();project=null;projectBaseSnapshot=null;viewStep=null;scriptDraft=null;assetPickerShotId='';state.dramaProject=null;syncProjectHeader();renderProjects();onProjectViewChange('');
  }
  async function patch(changes,{quiet=false,keysAlreadyMarked=false}={}) {
    if(!project)return null;
    const requestAccount=accountSnapshot();
    const targetProjectId=project.id;
    const targetEpoch=projectEpoch;
    const keys=Object.keys(changes);
    if(!keysAlreadyMarked)markProjectKeys(keys);
    keys.forEach(key=>pendingKeys.delete(key));
    const payload=cloneProjectValue(changes);
    const requestVersions=new Map(projectKeyVersions);
    const submittedVersions=new Map(keys.map(key=>[key,requestVersions.get(key)||0]));
    // Include queued field changes in the live draft before an earlier request
    // can reconcile and acknowledge them as part of a whole-project save.
    project={...project,...changes};
    state.dramaProject=project;
    const current=()=>projectEpoch===targetEpoch&&project?.id===targetProjectId&&isAccountCurrent(requestAccount);
    saveLabel('保存中…');
    const run=async()=>{
      if(!current())return null;
      // An earlier automatic reconciliation may have saved this queued draft.
      const unsavedKeys=keys.filter(key=>!submittedVersions.get(key)||Number(projectAcknowledgedVersions.get(key)||0)<Number(submittedVersions.get(key)));
      if(!unsavedKeys.length)return project;
      let sending=Object.fromEntries(unsavedKeys.map(key=>[key,payload[key]]));
      let savingVersions=submittedVersions;
      let base=cloneProjectValue(projectBaseSnapshot||project);
      project=mergeProjectResponseWithNewerKeys({...project,...sending},project,requestVersions,projectKeyVersions);
      state.dramaProject=project;
      let revision=project.revision;
      try{
        for(let attempt=0;attempt<4;attempt++){
          let result;
          try{
            result=await api(`/api/drama/projects/${targetProjectId}`,{method:'PATCH',body:JSON.stringify({...sending,revision})});
          }catch(error){
            if(!current())return null;
            if(error.code!=='PROJECT_VERSION_CONFLICT'||!error.project)throw error;
            const remote=Number(error.project.revision)<Number(projectBaseSnapshot?.revision)?cloneProjectValue(projectBaseSnapshot):restoreLocalProjectOutputs(normalizeProjectData(error.project));
            // One editor owns the draft. Background saves and generation results
            // must be reconciled here without interrupting their editing.
            project=mergeProjectDraft(base,project,remote);
            projectBaseSnapshot=cloneProjectValue(remote);
            state.dramaProject=project;
            cacheProject(project,requestAccount);
            savingVersions=new Map(projectKeyVersions);
            if(attempt===3)throw new Error('暂时未能保存，当前修改已保留，请稍后重试');
            sending=cloneProjectValue(project);
            base=cloneProjectValue(remote);
            revision=remote.revision;
            continue;
          }
          if(!current())return null;
          const serverProject=Number(result.project.revision)<Number(projectBaseSnapshot?.revision)?cloneProjectValue(projectBaseSnapshot):restoreLocalProjectOutputs(normalizeProjectData(result.project));
          projectBaseSnapshot=cloneProjectValue(serverProject);
          project=mergeProjectResponseWithNewerKeys(serverProject,project,savingVersions,projectKeyVersions,projectAcknowledgedVersions);
          for(const [key,version] of savingVersions){
            projectAcknowledgedVersions.set(key,Math.max(version,projectAcknowledgedVersions.get(key)||0));
            if(Number(projectKeyVersions.get(key)||0)<=version)pendingKeys.delete(key);
          }
          cacheProject(project,requestAccount);
          projects=mergeDramaProjectList(projects,project);state.dramaProject=project;
          saveLabel(pendingKeys.size?'未保存…':'已保存');if(!quiet)render(true);return project;
        }
      }catch(error){
        if(!current())return null;
        for(const key of new Set([...keys,...savingVersions.keys()])){
          if(keys.includes(key)||Number(projectKeyVersions.get(key)||0)>Number(projectAcknowledgedVersions.get(key)||0))pendingKeys.add(key);
        }
        saveLabel('保存失败');toast(error.message);throw error;
      }
    };
    const request=projectMutationChain.catch(()=>{}).then(run);
    projectMutationChain=request;
    void request.catch(()=>{});
    return request;
  }
  function mergeProjectDraft(base,local,remote){
    const preview=mergeProjectThreeWay({base,local,remote});
    const merged=preview.conflicts.length?mergeProjectThreeWay({base,local,remote,choices:projectConflictChoiceMap(preview.conflicts,'local')}):preview;
    // Text and its mentions are one edit. An older background response must
    // not detach a reference just because its label was unchanged locally.
    for(const shot of merged.project.shots||[]){
      const localShot=local.shots?.find(item=>item.id===shot.id);
      const baseShot=base.shots?.find(item=>item.id===shot.id);
      if(!localShot||localShot.script===baseShot?.script&&JSON.stringify(localShot.assetMentions||[])===JSON.stringify(baseShot?.assetMentions||[]))continue;
      for(const key of ['script','assetMentions','promptOverride','action','visualDirection'])if(Object.hasOwn(localShot,key))shot[key]=cloneProjectValue(localShot[key]);
      const mentionIds=(localShot.assetMentions||[]).map(item=>item.id);
      shot.referenceAssetIds=[...new Set([...(shot.referenceAssetIds||[]),...mentionIds])];
      if(shot.generation?.type==='REFERENCE')shot.generation.referenceAssetIds=[...new Set([...(shot.generation.referenceAssetIds||[]),...mentionIds])];
    }
    // Keep independent additions from in-flight generations. Respect an
    // explicit removal instead of resurrecting a deleted version.
    for(const conflict of preview.conflicts){
      const match=/^shots\[([^\]]+)\]\.videoVersions$/.exec(conflict.path);
      if(!match||![conflict.baseValue,conflict.localValue,conflict.remoteValue].every(Array.isArray))continue;
      if(!conflict.baseValue.every(id=>conflict.localValue.includes(id)&&conflict.remoteValue.includes(id)))continue;
      const shot=merged.project.shots?.find(item=>String(item.id)===match[1]);
      if(shot)shot.videoVersions=[...new Set([...conflict.remoteValue,...conflict.localValue])];
    }
    return merged.project;
  }
  function acceptProjectResponse(value,{base=projectBaseSnapshot||project}={}){
    if(!value||value.id!==project?.id||Number(value.revision)<Number(projectBaseSnapshot?.revision))return project;
    const remote=restoreLocalProjectOutputs(normalizeProjectData(value));
    project=mergeProjectDraft(base,project,remote);
    projectBaseSnapshot=cloneProjectValue(remote);
    projects=mergeDramaProjectList(projects,project);state.dramaProject=project;cacheProject(project);
    return project;
  }
  async function navigateStep(step,request=projectRequest()){
    try {
      await flushSave();
      assertProjectRequest(request);
      const frontier=professional()?stepOrder.length-1:stepOrder.indexOf(project.maxStep||project.step);
      if(stepOrder.indexOf(step)>frontier)return false;
      viewStep=step; assetPickerShotId=''; dropFocus(); render(true); const host=scroller(); if(host)host.scrollTop=0;
      return true;
    } catch(error) { if(error.stale)return false; throw error; }
  }
  async function advanceStep(step,request=projectRequest()){
    try {
      await flushSave();
      assertProjectRequest(request);
      const result=await patch({step},{quiet:true});
      assertProjectRequest(request);
      if(!result)return false;
      project=result; viewStep=step; assetPickerShotId=''; dropFocus(); render(true); const host=scroller(); if(host)host.scrollTop=0;
      return true;
    } catch(error) { if(error.stale)return false; throw error; }
  }

  function render(force=false,{focus=true}={}){
    if(state.route!=='drama')return;
    if(!project)return renderProjects();
    startProfessionalPriceRefresh();
    const active=document.activeElement;
    const focusedField=root.contains(active)&&active?.matches('textarea,input,select,[contenteditable="true"]') ? { id:active.id, start:active.selectionStart, end:active.selectionEnd } : null;
    if(!force&&focusedField)return;
    const host=professional()?root.querySelector('.wb-shot-scroll'):scroller(); const offset=host?.scrollTop||0;
    project=normalizeProjectData(project);viewStep||=project.step;state.dramaProject=project;syncProjectHeader();
    if(professional()){
      renderProfessionalWorkspace({focus:focus&&!focusedField,scrollTop:offset});
      const nextHost=root.querySelector('.wb-shot-scroll');
      if(nextHost){const restoredOffset=clampVirtualScrollOffset(offset,nextHost.scrollHeight,nextHost.clientHeight);nextHost.scrollTop=restoredOffset;if(restoredOffset)renderProfessionalShotWindow({scroll:nextHost});}
      // Restore focus only after the preserved scroll window is mounted. A field
      // edited in a non-first virtual window is not present until this point.
      if(focusedField){const next=document.getElementById(focusedField.id);if(next&&root.contains(next)){next.focus();if(typeof focusedField.start==='number'&&typeof next.setSelectionRange==='function')next.setSelectionRange(focusedField.start,focusedField.end);}}
      return;
    }
    renderDirectorWorkspace(); return;
  }
  function renderDirectorWorkspace(){
    directorWorkspaceView ||= createDirectorWorkspace(root, {
      project:()=>project, task, toast, images:()=>imageAssets(),
      generationConfig:()=>state.config,
      generationPricing:()=>({config:state.config,pricing:state.pricing}),
      formatCredits:creditText,
      imported:()=>project.projectAssetIds.map(id=>asset(id)).filter(f=>f&&['image','video'].includes(f.kind)).map(f=>({...f,url:assetPreviewUrl(f)})),
      importAsset:async()=>{
        const request=projectRequest();
        const selected=importCanvasAsset?await importCanvasAsset({multiple:true}):null;
        assertProjectRequest(request);
        const files=(Array.isArray(selected)?selected:[selected]).filter(Boolean);
        if(!files.length)return [];
        const ids=new Set(files.map(file=>file.id));
        state.files=[...files,...state.files.filter(file=>!ids.has(file.id))];
        await patch({projectAssetIds:[...new Set([...project.projectAssetIds,...ids])]},{quiet:true});
        assertProjectRequest(request);
        return files;
      },
      // Adding files only keeps the local copy. prepareCloudFiles uploads them
      // when a message is sent or a generation starts.
      prepareChatAsset:async({assetId,taskId})=>{
        const file=assetId?asset(assetId):taskAsset(taskId);
        if(!file)throw new Error('素材文件尚未就绪，请稍后重试');
        return {...file,previewUrl:assetPreviewUrl(file)};
      },
      uploadChatFile:async({maxFiles=30}={})=>{
        const request=projectRequest();
        const selected=await importCanvasAsset({chat:true,multiple:true,maxFiles});assertProjectRequest(request);
        if(!selected)return [];
        const files=(Array.isArray(selected)?selected:[selected]).filter(Boolean);
        state.files=[...files,...state.files.filter(f=>!files.some(file=>file.id===f.id))];
        return files.map(file=>({...file,previewUrl:assetPreviewUrl(file)}));
      },
      prepareCloudFiles:async files=>{
        const request=projectRequest();
        const list=Array.isArray(files)?files:[];
        const unique=[...new Set(list.map(file=>file.id))];
        const cloudIds=await ensureCloudReferenceIds(unique);assertProjectRequest(request);
        const byId=new Map(unique.map((id,index)=>[id,cloudIds[index]]));
        return list.map(file=>{const id=byId.get(file.id);return {...file,...(asset(id)||{}),id,previewUrl:file.previewUrl||assetPreviewUrl(file)};});
      },
      canvasFile:({assetId,taskId})=>assetId?asset(assetId):taskAsset(taskId),
      registerCanvasFile,
      importLocalMedia,
      uploadGenerationFile:async()=>{
        const request=projectRequest();
        const file=await importCanvasAsset({generation:true});assertProjectRequest(request);
        if(!file)return null;
        state.files=[file,...state.files.filter(f=>f.id!==file.id)];
        return {...file,previewUrl:assetPreviewUrl(file)};
      },
      media:id=>{const f=taskAsset(id);return f?{kind:f.kind,url:assetPreviewUrl(f),width:f.width,height:f.height}:null;},
      patch:changes=>patch(changes,{quiet:true}),
      markCanvasDirty:()=>{canvasChangeVersion+=1;},
      snapshotKey:kind=>snapshotKey(project.id,kind),
      agentApi:async (url,options)=>{
        const request=projectRequest();const result=await api(url,options);assertProjectRequest(request);
        if(result.balance!==undefined)setCreditBalance(result.balance);
        const tasks=Array.isArray(result.tasks)?result.tasks:url==='/api/generations'&&options?.method==='POST'&&result.id?[result]:[];
        if(tasks.length){
          const previousTasks=new Map(state.tasks.map(item=>[item.id,item]));
          const generatedAssetIds=[...new Set(tasks.map(item=>{
            const assetId=String(item?.assetId||'');
            const previous=previousTasks.get(item?.id);
            return assetId&&String(previous?.assetId||'')!==assetId?assetId:'';
          }).filter(Boolean))];
          const ids=new Set(tasks.map(t=>t.id));const hasNew=tasks.some(t=>!previousTasks.has(t.id));state.tasks=[...tasks,...state.tasks.filter(t=>!ids.has(t.id))];
          if(generatedAssetIds.length&&typeof syncDesktopDeliveries==='function')void syncDesktopDeliveries({assetIds:generatedAssetIds}).catch(error=>console.warn('[agent] 画布成品本地同步失败',error));
          if(hasNew)scheduleTaskPoll(0);
        }
        if(result.project&&Number(result.project.revision)>Number(project.revision)){
          const remote=normalizeProjectData(result.project);
          const merged=mergeProjectThreeWay({base:projectBaseSnapshot||project,local:project,remote});
          if(!merged.conflicts?.length){project={...merged.project,directorWorkspace:project.directorWorkspace};projectBaseSnapshot=cloneProjectValue(remote);state.dramaProject=project;cacheProject(project,request.account);}
        }
        return result;
      },
      execute:executeDirectorAction,
    });
    directorWorkspaceView.mount();
  }
  async function executeDirectorAction(action,isStopped){
    const request=projectRequest();
    const ensure=()=>{assertProjectRequest(request);if(isStopped())throw new Error('制作已暂停');};
    ensure();
    if(action.type==='design_story'){
      if(project.directorWorkspace?.lockedIds?.length)throw new Error('已有锁定内容，不能重建故事');
      const result=await api(`/api/drama/projects/${project.id}/direct`,{method:'POST',body:JSON.stringify({input:action.data.input||project.input,settings:{...project.settings,...(action.data.settings||{})}})});
      assertProjectRequest(request);project=normalizeProjectData(result.project);projectBaseSnapshot=cloneProjectValue(project);state.dramaProject=project;setCreditBalance(result.balance);return;
    }
    if(action.type==='check_continuity'){
      const issues=project.shots.flatMap((s,i)=>shotReadiness(s).map(issue=>`镜头 ${i+1}：${typeof issue==='string'?issue:JSON.stringify(issue)}`));
      if(issues.length)throw new Error(`连续性 / 制作检查待处理：${issues.slice(0,6).join('；')}`);
      return;
    }
    if(action.type==='assemble'){await assembleDramaLocally();ensure();return;}
    const resource=project.resources.find(r=>r.id===action.targetId);
    const shot=project.shots.find(r=>r.id===action.targetId);
    if(action.type==='read_tail'){
      if(!shot)throw new Error('镜头不存在');const index=project.shots.indexOf(shot);const next=project.shots[index+1];
      if(next&&project.directorWorkspace.lockedIds.includes(next.id))throw new Error('下一镜已锁定，不能更换首帧');
      const file=await extractDramaTailLocally(shot);ensure();shot.tailFrameAssetId=file.id;
      if(next){next.generation={...next.generation,type:'FIRST&LAST',firstFrameAssetId:file.id};}
      await patch({shots:project.shots},{quiet:true});return;
    }
    let generationId=action.taskId;
    if(!generationId){
      let body;
      if(action.type==='generate_resource'){
        if(!resource)throw new Error('素材不存在');
        body={type:'image',prompt:buildResourceImagePrompt(resource,{aspectRatio:project.settings.aspectRatio,styled:Boolean(project.style)}),size:project.settings.aspectRatio,quality:'medium',referenceAssetIds:[]};
      }else if(action.type==='generate_video'){
        if(!shot)throw new Error('镜头不存在');ensureProfessionalVideoSettings(shot);
        const warning=professionalProductionWarning(shot);if(warning)throw new Error(warning);
        if(!shot.generation.modelId)throw new Error('请先配置可用的视频模型');
        const refs=shotGenerationAssetIds(shot);const cloudRefs=await ensureCloudReferenceIds(refs);ensure();
        const requestShot=videoRequestShot(shot,refs);
        body={type:'video',prompt:shotVideoPrompt(requestShot),dramaProjectId:project.id,dramaShotId:shot.id,modelId:shot.generation.modelId,aspectRatio:shot.aspectRatio,duration:shot.duration,quality:shot.generation.quality,generationType:requestShot.generation.type,referenceAssetIds:cloudRefs};
      }else throw new Error('不支持的制作操作');
      action.requestBody ||= {...body,precheckSource:'agent',dramaProjectId:project.id,dramaStyleRevision:project.style?.revision || 0,requestId:`${project.directorWorkspace.plan.id}-${action.id}-${action.previousTaskIds?.length||0}`};
      project.directorWorkspace.plan.actions=project.directorWorkspace.plan.actions.map(a=>a.id===action.id?{...action}:a);
      await patch({directorWorkspace:project.directorWorkspace},{quiet:true});ensure();
      const generation=await api('/api/generations',{method:'POST',body:JSON.stringify(action.requestBody)});assertProjectRequest(request);
      generationId=generation.id;action.taskId=generationId;setCreditBalance(generation.balance);state.tasks=[generation,...state.tasks.filter(t=>t.id!==generation.id)];scheduleTaskPoll();
      // Record the job before waiting, so resuming never submits a duplicate paid request.
      project.directorWorkspace.plan.actions=project.directorWorkspace.plan.actions.map(a=>a.id===action.id?{...a,taskId:generationId}:a);
      await patch({directorWorkspace:project.directorWorkspace},{quiet:true});
    }
    const attached=resource?project.resources.find(r=>r.id===resource.id)?.versions?.includes(generationId):project.shots.find(s=>s.id===shot.id)?.videoVersions?.includes(generationId);
    if(!attached){
      const route=resource?`resources/${resource.id}/versions`:`shots/${shot.id}/videos`;
      const result=await api(`/api/drama/projects/${project.id}/${route}`,{method:'POST',body:JSON.stringify({taskId:generationId})});assertProjectRequest(request);
      project=normalizeProjectData(result.project);state.dramaProject=project;
    }
    const deadline=Date.now()+30*60*1000;
    while(Date.now()<deadline){
      ensure();await loadTasks();await loadFiles();ensure();directorWorkspaceView?.refresh();
      const current=task(generationId);
      if(current?.status==='failed'||current?.status==='cancelled')throw Object.assign(new Error(current.error||'生成失败，请检查原因后重新规划'),{generationFailed:true,retryable:!['CONTENT_POLICY','INSUFFICIENT_CREDITS','INVALID_REQUEST'].includes(current.failure?.code)});
      if(current?.status==='completed'&&taskLocallyReady(generationId)){
        if(resource){const currentResource=project.resources.find(r=>r.id===resource.id);currentResource.selectedTaskId=generationId;await patch({resources:project.resources},{quiet:true});}
        else {const currentShot=project.shots.find(r=>r.id===shot.id);currentShot.selectedVideoTaskId=generationId;await patch({shots:project.shots},{quiet:true});}
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
    throw new Error('生成仍在进行，可稍后继续此计划');
  }
  function refreshTasks(){
    if(project?.mode==='smart'&&state.route==='drama'){directorWorkspaceView?.refresh();return;}
    if (assetMissing(professionalMediaPreview)) document.querySelector('#professionalMediaPreviewDialog')?.close();
    if(!project||state.route!=='drama')return;
    const taskIds=[...new Set(project.shots.flatMap(shot=>[shot.selectedVideoTaskId,...(shot.videoVersions||[]),...(shot.pendingImageGenerations||[]).map(item=>item.taskId)]).filter(Boolean))];
    const signature=taskIds.map(id=>{const item=task(id);return `${id}:${item?.status||''}:${item?.progress??''}:${item?.progressStage||''}:${item?.failure?.code||''}:${item?.error||''}:${item?.assetId||''}`;}).join('|');
    const fileIds=[...new Set([...projectAssetIds,...project.shots.flatMap(shot=>[...shotReferenceIds(shot),shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId]),...taskIds.map(id=>task(id)?.assetId),project.finalAssetId].filter(Boolean))];
    const fileSignature=fileIds.map(id=>{const item=recordIndexes.fileById(id);return `${id}:${item?.name||''}:${item?.url||''}:${item?.localStatus||''}:${item?.localPath||''}:${assetSyncing(item)}:${localDeliverySignature(id)}`;}).join('|');
    const changed=signature!==taskRenderSignature||fileSignature!==fileRenderSignature;
    taskRenderSignature=signature;
    fileRenderSignature=fileSignature;
    if(professional()){
      if(!changed)return;
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
    if (state.route !== 'drama' || !isMountedVirtualShotScroll(root, scroll) || !project?.shots?.length) return;
    const range = virtualRangeFor(scroll.scrollTop, scroll.clientHeight || window.innerHeight || 800);
    const active = document.activeElement;
    const activeCard = active?.closest?.('[data-wb-shot]');
    const activeIndex = activeCard ? Number(activeCard.dataset.wbShotIndex) : -1;
    if (root.contains(activeCard) && Number.isInteger(activeIndex) && activeIndex >= range.start - 1 && activeIndex <= range.end) {
      range.start = Math.min(range.start, activeIndex);
      range.end = Math.max(range.end, activeIndex + 1);
    }
    const key = `${range.start}:${range.end}:${project.shots.slice(range.start,range.end).map(shot=>shot.id).join(',')}`;
    if (!force && key === virtualRangeKey) {
      updateVirtualSpacers(scroll);
      return;
    }
    const previousScrollTop = scroll.scrollTop;
    virtualStart = range.start;
    virtualEnd = range.end;
    virtualRangeKey = key;
    const locked = projectEditingLocked(project);
    const shots = project.shots.slice(range.start, range.end);
    const items = scroll.querySelector('[data-wb-virtual-items]');
    if (!items) return;
    const retainedIds = new Set(shots.map(shot => shot.id));
    virtualShotResizeObserver?.disconnect();
    virtualShotResizeObserver = null;
    const added = [];
    [...items.children].forEach(card => {
      if (!force && retainedIds.has(card.dataset.wbShot)) return;
      if (mentionPicker.editor && card.contains(mentionPicker.editor)) closeMentionPicker();
      releaseWorkbenchVideos(card);
      card.remove();
    });
    shots.forEach((shot, offset) => {
      let card = items.querySelector(`[data-wb-shot="${CSS.escape(shot.id)}"]`);
      if (!card) {
        const template = document.createElement('template');
        template.innerHTML = workbenchShotCard(shot, range.start + offset, locked);
        card = template.content.firstElementChild;
        added.push(card);
      }
      card.dataset.wbShotIndex = range.start + offset;
      card.classList.toggle('is-active', shot.id === professionalShotId);
      const current = items.children[offset];
      if (current !== card) items.insertBefore(card, current || null);
    });
    const finalCut = scroll.querySelector('.wb-final-cut');
    if (locked && range.end === project.shots.length) {
      if (!finalCut) {
        scroll.insertAdjacentHTML('beforeend', workbenchFinalCut(project.finalAssetId));
        const nextFinalCut=scroll.querySelector('.wb-final-cut');
        if(nextFinalCut){bindWorkbenchPreviewActions(nextFinalCut);hydrateWorkbenchVideos(nextFinalCut);}
      }
    } else finalCut?.remove();
    // Set the spacer geometry before restoring scrollTop; otherwise the browser
    // can clamp a deep position to the short, newly-mounted window.
    updateVirtualSpacers(scroll);
    scroll.scrollTop = clampVirtualScrollOffset(previousScrollTop, scroll.scrollHeight, scroll.clientHeight);
    const taskById = new Map(state.tasks.map(item => [item.id, item]));
    const fileById = new Map(state.files.map(item => [item.id, item]));
    added.forEach(card => {
      const shot=project.shots.find(item=>item.id===card.dataset.wbShot);
      const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
      shotPreviewSignatures.set(shot.id, shotPreviewContentSignatureFromMaps(shot, taskById, fileById, assetSyncing, previewTaskId) + localDeliverySignature(task(previewTaskId)?.assetId));
    });
    added.forEach(card => bindStoryboardWorkbench({ focus:false, cardsOnly:true, scope:card }));
    updateVirtualSpacers(scroll);
    observeVirtualShotHeights(scroll);

  }

  function workbenchEmptyShotState(locked){
    return `<section class="wb-empty-shot-state" aria-label="分镜为空">
      <span class="wb-empty-shot-icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none">
          <rect x="8.5" y="10.5" width="31" height="27" rx="5" />
          <path d="M9 18h30M15 11l4 7M29 11l4 7" />
          <path d="M24 23v10M19 28h10" />
        </svg>
      </span>
      <p>还没有分镜，先新建一个分镜开始创作。</p>
      <button type="button" class="wb-empty-shot-action wb-add-shot" ${locked?'disabled':''}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
        <span>新建分镜</span>
      </button>
    </section>`;
  }

  function workbenchActionBar(locked){
    const hasShots=project.shots.length>0;
    const completed=project.shots.filter(item=>taskLocallyReady(item.selectedVideoTaskId)).length;
    const canAssemble=completed>1;
    const assemblyHistoryCount=(project.assemblyVideos||[]).length;
    return hasShots||locked?`<footer class="wb-action-bar${hasShots&&project.shots.length>1&&!locked?' has-assemble':''}">
          ${hasShots?`<button type="button" class="wb-add-shot secondary-button" ${locked?'disabled':''}>＋ 新建分镜</button>`:''}
          ${hasShots&&project.shots.length>1&&!locked?`<div class="wb-assemble-actions${assemblyHistoryCount?' has-history':''}"><button type="button" class="wb-assemble stage-next" ${canAssemble?'':'disabled'}>分镜合成 <span>${completed} 个成品</span></button>${assemblyHistoryCount?`<button type="button" class="wb-assembly-library" aria-label="打开合成视频库" title="查看历史合成视频"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M7 4.5V3h6v1.5M6.5 8h7M6.5 11h5"/></svg><b>${assemblyHistoryCount}</b></button>`:''}</div>`:''}
          ${locked?'<span class="wb-locked-note">成片已生成，后续不可继续添加分镜和编辑</span>':''}
        </footer>`:'';
  }

  function setWorkbenchText(node,value){
    if(node&&node.textContent!==value)node.textContent=value;
  }

  function syncWorkbenchActionBar(locked){
    const markup=workbenchActionBar(locked);
    const current=root.querySelector('.wb-action-bar');
    if(!markup){current?.remove();return;}
    const template=document.createElement('template');template.innerHTML=markup;
    const next=template.content.firstElementChild;
    if(!current){root.querySelector('.wb-editor-panel').append(next);bindWorkbenchActionBar(next);return;}
    if(current.className!==next.className)current.className=next.className;
    for(const selector of ['.wb-add-shot','.wb-assemble-actions','.wb-locked-note']){
      const oldPart=current.querySelector(selector);const newPart=next.querySelector(selector);
      if(!newPart){oldPart?.remove();continue;}
      if(!oldPart){current.append(newPart);continue;}
      if(selector!=='.wb-assemble-actions')continue;
      const oldButton=oldPart.querySelector('.wb-assemble');const newButton=newPart.querySelector('.wb-assemble');
      oldButton.disabled=newButton.disabled;
      setWorkbenchText(oldButton.querySelector('span'),newButton.querySelector('span').textContent);
      oldPart.className=newPart.className;
      const oldHistory=oldPart.querySelector('.wb-assembly-library');const newHistory=newPart.querySelector('.wb-assembly-library');
      if(!newHistory)oldHistory?.remove();
      else if(!oldHistory)oldPart.append(newHistory);
      else setWorkbenchText(oldHistory.querySelector('b'),newHistory.querySelector('b').textContent);
    }
  }

  function patchWorkbenchAssets(locked){
    const current=root.querySelector('.wb-assets-panel');
    const template=document.createElement('template');template.innerHTML=projectAssetsPanel(locked);
    const next=template.content.firstElementChild;
    const existing=new Map([...current.querySelectorAll('[data-wb-asset-tile]')].map(tile=>[tile.dataset.wbAssetTile,tile]));
    const desiredIds=new Set([...next.querySelectorAll('[data-wb-asset-tile]')].map(tile=>tile.dataset.wbAssetTile));
    existing.forEach((tile,id)=>{if(!desiredIds.has(id)){releaseWorkbenchVideos(tile);tile.remove();}});
    next.querySelectorAll('[data-wb-asset-group]').forEach(group=>{
      const oldGroup=current.querySelector(`[data-wb-asset-group="${group.dataset.wbAssetGroup}"]`);
      const grid=oldGroup.querySelector('.wb-asset-grid');const add=grid.querySelector('.wb-asset-add-tile');
      setWorkbenchText(oldGroup.querySelector('header span'),group.querySelector('header span').textContent);
      let index=0;
      group.querySelectorAll('[data-wb-asset-tile]').forEach(tile=>{
        const retained=existing.get(tile.dataset.wbAssetTile);
        const item=retained||tile;
        const at=grid.children[index++];
        if(at!==item)grid.insertBefore(item,at||add);
        if(!retained){bindWorkbenchProjectAssetActions(item);hydrateWorkbenchVideos(item);}
      });
    });
    setWorkbenchText(current.querySelector('.wb-assets-footer span'),next.querySelector('.wb-assets-footer span').textContent);
    patchProfessionalAssetSurfaces();
  }

  function rememberWorkbenchCard(card,shot){
    const settings=workbenchShotSettings(shot,projectEditingLocked(project));
    workbenchCardSignatures.set(card,{
      title:shot.title,
      editor:JSON.stringify([shot.script,shot.assetMentions]),
      settings:settings.modelSelect+settings.modeSelect+settings.specs,
      pending:professionalGenerationPending.has(shot.id),
    });
    const row=card.querySelector('.wb-input-reference-row');
    if(row){
      workbenchReferenceSignatures.set(row,workbenchReferenceRow(shot));
      [...row.children].forEach(chip=>workbenchAssetSurfaceSignatures.set(chip,projectAssetMedia(asset(chip.dataset.wbReferenceId))));
    }
  }

  function patchMountedWorkbenchShot(card){
    const shot=project.shots.find(item=>item.id===card.dataset.wbShot);if(!shot)return;
    const snapshot=workbenchCardSignatures.get(card);
    if(!snapshot){rememberWorkbenchCard(card,shot);return;}
    if(snapshot.title!==shot.title){shotPreviewSignatures.delete(shot.id);snapshot.title=shot.title;}
    if(!card.classList.contains('is-editing-title')){
      const display=card.querySelector('[data-wb-edit-title]');const input=card.querySelector('[data-wb-field="title"]');
      if(display?.textContent!==shot.title){setWorkbenchText(display,shot.title);fitWorkbenchTitle(display);}
      if(input&&input.value!==shot.title){input.value=shot.title;fitWorkbenchTitle(input);}
      display?.setAttribute('aria-label',`修改分镜名称：${shot.title}`);
      card.querySelector('[data-wb-delete-shot]')?.setAttribute('aria-label',`删除${shot.title}`);
    }
    const editor=card.querySelector('.wb-rich-input');
    const editorSignature=JSON.stringify([shot.script,shot.assetMentions]);
    if(snapshot.editor!==editorSignature){
      if(editor.contains(document.activeElement)||editor.dataset.composing==='true')deferProfessionalRender();
      else{
        releaseWorkbenchVideos(editor);
        editor.innerHTML=workbenchReferenceRow(shot)+(shot.script.trim()?renderMentionEditorContent(shot):richEditorEmptyChar);
        const row=editor.querySelector('.wb-input-reference-row');
        if(row)workbenchReferenceSignatures.set(row,workbenchReferenceRow(shot));
        bindMentionChipInteractions(editor);
        hydrateWorkbenchVideos(editor);
        snapshot.editor=editorSignature;
      }
    }
    refreshWorkbenchReferenceRow(shot.id,shot);
    const settings=workbenchShotSettings(shot,projectEditingLocked(project));
    const settingsSignature=settings.modelSelect+settings.modeSelect+settings.specs;
    if(snapshot.settings!==settingsSignature){refreshWorkbenchShotControls(card,settings);snapshot.settings=settingsSignature;}
    const pending=professionalGenerationPending.has(shot.id);
    if(snapshot.pending!==pending){shotPreviewSignatures.delete(shot.id);snapshot.pending=pending;}
    refreshWorkbenchShotStatus(card,shot);
    card.classList.toggle('is-active',shot.id===professionalShotId);
  }

  function renderProfessionalWorkspace({focus=true,scrollTop=0}={}){
    closeMentionPicker();
    removeOrphanMentionChips();
    if (virtualShotProjectId !== project.id) {
      virtualShotHeights.clear();
      virtualShotProjectId = project.id;
    }
    professionalShotId=project.shots.some(shot=>shot.id===professionalShotId)?professionalShotId:project.shots[0]?.id||'';
    professionalPreviewShotId=project.shots.some(shot=>shot.id===professionalPreviewShotId)?professionalPreviewShotId:professionalShotId;
    seedProjectAssets();
    const locked=projectEditingLocked(project);
    const hasShots=project.shots.length>0;
    const mounted=root.querySelector('.storyboard-workbench');
    if(mounted?.dataset.projectId===project.id&&mounted.classList.contains('is-locked')===locked){
      patchWorkbenchAssets(locked);
      syncWorkbenchActionBar(locked);
      const scroll=root.querySelector('.wb-shot-scroll');
      if(!hasShots){
        if(!scroll.classList.contains('is-empty')){
          releaseWorkbenchVideos(scroll);
          resetVirtualShotWindow();
          scroll.classList.add('is-empty');
          scroll.innerHTML=workbenchEmptyShotState(locked);
          bindWorkbenchEmptyAction(scroll.querySelector('.wb-empty-shot-action'));
        }
      }else{
        if(scroll.classList.contains('is-empty')){
          scroll.classList.remove('is-empty');
          scroll.innerHTML='<div data-wb-virtual-spacer="top" aria-hidden="true"></div><div data-wb-virtual-items></div><div data-wb-virtual-spacer="bottom" aria-hidden="true"></div>';
        }
        renderProfessionalShotWindow({scroll});
        root.querySelectorAll('[data-wb-shot]').forEach(card=>patchMountedWorkbenchShot(card));
        patchProfessionalTaskSurfaces();
      }
      return;
    }
    const actionBar=workbenchActionBar(locked);
    resetWorkbenchVideoObserver();
    resetVirtualShotWindow();
    root.innerHTML=`<section class="professional-workspace storyboard-workbench ${locked?'is-locked':''}" data-project-id="${esc(project.id)}" aria-label="短剧分镜创作工作台">
      ${projectAssetsPanel(locked)}
      <main class="professional-shot-editor wb-editor-panel">
        <div class="professional-shot-editor-scroll wb-shot-scroll${hasShots?'':' is-empty'}">${hasShots?'<div data-wb-virtual-spacer="top" aria-hidden="true"></div><div data-wb-virtual-items></div><div data-wb-virtual-spacer="bottom" aria-hidden="true"></div>':workbenchEmptyShotState(locked)}</div>
        ${actionBar}
      </main>
    </section>`;
    shotPreviewSignatures.clear();
    const taskById=new Map(state.tasks.map(item=>[item.id,item]));const fileById=new Map(state.files.map(item=>[item.id,item]));
    project.shots.forEach(shot=>{
      const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
      shotPreviewSignatures.set(shot.id, shotPreviewContentSignatureFromMaps(shot, taskById, fileById, assetSyncing, previewTaskId) + localDeliverySignature(task(previewTaskId)?.assetId));
    });
    bindStoryboardWorkbench({focus:false});
    const scroll=root.querySelector('.wb-shot-scroll');
    if(hasShots){updateVirtualSpacers(scroll);scroll.scrollTop=scrollTop;}
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
    return `<aside class="professional-shot-directory wb-assets-panel"><header><h2>项目素材</h2><button type="button" class="gradient-button wb-add-asset" ${locked?'disabled':''}>＋ 添加素材</button></header><div class="wb-assets-scroll">${groups.map(([key,label])=>{const files=projectAssetIds.map(id=>asset(id)).filter(file=>file&&projectAssetKind(file)===key);return `<section class="wb-asset-group" data-wb-asset-group="${key}"><header><b>${label}</b><span>${files.length}</span></header><div class="wb-asset-grid">${files.map(file=>`<div data-wb-asset-tile="${esc(file.id)}" class="wb-asset-tile ${projectAssetIds.includes(file.id)?'is-project':''} ${locked?'is-locked':''}"><button type="button" class="wb-asset-apply" data-project-asset="${esc(file.id)}" data-project-asset-kind="${key}" ${locked||assetSyncing(file)?'disabled':''}>${projectAssetMedia(file)}<span class="wb-asset-name">${esc(file.name)}</span></button>${locked?'':`<button type="button" class="wb-asset-remove" data-project-asset-remove="${esc(file.id)}" aria-label="从项目中移除 ${esc(file.name)}" title="从项目中移除"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`}</div>`).join('')}<button type="button" class="wb-asset-add-tile" data-project-asset-add="${key}" aria-label="添加${label}" ${locked?'disabled':''}><b>＋</b><span>添加</span></button></div></section>`;}).join('')}</div><footer class="wb-assets-footer"><span>${projectAssetIds.length} 个素材已添加到项目</span><small>支持图片、视频、音频</small></footer></aside>`;
  }

  function patchProfessionalAssetSurfaces(){
    root.querySelectorAll('.wb-asset-apply[data-project-asset]').forEach(button=>{
      const file=asset(button.dataset.projectAsset);
      const name=button.querySelector('.wb-asset-name');
      if(!file||!name)return;
      const media=projectAssetMedia(file);
      const unchanged=workbenchAssetSurfaceSignatures.get(button)===media;
      workbenchAssetSurfaceSignatures.set(button,media);
      setWorkbenchText(name,file.name);
      button.disabled=Boolean(project.finalAssetId||assetSyncing(file));
      if(unchanged)return;
      releaseWorkbenchVideos(button);
      while(button.firstChild&&button.firstChild!==name)button.firstChild.remove();
      name.insertAdjacentHTML('beforebegin',media);
      hydrateWorkbenchVideos(button);
    });
  }

  function mentionKindLabel(kind){return ({image:'图片',video:'视频',audio:'音频'}[kind]||'素材');}
  function mentionLabel(mention,file){return String(mention?.label||file?.name||'未命名素材').replace(/^@/,'').trim()||'未命名素材';}
  function mentionChipMarkup(mention){
    const file=asset(mention.id);
    const label=mentionLabel(mention,file);
    const kind=file?.kind||mention.kind||'image';
    const preview=!file?'':kind==='image'?assetImageMarkup(file, label):kind==='video'?workbenchVideoMarkup(file):'<b>♫</b>';
    // A temporarily unloaded asset must not turn an existing reference into
    // plain text: the next input would then remove its saved identity.
    return `<span class="wb-mention-chip" data-mention-id="${esc(mention.id)}" data-mention-label="${esc(label)}" data-mention-kind="${esc(kind)}" contenteditable="false" aria-label="引用${esc(label)}，${mentionKindLabel(kind)}">${preview?`<span class="wb-mention-thumb">${preview}</span>`:''}<span class="wb-mention-name">${esc(label)}</span></span>`;
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
  function richEditorContainsRange(editor,range){
    if(!editor?.isConnected||!range)return false;
    try{return editor.contains(range.startContainer)&&editor.contains(range.endContainer);}catch{return false;}
  }
  function richEditorRange(editor,preferredRange=null){
    if(!editor?.isConnected)return null;
    if(richEditorContainsRange(editor,preferredRange))return preferredRange;
    const selection=window.getSelection?.();
    if(selection?.rangeCount){const currentRange=selection.getRangeAt(0);if(richEditorContainsRange(editor,currentRange))return currentRange.cloneRange();}
    const fallback=document.createRange();fallback.selectNodeContents(editor);fallback.collapse(false);return fallback;
  }
  function resolveRichEditor(shotId,preferredEditor=null){
    if(preferredEditor?.isConnected&&root.contains(preferredEditor))return preferredEditor;
    return [...root.querySelectorAll('[data-wb-rich-editor="script"]')].find(editor=>String(editor.dataset.shotId||'')===String(shotId||''))||null;
  }
  function removeOrphanMentionChips(){
    document.querySelectorAll('.wb-mention-chip').forEach(chip=>{if(!chip.closest('.wb-rich-input'))chip.remove();});
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
    return sortFilesByRecency(projectAssetIds.map(id=>asset(id)).filter(file=>file&&['image','video','audio'].includes(file.kind)&&!assetSyncing(file)&&(!query||String(file.name).toLocaleLowerCase('zh-CN').includes(query))));
  }
  function paintMentionPicker(){
    const editor=mentionPicker.editor; if(!editor)return;
    let picker=document.querySelector('#wbMentionPicker'); if(!picker){picker=document.createElement('div');picker.id='wbMentionPicker';picker.className='wb-mention-picker';document.body.append(picker);}
    const files=mentionPickerFiles();
    picker.innerHTML=`<header><div><b>引用项目素材</b><small>选择后会显示为素材卡片</small></div><button type="button" data-mention-close aria-label="关闭素材选择器"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></header><label class="wb-mention-search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/></svg><input type="search" value="${esc(mentionPicker.query)}" placeholder="搜索项目素材" aria-label="搜索项目素材"></label><div class="wb-mention-options" role="listbox">${files.map(file=>`<button type="button" role="option" data-mention-option="${esc(file.id)}"><span class="wb-mention-option-media">${projectAssetMedia(file)}</span><span><b>${esc(file.name)}</b><small>${mentionKindLabel(file.kind)} · 项目素材</small></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button>`).join('')||'<div class="wb-mention-empty"><b>没有匹配的项目素材</b><small>先将图片、视频或音频添加到左侧项目素材</small><button type="button" data-mention-add-asset>添加项目素材</button></div>'}</div>`;
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
    const shot=project.shots.find(item=>item.id===mentionPicker.shotId); const file=asset(assetId); const editor=resolveRichEditor(mentionPicker.shotId,mentionPicker.editor); if(!shot||!file||!editor)return;
    const range=richEditorRange(editor,mentionPicker.range); if(!range)return; editor.focus(); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range); removeTriggerAt(range);
    const mention={id:file.id,label:file.name,kind:file.kind}; const holder=document.createElement('span'); holder.innerHTML=mentionChipMarkup(mention); const chip=holder.firstElementChild; range.insertNode(chip); const spacer=document.createTextNode(' '); chip.after(spacer); /* Keep the caret inside the editable spacer so the next IME composition includes its first key. */ range.setStart(spacer,spacer.nodeValue.length); range.collapse(true); selection.removeAllRanges();selection.addRange(range); bindMentionChipInteractions(editor);
    projectAssetIds=[...new Set([...projectAssetIds,file.id])]; project.projectAssetIds=[...projectAssetIds]; project.projectAssetCategories=Object.fromEntries(projectAssetCategories); updateShotScriptFromEditor(shot.id,editor); closeMentionPicker({restoreFocus:true,range:range.cloneRange()});
  }
  // 自动 @ 引用：仅短剧创作的分镜输入框、仅项目素材内的素材参与匹配。
  // 素材名允许写不带后缀的写法（@小美 命中 小美.png），因此索引同时收录完整文件名与去后缀名。
  // 只有邮箱式的 ASCII 前缀会阻止引用；中文正文里的 @ 必须能触发匹配。
  const autoMentionWordChar=/[A-Za-z0-9._%+-]/;
  const autoMentionBaseName=name=>String(name||'').trim().replace(/\.[A-Za-z0-9]{1,8}$/,'').trim();
  const autoMentionKey=text=>String(text||'').trim().toLocaleLowerCase('zh-CN');
  function autoMentionIndex(){
    const index=new Map();
    projectAssetIds.map(id=>asset(id)).filter(file=>file&&['image','video','audio'].includes(file.kind)&&!assetSyncing(file)).forEach(file=>{
      const name=String(file.name||'').trim(); if(!name)return;
      new Set([name,autoMentionBaseName(name)||name]).forEach(text=>{
        const key=autoMentionKey(text); if(!key)return;
        const entry=index.get(key)||{key,label:text,files:[]};
        if(!entry.files.some(item=>item.id===file.id))entry.files.push(file);
        index.set(key,entry);
      });
    });
    // 长名优先，保证 @小美丽 不会被 @小美 抢先命中。
    return [...index.values()].sort((a,b)=>b.key.length-a.key.length);
  }
  function autoMentionMatchAt(text,index,entries){
    return entries.find(entry=>autoMentionKey(text.slice(index,index+entry.key.length))===entry.key)||null;
  }
  function autoMentionFragment(text){
    const source=String(text||'').replace(/\r\n?/g,'\n');
    const entries=source.includes('@')?autoMentionIndex():[];
    const fragment=document.createDocumentFragment();
    const mentionIds=[]; const ambiguous=[];
    let buffer=''; let position=0;
    const flush=()=>{if(buffer){fragment.append(document.createTextNode(buffer));buffer='';}};
    while(position<source.length){
      const char=source[position];
      // 前一个字符是字母数字时视为邮箱等普通文本，不触发引用。
      const boundary=position===0||!autoMentionWordChar.test(source[position-1]);
      const match=char==='@'&&entries.length&&boundary?autoMentionMatchAt(source,position+1,entries):null;
      if(!match){buffer+=char;position+=1;continue;}
      position+=1+match.key.length;
      if(match.files.length>1){buffer+=`@${match.label}`;ambiguous.push(match.label);continue;}
      const holder=document.createElement('span');
      holder.innerHTML=mentionChipMarkup({id:match.files[0].id,label:match.label,kind:match.files[0].kind});
      const chip=holder.firstElementChild;
      if(!chip?.classList.contains('wb-mention-chip')){buffer+=`@${match.label}`;continue;}
      flush(); fragment.append(chip); mentionIds.push(match.files[0].id);
    }
    flush();
    return {fragment,mentionIds,ambiguous:[...new Set(ambiguous)]};
  }
  function pasteIntoRichEditor(id,editor,event){
    if(!editor||project.finalAssetId||editor.getAttribute('contenteditable')!=='true')return;
    const text=event.clipboardData?.getData('text/plain');
    if(typeof text!=='string')return;
    event.preventDefault();
    closeMentionPicker();
    const selection=window.getSelection();
    if(!selection?.rangeCount||!richEditorContainsRange(editor,selection.getRangeAt(0)))setRichEditorCaret(editor);
    const range=richEditorRange(editor); if(!range)return;
    range.deleteContents();
    // 参考素材行不可编辑，插入点必须落在它之后。
    const referenceRow=editor.querySelector('.wb-input-reference-row');
    if(referenceRow&&range.startContainer===editor&&range.startOffset===0){range.setStartAfter(referenceRow);range.collapse(true);}
    const {fragment,mentionIds,ambiguous}=autoMentionFragment(text);
    const last=fragment.lastChild;
    if(last){
      range.insertNode(fragment);
      if(last.nodeType===Node.TEXT_NODE)setRichEditorCaret(editor,last,last.nodeValue.length);
      else{const spacer=document.createTextNode(' ');last.after(spacer);setRichEditorCaret(editor,spacer,spacer.nodeValue.length);}
    }
    bindMentionChipInteractions(editor);
    normalizeEmptyRichEditor(editor);
    updateShotScriptFromEditor(id,editor);
    // 粘贴内容以裸 @ 结尾时，沿用输入时的手动选择器。
    if(mentionTriggerAtCaret(editor))openMentionPicker(id,editor);
    const imported=new Set(mentionIds).size;
    if(imported)toast(`已自动引用 ${imported} 个项目素材`);
    if(ambiguous.length)toast(`@${ambiguous[0]} 对应多个同名素材，请补全文件后缀`);
  }
  function updateShotScriptFromEditor(id,editor){
    const shot=project.shots.find(item=>item.id===id); if(!shot||project.finalAssetId)return;
    const script=serializeRichEditor(editor);const mentions=mentionsFromEditor(editor);
    if(shot.script===script&&JSON.stringify(shot.assetMentions||[])===JSON.stringify(mentions))return;
    const previousReferenceIds=shotReferenceIds(shot);
    const previousMentionIds=new Set((shot.assetMentions||[]).map(item=>item.id));
    shot.script=script; shot.assetMentions=mentions;
    shot.referenceAssetIds=[...(shot.referenceAssetIds||[])].filter(id=>!previousMentionIds.has(id));
    shot.generation.referenceAssetIds=[...(shot.generation.referenceAssetIds||[])].filter(id=>!previousMentionIds.has(id));
    shot.referenceAssetIds=[...new Set([...shot.referenceAssetIds,...mentions.map(item=>item.id)])];
    if(mentions.length&&shot.generation.type==='TEXT')shot.generation.type='REFERENCE';
    syncProfessionalReferences(shot);
    // 专业工作台的输入框就是用户最终提交给视频模型的 Prompt。
    // 同步保存 promptOverride，避免服务端回读项目时用结构化字段覆盖用户输入。
    shot.promptOverride=shot.script.trim(); shot.action=shot.script; shot.visualDirection=shot.script; invalidateProfessionalShot(shot,'分镜内容已修改'); queueProfessionalSave();
    const card=root.querySelector(`[data-wb-shot="${id}"]`); const editorEmpty=!shot.script.trim(); if(editor){editor.dataset.empty=editorEmpty?'true':'false';} const modeSelect=card?.querySelector('[data-wb-field="generation.type"]'); if(modeSelect){modeSelect.value=shot.generation.type;syncWorkbenchDropdown(modeSelect.closest('.wb-dropdown'));}
    const snapshot=card&&workbenchCardSignatures.get(card);if(snapshot)snapshot.editor=JSON.stringify([shot.script,shot.assetMentions]);
    scheduleWorkbenchShotStatus(card,id);
    const nextReferenceIds=shotReferenceIds(shot); if(previousReferenceIds.length!==nextReferenceIds.length||previousReferenceIds.some(assetId=>!nextReferenceIds.includes(assetId))){refreshWorkbenchReferenceRow(id,shot);refreshWorkbenchShotControls(card);}
  }
  function bindMentionChipInteractions(editor){
    editor?.querySelectorAll('.wb-mention-chip').forEach(chip=>{chip.dataset.mentionBound='1';});
  }
  function openShotPromptOptimization(id) {
    const shot = project?.shots.find(item => item.id === id);
    if (!shot || project.finalAssetId) return;
    const editor = resolveRichEditor(id);
    if (editor) updateShotScriptFromEditor(id, editor);
    if (!shot.script.trim()) return toast('请先填写分镜内容');
    const original = shot.script;
    let appliedValue = '';
    const request = projectRequest();
    closeMentionPicker(); closeWorkbenchDropdowns();
    promptOptimization.open({ original, projectId:project.id, shotId:id, modelId:shot.generation.modelId,
      maxLength:videoPromptMaxLength(shot.generation.modelId),
      mentionLabels:(shot.assetMentions || []).map(item => item.label),
      referenceFiles:shotGenerationAssetIds(shot).map(id => asset(id)).filter(Boolean).map(file => ({id:file.id,name:file.name,kind:file.kind})),
      referencesFor:value => {
        const current = project.shots.find(item => item.id === id);
        const holder = document.createElement('div');
        holder.innerHTML = optimizedShotEditorMarkup(current, value);
        const assetMentions = mentionsFromEditor(holder);
        const referenceFiles = [...new Set([...shotGenerationAssetIds(current),...assetMentions.map(item => item.id)])].map(id => asset(id)).filter(Boolean).map(file => ({id:file.id,name:file.name,kind:file.kind}));
        return {assetMentions,referenceFiles};
      },
      prepare:async () => { await flushSave(); assertProjectRequest(request); },
      isCurrent:() => isProjectRequestCurrent(request) && state.route === 'drama',
      apply:async value => {
        assertProjectRequest(request);
        const current = project.shots.find(item => item.id === id);
        if (!current || project.finalAssetId) throw new Error('分镜已无法编辑，请返回后重试');
        if (current.script !== original && current.script !== appliedValue) throw new Error('原始内容已有变化，请取消后重新优化');
        const target = resolveRichEditor(id) || document.createElement('div');
        releaseWorkbenchVideos(target);
        target.innerHTML = workbenchReferenceRow(current) + optimizedShotEditorMarkup(current, value);
        updateShotScriptFromEditor(id, target);
        appliedValue = current.script;
        bindMentionChipInteractions(target); hydrateWorkbenchVideos(target);
        await flushSave(); assertProjectRequest(request);
        toast('已使用优化后的分镜内容');
      },
    });
  }
  function optimizedShotEditorMarkup(shot, value) {
    const holder = document.createElement('div');
    holder.innerHTML = renderMentionEditorContent({...shot,script:value});
    // Keep existing ID bindings first; resolve new names with the usual @ matcher.
    const resolve = node => {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue.includes('@')) node.replaceWith(autoMentionFragment(node.nodeValue).fragment);
      else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('wb-mention-chip')) [...node.childNodes].forEach(resolve);
    };
    [...holder.childNodes].forEach(resolve);
    return holder.innerHTML;
  }
  function workbenchReferenceRow(shot){
    const refs=shotReferenceIds(shot).map(id=>asset(id)).filter(Boolean);
    if(!refs.length)return '';
    return `<div class="wb-input-reference-row" contenteditable="false" aria-label="当前分镜参考素材">${refs.map(file=>`<span class="wb-reference-chip" data-wb-reference-id="${esc(file.id)}"><span>${projectAssetMedia(file)}</span><em>${esc(file.name)}</em><button type="button" class="wb-reference-remove" data-wb-remove-reference="${file.id}" contenteditable="false" aria-label="删除参考素材 ${esc(file.name)}" title="删除参考素材"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></span>`).join('')}</div>`;
  }
  function refreshWorkbenchReferenceRow(shotId,shot){
    const editor=root.querySelector(`[data-wb-shot="${shotId}"] .wb-rich-input`); if(!editor)return;
    if(editor.dataset.composing==='true'){deferProfessionalRender();return;}
    const selection=window.getSelection(); const range=selection?.rangeCount&&editor.contains(selection.anchorNode)?selection.getRangeAt(0).cloneRange():null;
    const markup=workbenchReferenceRow(shot); const current=editor.querySelector('.wb-input-reference-row');
    let changed=false;
    if(markup){
      if(!current){changed=true;editor.insertAdjacentHTML('afterbegin',markup);const row=editor.querySelector('.wb-input-reference-row');workbenchReferenceSignatures.set(row,markup);hydrateWorkbenchVideos(row);}
      else if(workbenchReferenceSignatures.get(current)!==markup){
        changed=true;
        const template=document.createElement('template');template.innerHTML=markup;
        const next=template.content.firstElementChild;
        const chips=new Map([...current.children].map(chip=>[chip.dataset.wbReferenceId,chip]));
        const ids=new Set([...next.children].map(chip=>chip.dataset.wbReferenceId));
        chips.forEach((chip,id)=>{if(!ids.has(id)){releaseWorkbenchVideos(chip);chip.remove();}});
        [...next.children].forEach((chip,index)=>{
          const retained=chips.get(chip.dataset.wbReferenceId);const item=retained||chip;
          const media=projectAssetMedia(asset(chip.dataset.wbReferenceId));
          if(retained&&workbenchAssetSurfaceSignatures.get(retained)!==media){releaseWorkbenchVideos(retained);retained.firstElementChild.replaceWith(chip.firstElementChild);hydrateWorkbenchVideos(retained);}
          workbenchAssetSurfaceSignatures.set(item,media);
          if(retained)setWorkbenchText(retained.querySelector('em'),chip.querySelector('em').textContent);
          const at=current.children[index];if(at!==item)current.insertBefore(item,at||null);
          if(!retained)hydrateWorkbenchVideos(item);
        });
        workbenchReferenceSignatures.set(current,markup);
      }
    }else if(current){changed=true;releaseWorkbenchVideos(current);current.remove();}
    const row=editor.querySelector('.wb-input-reference-row');
    if(row)[...row.children].forEach(chip=>{if(!workbenchAssetSurfaceSignatures.has(chip))workbenchAssetSurfaceSignatures.set(chip,projectAssetMedia(asset(chip.dataset.wbReferenceId)));});
    editor.classList.toggle('has-reference',Boolean(markup));
    editor.querySelectorAll('[data-wb-remove-reference]').forEach(button=>{if(button.dataset.wbReferenceBound==='1')return;button.dataset.wbReferenceBound='1';button.addEventListener('click',event=>{event.stopPropagation();removeWorkbenchReference(shotId,button.dataset.wbRemoveReference);});});
    if(changed&&range&&editor.isConnected){selection.removeAllRanges();selection.addRange(range);}
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
    const openControls=[...root.querySelectorAll('.wb-dropdown.is-open,.wb-spec-control.is-open')];
    const portal=document.querySelector('#wbDropdownPortal');
    const changed=openControls.length>0||Boolean(portal)||focusTrigger;
    openControls.forEach(control=>{control.classList.remove('is-open');control.querySelector('[aria-expanded="true"]')?.setAttribute('aria-expanded','false');});
    portal?.remove(); if(focusTrigger)trigger?.focus();
    // This function is also called from the document-level pointer handler.
    // A no-op close must not enqueue a render between pointerdown and click;
    // doing so can detach the footer button before its click event arrives.
    if(changed)scheduleFlushDeferredProfessionalRender();
  }

  function workbenchPortalKeyboard(panel,trigger){
    panel.addEventListener('keydown',event=>{const options=[...panel.querySelectorAll('button:not(:disabled)')];const current=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeWorkbenchDropdowns({focusTrigger:true});return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,current+(event.key==='ArrowDown'?1:-1)));options[next]?.focus();});
  }

  function openWorkbenchDropdown(dropdown,{focusOption=false}={}){
    const source=dropdown.querySelector('[data-wb-dropdown-source]'); const trigger=dropdown.querySelector('[data-wb-dropdown-trigger]'); if(!source||!trigger||trigger.disabled)return;
    if(dropdown.classList.contains('is-open')){closeWorkbenchDropdowns();return;} closeWorkbenchDropdowns(); dropdown.classList.add('is-open');trigger.setAttribute('aria-expanded','true');
    const kind=dropdown.dataset.wbDropdownKind||'mode'; const panel=document.createElement('div');panel.id='wbDropdownPortal';panel.className=`wb-floating-panel wb-select-popover is-${kind}`;panel.setAttribute('role','listbox');panel.setAttribute('aria-label',trigger.getAttribute('aria-label')||'选择');
    const options=[...source.options]; panel.innerHTML=`<header><b>${esc(trigger.getAttribute('aria-label')||'请选择')}</b>${kind==='model'?'<small>仅显示当前模式可用的模型</small>':''}</header><div class="wb-select-option-list">${options.map(option=>{const promo=kind==='model'&&option.value==='minimax-h3-15s'&&!state.config?.modelPrices?.some(item=>item.modelId===option.value&&item.unit==='request')?'<em class="wb-model-promo">限时特惠 ¥0.05/s 起</em>':'';return `<button type="button" role="option" data-wb-portal-value="${esc(option.value)}" aria-selected="${String(option.value===source.value)}" ${option.disabled?'disabled':''}>${kind==='model'?`<span class="wb-select-option-icon">${professionalModelIcon(option.value)}</span>`:''}<span class="wb-select-option-copy"><span class="wb-model-option-title"><b>${esc(option.textContent)}</b>${promo}</span>${option.dataset.meta?`<small>${esc(option.dataset.meta)}</small>`:''}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-6"/></svg></button>`;}).join('')}</div>`;
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

  function bindWorkbenchDropdowns(scope=root){
    scope.querySelectorAll('[data-wb-dropdown]').forEach(dropdown=>{const trigger=dropdown.querySelector('[data-wb-dropdown-trigger]');if(!trigger)return;syncWorkbenchDropdown(dropdown);trigger.addEventListener('click',event=>{event.stopPropagation();openWorkbenchDropdown(dropdown);});trigger.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Enter',' '].includes(event.key))return;event.preventDefault();openWorkbenchDropdown(dropdown,{focusOption:true});});});
    scope.querySelectorAll('[data-wb-spec-control]').forEach(control=>{const trigger=control.querySelector('[data-wb-specs-trigger]');if(!trigger)return;syncWorkbenchSpecs(control);trigger.addEventListener('click',event=>{event.stopPropagation();openWorkbenchSpecs(control);});trigger.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Enter',' '].includes(event.key))return;event.preventDefault();openWorkbenchSpecs(control,{focusOption:true});});});
  }

  function workbenchShotPreview(shot){
    const generationPending=professionalGenerationPending.has(shot?.id);
    const previewTaskId=professionalPreviewTaskIds.get(shot?.id)||shot?.selectedVideoTaskId;
    const selectedTask=task(previewTaskId);
    const selectedReady=taskLocallyReady(previewTaskId);
    const selectedSyncing=taskSyncing(previewTaskId);
    const selectedFile=selectedReady?taskAsset(previewTaskId):null;
    const selectedState=videoPreviewVersionState(selectedTask,{ready:selectedReady,syncing:selectedSyncing});
    const showFailureDetails=selectedTask?.status==='failed'&&professionalPreviewTaskIds.get(shot?.id)===previewTaskId;
    const versions=(shot?.videoVersions||[]).map(id=>({id,file:taskAsset(id),task:task(id)}));
    const pendingCount=generationPending?Math.max(1,Math.min(4,Number(shot?.generation?.count)||1)):0;
    const pendingThumbs=Array.from({length:pendingCount},(_,index)=>`<div data-wb-version="pending-${index}" data-wb-thumb-content="pending" class="wb-preview-thumb is-pending" role="status" aria-label="第 ${index+1} 个视频版本生成中"><span class="wb-preview-thumb-pending"><i class="wb-preview-thumb-loader" aria-hidden="true"></i></span></div>`).join('');
    const media=generationPending?renderVideoGenerationLoading():selectedFile?`<button type="button" class="wb-preview-media" data-wb-preview-file="${esc(selectedFile.id)}" aria-label="点击查看${esc(shot?.title||'分镜')}大视频">${workbenchVideoMarkup(selectedFile)}<span class="wb-preview-expand">点击查看大视频</span></button>`:showFailureDetails?generationFailurePreviewMarkup(selectedTask):selectedState==='failed'?generationFailurePromptMarkup():selectedState==='syncing'?localDeliveryMarkup(selectedTask)||`<div class="wb-preview-empty"><b>正在准备文件…</b></div>`:selectedState==='pending'?workbenchVideoProgressMarkup(selectedTask):previewTaskId?`<div class="wb-preview-empty wb-preview-missing"><span class="wb-preview-missing-icon" aria-hidden="true">${generationFailureIcon}</span><b>${selectedTask?.status==='completed'&&selectedTask?.assetId?'视频文件未找到':'视频暂不可用'}</b><small>请刷新后重试，或重新生成此版本</small></div>`:`<div class="wb-preview-empty wb-preview-empty-state" aria-label="生成后在这里预览"><b>生成后在这里预览</b></div>`;
    const mediaKey=JSON.stringify([generationPending?pendingCount:0,previewTaskId,selectedState,selectedFile?.url||'',showFailureDetails,selectedFile?'':shot.aspectRatio,selectedTask?.error||'',selectedTask?.failure||null,localDeliverySignature(selectedTask?.assetId)]);
    const versionStrip=versions.length||generationPending?`<div class="wb-preview-versions" aria-label="视频版本">${pendingThumbs}${versions.map(item=>workbenchPreviewThumbMarkup(item,{selected:!generationPending&&item.id===previewTaskId,shotId:shot.id,shotTitle:shot.title})).join('')}</div>`:'';
    return `<section class="wb-shot-preview" aria-label="${esc(shot?.title||'分镜')}预览"><header><b>预览</b><span>${generationPending?'正在准备…':versions.length?`${versions.length} 个版本`:'暂无视频'}</span></header><div class="wb-preview-stage" data-wb-preview-content="${esc(mediaKey)}" style="--video-ratio:${ratioCss(shot?.aspectRatio||'9:16')}">${media}</div>${versionStrip}</section>`;
  }

  function workbenchTitleWidth(value){
    const title=String(value||'');
    const units=Array.from(title).reduce((total,char)=>total+(char.charCodeAt(0)>255?1:0.58),0);
    return Math.min(320,Math.max(26,Math.ceil(units*16+10)));
  }
  function fitWorkbenchTitle(input){
    if(!input)return;
    const value=input.value||input.textContent||'';
    const width=workbenchTitleWidth(value);
    input.style.width=`${width}px`;
  }
  function workbenchShotSettings(shot,locked){
    const {models,parameters,modelId}=ensureProfessionalVideoSettings(shot);
    const modelOptions=models.map(model=>({...model,value:model.id,label:model.label,meta:model.description||'',disabled:!professionalModelIsAvailable(model)}));
    const modelSelect=workbenchDropdownMarkup('generation.modelId','模型',modelOptions,modelId,{disabled:locked||!models.some(professionalModelIsAvailable),sourceAttrs:'data-wb-field="generation.modelId"'});
    const ratioOptions=parameters?.aspectRatios||ratios;
    const durationOptions=parameters?.durations?.filter(value=>Number(value)!==30)||durations;
    const qualityOptions=parameters?.qualityOptions||['720p'];
    const countOptions=[1,2,4];
    const activeModel=models.find(model=>model.id===modelId);
    const modeDescriptions={TEXT:'仅使用文字描述',REFERENCE:'使用项目素材保持人物与场景一致','FIRST&LAST':'使用首帧与尾帧控制镜头'};
    const modeOptions=[['TEXT','文本生成'],['REFERENCE','参考图片'],['FIRST&LAST','首尾帧']].map(([value,label])=>{const supported=Boolean(activeModel?.modes?.some(mode=>mode.generationType===value));const blockedByRefs=(value==='TEXT'||value==='FIRST&LAST')&&shotReferenceIds(shot).length>0;return {value,label,meta:modeDescriptions[value],disabled:!supported||blockedByRefs};});
    const modeSelect=workbenchDropdownMarkup('generation.type','模式',modeOptions,shot.generation.type,{disabled:locked,sourceAttrs:'data-wb-field="generation.type"'});
    const specs=workbenchSpecsMarkup(shot,ratioOptions,qualityOptions,durationOptions,countOptions,locked);
    return {modelSelect,modeSelect,specs};
  }

  function workbenchShotCard(shot,index,locked){
    const status=taskDisplayStatus(shot.selectedVideoTaskId);
    const active=shot.id===professionalShotId;
    const {modelSelect,modeSelect,specs}=workbenchShotSettings(shot,locked);
    const capability=professionalCapabilityState(shot);
    const cost=professionalVideoCostState(shot);
    const placeholder='描述当前分镜的内容，可使用 @ 引用项目素材中的素材；粘贴含 @素材名 的文字会自动引用';
    const references=workbenchReferenceRow(shot);
    const editorContent=shot.script.trim()?renderMentionEditorContent(shot):richEditorEmptyChar;
    const tooltip=capability.message||cost.message||'';
    return `<article class="wb-shot-card ${active?'is-active':''} ${status==='completed'?'is-generated':''} ${status==='failed'?'is-failed':''}" data-wb-shot="${shot.id}" data-wb-shot-index="${index}">
      <div class="wb-shot-legend"><button type="button" class="wb-shot-title-display" data-wb-edit-title data-tooltip="点击修改名称" title="点击修改名称" aria-label="修改分镜${index+1}名称：${esc(shot.title)}" style="width:${workbenchTitleWidth(shot.title)}px" ${locked?'disabled':''}>${esc(shot.title)}</button><input class="wb-shot-title wb-shot-title-input hidden" data-wb-field="title" value="${esc(shot.title)}" maxlength="120" aria-label="分镜${index+1}名称" style="width:${workbenchTitleWidth(shot.title)}px" ${locked?'disabled':''}></div><button type="button" class="wb-shot-delete" data-wb-delete-shot="${shot.id}" aria-label="删除${esc(shot.title)}" title="删除分镜" ${locked?'disabled':''}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
      <div class="wb-shot-layout"><section class="wb-shot-edit-column"><label class="wb-prompt-label" for="wb-script-${shot.id}">输入分镜内容</label><div id="wb-script-${shot.id}" class="wb-rich-input ${references?'has-reference':''}" data-wb-rich-editor="script" data-shot-id="${shot.id}" data-empty="${shot.script.trim()?'false':'true'}" data-placeholder="${esc(placeholder)}" contenteditable="${locked?'false':'true'}" role="textbox" aria-multiline="true" aria-label="分镜${index+1}内容">${references}${editorContent}</div><footer class="wb-shot-controls"><button type="button" class="wb-control-plus" data-wb-add-reference="${shot.id}" aria-label="添加分镜参考素材" ${locked?'disabled':''}>＋</button><div class="wb-control-select wb-model-select">${modelSelect}</div><div class="wb-dropdown-control wb-mode-control">${modeSelect}</div><div class="wb-dropdown-control wb-specs-control">${specs}</div><div class="wb-shot-actions">${promptOptimizationButton(shot,locked)}<button type="button" class="wb-generate-button" data-wb-generate="${shot.id}" ${locked||!capability.ok||professionalGenerationPending.has(shot.id)?'disabled':''} title="${esc(tooltip)}"><span class="wb-generation-cost" aria-label="${cost.credits===null?esc(cost.label):`预计 ${cost.label} 积分`}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg><span data-wb-credit-value>${cost.credits===null?'—':cost.label}</span></span><span class="wb-generate-divider" aria-hidden="true"></span><span data-wb-generate-label>${status==='completed'?'再次生成':'生成'}</span></button></div></footer></section>${workbenchShotPreview(shot)}</div>
    </article>`;
  }

  function workbenchFinalCut(assetId){
    const file=asset(assetId);if(!file)return '';
    if(assetSyncing(file))return `<section class="wb-final-cut" aria-label="最终成片"><header><div><b>最终成片</b><span>正在合成所选分镜视频</span></div><span class="wb-lock-mark">生成中</span></header><div class="wb-preview-empty"><span class="wb-preview-play">${PREVIEW_PLAY_ICON}</span><b>完整成片生成中…</b></div></section>`;
    return `<section class="wb-final-cut" aria-label="最终成片"><header><div><b>最终成片</b><span>已按当前选中版本完成合成</span></div><span class="wb-lock-mark">已锁定</span></header><button type="button" class="wb-final-media" data-wb-preview-file="${esc(file.id)}" aria-label="点击查看最终成片">${workbenchVideoMarkup(file)}<span class="wb-preview-expand">点击查看最终成片</span></button></section>`;
  }


  const workbenchStatusFrames=new WeakSet();
  function scheduleWorkbenchShotStatus(card,id){
    if(!card||workbenchStatusFrames.has(card))return;
    workbenchStatusFrames.add(card);
    requestAnimationFrame(()=>{workbenchStatusFrames.delete(card);if(card.isConnected)refreshWorkbenchShotStatus(card,project?.shots.find(shot=>shot.id===id));});
  }

  function refreshWorkbenchShotStatus(card,shot){
    if(!card||!shot)return;void refreshProfessionalPrices();const capability=professionalCapabilityState(shot);const cost=professionalVideoCostState(shot);const generate=card.querySelector('[data-wb-generate]');if(generate){generate.disabled=Boolean(project.finalAssetId||!capability.ok||professionalGenerationPending.has(shot.id));generate.title=capability.message||cost.message||'';const credits=card.querySelector('.wb-generation-cost');if(credits){credits.setAttribute('aria-label',cost.credits===null?cost.label:`预计 ${cost.label} 积分`);const value=credits.querySelector('[data-wb-credit-value]');setWorkbenchText(value,cost.credits===null?'—':cost.label);}}const optimize=card.querySelector('[data-wb-optimize]');if(optimize){optimize.disabled=Boolean(project.finalAssetId||!shot.script.trim());optimize.title=shot.script.trim()?'优化分镜内容':'请先填写分镜内容';}const editor=card.querySelector('.wb-rich-input');if(editor)editor.dataset.empty=shot.script.trim()?'false':'true';
  }
  async function deletePreviewVideo(shotId,taskId,button){
    const id=String(taskId||'');
    const shot=project.shots.find(item=>item.id===shotId);
    const request=projectRequest();
    const generation=task(id);
    if(!shot||!(shot.videoVersions||[]).includes(id))return;
    if(['queued','running'].includes(generation?.status))return toast('视频生成中，完成后才能删除');
    if(!await confirmDelete({title:generation?.status==='failed'?'确认删除失败版本':'确认删除视频版本',message:generation?.status==='failed'?'失败版本删除后无法恢复。':'该视频版本、关联文件删除后无法恢复。'}))return;
    if(generation?.status!=='failed'&&!await confirmDelete({title:'再次确认删除视频版本',message:'这是已生成的视频内容。确认永久删除，并从所有关联短剧分镜中移除吗？'}))return;
    assertProjectRequest(request);
    button.disabled=true;
    try{
      const result=await api(`/api/drama/projects/${encodeURIComponent(project.id)}/shots/${encodeURIComponent(shot.id)}/videos/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});
      assertProjectRequest(request);
      project=restoreLocalProjectOutputs(normalizeProjectData(result.project));
      projectBaseSnapshot=cloneProjectValue(project);
      projects=mergeDramaProjectList(projects,project);
      state.dramaProject=project;
      if(professionalPreviewTaskIds.get(shotId)===id)professionalPreviewTaskIds.delete(shotId);
      state.tasks=state.tasks.filter(item=>item.id!==id);
      const deletedAssetId = result?.deletedAssetId || generation?.assetId;
      if(deletedAssetId) {
        if (removeCloudAssets) await removeCloudAssets([deletedAssetId]);
        else state.files=state.files.filter(file=>file.id!==deletedAssetId);
        assertProjectRequest(request);
      }
      // Confirm the deletion against the shared generation list as well. If a
      // polling request was already in flight, its older response must not
      // resurrect this task on the video-generation page.
      await loadTasks();
      assertProjectRequest(request);
      render(true,{focus:false});
      toast('视频版本及关联文件已删除');
    }catch(error){if(error.stale)return;button.disabled=false;toast(error.message);}
  }

  async function refreshProject({ quiet = false } = {}) {
    if (!project?.id) return project;
    const targetProjectId=project.id;
    const targetEpoch=projectEpoch;
    const requestAccount=accountSnapshot();
    try {
      await flushSave();
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId||!isAccountCurrent(requestAccount))return project;
      const result=await api(`/api/drama/projects/${encodeURIComponent(targetProjectId)}`);
      if(projectEpoch!==targetEpoch||project?.id!==targetProjectId||!isAccountCurrent(requestAccount))return project;
      acceptProjectResponse(result.project);
      if(!quiet)render(true,{focus:false});
      return project;
    }catch(error){
      if(!quiet&&isAccountCurrent(requestAccount))toast(error.message);
      throw error;
    }
  }

  function bindWorkbenchPreviewActions(scope=root){
    scope.querySelectorAll('.retry-local-download').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();retryLocalDownload(button.dataset.assetId);}));
    scope.querySelectorAll('[data-wb-preview-file]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const file=asset(button.dataset.wbPreviewFile);if(file&&assetSyncing(file))return toast('素材正在准备文件，请稍后再预览');openProfessionalMediaPreview(button.dataset.wbPreviewFile);}));
    scope.querySelectorAll('[data-wb-delete-preview-video]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();void deletePreviewVideo(button.dataset.wbDeletePreviewShot,button.dataset.wbDeletePreviewVideo,button);}));
    scope.querySelectorAll('[data-wb-preview-video]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();professionalPreviewShotId=button.dataset.wbPreviewShot;professionalShotId=button.dataset.wbPreviewShot;const previewTaskId=button.dataset.wbPreviewVideo;const shot=project.shots.find(item=>item.id===professionalShotId);const generation=task(previewTaskId);const selectedFile=taskAsset(previewTaskId);const canPreview=taskLocallyReady(previewTaskId);activateProfessionalShot(professionalPreviewShotId);if(!shot)return;if(canPreview&&selectedFile){professionalPreviewTaskIds.delete(shot.id);shot.selectedVideoTaskId=previewTaskId;queueProfessionalSave();patchProfessionalTaskSurfaces();openProfessionalMediaPreview(selectedFile.id);return;}
      // Failed and still-generating versions both stay clickable: the click only moves the
      // large preview onto that task so the user can watch its progress or failure reason.
      if(videoPreviewVersionState(generation,{ready:canPreview,syncing:taskSyncing(previewTaskId)})==='missing')return;
      professionalPreviewTaskIds.set(shot.id,previewTaskId);
      patchProfessionalTaskSurfaces();}));
  }

  function assemblyHistoryDate(value){
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function closeProfessionalAssemblyLibrary(){
    const dialog=document.querySelector('#professionalAssemblyLibraryDialog');
    if(dialog?.open)dialog.close();
  }
  function openProfessionalAssemblyLibrary(){
    const history=[...(project?.assemblyVideos||[])].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    let dialog=document.querySelector('#professionalAssemblyLibraryDialog');
    if(!dialog){
      dialog=document.createElement('dialog');dialog.id='professionalAssemblyLibraryDialog';dialog.className='professional-assembly-library-dialog';
      dialog.addEventListener('close',()=>{releaseWorkbenchVideos(dialog);dialog.innerHTML='';});
      document.body.append(dialog);
    }
    dialog.innerHTML=`<div class="dialog-head"><div><span class="dialog-kicker">ASSEMBLY LIBRARY</span><h2>合成视频库</h2><p>这里保留本项目每次合成的成片。新增分镜或更换视频后，可以继续合成新的版本。</p></div><button type="button" data-assembly-library-close aria-label="关闭">×</button></div><div class="assembly-library-body"><div class="assembly-library-summary"><b>${history.length} 条合成记录</b><span>按最近合成时间排序</span></div><div class="assembly-library-grid">${history.map((item,index)=>{const file=asset(item.assetId);const media=file&&String(file.url||'').startsWith('gugu-media://')?`<video data-preview-src="${esc(file.url)}" controls preload="none" playsinline></video>`:'<div class="assembly-history-missing"><span>⌁</span><b>视频文件暂不可用</b><small>请在生成该视频的桌面设备上打开项目</small></div>';return `<article class="assembly-history-card"><div class="assembly-history-media">${media}</div><footer><div><b>合成版本 ${history.length-index}</b><span>${assemblyHistoryDate(item.createdAt)} · ${item.shotCount||'多个'} 个成品视频</span></div>${file?`<button type="button" class="secondary-button" data-assembly-history-preview="${esc(file.id)}">放大播放</button>`:''}</footer></article>`;}).join('')||'<div class="assembly-library-empty"><span>⌁</span><b>还没有合成记录</b><p>完成至少 2 个分镜视频后，点击“分镜合成”即可在这里保留成片。</p></div>'}</div></div><footer class="assembly-library-footer"><span>历史成片不会影响后续分镜编辑和再次合成</span><button type="button" class="secondary-button" data-assembly-library-close>关闭</button></footer>`;
    dialog.querySelectorAll('[data-assembly-library-close]').forEach(button=>button.onclick=closeProfessionalAssemblyLibrary);
    dialog.querySelectorAll('[data-assembly-history-preview]').forEach(button=>button.onclick=()=>openProfessionalMediaPreview(button.dataset.assemblyHistoryPreview));
    dialog.showModal();
  }

  function patchWorkbenchPreviewProgress(card, shot){
    const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
    const generation = task(previewTaskId);
    const progress = videoTaskProgress(generation);
    updateVideoGenerationProgress(card?.querySelector('.wb-shot-preview .wb-video-generation'), progress);
  }

  function patchWorkbenchPreview(current,next){
    current.setAttribute('aria-label',next.getAttribute('aria-label'));
    setWorkbenchText(current.querySelector('header span'),next.querySelector('header span').textContent);
    const oldStage=current.querySelector('.wb-preview-stage');const newStage=next.querySelector('.wb-preview-stage');
    const oldMedia=oldStage.querySelector('.wb-preview-media');const newMedia=newStage.querySelector('.wb-preview-media');
    if(oldMedia&&newMedia&&oldMedia.getAttribute('aria-label')!==newMedia.getAttribute('aria-label'))oldMedia.setAttribute('aria-label',newMedia.getAttribute('aria-label'));
    if(oldStage.dataset.wbPreviewContent!==newStage.dataset.wbPreviewContent){
      releaseWorkbenchVideos(oldStage);oldStage.replaceWith(newStage);
      bindWorkbenchPreviewActions(newStage);bindWorkbenchVideoRatios(newStage);hydrateWorkbenchVideos(newStage);
    }
    const oldVersions=current.querySelector('.wb-preview-versions');const newVersions=next.querySelector('.wb-preview-versions');
    if(!newVersions){if(oldVersions){releaseWorkbenchVideos(oldVersions);oldVersions.remove();}return;}
    if(!oldVersions){current.append(newVersions);bindWorkbenchPreviewActions(newVersions);hydrateWorkbenchVideos(newVersions);return;}
    const existing=new Map([...oldVersions.children].map(node=>[node.dataset.wbVersion,node]));
    const desired=new Set([...newVersions.children].map(node=>node.dataset.wbVersion));
    existing.forEach((node,id)=>{if(!desired.has(id)){releaseWorkbenchVideos(node);node.remove();}});
    [...newVersions.children].forEach((node,index)=>{
      const old=existing.get(node.dataset.wbVersion);
      const retained=old&&old.dataset.wbThumbContent===node.dataset.wbThumbContent;
      const item=retained?old:node;
      if(old&&!retained){releaseWorkbenchVideos(old);old.replaceWith(node);}
      if(retained){
        if(old.className!==node.className)old.className=node.className;
        ['.wb-preview-thumb-view','.wb-preview-thumb-delete'].forEach(selector=>{
          const button=old.querySelector(selector);const nextButton=node.querySelector(selector);
          if(button&&nextButton&&button.getAttribute('aria-label')!==nextButton.getAttribute('aria-label'))button.setAttribute('aria-label',nextButton.getAttribute('aria-label'));
        });
      }else{bindWorkbenchPreviewActions(item);hydrateWorkbenchVideos(item);}
      const at=oldVersions.children[index];if(at!==item)oldVersions.insertBefore(item,at||null);
    });
  }

  function patchProfessionalTaskSurfaces(){
    if(!project||state.route!=='drama')return;
    let completed=0;
    const taskById=new Map(state.tasks.map(item=>[item.id,item]));const fileById=new Map(state.files.map(item=>[item.id,item]));
    patchProfessionalAssetSurfaces();
    completed=project.shots.filter(shot=>taskLocallyReady(shot.selectedVideoTaskId)).length;
    const mountedCards=[...root.querySelectorAll('[data-wb-shot]')];
    const shotById=new Map(project.shots.map(shot=>[shot.id,shot]));
    mountedCards.forEach(card=>{
      const shot=shotById.get(card.dataset.wbShot);if(!shot)return;
      const selectedStatus=taskDisplayStatus(shot.selectedVideoTaskId);

      card.classList.toggle('is-generated',selectedStatus==='completed');
      card.classList.toggle('is-failed',selectedStatus==='failed');
      refreshWorkbenchReferenceRow(shot.id,shot);
      refreshWorkbenchShotStatus(card,shot);
      const generateLabel=card.querySelector('[data-wb-generate-label]');
      setWorkbenchText(generateLabel,selectedStatus==='completed'?'再次生成':'生成');
      const previewTaskId = professionalPreviewTaskIds.get(shot.id) || shot.selectedVideoTaskId;
      const signature=shotPreviewContentSignatureFromMaps(shot,taskById,fileById,assetSyncing,previewTaskId) + localDeliverySignature(task(previewTaskId)?.assetId);
      if(signature===shotPreviewSignatures.get(shot.id)){
        patchWorkbenchPreviewProgress(card, shot);
        return;
      }
      shotPreviewSignatures.set(shot.id,signature);
      const current=card.querySelector('.wb-shot-preview');
      if(!current)return;
      const template=document.createElement('template');
      template.innerHTML=workbenchShotPreview(shot);
      patchWorkbenchPreview(current,template.content.firstElementChild);
      patchWorkbenchPreviewProgress(card,shot);
    });
    const assemble=root.querySelector('.wb-assemble');
    if(assemble){assemble.disabled=completed<2;const count=assemble.querySelector('span');setWorkbenchText(count,`${completed} 个成品`);}
  }

  function activateProfessionalShot(id){
    if(!project.shots.some(shot=>shot.id===id))return;
    professionalShotId=id;
    professionalPreviewShotId=id;
    root.querySelectorAll('[data-wb-shot]').forEach(item=>item.classList.toggle('is-active',item.dataset.wbShot===id));
  }

  const updateWorkbenchShot=(id,field,value)=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return false;let target=shot;if(field==='generation.type'){if(value==='TEXT'&&shotReferenceIds(target).length){toast('当前分镜已有参考素材，不能切换为文本生成');return false;}if(value==='FIRST&LAST'&&shotReferenceIds(target).length){toast('当前分镜已有参考素材，请先移除后再使用首尾帧');return false;}const model=state.config?.videoCapabilities?.models?.find(item=>item.id===target.generation.modelId);if(!model?.modes?.some(mode=>mode.generationType===value)){toast('这个模型暂不支持该生成方式，请更换模型');return false;}target.generation.type=value;target.generation.referenceAssetIds=value==='TEXT'||value==='FIRST&LAST'?[]:target.generation.referenceAssetIds;ensureProfessionalVideoSettings(target);}else if(field==='generation.modelId'){const models=professionalVideoModels(target);if(!models.some(model=>model.id===value&&professionalModelIsAvailable(model))){toast('这个模型暂时无法使用，请更换模型');return false;}const resetDuration=target.generation.modelId!==value;target.generation.modelId=value;ensureProfessionalVideoSettings(target,{resetDuration});}else target[field]=field==='duration'?Number(value):value;target.action=field==='script'?value:target.action;target.visualDirection=field==='script'?value:target.visualDirection;invalidateProfessionalShot(target,'分镜参数已修改');queueProfessionalSave();return true;};

  function bindWorkbenchShotSettings(card){
    const id=card.dataset.wbShot;
    card.querySelectorAll('[data-wb-field="generation.modelId"]').forEach(field=>field.addEventListener('change',event=>{updateWorkbenchShot(id,'generation.modelId',event.target.value);refreshWorkbenchShotControls(card);}));
    card.querySelector('[data-wb-field="generation.type"]')?.addEventListener('change',event=>{updateWorkbenchShot(id,'generation.type',event.target.value);refreshWorkbenchShotControls(card);});
    card.querySelector('[data-wb-spec]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.aspectRatio=event.target.value;invalidateProfessionalShot(shot,'画幅已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);});
    card.querySelector('[data-wb-quality]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.generation.quality=event.target.value;invalidateProfessionalShot(shot,'清晰度已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);});
    card.querySelector('[data-wb-duration]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.duration=Number(event.target.value);invalidateProfessionalShot(shot,'时长已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);});
    card.querySelector('[data-wb-count]')?.addEventListener('change',event=>{const shot=project.shots.find(item=>item.id===id);if(!shot||project.finalAssetId)return;shot.generation.count=Math.max(1,Math.min(4,Number(event.target.value)||1));invalidateProfessionalShot(shot,'生成数量已修改');queueProfessionalSave();syncWorkbenchSpecs(card.querySelector('[data-wb-spec-control]'));refreshWorkbenchShotStatus(card,shot);});
  }

  function refreshWorkbenchShotControls(card,settings=null){
    if(!card)return;
    if(card.querySelector('.wb-dropdown.is-open,.wb-spec-control.is-open'))closeWorkbenchDropdowns();
    const shot=project.shots.find(item=>item.id===card.dataset.wbShot);
    if(!shot)return;
    const template=document.createElement('template');
    const {modelSelect,modeSelect,specs}=settings||workbenchShotSettings(shot,projectEditingLocked(project));
    template.innerHTML=`<div class="wb-control-select wb-model-select">${modelSelect}</div><div class="wb-dropdown-control wb-mode-control">${modeSelect}</div><div class="wb-dropdown-control wb-specs-control">${specs}</div>`;
    // Preserve the editor, reference chips, generate button and video preview.
    ['.wb-model-select','.wb-mode-control','.wb-specs-control'].forEach(selector=>{
      const current=card.querySelector(selector);
      const next=template.content.querySelector(selector);
      if(current&&next){current.replaceWith(next);bindWorkbenchDropdowns(next);}
    });
    bindWorkbenchShotSettings(card);
    const snapshot=workbenchCardSignatures.get(card);
    if(snapshot)snapshot.settings=modelSelect+modeSelect+specs;
    refreshWorkbenchShotStatus(card,shot);
  }

  function bindWorkbenchActionBar(actionBar){
    if(actionBar){
      // Keep the bottom rail as one stable interaction boundary. A document
      // pointer/focus handler may schedule a background refresh while an
      // assembly result is being attached; stopping it here prevents that
      // refresh from detaching the button between pointerdown and click.
      actionBar.addEventListener('pointerdown',event=>{
        const button=event.target.closest?.('button');
        if(!button||!actionBar.contains(button))return;
        event.stopPropagation();
        deferredProfessionalRender=false;
      });
      actionBar.addEventListener('click',event=>{
        const button=event.target.closest?.('button');
        if(!button||!actionBar.contains(button)||button.disabled)return;
        event.preventDefault();
        event.stopPropagation();
        if(button.matches('.wb-add-shot'))void addProfessionalShot();
        else if(button.matches('.wb-assemble'))void assembleProfessionalProject();
        else if(button.matches('.wb-assembly-library'))openProfessionalAssemblyLibrary();
      });
    }
  }

  function bindWorkbenchProjectAssetActions(scope){
    scope.querySelectorAll('[data-project-asset]').forEach(tile=>{workbenchAssetSurfaceSignatures.set(tile,projectAssetMedia(asset(tile.dataset.projectAsset)));const activate=()=>{if(tile.disabled||tile.getAttribute('aria-disabled')==='true')return;projectAssetCategory=tile.dataset.projectAssetKind||'other';applyProjectAssetToShot(tile.dataset.projectAsset,professionalShotId);};tile.addEventListener('click',event=>{if(event.target.closest?.('[data-project-asset-remove]'))return;activate();});tile.addEventListener('keydown',event=>{if(event.target.closest?.('[data-project-asset-remove]'))return;if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();activate();});});
    scope.querySelectorAll('[data-project-asset-remove]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();await removeProjectAsset(button.dataset.projectAssetRemove);}));
  }

  function bindWorkbenchEmptyAction(emptyShotAction){
    if(emptyShotAction){
      // The empty state is rendered without the bottom action bar. Keep its
      // create button inside the same interaction boundary so a deferred
      // refresh cannot detach it between pointerdown and click.
      emptyShotAction.addEventListener('pointerdown',event=>{
        event.stopPropagation();
        deferredProfessionalRender=false;
      });
      emptyShotAction.addEventListener('click',event=>{
        if(emptyShotAction.disabled)return;
        event.preventDefault();
        event.stopPropagation();
        void addProfessionalShot();
      });
    }
  }

  function bindStoryboardWorkbench({focus=true,cardsOnly=false,scope=root}={}){
    bindWorkbenchDropdowns(scope);
    const cards=scope.matches?.('[data-wb-shot]')?[scope]:[...scope.querySelectorAll('[data-wb-shot]')];
    cards.forEach(card=>{
      const id=card.dataset.wbShot;
      const selectShot=event=>{if(event.target.closest('[data-wb-delete-shot]'))return;activateProfessionalShot(id);};
      card.addEventListener('focusin',selectShot);
      card.addEventListener('click',selectShot);
      const titleDisplay=card.querySelector('[data-wb-edit-title]');
      const titleInput=card.querySelector('[data-wb-field="title"]');
      const currentShot=()=>project.shots.find(item=>item.id===id);
      const syncTitleUi=value=>{const title=value||DEFAULT_SHOT_TITLE;if(titleDisplay){titleDisplay.textContent=title;fitWorkbenchTitle(titleDisplay);titleDisplay.setAttribute('aria-label',`修改分镜名称：${title}`);}if(titleInput){titleInput.value=title;fitWorkbenchTitle(titleInput);}root.querySelector(`[data-professional-shot="${id}"] b`)?.replaceChildren(document.createTextNode(title));const deleteButton=card.querySelector('[data-wb-delete-shot]');if(deleteButton)deleteButton.setAttribute('aria-label',`删除${title}`);};
      const leaveTitleEdit=({focusDisplay=false}={})=>{if(!titleInput)return;titleInput.value=currentShot()?.title||DEFAULT_SHOT_TITLE;titleInput.classList.add('hidden');titleDisplay?.classList.remove('hidden');card.classList.remove('is-editing-title');syncTitleUi(titleInput.value);if(focusDisplay)titleDisplay?.focus();};
      const commitTitle=()=>{if(!titleInput||!card.classList.contains('is-editing-title'))return;const value=titleInput.value.trim()||DEFAULT_SHOT_TITLE;if(titleInput.value!==value)titleInput.value=value;if(currentShot()?.title!==value)updateWorkbenchShot(id,'title',value);leaveTitleEdit();};
      titleDisplay?.addEventListener('click',event=>{event.stopPropagation();if(titleInput?.disabled||!currentShot())return;titleInput.value=currentShot().title||DEFAULT_SHOT_TITLE;titleDisplay.classList.add('hidden');titleInput.classList.remove('hidden');card.classList.add('is-editing-title');requestAnimationFrame(()=>{titleInput.focus();titleInput.select();});});
      titleInput?.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();leaveTitleEdit({focusDisplay:true});return;}if(event.key==='Enter'){event.preventDefault();event.stopPropagation();commitTitle();}});
      titleInput?.addEventListener('blur',commitTitle);
      card.querySelectorAll('[data-wb-field]').forEach(field=>{field.addEventListener('input',()=>{const key=field.dataset.wbField;if(key.startsWith('generation.')||key==='title')return;updateWorkbenchShot(id,key,field.value);const generate=card.querySelector('[data-wb-generate]');if(generate)generate.disabled=Boolean(project.finalAssetId||professionalProductionWarning(project.shots.find(item=>item.id===id)));});});
      const richEditor=card.querySelector('[data-wb-rich-editor]');
      const syncRichEditorInput=()=>{if(!richEditor?.isConnected||richEditor.dataset.composing==='true')return;normalizeEmptyRichEditor(richEditor);updateShotScriptFromEditor(id,richEditor);if(mentionTriggerAtCaret(richEditor))openMentionPicker(id,richEditor);};
      richEditor?.addEventListener('compositionstart',()=>{richEditor.dataset.composing='true';});
      richEditor?.addEventListener('compositionend',()=>{richEditor.dataset.composing='false';requestAnimationFrame(()=>{syncRichEditorInput();if(richEditor.isConnected&&currentShot())refreshWorkbenchReferenceRow(id,currentShot());});});
      richEditor?.addEventListener('input',event=>{if(event.isComposing||event.inputType==='insertCompositionText'||richEditor.dataset.composing==='true')return;syncRichEditorInput();});
      richEditor?.addEventListener('paste',event=>pasteIntoRichEditor(id,richEditor,event));
      richEditor?.addEventListener('keydown',event=>{if(removeMentionAtCaret(id,richEditor,event))return;if(event.key==='Escape')closeMentionPicker();if(event.key==='ArrowDown'&&document.querySelector('#wbMentionPicker')){event.preventDefault();document.querySelector('#wbMentionPicker [data-mention-option]')?.focus();}});
      bindMentionChipInteractions(richEditor);
      bindWorkbenchShotSettings(card);
      rememberWorkbenchCard(card,currentShot());
      card.querySelectorAll('[data-wb-add-reference],[data-wb-shot-assets]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();professionalShotId=id;professionalPreviewShotId=id;openProjectAssetDialog('other',id);}));
      card.querySelector('[data-wb-delete-shot]')?.addEventListener('click',async event=>{event.stopPropagation();await deleteShot(id);});
      card.querySelectorAll('[data-wb-remove-reference]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();removeWorkbenchReference(id,button.dataset.wbRemoveReference);}));
      card.querySelector('[data-wb-generate]')?.addEventListener('click',async event=>{event.stopPropagation();professionalShotId=id;professionalPreviewShotId=id;await generateProfessionalVideo();});
      card.querySelector('[data-wb-optimize]')?.addEventListener('click',event=>{event.stopPropagation();openShotPromptOptimization(id);});
    });
    bindWorkbenchPreviewActions(scope);
    bindWorkbenchVideoRatios(scope);
    hydrateWorkbenchVideos(scope);
    if(cardsOnly){
      if(focus)root.querySelector('.wb-shot-card:not(.is-locked) .wb-rich-input[contenteditable="true"]')?.focus();
      return;
    }
    root.querySelector('.wb-add-asset')?.addEventListener('click',()=>openProjectAssetDialog('other'));
    root.querySelectorAll('[data-project-asset-add]').forEach(button=>button.addEventListener('click',()=>openProjectAssetDialog(button.dataset.projectAssetAdd)));
    bindWorkbenchProjectAssetActions(root);
    bindWorkbenchActionBar(root.querySelector('.wb-action-bar'));
    bindWorkbenchEmptyAction(root.querySelector('.wb-empty-shot-action'));
    root.querySelector('.wb-shot-scroll')?.addEventListener('scroll',()=>{closeWorkbenchDropdowns();closeMentionPicker();scheduleVirtualShotWindow();},{passive:true});
    if(!mentionDismissBound||!workbenchDropdownDismissBound){document.addEventListener('pointerdown',event=>{const actionBar=event.target.closest?.('.wb-action-bar');if(!event.target.closest('#wbMentionPicker,.wb-rich-input'))closeMentionPicker();if(!event.target.closest('#wbDropdownPortal,.wb-dropdown,.wb-spec-control'))closeWorkbenchDropdowns();if(actionBar){deferredProfessionalRender=false;return;}scheduleFlushDeferredProfessionalRender();});document.addEventListener('focusout',event=>{if(root.contains(event.target)&&!event.relatedTarget?.closest?.('.wb-action-bar'))scheduleFlushDeferredProfessionalRender();});window.addEventListener('resize',()=>{closeWorkbenchDropdowns();closeMentionPicker();scheduleVirtualShotWindow();},{passive:true});mentionDismissBound=true;workbenchDropdownDismissBound=true;}
  }

  function applyProjectAssetToShot(assetId,shotId){
    const shot=project.shots.find(item=>item.id===shotId);const file=asset(assetId);if(!shot||!file||assetSyncing(file)||project.finalAssetId)return;
    projectAssetIds=[...new Set([...projectAssetIds,assetId])];project.projectAssetIds=[...projectAssetIds];projectAssetCategories.set(assetId,projectAssetCategory);project.projectAssetCategories=Object.fromEntries(projectAssetCategories);
    if(file.kind==='image'&&projectAssetCategory==='characters'){shot.professionalAssets.characters=[...new Set([...(shot.professionalAssets.characters||[]),assetId])];}
    else if(file.kind==='image'&&projectAssetCategory==='locations'){shot.professionalAssets.locations=[...new Set([...(shot.professionalAssets.locations||[]),assetId])];}
    addReferenceAssetToShot(shot,assetId);ensureProfessionalVideoSettings(shot);
    invalidateProfessionalShot(shot,'项目素材已添加到本镜');queueProfessionalSave();queueSave('projectAssetIds','projectAssetCategories');professionalPreviewShotId=shot.id;render(true,{focus:false});
  }

  function addReferenceAssetToShot(shot,assetId){if(!shot||!asset(assetId))return;shot.referenceAssetIds=[...new Set([...(shot.referenceAssetIds||[]),assetId])];shot.generation.referenceAssetIds=[...new Set([...(shot.generation.referenceAssetIds||[]),assetId])];if(shot.generation.type==='TEXT')shot.generation.type='REFERENCE';syncProfessionalReferences(shot);}

  async function removeProjectAsset(assetId){
    const id=String(assetId||'');
    const request=projectRequest();
    const file=asset(id);
    if(!file||project?.finalAssetId)return;
    const referencedShots=project.shots.filter(shot=>shotReferenceIds(shot).includes(id)||[shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId,shot.tailFrameAssetId].some(value=>String(value||'')===id)).length;
    const message=referencedShots?`将从当前项目移除「${file.name}」，并解除 ${referencedShots} 个分镜中的引用。文件库中的原始素材不会被删除。`:'仅从当前项目移除该素材，文件库中的原始素材不会被删除。';
    if(!await confirmDelete({title:'确认移除项目素材',message}))return;
    assertProjectRequest(request);
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
      return changed?{...shot,script,action:script,visualDirection:script,professionalAssets,generation,referenceAssetIds,assetMentions,tailFrameAssetId:String(shot.tailFrameAssetId||'')===id?'':shot.tailFrameAssetId,lifecycle:{...shot.lifecycle,status:'draft',revision:(shot.lifecycle?.revision||1)+1,staleReasons:[...new Set([...(shot.lifecycle?.staleReasons||[]),'项目素材已移除'])]}}:shot;
    });
    projectAssetIds=projectAssetIds.filter(value=>String(value)!==id);
    projectAssetCategories.delete(id);
    project.projectAssetIds=[...projectAssetIds];
    project.projectAssetCategories=Object.fromEntries(projectAssetCategories);
    project.resources=nextResources;
    project.shots=nextShots;
    try{
      await patch({projectAssetIds:project.projectAssetIds,projectAssetCategories:project.projectAssetCategories,resources:project.resources,shots:project.shots},{quiet:true});
      assertProjectRequest(request);
      render(true,{focus:false});
      toast('已从项目移除素材');
    }catch(error){
      if(error.stale){
        return;
      }
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
    const dialog=document.querySelector('#projectAssetDialog');if(dialog){releaseWorkbenchVideos(dialog);dialog.innerHTML='';}
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
    dialogs.filter(item=>item!==dialog).forEach(item=>{releaseWorkbenchVideos(item);item.remove();});
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
    const availableFiles=sortFilesByRecency(withoutSupersededLocalFiles(state.files).filter(file=>file.localStatus!=='missing'&&assetKinds.includes(file.kind)&&!assetSyncing(file)));
    const kindCounts=availableFiles.reduce((counts,file)=>{counts[file.kind]=(counts[file.kind]||0)+1;return counts;},{image:0,video:0,audio:0});
    const files=availableFiles.filter(file=>(projectAssetKindFilter==='all'||file.kind===projectAssetKindFilter)&&(!query||String(file.name).toLocaleLowerCase('zh-CN').includes(query)));
    const chosen=new Set(projectAssetSelection);
    const categoryLabel={characters:'人物',locations:'场景',props:'物品',other:'其他'}[projectAssetCategory]||'其他';
    const totalCount=assetKinds.reduce((sum,kind)=>sum+kindCounts[kind],0);
    const iconUpload='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>';
    const iconClose='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    const iconSearch='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
    resetProjectAssetMediaObserver();
    releaseWorkbenchVideos(dialog);
    dialog.innerHTML=`<div class="dialog-head"><div><h2 id="projectAssetDialogTitle">添加${categoryLabel}素材</h2><p>上传素材，或从文件库选择图片、视频、音频。</p></div><button type="button" class="project-asset-close" data-project-asset-close aria-label="关闭">${iconClose}</button></div><div class="project-asset-dialog-toolbar"><label class="project-asset-search">${iconSearch}<input id="projectAssetSearch" type="search" value="${esc(projectAssetQuery)}" placeholder="搜索文件名" aria-label="搜索文件名"></label><button type="button" class="secondary-button project-asset-upload" data-project-asset-upload>${iconUpload}<span>上传素材</span></button><div class="project-asset-kind-filter" role="tablist" aria-label="按素材类型筛选">${[['all','全部'],...assetKinds.map(kind=>[kind,kindLabels[kind]])].map(([kind,label])=>`<button type="button" role="tab" class="${projectAssetKindFilter===kind?'active':''}" data-project-asset-kind-filter="${kind}" aria-selected="${projectAssetKindFilter===kind}"><span>${label}</span><small>${kind==='all'?totalCount:kindCounts[kind]}</small></button>`).join('')}</div></div><div class="project-asset-dialog-grid">${files.map(file=>`<button type="button" class="${chosen.has(file.id)?'selected':''}" data-project-asset-option="${esc(file.id)}" aria-pressed="${chosen.has(file.id)}" aria-label="${esc(file.name)}">${projectAssetMedia(file,{lazy:true})}<span>${esc(file.name)}</span><i aria-hidden="true">✓</i></button>`).join('')||`<p>${query||projectAssetKindFilter!=='all'?'没有匹配的素材。':'文件库中还没有可用素材。'}</p>`}</div><footer><button type="button" class="secondary-button" data-project-asset-close>取消</button><button type="button" class="gradient-button" data-project-asset-confirm ${chosen.size?'':'disabled'}>添加到项目</button></footer>`;
    hydrateProjectAssetMedia(dialog);
    dialog.querySelectorAll('[data-project-asset-kind-filter]').forEach(button=>button.onclick=()=>{projectAssetKindFilter=button.dataset.projectAssetKindFilter;paintProjectAssetDialog();});
    dialog.querySelectorAll('[data-project-asset-close]').forEach(button=>button.onclick=closeProjectAssetDialog);
    dialog.querySelector('#projectAssetSearch')?.addEventListener('input',event=>{projectAssetQuery=event.target.value;clearTimeout(projectAssetSearchTimer);projectAssetSearchTimer=window.setTimeout(()=>{projectAssetSearchTimer=0;if(dialog.open)paintProjectAssetDialog({restoreSearchFocus:true});},120);});
    dialog.querySelectorAll('[data-project-asset-option]').forEach(button=>button.onclick=()=>{const id=button.dataset.projectAssetOption;const selected=projectAssetSelection.includes(id);projectAssetSelection=selected?projectAssetSelection.filter(value=>value!==id):[...projectAssetSelection,id];button.classList.toggle('selected',!selected);button.setAttribute('aria-pressed',String(!selected));const confirm=dialog.querySelector('[data-project-asset-confirm]');if(confirm)confirm.disabled=projectAssetSelection.length===0;});
    dialog.querySelector('[data-project-asset-upload]')?.addEventListener('click',async event=>{
      const button=event.currentTarget;
      if(button.disabled)return;
      const request=projectRequest();
      button.disabled=true;
      try{
        const result=uploadAsset?await uploadAsset({context:'professional-project',multiple:true}):await uploadImage?.({context:'professional-project'});
        assertProjectRequest(request);
        const files=(Array.isArray(result)?result:[result]).filter(file=>file?.id);
        if(!files.length)return;
        const ids=new Set(files.map(file=>file.id));
        projectAssetSelection=[...new Set([...projectAssetSelection,...ids])];
        ids.forEach(id=>projectAssetCategories.set(id,projectAssetCategory));
        state.files=[...new Map(files.map(file=>[file.id,file])).values(),...state.files.filter(item=>!ids.has(item.id))];
        paintProjectAssetDialog();
      }catch(error){if(error.stale)return;toast(error.message);}
      finally{button.disabled=false;}
    });
    dialog.querySelector('[data-project-asset-confirm]')?.addEventListener('click',()=>{const selected=[...projectAssetSelection];const targetShot=projectAssetTargetShotId?project.shots.find(item=>item.id===projectAssetTargetShotId):null;selected.forEach(id=>projectAssetCategories.set(id,projectAssetCategory));projectAssetIds=[...new Set([...projectAssetIds,...selected])];project.projectAssetIds=[...projectAssetIds];project.projectAssetCategories=Object.fromEntries(projectAssetCategories);if(targetShot){selected.forEach(id=>addReferenceAssetToShot(targetShot,id));ensureProfessionalVideoSettings(targetShot);invalidateProfessionalShot(targetShot,'参考素材已添加到本镜');queueProfessionalSave();professionalPreviewShotId=targetShot.id;}projectAssetTargetShotId='';queueSave('projectAssetIds','projectAssetCategories');closeProjectAssetDialog();render(true,{focus:false});toast(targetShot?`已添加 ${selected.length} 个分镜参考`:`已添加 ${selected.length} 个项目素材`);});
    if(restoreSearchFocus)requestAnimationFrame(()=>{if(!dialog.open)return;const search=dialog.querySelector('#projectAssetSearch');search?.focus({preventScroll:true});search?.setSelectionRange(projectAssetQuery.length,projectAssetQuery.length);});
  }

  function professionalPendingCards(shot,{kind='',frameField=''}={}){
    const persisted=(shot.pendingImageGenerations||[]).filter(item=>kind?item.targetType==='category'&&item.kind===kind:item.targetType==='frame'&&item.frameField===frameField);
    const transient=professionalPendingImageGenerations.filter(item=>item.shotId===shot.id&&(kind?item.targetType==='category'&&item.kind===kind:item.targetType==='frame'&&item.frameField===frameField));
    return [...transient,...persisted].filter(item=>!assetMissing(task(item.taskId)?.assetId)).map(item=>{const generation=item.taskId?task(item.taskId):null;const failed=generation?.status==='failed';const missing=Boolean(item.taskId&&!generation);const syncing=Boolean(item.taskId&&taskSyncing(item.taskId));const unavailable=Boolean(generation?.status==='completed'&&!generation.assetId);const terminal=failed||missing||unavailable;const status=failed?generationFailureMarkup(generation):missing?'图片暂不可用':unavailable?'图片暂不可用':syncing?'图片保存中':generation?.status==='running'?'正在生成图片':generation?.status==='queued'?'正在排队': '正在准备';const visual=terminal?`<span class="professional-pending-failure" aria-hidden="true">${generationFailureIcon}</span>`:'<span class="loader-ring"></span>';return `<article class="professional-pending-image ${failed?'failed':''} ${missing||unavailable?'missing':''}"><div class="professional-pending-visual">${visual}</div><div><b>${esc(item.label||'图片')}</b><span>${status}</span></div>${terminal?`<button type="button" data-professional-dismiss-pending="${item.id}" data-professional-pending-shot="${shot.id}" aria-label="关闭${failed?'失败':missing?'不可用':'不可用'}提示">×</button>`:''}</article>`;}).join('');
  }


  function professionalDurationWarning(shot){
    const parameters=professionalVideoParameters(shot);
    const duration=Number(shot?.duration);
    if(!parameters||!Number.isFinite(duration)||parameters.durations.includes(duration))return '';
    return `所选视频模型不支持 ${duration} 秒，请选择 ${parameters.durations.join('、')} 秒后再生成。`;
  }
  function professionalCapabilityState(shot){
    if(!shot?.generation)return {ok:false,message:'当前分镜生成参数不完整。'};
    if(!String(shot.script||'').trim())return {ok:false,message:'请先填写分镜内容。'};
    const configuredModel=state.config?.videoCapabilities?.models?.find(model=>model.id===shot.generation.modelId);
    if(!configuredModel)return {ok:false,message:'请选择可用的视频模型。'};
    if(!professionalModelIsAvailable(configuredModel))return {ok:false,message:`${configuredModel.label||'这个模型'}暂不可用。`};
    const parameters=professionalVideoParameters(shot);
    if(!parameters)return {ok:false,message:`${configuredModel.label||'这个模型'}不支持${generationModeName(shot.generation.type)}模式。`};
    if(!parameters.aspectRatios.includes(shot.aspectRatio))return {ok:false,message:`${configuredModel.label}不支持 ${shot.aspectRatio} 画幅，请切换为 ${parameters.aspectRatios.join('、')}。`};
    if(!parameters.qualityOptions.includes(shot.generation.quality))return {ok:false,message:`${configuredModel.label}不支持 ${shot.generation.quality} 清晰度，请选择 ${parameters.qualityOptions.join('、')}。`};
    if(!parameters.durations.includes(Number(shot.duration)))return {ok:false,message:`${configuredModel.label}不支持 ${shot.duration} 秒，请选择 ${parameters.durations.join('、')} 秒。`};
    const allReferenceIds=shotReferenceIds(shot);
    const availableReferenceIds=availableShotReferenceIds(shot);
    if(allReferenceIds.length!==availableReferenceIds.length)return {ok:false,message:'有参考素材已失效，请重新选择或移除后再生成。'};
    if(shot.generation.type==='TEXT'&&allReferenceIds.length)return {ok:false,message:'当前生成方式不能添加参考素材，请切换为“参考图片”或移除素材。'};
    if(shot.generation.type==='FIRST&LAST'){
      if(allReferenceIds.length)return {ok:false,message:'首尾帧模式不能同时使用普通参考素材，请先移除角色、场景或 @ 引用。'};
      const frames=[shot.generation.firstFrameAssetId,shot.generation.lastFrameAssetId].filter(Boolean);
      if(!frames.length)return {ok:false,message:'首尾帧模式至少需要选择一张首帧图片。'};
      if(frames.some(id=>asset(id)?.kind!=='image'))return {ok:false,message:'首尾帧只能使用图片素材。'};
      if(frames.length>professionalMaxImages(shot))return {ok:false,message:`最多可使用 ${professionalMaxImages(shot)} 张首尾帧图片。`};
      return {ok:true,message:'',parameters,model:configuredModel};
    }
    if(shot.generation.type==='REFERENCE'){
      const max=professionalMaxImages(shot);
      if(!availableReferenceIds.length)return {ok:false,message:'参考图片方式至少需要添加 1 个参考素材。'};
      if(availableReferenceIds.length>max)return {ok:false,message:`最多可使用 ${max} 个参考素材，已添加 ${availableReferenceIds.length} 个。请移除多余素材后再试。`};
      const limits=professionalReferenceLimit(shot);
      const counts={image:0,video:0,audio:0};
      availableReferenceIds.forEach(id=>{const kind=asset(id)?.kind;if(Object.hasOwn(counts,kind))counts[kind]++;});
      for(const kind of Object.keys(counts))if(counts[kind]>Number(limits[kind]||0))return {ok:false,message:`最多可使用 ${limits[kind]||0} 个${kind==='image'?'图片':kind==='video'?'视频':'音频'}参考，已选择 ${counts[kind]} 个。`};
    }
    return {ok:true,message:'',parameters,model:configuredModel};
  }
  function professionalProductionWarning(shot){
    const referenceIds = shot.generation.type === 'TEXT' ? [] : shot.generation.type === 'FIRST&LAST'
      ? [shot.generation.firstFrameAssetId, shot.generation.lastFrameAssetId]
      : [...(shot.referenceAssetIds || []), ...(shot.generation.referenceAssetIds || []), ...Object.values(shot.professionalAssets || {}).flat()];
    if (referenceIds.some(assetMissing)) return '参考素材不存在，请重新选择';
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
  const professionalModelIconUrls=modelLogoUrls;
  const professionalModelIsAvailable=model=>Boolean(model&&model.enabled!==false&&model.availability!=='coming-soon'&&model.availability!=='unavailable'&&model.modes?.some(mode=>mode.qualityOptions?.length&&mode.durations?.length&&mode.aspectRatios?.length));
  function professionalModelIcon(modelId){const src=professionalModelIconUrls[modelId];return src?modelLogoMarkup(src,{className:'select-model-icon'}):'<span class="select-clock" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3.5 2"></path></svg></span>';}
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
    const choices=options.filter(option=>kind!=='model'||(professionalModelIsAvailable(option)&&!option.disabled)).map(option=>{
      const choice=typeof option==='object'?{...option,value:String(option.value),label:String(option.label)}:{value:String(option),label:kind==='duration'?`${option} 秒`:String(option)};
      return {...choice,disabled:Boolean(choice.disabled)||(kind==='model'&&(choice.enabled===false||choice.availability==='coming-soon'))};
    });
    if(kind!=='model'&&current&&!choices.some(option=>option.value===current))choices.unshift({value:current,label:kind==='duration'?`${current} 秒（这个模型不支持）`:`${current}（这个模型不支持）`,disabled:true});
    const chosen=choices.find(option=>option.value===current)||choices.find(option=>!option.disabled)||choices[0]; const selectedValue=chosen?.value||'';
    const label=kind==='model'?'视频模型':kind==='ratio'?'画幅':kind==='quality'?'分辨率':'时长';
    return `<div class="product-select professional-video-select ${disabled?'is-disabled':''}" data-for="professional-${key}" data-dynamic-options="true" data-professional-select="${key}"><button class="product-select-trigger" data-professional-select-trigger type="button" aria-label="选择${label}" aria-haspopup="listbox" aria-expanded="false" ${disabled?'disabled':''}>${chosen?professionalSelectIcon(kind,chosen.value):''}<span><b>${chosen?esc(chosen.label):'暂无可用选项'}</b>${kind==='model'&&chosen?.description?`<small class="select-model-description">${esc(chosen.description)}</small>`:''}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5-5 5"></path></svg></button><div class="product-select-menu hidden" role="listbox" aria-label="${label}">${choices.map(option=>`<button type="button" role="option" aria-selected="${option.value===selectedValue}" data-professional-select-option="${key}" data-value="${esc(option.value)}" ${option.disabled?'disabled':''} ${option.availability?`data-availability="${esc(option.availability)}"`:''}>${professionalSelectIcon(kind,option.value)}<span class="${kind==='model'?'select-option-label':''}"><b>${esc(option.label)}</b>${kind==='model'&&option.description?`<small class="select-model-description">${esc(option.description)}</small>`:''}</span><i>✓</i></button>`).join('')}</div></div>`;
  }
  function closeProfessionalVideoSelects(except=null){root.querySelectorAll('.professional-video-select').forEach(select=>{if(select===except)return;select.querySelector('.product-select-menu')?.classList.add('hidden');select.querySelector('.product-select-trigger')?.setAttribute('aria-expanded','false');});}
  document.addEventListener('click',event=>{if(!event.target.closest('.professional-video-select'))closeProfessionalVideoSelects();});


  function currentProfessionalShot(){return project.shots.find(shot=>shot.id===professionalShotId)||null;}
  function queueProfessionalSave(){queueSave('shots');}
  async function addProfessionalShot(){
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      if(project.finalAssetId)return toast('成片已合成，不能继续添加分镜');
      const shot=createProfessionalShot(project.shots.length+1);project.shots.push(shot);professionalShotId=shot.id;professionalPreviewShotId=shot.id;ensureProfessionalVideoSettings(shot);
      await patch({shots:project.shots},{quiet:true});
      assertProjectRequest(request);
      const scroll=root.querySelector('.wb-shot-scroll');
      if(!scroll)return;
      dropFocus();
      closeWorkbenchDropdowns();
      if(scroll.classList.contains('is-empty')){
        scroll.classList.remove('is-empty');
        scroll.innerHTML='<div data-wb-virtual-spacer="top" aria-hidden="true"></div><div data-wb-virtual-items></div><div data-wb-virtual-spacer="bottom" aria-hidden="true"></div>';
      }
      syncWorkbenchActionBar(false);
      updateVirtualSpacers(scroll);
      scroll.scrollTop=virtualHeightBefore(project.shots.length-1);
      renderProfessionalShotWindow({scroll});
      activateProfessionalShot(shot.id);
      root.querySelector(`[data-wb-shot="${CSS.escape(shot.id)}"] .wb-rich-input`)?.focus({preventScroll:true});
    }catch(error){if(error.stale)return;throw error;}
  }
  function invalidateProfessionalShot(shot,reason){shot.lifecycle={...shot.lifecycle,status:'draft',revision:(shot.lifecycle?.revision||1)+1,staleReasons:[...new Set([...(shot.lifecycle?.staleReasons||[]),reason])]};}
  function setProfessionalMode(mode){const shot=currentProfessionalShot();if(!shot)return;const ids=shotReferenceIds(shot);if((mode==='TEXT'||mode==='FIRST&LAST')&&ids.length)return toast(mode==='TEXT'?'当前分镜已有参考素材，不能切换为文本生成':'当前分镜已有参考素材，请先移除后再使用首尾帧');const model=state.config?.videoCapabilities?.models?.find(item=>item.id===shot.generation.modelId);if(!model?.modes?.some(item=>item.generationType===mode))return toast('这个模型暂不支持该生成方式，请更换模型');shot.generation.type=mode;if(mode==='TEXT'||mode==='FIRST&LAST'){shot.generation.referenceAssetIds=[];}if(mode==='FIRST&LAST'){shot.generation.firstFrameAssetId='';shot.generation.lastFrameAssetId='';}if(mode==='REFERENCE')shot.generation.referenceAssetIds=[...ids];ensureProfessionalVideoSettings(shot);invalidateProfessionalShot(shot,'生成模式已修改');queueProfessionalSave();render(true);}
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
  function openProfessionalMediaPreview(id){const file=asset(id);if(!file)return;if(window.guguDesktop&&!file.localOnly&&file.localStatus!=='saved'&&!String(file.url||'').startsWith('gugu-media://'))return toast('素材正在准备文件，请稍后再预览');let dialog=document.querySelector('#professionalMediaPreviewDialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='professionalMediaPreviewDialog';dialog.className='professional-media-preview-dialog';dialog.addEventListener('close',()=>{releaseWorkbenchVideos(dialog);dialog.innerHTML='';professionalMediaPreview=null;scheduleFlushDeferredProfessionalRender();});document.body.append(dialog);}professionalMediaPreview=id;releaseWorkbenchVideos(dialog);const media=file.kind==='video'?`<video src="${file.url}" controls autoplay playsinline></video>`:`<img src="${file.url}" alt="${esc(file.name)}">`;dialog.innerHTML=`<button type="button" class="professional-media-close" aria-label="关闭">×</button><div class="professional-media-preview-stage">${media}</div><footer><b>${esc(file.name)}</b><span>${file.kind==='video'?'视频播放':'图片预览'}</span></footer>`;dialog.querySelector('.professional-media-close').onclick=()=>dialog.close();dialog.showModal();}
  function rememberProfessionalAsset(id){if(!id)return;professionalRecentAssetIds=[id,...professionalRecentAssetIds.filter(value=>value!==id)].slice(0,24);}
  function professionalRecentAssets(){
    const used=project.shots.flatMap(shot=>[...(shot.professionalAssets?.characters||[]),...(shot.professionalAssets?.locations||[]),shot.generation?.firstFrameAssetId,shot.generation?.lastFrameAssetId]).filter(Boolean);
    const generated=state.tasks.filter(item=>item.type==='image'&&taskLocallyReady(item.id)).sort((a,b)=>String(b.finishedAt||b.updatedAt||b.createdAt).localeCompare(String(a.finishedAt||a.updatedAt||a.createdAt))).map(item=>item.assetId);
    const ids=[...generated,...professionalRecentAssetIds,...used.reverse()];
    return [...new Set(ids)].map(id=>asset(id)).filter(file=>file?.kind==='image'&&!assetSyncing(file)).slice(0,12);
  }
  function professionalPickerLabel(){if(professionalMediaPicker.frameField)return professionalMediaPicker.frameField==='firstFrameAssetId'?'首帧':'尾帧';return professionalMediaPicker.kind==='characters'?'角色':'场景';}
  function openProfessionalAssetPicker(kind){const shot=currentProfessionalShot();professionalAssetKind=kind;professionalFrameField='';professionalAssetSelection=[...(shot?.professionalAssets?.[kind]||[])];professionalMediaPicker={...professionalMediaPicker,tab:'library',kind,frameField:'',prompt:'',referenceAssetIds:[],query:''};paintProfessionalAssetDialog();}
  function openProfessionalFramePicker(field){const shot=currentProfessionalShot();professionalFrameField=field;professionalAssetKind='';professionalAssetSelection=shot?.generation?.[field]?[shot.generation[field]]:[];professionalMediaPicker={...professionalMediaPicker,tab:'library',kind:'',frameField:field,prompt:'',referenceAssetIds:[],query:''};paintProfessionalAssetDialog();}
  function setProfessionalFrameValue(shot,field,id){if(!shot)return;shot.generation[field]=id;if(field==='firstFrameAssetId'&&shot.generation.lastFrameAssetId===id)shot.generation.lastFrameAssetId='';if(field==='lastFrameAssetId'&&shot.generation.firstFrameAssetId===id)shot.generation.firstFrameAssetId='';}
  function setProfessionalFrame(field,id){const shot=currentProfessionalShot();if(!shot||!asset(id)||asset(id).kind!=='image')return toast('请选择有效的文件库图片');setProfessionalFrameValue(shot,field,id);rememberProfessionalAsset(id);invalidateProfessionalShot(shot,'首尾帧图片已修改');queueProfessionalSave();render(true);}
  async function clearProfessionalFrame(field){const shot=currentProfessionalShot();const request=projectRequest();if(!shot||!shot.generation[field]||!await confirmDelete({title:'确认删除图片',message:'图片一旦删除，无法恢复。'}))return;try{assertProjectRequest(request);shot.generation[field]='';invalidateProfessionalShot(shot,'首尾帧图片已修改');queueProfessionalSave();render(true);}catch(error){if(!error.stale)throw error;}}

  function professionalPickerCard(file,{recent=false}={}){
    const selected=professionalAssetSelection.includes(file.id);
    const action=recent?'data-professional-recent-asset':'data-professional-pick-asset';
    return `<button type="button" class="${selected?'selected':''}" ${action}="${file.id}">${assetImageMarkup(file, file.name)}<span>${esc(file.name)}</span></button>`;
  }
  function professionalUploadJobCard(job){
    const failed=job.status==='failed'; const completed=job.status==='completed'; const progress=Math.max(0,Math.min(100,Math.round(job.progress||0))); const percent=failed?'失败':`${progress}%`; const label=failed?job.error:completed?(job.selected?'上传完成，已选中':'上传完成'):(job.label||'准备上传');
    const media=job.kind==='image'&&job.previewUrl?`<img src="${esc(job.previewUrl)}" alt="${esc(job.name)}" decoding="async">`:job.kind==='video'&&job.previewUrl?`<video data-preview-src="${esc(job.previewUrl)}" muted preload="none"></video>`:'<span class="audio-file-mark">♫</span>';
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
    dialog.innerHTML=`<div class="dialog-head"><div><h2>选择参考图片</h2><p>参考图会帮助生成结果保持主体、材质与画面风格一致。</p></div><button type="button" data-professional-reference-close aria-label="关闭">×</button></div><p class="professional-dialog-help">最多选择 7 张图片，单张不超过 20 MB。上传后可以直接使用。</p><div class="professional-reference-actions"><button type="button" class="secondary-button" data-professional-reference-upload>↑ 上传图片</button><span>已选择 ${professionalGenerationReferenceSelection.length} / 7</span></div><div class="professional-reference-grid">${uploadJobs.map(professionalUploadJobCard).join('')}${images.length?images.map(file=>`<button type="button" class="${professionalGenerationReferenceSelection.includes(file.id)?'selected':''}" data-professional-reference-option="${file.id}">${assetImageMarkup(file, file.name)}<span>${esc(file.name)}</span><i>✓</i></button>`).join(''):(uploadJobs.length?'':'<div class="professional-reference-empty"><b>没有可用图片</b><p>先上传一张图片到文件库。</p></div>')}</div><footer><button type="button" class="secondary-button" data-professional-reference-close>取消</button><button type="button" class="gradient-button" data-professional-reference-confirm>使用所选图片</button></footer>`;
    dialog.querySelectorAll('[data-professional-reference-close]').forEach(button=>button.onclick=()=>dialog.close());
    dialog.querySelectorAll('[data-professional-reference-option]').forEach(button=>button.onclick=()=>{const id=button.dataset.professionalReferenceOption;if(professionalGenerationReferenceSelection.includes(id))professionalGenerationReferenceSelection=professionalGenerationReferenceSelection.filter(value=>value!==id);else if(professionalGenerationReferenceSelection.length<7)professionalGenerationReferenceSelection=[...professionalGenerationReferenceSelection,id];else return toast('最多选择 7 张参考图片');paintProfessionalGenerationReferenceDialog();});
    dialog.querySelector('[data-professional-reference-upload]')?.addEventListener('click',()=>{uploadImage?.({context:'professional-reference'}).then(file=>{if(!file)return;rememberProfessionalAsset(file.id);if(professionalGenerationReferenceSelection.length<7)professionalGenerationReferenceSelection=[...new Set([...professionalGenerationReferenceSelection,file.id])];else toast('已上传图片，但参考图片已达到上限');paintProfessionalGenerationReferenceDialog();}).catch(error=>toast(error.message));});
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
    const uploadPanel=`<section class="professional-picker-panel professional-upload-panel"><div class="professional-upload-jobs">${uploadJobs.map(professionalUploadJobCard).join('')}</div><div class="professional-upload-drop"><span>↑</span><h3>上传素材${label}图片</h3><p>支持 PNG、JPEG、WebP，单张不超过 20 MB。选择图片后即可继续。</p><button type="button" class="gradient-button" data-professional-upload-asset>选择图片</button></div></section>`;
    const libraryPanel=`<section class="professional-picker-panel professional-library-panel"><section class="professional-recent-assets"><header><b>最近使用</b><span>包含近期使用和生成的图片</span></header><div>${recentCards||'<p>暂无最近使用图片</p>'}</div></section><div class="professional-library-controls"><label class="professional-asset-search"><span>⌕</span><input id="professionalAssetSearch" type="search" value="${esc(professionalMediaPicker.query)}" placeholder="搜索图片"></label><span>已选择 ${professionalAssetSelection.length}${isFrame?'':' / 7'} 张</span></div><header class="professional-library-all-head"><b>全部图片</b><span>${filtered.length} 张</span></header><div class="professional-asset-dialog-grid">${filtered.map(file=>professionalPickerCard(file)).join('')||'<p>文件库中没有匹配的图片。</p>'}</div></section>`;
    const selectedReferences=professionalMediaPicker.referenceAssetIds.map(id=>asset(id)).filter(file=>file?.kind==='image');
    const referenceSummary=selectedReferences.length?selectedReferences.map(file=>`<span class="professional-generation-reference-thumb">${assetImageMarkup(file, file.name)}<button type="button" data-professional-remove-generation-reference="${file.id}" aria-label="移除参考图片 ${esc(file.name)}">×</button></span>`).join(''):'<p>尚未选择参考图片，可不添加。</p>';
    const generationPanel=`<section class="professional-picker-panel professional-image-generation"><label for="professionalAssetPrompt">创作描述</label><textarea id="professionalAssetPrompt" maxlength="4000" placeholder="描述${label}的主体、环境、光线、构图和风格……">${esc(professionalMediaPicker.prompt)}</textarea><div class="professional-generation-field"><header><b>参考图片</b><span>${selectedReferences.length} / 7</span></header><div class="professional-generation-reference-summary"><div>${referenceSummary}</div><button type="button" class="secondary-button" data-professional-open-generation-references>${selectedReferences.length?'调整参考图片':'选择参考图片'}</button></div></div><fieldset><legend>画布比例</legend><div class="professional-generation-ratios">${imageRatios.map(value=>`<label><input type="radio" name="professionalImageSize" value="${value}" ${professionalMediaPicker.size===value?'checked':''}><span>${value}</span></label>`).join('')}</div></fieldset><fieldset><legend>质量</legend><div class="professional-generation-quality">${imageQualities.map(([value,text])=>`<label><input type="radio" name="professionalImageQuality" value="${value}" ${professionalMediaPicker.quality===value?'checked':''}><span>${text}</span></label>`).join('')}</div></fieldset><div class="professional-generation-submit"><span>生成完成后即可使用 · ${label} · ${state.pricing.image} 积分</span><button type="button" class="gradient-button" data-professional-generate-asset>开始生成</button></div></section>`;
    const confirmAction=tab==='library'?`<button type="button" class="gradient-button" data-professional-confirm-assets ${!professionalAssetSelection.length?'disabled':''}>${isFrame?'使用此图片':`使用所选图片（${professionalAssetSelection.length}）`}</button>`:'';
    dialog.innerHTML=`<div class="dialog-head"><div><h2>添加${label}图片</h2><p>${isFrame?'选择一张图片作为当前帧。':'可选择多张图片，确认后按选择顺序添加。'}</p></div><button type="button" data-professional-close aria-label="关闭">×</button></div><nav class="professional-picker-tabs" aria-label="图片来源">${[['library','文件库'],['upload','上传图片'],['generate','图像生成']].map(([value,text])=>`<button type="button" class="${tab===value?'active':''}" data-professional-picker-tab="${value}">${text}</button>`).join('')}</nav>${tab==='upload'?uploadPanel:tab==='generate'?generationPanel:libraryPanel}<footer><button type="button" class="secondary-button" data-professional-close>取消</button>${confirmAction}</footer>`;
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
  async function generateProfessionalAsset(){
    if(!professionalAssetGeneration)return;
    const request=projectRequest();
    const pending={...professionalAssetGeneration};
    const checked=await promptPrecheck.check({prompts:[pending.prompt],source:'drama',scopeNote:true});
    if(checked.action==='cancel')return;
    professionalPendingImageGenerations=[pending,...professionalPendingImageGenerations];
    render(true);
    try{
      const referenceAssetIds=await ensureCloudReferenceIds(pending.referenceAssetIds);
      assertProjectRequest(request);
      const result=await api('/api/generations',{method:'POST',body:JSON.stringify({type:'image',prompt:checked.prompts[0],size:pending.size,quality:pending.quality,referenceAssetIds,...checked.fields})});
      assertProjectRequest(request);
      setCreditBalance(result.balance);
      state.tasks=[result,...state.tasks.filter(item=>item.id!==result.id)];
      scheduleTaskPoll();
      professionalPendingImageGenerations=professionalPendingImageGenerations.filter(item=>item.id!==pending.id);
      const shot=project.shots.find(item=>item.id===pending.shotId);
      if(shot){
        shot.pendingImageGenerations=[...(shot.pendingImageGenerations||[]),{...pending,taskId:result.id}];
        await patch({shots:project.shots},{quiet:true});
        assertProjectRequest(request);
      }
      professionalAssetGeneration=null;
      render(true);
      toast(`已开始生成${pending.label}图片，完成后即可使用`);
    }catch(error){
      professionalPendingImageGenerations=professionalPendingImageGenerations.filter(item=>item.id!==pending.id);
      if(professionalAssetGeneration?.id===pending.id)professionalAssetGeneration=null;
      if(error.stale)return;
      render(true);
      toast(error.message);
      await loadCredits();
    }
  }
  async function generateProfessionalVideo(){
    let shot=currentProfessionalShot();
    if(!shot||!shot.script.trim()||professionalGenerationPending.has(shot.id))return;
    void refreshProfessionalPrices();
    const targetProjectId=project.id;
    const targetShotId=shot.id;
    const request=projectRequest(targetProjectId);
    ensureProfessionalVideoSettings(shot);
    if(!shot.generation.modelId)return toast('当前没有可用的视频模型，请稍后再试。');
    let warning=professionalProductionWarning(shot);
    if(warning)return toast(warning);
    if(!shotGenerationReady(shot))return;
    const clearPending=()=>professionalGenerationPending.delete(targetShotId);
    professionalGenerationPending.add(targetShotId);
    // Paint the preview state before saving references,
    // or waiting for the generation API to return a task id.
    render(true,{focus:false});
    try{
      await flushSave();
      if(!isProjectRequestCurrent(request)){clearPending();return;}
      // Selection may change while the save is pending; keep the clicked shot.
      shot=project.shots.find(item=>item.id===targetShotId);
      if(!shot){clearPending();return;}
      shot=cloneProjectValue(shot);
      ensureProfessionalVideoSettings(shot);
      if(!shot.generation.modelId){clearPending();render(true,{focus:false});return toast('当前没有可用的视频模型，请稍后再试。');}
      warning=professionalProductionWarning(shot);
      if(warning){clearPending();render(true,{focus:false});return toast(warning);}
      if(!shotGenerationReady(shot)){clearPending();render(true,{focus:false});return;}
      const refs=shotGenerationAssetIds(shot); const requestShot=videoRequestShot(shot,refs); const count=Math.max(1,Math.min(4,Number(shot.generation.count)||1));
      const checked=await promptPrecheck.check({prompts:[shotVideoPrompt(requestShot)],modelId:shot.generation.modelId,source:'drama',scopeNote:true});
      if(checked.action==='cancel'){clearPending();render(true,{focus:false});return;}
      const finalPrompt=checked.prompts[0];
      const cloudRefs=await ensureCloudReferenceIds(refs);
      if(!isProjectRequestCurrent(request)){clearPending();return;}
      const payload={...checked.fields,type:'video',quantity:count,prompt:finalPrompt,dramaProjectId:targetProjectId,dramaShotId:targetShotId,modelId:shot.generation.modelId,aspectRatio:shot.aspectRatio,duration:shot.duration,quality:shot.generation.quality,generationType:requestShot.generation.type,referenceAssetIds:cloudRefs};
      const generationBase=cloneProjectValue(projectBaseSnapshot||project);
      const response=await api('/api/generations',{method:'POST',body:JSON.stringify(payload)});
      if(!isProjectRequestCurrent(request)){clearPending();return;}
      const results=Array.isArray(response.tasks)?response.tasks:[response];
      setCreditBalance(response.balance);
      state.tasks=[...results,...state.tasks.filter(item=>!results.some(result=>result.id===item.id))];scheduleTaskPoll();
      if(!isProjectRequestCurrent(request)){clearPending();return;}
      if(response.project){acceptProjectResponse(response.project,{base:generationBase});professionalPreviewTaskIds.set(targetShotId,results[0].id);}
      // The response already contains the tasks; show them without another network wait.
      clearPending();
      render(true);toast(`已开始生成 ${results.length} 个分镜视频`);
    }catch(error){clearPending();if(error.stale)return;render(true,{focus:false});toast(error.message);await loadCredits();}
  }
  async function selectProfessionalVideo(taskId){
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      const shot=currentProfessionalShot();if(!shot||!taskLocallyReady(taskId))return taskSyncing(taskId)?toast('视频正在准备，请稍后选择'):undefined;
      shot.selectedVideoTaskId=taskId;await patch({shots:project.shots});assertProjectRequest(request);
    }catch(error){if(error.stale)return;throw error;}
  }
  async function extractProfessionalTail(){const shot=currentProfessionalShot();if(!shot)return;const request=projectRequest();try{const result=await extractDramaTailLocally(shot);assertProjectRequest(request);shot.tailFrameAssetId=result.id;await patch({shots:project.shots},{quiet:true});assertProjectRequest(request);render(true);toast('尾帧已保存到素材库');}catch(error){if(error.stale)return;toast(error.message);}}
  function professionalAssemblyItems(){
    return project.shots.flatMap((shot,index)=>taskLocallyReady(shot.selectedVideoTaskId)?[{shot,index,...taskLocalAsset(shot.selectedVideoTaskId),taskId:shot.selectedVideoTaskId}]:[]);
  }
  function professionalAssemblyCandidates(){
    return project.shots.flatMap((shot,index)=>{
      const versionIds=[...(Array.isArray(shot.videoVersions)?shot.videoVersions:[])];
      if(shot.selectedVideoTaskId&&!versionIds.includes(shot.selectedVideoTaskId))versionIds.unshift(shot.selectedVideoTaskId);
      return [...new Set(versionIds.map(String).filter(Boolean))].map(taskId=>{
        const file=taskAsset(taskId);
        return {shot,index,taskId,file,id:localAssetId(file)};
      }).filter(item=>Boolean(item.id)&&taskLocallyReady(item.taskId));
    });
  }
  function assemblySelectionItems(candidates,selection){
    return candidates.filter(item=>{
      const choice=selection.get(item.shot.id);
      return choice?.included===true&&choice.taskId===item.taskId;
    });
  }
  function closeProfessionalAssemblyDialog(){const dialog=document.querySelector('#professionalAssemblyDialog');if(dialog?.open)dialog.close();}
  function openProfessionalAssemblyDialog(){
    let candidates;
    try{candidates=professionalAssemblyCandidates();}catch(error){return toast(error.message);}
    if(candidates.length<2)return toast('至少需要 2 个已完成的视频才能合成');
    const groups=[];
    project.shots.forEach((shot,index)=>{
      const items=candidates.filter(item=>item.shot.id===shot.id);
      if(items.length)groups.push({shot,index,items});
    });
    const selection=new Map(groups.map(group=>{
      const preferred=group.items.find(item=>item.taskId===group.shot.selectedVideoTaskId)||group.items[0];
      return [group.shot.id,{included:true,taskId:preferred.taskId}];
    }));
    let dialog=document.querySelector('#professionalAssemblyDialog');
    if(!dialog){
      dialog=document.createElement('dialog');dialog.id='professionalAssemblyDialog';dialog.className='professional-assembly-dialog';
      dialog.addEventListener('close',()=>{releaseWorkbenchVideos(dialog);dialog.innerHTML='';});
      document.body.append(dialog);
    }
    dialog.innerHTML=`<div class="dialog-head"><div><span class="dialog-kicker">成片</span><h2>选择本次分镜合成内容</h2><p>可从已完成的视频中自由组合。每个分镜最多选择一个版本，未完成的分镜不会参与合成。</p></div><button type="button" data-assembly-close aria-label="关闭">×</button></div><div class="professional-assembly-body"><section class="professional-assembly-preview" data-assembly-preview></section><ol class="professional-assembly-list assembly-selection-list">${groups.map(group=>`<li data-assembly-shot-row="${esc(group.shot.id)}"><div class="assembly-shot-selection-head"><label class="assembly-shot-toggle"><input type="checkbox" data-assembly-include="${esc(group.shot.id)}" checked><span><b>分镜 ${group.index+1} · ${esc(group.shot.title)}</b><small>${group.items.length} 个可用版本</small></span></label><span class="assembly-shot-selection-status" data-assembly-shot-status="${esc(group.shot.id)}">已选 1 个版本</span></div><div class="assembly-version-options">${group.items.map((item,versionIndex)=>`<button type="button" data-assembly-version="${esc(group.shot.id)}" data-assembly-task="${esc(item.taskId)}" aria-pressed="false"><span>${String(versionIndex+1).padStart(2,'0')}</span><div><b>版本 ${versionIndex+1}</b><small>${esc(item.file.name)}</small></div><i>预览</i></button>`).join('')}</div></li>`).join('')}</ol></div><footer><span data-assembly-selection-summary>已选择 0 个视频 · 至少选择 2 个</span><div><button type="button" class="secondary-button" data-assembly-close>返回检查</button><button type="button" class="gradient-button" data-assembly-confirm disabled>至少选择 2 个视频</button></div></footer>`;
    let previewItem=null;
    let previewTarget=null;
    const selectedItems=()=>assemblySelectionItems(candidates,selection);
    const renderSelection=()=>{
      const items=selectedItems();
      const first=items.find(item=>item.shot.id===previewTarget?.shot.id&&item.taskId===previewTarget?.taskId)||items[0];
      const previewChanged=first!==previewItem;
      previewItem=first;
      previewTarget=first;
      const preview=dialog.querySelector('[data-assembly-preview]');
      if(preview&&(previewChanged||!preview.innerHTML)){
        preview.querySelector('video')?.pause();
        preview.innerHTML=first?`<video src="${esc(first.file.url)}" controls preload="metadata" playsinline></video><div><b>${esc(first.shot.title)}</b><span>${esc(first.file.name)}</span></div>`:'<div class="assembly-preview-empty"><span>⌁</span><b>请选择至少 2 个视频</b><small>可勾选分镜，并在右侧切换视频版本</small></div>';
      }
      dialog.querySelectorAll('[data-assembly-shot-row]').forEach(row=>{
        const choice=selection.get(row.dataset.assemblyShotRow);
        const included=choice?.included===true;
        const selected=items.find(item=>item.shot.id===row.dataset.assemblyShotRow);
        row.classList.toggle('is-excluded',!included);
        const status=row.querySelector('[data-assembly-shot-status]');
        if(status)status.textContent=included&&selected?`已选版本 ${[...row.querySelectorAll('[data-assembly-version]')].findIndex(button=>button.dataset.assemblyTask===selected.taskId)+1}`:'本次不合成';
        const includeInput=row.querySelector('[data-assembly-include]');
        if(includeInput)includeInput.checked=included;
        row.querySelectorAll('[data-assembly-version]').forEach(button=>{
          const active=included&&button.dataset.assemblyTask===choice?.taskId;
          button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
        });
      });
      const summary=dialog.querySelector('[data-assembly-selection-summary]');
      if(summary)summary.textContent=items.length>1?`已选择 ${items.length} 个视频 · 按分镜顺序合成`:`已选择 ${items.length} 个视频 · 至少选择 2 个`;
      const confirm=dialog.querySelector('[data-assembly-confirm]');
      if(confirm){confirm.disabled=items.length<2;confirm.textContent=items.length>1?`确认并开始合成（${items.length} 个）`:'至少选择 2 个视频';}
    };
    dialog.querySelectorAll('[data-assembly-close]').forEach(button=>button.onclick=closeProfessionalAssemblyDialog);
    dialog.querySelectorAll('[data-assembly-include]').forEach(input=>input.onchange=()=>{
      const choice=selection.get(input.dataset.assemblyInclude);if(!choice)return;
      choice.included=input.checked;renderSelection();
    });
    dialog.querySelectorAll('[data-assembly-version]').forEach(button=>button.onclick=()=>{
      const choice=selection.get(button.dataset.assemblyVersion);if(!choice)return;
      choice.taskId=button.dataset.assemblyTask;choice.included=true;
      previewTarget=candidates.find(item=>item.shot.id===button.dataset.assemblyVersion&&item.taskId===choice.taskId);
      renderSelection();
    });
    dialog.querySelector('[data-assembly-confirm]').onclick=event=>void performProfessionalAssembly(event.currentTarget,selectedItems);
    renderSelection();
    dialog.showModal();
  }
  async function performProfessionalAssembly(button,selectionProvider=null){
    if(!project)return closeProfessionalAssemblyDialog();
    const items=selectionProvider?selectionProvider():professionalAssemblyItems();
    if(items.length<2){closeProfessionalAssemblyDialog();return toast('至少需要 2 个已完成的视频才能合成');}
    deferredProfessionalRender=false;
    button.disabled=true;button.textContent='正在拼接成片…';
    document.querySelectorAll('#professionalAssemblyDialog [data-assembly-include],#professionalAssemblyDialog [data-assembly-version]').forEach(control=>control.disabled=true);
    try{await assembleDramaLocally(items);deferredProfessionalRender=false;closeProfessionalAssemblyDialog();render(true,{focus:false});toast(`已合成 ${items.length} 个分镜视频，最终成片已生成`);}
    catch(error){if(error.stale)return;toast(error.message);button.disabled=false;button.textContent='确认并重新合成';document.querySelectorAll('#professionalAssemblyDialog [data-assembly-include],#professionalAssemblyDialog [data-assembly-version]').forEach(control=>control.disabled=false);}
  }
  async function assembleProfessionalProject(){const request=projectRequest();const completed=project.shots.filter(item=>taskLocallyReady(item.selectedVideoTaskId)).length;if(completed<2)return toast('至少需要 2 个已完成的视频才能合成');deferredProfessionalRender=false;await flushSave();if(!isProjectRequestCurrent(request))return;deferredProfessionalRender=false;openProfessionalAssemblyDialog();}

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
  async function addScene(){
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      const index=project.scenes.length+1;
      project.scenes.push({id:crypto.randomUUID(),sceneNumber:index,heading:`第 ${index} 场`,location:'',timeOfDay:'',lighting:'',dramaticFunction:'',beats:[]});
      await patch({scenes:project.scenes});
      assertProjectRequest(request);
      const cards=document.querySelectorAll('[data-scene-id]');cards[cards.length-1]?.querySelector('[data-scene-field="heading"]')?.focus();
    }catch(error){if(error.stale)return;throw error;}
  }
  async function deleteScene(id){
    const request=projectRequest();
    const scene=project.scenes.find(item=>item.id===id);
    if(!scene||!await confirmDelete({title:'确认删除场次',message:'场次一旦删除，无法恢复。'}))return;
    try{
      assertProjectRequest(request);
      project.scenes=project.scenes.filter(item=>item.id!==id);project.shots.forEach(shot=>{if(shot.sceneId===id)shot.sceneId='';});
      await patch({scenes:project.scenes,shots:project.shots});
      assertProjectRequest(request);
    }catch(error){if(error.stale)return;throw error;}
  }
  function inputSettings(){ return {shotCount:Number(document.querySelector('#settingShotCount').value),totalDuration:Number(document.querySelector('#settingTotalDuration').value),shotDuration:Number(document.querySelector('#settingShotDuration').value),aspectRatio:document.querySelector('#settingAspectRatio').value}; }
  async function runDirector(){ const button=document.querySelector('#runSmartDirector'); const status=document.querySelector('#scriptActionStatus'); const value=document.querySelector('#projectInput').value.trim(); if(!value){status.textContent='先输入一句话创意或剧本。';document.querySelector('#projectInput').focus();return;} const settings=inputSettings(); const request=projectRequest(); button.disabled=true;button.innerHTML='<span class="button-spinner"></span> 正在生成并校验导演方案';status.textContent='导演正在整理故事和分镜，请稍候。完成后会自动补全缺失内容。请不要关闭页面。';try{await patch({input:value,settings},{quiet:true});assertProjectRequest(request);const result=await api(`/api/drama/projects/${project.id}/direct`,{method:'POST',body:JSON.stringify({input:value,settings})});assertProjectRequest(request);project=normalizeProjectData(result.project);projectBaseSnapshot=cloneProjectValue(project);projects=mergeDramaProjectList(projects,project);scriptDraft=null;state.dramaProject=project;setCreditBalance(result.balance);document.querySelector('#dramaProjectTitle').value=project.title;const completed=Number(result.usage.completionCount)||0;const repairs=Number(result.usage.recoveryAttempts)||0;const corrected=Number(result.usage.correctedProblemCount)||0;const outcome=result.usage.autoRegenerated?`导演方案已生成，已自动整理 ${repairs} 轮`:result.usage.autoCorrected?`导演方案已生成，已自动校正 ${repairs} 轮${corrected?`修复 ${corrected} 项问题`:''}`:completed?`导演方案已生成，自动补全 ${completed} 个分镜`:'导演方案已生成';toast(`${outcome}，本次消耗 ${creditText(result.usage.chargedCredits)} 积分`);render();}catch(error){if(error.stale)return;if(error.balance!==undefined)setCreditBalance(error.balance);else await loadCredits();const charged=Number(error.usage?.chargedCredits)||0;const billed=charged?` 本次已消耗 ${creditText(charged)} 积分。`:'';const rounds=Number(error.directorRecovery?.round)||0;const recovery=error.directorRecovery?.attempted&&rounds?(error.directorRecovery?.history?.includes('regenerate')?`自动整理了 ${rounds} 轮，但仍未形成可用方案。`:error.directorRecovery?.history?.includes('replace')||error.directorRecovery?.mode==='replace'?`自动校正了 ${rounds} 轮，但仍未形成可用方案。`:`自动补全了 ${rounds} 轮，但仍未形成可用方案。`):'';const message=recovery||error.message;status.textContent=`生成失败：${message}${billed}你可以重新生成完整导演方案。`;button.disabled=false;button.innerHTML='重新生成完整导演方案 <span>→</span>';} }
  async function continueProfessionalScript(){
    const button=document.querySelector('#saveProfessionalScript');
    const status=document.querySelector('#scriptActionStatus');
    const value=document.querySelector('#projectInput').value.trim();
    if(!value){status.textContent='先填写剧本正文。';document.querySelector('#projectInput').focus();return;}
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      project.scenes.forEach(scene=>collectSceneCard(scene.id));
      if(!project.scenes.length)project.scenes.push({id:crypto.randomUUID(),sceneNumber:1,heading:'第 1 场',location:'',timeOfDay:'',lighting:'',dramaticFunction:'',beats:[]});
      pendingKeys.delete('scenes');clearTimeout(saveTimer);button.disabled=true;button.innerHTML='<span class="button-spinner"></span> 正在保存';
      const settings=inputSettings();
      const result=await patch({script:value,settings,scenes:project.scenes,step:'resources'},{quiet:true});
      assertProjectRequest(request);
      if(!result)return;
      project=result;viewStep='resources';scriptDraft=null;dropFocus();render(true);const host=scroller();if(host)host.scrollTop=0;
    }catch(error){
      if(error.stale)return;
      status.textContent=`保存失败：${error.message}`;button.disabled=false;button.innerHTML='保存剧本，进入素材生成 <span>→</span>';
    }
  }
  function collectDirectorReview(){
    project.synopsis=document.querySelector('#reviewSynopsis')?.value.trim()||project.synopsis;
    document.querySelectorAll('[data-review-scene]').forEach(card=>{const scene=project.scenes.find(item=>item.id===card.dataset.reviewScene);card.querySelectorAll('[data-review-scene-field]').forEach(field=>scene[field.dataset.reviewSceneField]=field.value);});
    document.querySelectorAll('[data-review-resource]').forEach(card=>{const resource=project.resources.find(item=>item.id===card.dataset.reviewResource);card.querySelectorAll('[data-review-resource-field]').forEach(field=>resource[field.dataset.reviewResourceField]=field.value);});
    document.querySelectorAll('[data-review-shot]').forEach(card=>{const shot=project.shots.find(item=>item.id===card.dataset.reviewShot);card.querySelectorAll('[data-review-shot-field]').forEach(field=>shot[field.dataset.reviewShotField]=field.value);});
  }
  async function confirmScriptReview(){
    const button=document.querySelector('#confirmScriptReview');
    const status=document.querySelector('#scriptActionStatus');
    const value=document.querySelector('#reviewScript').value.trim();
    if(!value){status.textContent='剧本正文不能为空。';document.querySelector('#reviewScript').focus();return;}
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      collectDirectorReview();button.disabled=true;button.innerHTML='<span class="button-spinner"></span> 正在保存并进入下一步';
      const result=await patch({script:value,synopsis:project.synopsis,scenes:project.scenes,resources:project.resources,shots:project.shots,step:'resources'},{quiet:true});
      assertProjectRequest(request);
      if(!result)return;
      project=result;viewStep='resources';scriptDraft=null;render();
    }catch(error){
      if(error.stale)return;
      status.textContent=`保存失败：${error.message}`;button.disabled=false;button.innerHTML='确认方案，进入素材生成 <span>→</span>';
    }
  }

  function resourceVersionCard(resource,taskId){ const generation=task(taskId); const file=taskAsset(taskId); const selected=resource.selectedTaskId===taskId; const syncing=taskSyncing(taskId); const ready=taskLocallyReady(taskId); const missing=generation?.status==='completed'&&Boolean(generation.assetId)&&!file; const status=generation?.status==='failed'?generationFailureMarkup(generation):syncing?'保存中…':missing?'成品文件未找到':generation?({queued:'排队中',running:'生成中'}[generation.status]||generation.status):'记录缺失'; return `<button class="resource-version ${selected?'selected':''}" data-select-resource="${resource.id}" data-task-id="${taskId}" ${ready?'':'disabled'}>${ready?`<img src="${file.url}" alt="${esc(resource.name)}">`:`<span class="version-state">${status}</span>`}<i>${selected&&ready?'✓ 已选':ready?'选择此版':syncing?'保存中…':missing?'文件尚未准备好':'等待完成'}</i></button>`; }
  async function addResource(type='character'){
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      const label={character:'新角色',location:'新场景',prop:'新物品'}[type]||'新素材';const id=crypto.randomUUID();
      project.resources.push({id,type,name:label,description:'',prompt:`${project.style?'角色参考图':'真人短剧角色定妆照'}，9:16，正面、侧面与全身标准视图，保持身份特征一致`,bible:{identity:'',dramaticGoal:'',appearance:'',costume:'',canonicalViews:'正面、左右侧面、全身标准视图',stateNotes:''},lifecycle:{status:'draft',revision:1,approvedAt:''},versions:[],selectedTaskId:''});
      await patch({resources:project.resources});
      assertProjectRequest(request);
      const field=document.querySelector(`[data-resource-id="${id}"] [data-resource-field="name"]`);if(field){field.focus();field.select();}
    }catch(error){if(error.stale)return;throw error;}
  }
  function collectResourceCard(id){const card=document.querySelector(`[data-resource-id="${id}"]`);const item=project.resources.find(x=>x.id===id);if(!card||!item)return item;card.querySelectorAll('[data-resource-field]').forEach(field=>item[field.dataset.resourceField]=field.value);card.querySelectorAll('[data-bible-field]').forEach(field=>item.bible[field.dataset.bibleField]=field.value);return item;}
  function refreshCompiledResourcePrompt(id){const card=document.querySelector(`[data-resource-id="${id}"]`);const item=collectResourceCard(id);const output=card?.querySelector('[data-compiled-resource-prompt]');if(output&&item)output.value=buildResourceImagePrompt(item,{aspectRatio:project.settings.aspectRatio,styled:Boolean(project.style)});}
  async function saveResource(id,{quiet=false,notify=true}={},request=projectRequest()){
    try{
      assertProjectRequest(request);
      const item=collectResourceCard(id);if(!item)return false;
      item.lifecycle={...item.lifecycle,status:item.selectedTaskId?'approved':'draft',revision:(item.lifecycle?.revision||1)+1};project.shots.filter(shot=>shot.resourceIds.includes(id)).forEach(shot=>{shot.lifecycle.staleReasons=[...new Set([...(shot.lifecycle.staleReasons||[]),`${item.name} 定义已更新`])];});
      await patch({resources:project.resources,shots:project.shots},{quiet});
      assertProjectRequest(request);
      if(notify)toast('素材说明已保存，相关分镜需要重新检查');
      return true;
    }catch(error){if(error.stale)return false;throw error;}
  }
  async function deleteResource(id){
    const request=projectRequest();
    const resource=project.resources.find(item=>item.id===id);
    if(!resource||!await confirmDelete({title:'确认删除素材',message:'素材一旦删除，无法恢复。'}))return;
    try{
      assertProjectRequest(request);
      project.resources=project.resources.filter(item=>item.id!==id);project.shots.forEach(shot=>shot.resourceIds=shot.resourceIds.filter(resourceId=>resourceId!==id));
      await patch({resources:project.resources,shots:project.shots});
      assertProjectRequest(request);
    }catch(error){if(error.stale)return;throw error;}
  }
  async function generateResource(id,button){
    if(!project.resources.find(x=>x.id===id))return;
    const request=projectRequest();
    if(!await saveResource(id,{quiet:true,notify:false},request))return;
    if(!isProjectRequestCurrent(request))return;
    const resource=project.resources.find(x=>x.id===id);const checked=await promptPrecheck.check({prompts:[buildResourceImagePrompt(resource,{aspectRatio:project.settings.aspectRatio,styled:Boolean(project.style)})],source:'drama',scopeNote:true});if(checked.action==='cancel'||!isProjectRequestCurrent(request))return;const finalPrompt=checked.prompts[0];button=document.querySelector(`[data-generate-resource="${id}"]`)||button;button.disabled=true;button.textContent='正在准备…';
    try{
      const generation=await api('/api/generations',{method:'POST',body:JSON.stringify({type:'image',prompt:finalPrompt,size:project.settings.aspectRatio,quality:'medium',referenceAssetIds:[],...checked.fields})});
      assertProjectRequest(request);setCreditBalance(generation.balance);state.tasks=[generation,...state.tasks.filter(x=>x.id!==generation.id)];scheduleTaskPoll();
      const result=await api(`/api/drama/projects/${project.id}/resources/${id}/versions`,{method:'POST',body:JSON.stringify({taskId:generation.id})});
      assertProjectRequest(request);project=result.project;state.dramaProject=project;render();toast(`素材图已开始生成，预计消耗 ${generation.creditCost} 积分`);
    }catch(error){if(error.stale)return;toast(error.message);await loadCredits();button.disabled=false;button.textContent='重新生成';}
  }
  async function generateAllResources(){ const targets=project.resources.filter(item=>!item.selectedTaskId); if(!targets.length)return toast('所有素材都已有选中版本'); const button=document.querySelector('#generateAllResources');button.disabled=true;for(const item of targets){const card=document.querySelector(`[data-resource-id="${item.id}"]`);if(card)await generateResource(item.id,card.querySelector('[data-generate-resource]'));}toast('素材已全部开始生成'); }
  async function selectResourceVersion(resourceId,taskId){ const request=projectRequest(); const result=await api(`/api/drama/projects/${project.id}/resources/${resourceId}/select`,{method:'PATCH',body:JSON.stringify({taskId})});assertProjectRequest(request);project=result.project;state.dramaProject=project;render(); }

  function shotReferences(shot){ return selectedResourceAssetIds(shot).map(id=>asset(id)).filter(Boolean); }
  function shotReadiness(shot){const reasons=[];if(!shot.narrativeFunction)reasons.push('缺少叙事功能');if(!shot.startState||!shot.endState)reasons.push('起止状态未定义');if(project.workflowVersion>=2&&!(shot.sourceBeatIds||[]).length)reasons.push('没有认领剧本节拍');if(project.workflowVersion>=3&&!(shot.motionPlan||[]).length)reasons.push('缺少逐秒运动时间轴');if((shot.resourceIds||[]).some(id=>!project.resources.find(item=>item.id===id)?.selectedTaskId))reasons.push('引用素材未定稿');return [...new Set([...(shot.lifecycle?.staleReasons||[]),...reasons])];}
  function motionTimelineEditor(shot){if(!(shot.motionPlan||[]).length)return '<div class="motion-timeline-empty">旧版分镜：生成视频时会根据起止状态自动安排动作。</div>';return `<div class="motion-timeline-editor"><h4>逐秒运动时间轴</h4>${shot.motionPlan.map((item,index)=>`<div class="motion-timeline-row" data-motion-index="${index}"><span>${item.startSecond}–${item.endSecond}s</span><input data-motion-field="subjectMotion" value="${esc(item.subjectMotion)}" aria-label="主体动作"><select data-motion-field="amplitude">${['静止','微小','小','中','大'].map(value=>`<option ${value===item.amplitude?'selected':''}>${value}</option>`).join('')}</select><select data-motion-field="speed">${['静止','极慢','慢','中','快'].map(value=>`<option ${value===item.speed?'selected':''}>${value}</option>`).join('')}</select><input data-motion-field="cameraMotion" value="${esc(item.cameraMotion)}" aria-label="摄影机动作"></div>`).join('')}</div>`;}
  function beatClaimList(shot){
    const scene=project.scenes.find(item=>item.id===shot.sceneId);
    if(!scene)return '<div class="beat-claim empty">在「镜头设置」里选择场次后，可在此勾选本镜要拍的剧本节拍。</div>';
    const beats=scene.beats||[];
    if(!beats.length)return '<div class="beat-claim empty">这一场还没有节拍，回到第一步「剧本设计」补写。</div>';
    const claimed=new Set(shot.sourceBeatIds||[]);
    const seconds=beats.filter(beat=>claimed.has(beat.id)).reduce((sum,beat)=>sum+(Number(beat.estimatedSeconds)||beatSeconds(beat)),0);
    return `<div class="beat-claim"><header><b>本镜认领的剧本节拍</b><span data-beat-total class="${seconds>shot.duration?'over':''}">${Math.round(seconds*10)/10} / ${shot.duration} 秒</span></header><div>${beats.map(beat=>`<label><input type="checkbox" data-shot-beat="${beat.id}" ${claimed.has(beat.id)?'checked':''}><span><i>${beat.kind==='dialogue'?'台词':'动作'}</i>${esc(beat.kind==='dialogue'?`${beat.speaker||'角色'}：${beat.text}`:beat.text)}</span></label>`).join('')}</div></div>`;
  }
  function paintBeatClaim(id){ const card=document.querySelector(`[data-shot-id="${id}"]`); const shot=project.shots.find(item=>item.id===id); const host=card?.querySelector('[data-beat-claim]'); if(host&&shot)host.innerHTML=beatClaimList(shot); }
  function refreshBeatTotal(id){ const card=document.querySelector(`[data-shot-id="${id}"]`); const shot=project.shots.find(item=>item.id===id); const node=card?.querySelector('[data-beat-total]'); if(!node||!shot)return; const scene=project.scenes.find(item=>item.id===shot.sceneId); const claimed=new Set(shot.sourceBeatIds||[]); const seconds=(scene?.beats||[]).filter(beat=>claimed.has(beat.id)).reduce((sum,beat)=>sum+(Number(beat.estimatedSeconds)||beatSeconds(beat)),0); node.textContent=`${Math.round(seconds*10)/10} / ${shot.duration} 秒`; node.classList.toggle('over',seconds>shot.duration); }
  function refreshCompiledShotPrompt(id){ const card=document.querySelector(`[data-shot-id="${id}"]`); const shot=project.shots.find(item=>item.id===id); const output=card?.querySelector('[data-compiled-shot-prompt]'); if(output&&shot)output.value=shotVideoPrompt(shot); }
  function assetPickerItems(shot){ const query=assetPickerQuery.trim().toLowerCase(); const images=sortFilesByRecency(state.files.filter(file=>file.localStatus!=='missing'&&file.kind==='image'&&(!query||String(file.name).toLowerCase().includes(query)))); const chosen=new Set(shot.referenceAssetIds||[]); return images.length?images.map(file=>`<button type="button" class="${chosen.has(file.id)?'chosen':''}" data-add-asset="${file.id}" data-shot-id="${shot.id}"><img src="${file.url}" alt="${esc(file.name)}" loading="lazy"><span>${esc(file.name)}</span></button>`).join(''):`<p>${query?'没有匹配的图片':'素材库还没有图片'}</p>`; }
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
  async function saveShot(id){
    const request=projectRequest();
    try{
      assertProjectRequest(request);
      collectShot(id);
      await patch({shots:project.shots});
      assertProjectRequest(request);
      toast('分镜已保存');
    }catch(error){
      if(error.stale)return;
      throw error;
    }
  }
  async function saveAllShots(quiet=false,request=projectRequest()){
    try{
      assertProjectRequest(request);
      project.shots.forEach(shot=>collectShot(shot.id));
      await patch({shots:project.shots},{quiet:true});
      assertProjectRequest(request);
      if(!quiet){render(true);toast('全部分镜已保存');}
      return true;
    }catch(error){
      if(error.stale)return false;
      throw error;
    }
  }
  async function addShot(){const id=crypto.randomUUID();const last=project.shots[project.shots.length-1];project.shots.push({id,shotNumber:project.shots.length+1,sceneNumber:1,sceneId:last?.sceneId||project.scenes[0]?.id||'',title:`分镜 ${project.shots.length+1}`,sourceBeatIds:[],script:'',prompt:'',visualDirection:'',narrativeFunction:'',shotSize:'中景',cameraMovement:'固定',framing:'',startStateId:'',startState:last?.endState||'',action:'',endStateId:'',endState:'',continuityNotes:'',sound:'',negativePrompt:'禁止人物变脸、服装变化、道具消失、空间轴线跳变',duration:project.settings.shotDuration,aspectRatio:project.settings.aspectRatio,resourceIds:last?[...(last.resourceIds||[])]:[],referenceAssetIds:[],generation:{type:'TEXT',firstFrameAssetId:'',lastFrameAssetId:'',referenceAssetIds:[],quality:'720p'},lifecycle:{status:'draft',revision:1,staleReasons:[]},videoVersions:[],selectedVideoTaskId:'',tailFrameAssetId:''});await patch({shots:project.shots});const card=document.querySelector(`[data-shot-id="${id}"]`);card?.scrollIntoView({block:'center'});card?.querySelector('[data-shot-field="title"]')?.focus();}
  async function deleteShot(id){
    const request=projectRequest();
    const shot=project.shots.find(item=>item.id===id);
    if(!shot)return;
    if(!professional()){
      try{
        if(!await confirmDelete({title:'确认删除分镜',message:'分镜一旦删除，无法恢复。'}))return;
        assertProjectRequest(request);
        project.shots=project.shots.filter(item=>item.id!==id);
        await patch({shots:project.shots});
        assertProjectRequest(request);
      }catch(error){
        if(error.stale)return;
        throw error;
      }
      return;
    }
    const generationIds=[...new Set([...(shot.videoVersions||[]),shot.selectedVideoTaskId,...(shot.pendingImageGenerations||[]).map(item=>item?.taskId)].filter(Boolean))];
    const generations=generationIds.map(task).filter(Boolean);
    if(generations.some(item=>['queued','running'].includes(item.status)))return toast('该分镜仍在生成，请等待完成后再删除');
    const hasGeneratedContent=generations.some(item=>item.status!=='failed');
    const firstMessage=hasGeneratedContent?'将删除该分镜、全部历史视频版本和关联文件。':'分镜删除后无法恢复。';
    if(!await confirmDelete({title:'确认删除分镜',message:firstMessage}))return;
    assertProjectRequest(request);
    if(hasGeneratedContent&&!await confirmDelete({title:'再次确认永久删除',message:'该分镜包含已生成内容。确认永久删除分镜及其全部视频文件吗？'}))return;
    assertProjectRequest(request);
    await flushSave();
    assertProjectRequest(request);
    const targetProjectId=request.projectId;
    try{
      const result=await api(`/api/drama/projects/${encodeURIComponent(targetProjectId)}/shots/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});
      assertProjectRequest(request);
      project=restoreLocalProjectOutputs(normalizeProjectData(result.project));
      projects=mergeDramaProjectList(projects,project);
      state.dramaProject=project;
      virtualShotHeights.delete(id);
      resetVirtualShotWindow();
      deferredProfessionalRender=false;
      const deletedTaskIds=new Set(result.deletedTaskIds||generationIds);
      state.tasks=state.tasks.filter(item=>!deletedTaskIds.has(item.id));
      if(result.deletedAssetIds?.length&&removeCloudAssets){
        await removeCloudAssets(result.deletedAssetIds);
        assertProjectRequest(request);
      }
      professionalPreviewTaskIds.delete(id);
      professionalShotId=project.shots[0]?.id||'';
      professionalPreviewShotId=professionalShotId;
      if(state.route==='drama')render(true,{focus:false});
      toast('分镜及关联内容已删除');
    }catch(error){if(error.stale)return;toast(error.message);}
  }
  async function toggleAssetOnShot(shotId,assetId){const request=projectRequest();try{assertProjectRequest(request);const shot=project.shots.find(x=>x.id===shotId);if(!shot)return;if(shot.referenceAssetIds.includes(assetId))shot.referenceAssetIds=shot.referenceAssetIds.filter(id=>id!==assetId);else shot.referenceAssetIds.push(assetId);await patch({shots:project.shots});assertProjectRequest(request);}catch(error){if(error.stale)return;throw error;}}
  async function removeAssetFromShot(shotId,assetId){const request=projectRequest();try{assertProjectRequest(request);const shot=project.shots.find(x=>x.id===shotId);if(!shot)return;shot.referenceAssetIds=shot.referenceAssetIds.filter(id=>id!==assetId);for(const resource of project.resources){if(taskAsset(resource.selectedTaskId)?.id===assetId)shot.resourceIds=shot.resourceIds.filter(id=>id!==resource.id);}await patch({shots:project.shots});assertProjectRequest(request);}catch(error){if(error.stale)return;throw error;}}

  function videoVersion(shot,id){const generation=task(id);const file=taskAsset(id);const selected=shot.selectedVideoTaskId===id;const syncing=taskSyncing(id);const ready=taskLocallyReady(id);const versionState=videoPreviewVersionState(generation,{ready,syncing});const pending=versionState==='pending'||versionState==='syncing';const missing=versionState==='missing';const status=generation?.status==='failed'?generationFailureMarkup(generation):pending?'生成中…':missing?'暂不可用':generation?({queued:'排队中',running:'生成中'}[generation.status]||generation.status):'记录缺失';return `<div class="video-version-wrap ${pending?'is-pending':''}"><button class="video-version ${selected?'selected':''}" data-select-video="${id}" data-shot-id="${shot.id}" ${ready?'':'disabled'}>${ready?workbenchVideoMarkup(file):`<span>${status}</span>`}<i>${selected&&ready?'✓ 当前版本':ready?'选择此版':pending?'生成中…':missing?'暂不可用':'等待完成'}</i></button>${pending?'':`<button type="button" class="video-version-delete" data-wb-delete-preview-video="${esc(id)}" data-wb-delete-preview-shot="${esc(shot.id)}" aria-label="删除${esc(shot.title)}视频版本" title="删除视频版本">×</button>`}</div>`;}
  function videoRoute(shot){
    const routing=state.config?.videoCapabilities?.routing||[];
    const firstLast=shot.generation.type==='FIRST&LAST'&&shot.duration===8;
    const route=routing.find(item=>firstLast
      ? item.mode==='FIRST&LAST'&&item.duration===shot.duration
      : item.mode==='TEXT|REFERENCE'&&(item.duration===shot.duration||item.durations?.includes(shot.duration)));
    return {engine:route?.label||(firstLast?'Veo 3.1 Fast':'Grok 1.5'),note:firstLast?'首尾帧连续性':'标准视频生成'};
  }
  function shotVideoPrompt(shot){const scene=project.scenes.find(item=>item.id===shot.sceneId);const resources=(shot.resourceIds||[]).map(id=>project.resources.find(item=>item.id===id)).filter(Boolean);return buildShotVideoPrompt({project,shot,scene,resources});}
  function compiledShotVideoPrompt(shot){return shotVideoPrompt({...shot,promptOverride:''});}
  function videoRequestShot(shot,referenceAssetIds){if(!referenceAssetIds?.length)return shot;const references=referenceAssetIds.map(id=>asset(id)).filter(Boolean);return {...shot,assetMentions:orderedShotReferenceMentions(shot,references),generation:{...shot.generation,type:shot.generation.type==='TEXT'?'REFERENCE':shot.generation.type}};}
  function shotReferenceIds(shot){return [...new Set([...professionalAssetIds(shot),...(shot.referenceAssetIds||[]),...(shot.generation?.referenceAssetIds||[]),...(shot.assetMentions||[]).map(item=>item.id)])].filter(Boolean);}
  function availableShotReferenceIds(shot){return shotReferenceIds(shot).filter(id=>asset(id));}
  function shotGenerationAssetIds(shot){if(shot.generation.type==='TEXT')return [];if(shot.generation.type==='FIRST&LAST')return [shot.generation.firstFrameAssetId,shot.generation.lastFrameAssetId].filter(id=>asset(id));return availableShotReferenceIds(shot);}
  function shotGenerationReady(shot){const count=shotGenerationAssetIds(shot).length;if(shot.generation.type==='TEXT')return true;if(shot.generation.type==='FIRST&LAST')return count>=1&&count<=professionalMaxImages(shot);return count>=1&&count<=professionalMaxImages(shot);}
  function professionalVideoModels(shot){const models=state.config?.videoCapabilities?.models;return Array.isArray(models)?models.filter(model=>{const supportsMode=Array.isArray(model.modes)&&model.modes.some(mode=>mode.generationType===shot.generation.type);return !['minimax-h3'].includes(model.id)&&professionalModelIsAvailable(model)&&supportsMode;}).map(model=>model.id==='grok'?{...model,modes:model.modes?.map(mode=>({...mode,durations:mode.durations?.filter(value=>Number(value)!==30)}))}:model):[];}
  function professionalVideoParameters(shot){const mode=professionalVideoModels(shot).find(model=>model.id===shot.generation.modelId)?.modes?.find(mode=>mode.generationType===shot.generation.type);return mode?{...mode,durations:mode.durationsByQuality?.[shot.generation.quality]?.[shot.aspectRatio]||mode.durations}:null;}
  function professionalMaxImages(shot){const parameters=professionalVideoParameters(shot);return parameters?.maxImages||parameters?.referenceLimits?.total||7;}
  function professionalReferenceLimit(shot){const parameters=professionalVideoParameters(shot);return parameters?.referenceLimits||{image:7,video:0,audio:0,total:professionalMaxImages(shot)};}
  function professionalVideoUsesDynamicQuote(shot){return ROUTED_VIDEO_MODEL_IDS.has(canonicalVideoModelId(shot?.generation?.modelId));}
  function professionalVideoCostState(shot){
    const count=Math.max(1,Math.min(4,Number(shot.generation?.count)||1));
    if(professionalVideoUsesDynamicQuote(shot)){
      // The public catalog is loaded with the page; parameter changes only do local math.
      const price=state.config?.modelPrices?.find(item=>canonicalVideoModelId(item.modelId)===canonicalVideoModelId(shot.generation.modelId)&&item.quality===shot.generation.quality&&item.available!==false);
      const credits=price&&price.credits!=null&&Number.isFinite(Number(price.credits))?Number(price.credits)*(price.unit==='second'?Number(shot.duration):1)*count:null;
      return {ready:true,credits,label:credits===null?'积分预估暂不可用':creditText(credits),message:'',priceVersion:''};
    }
    const billable=videoRequestShot(shot,shotGenerationAssetIds(shot));const parameters=professionalVideoParameters(billable);const selectedPricing=parameters?.pricingByQuality?.[shot.generation?.quality]||parameters?.pricing;
    const credits=selectedPricing?.unit==='request'?Number(selectedPricing.amount)/(selectedPricing.currency==='credit'?1:Number(state.pricing.yuanPerCredit||0.1))*count:selectedPricing?.unit==='second'?shot.duration*Number(selectedPricing.amount)*count:shot.duration*state.pricing.videoPerSecond*count;
    return {ready:true,credits,label:creditText(credits),message:'',priceVersion:''};
  }
  function ensureProfessionalVideoSettings(shot,{resetDuration=false}={}){
    if(!shot?.generation)return {models:[],parameters:null,modelId:''};
    const models=professionalVideoModels(shot);
    const current=String(shot.generation.modelId||'');
    const currentModel=models.find(model=>model.id===current&&professionalModelIsAvailable(model));
    const compatibleModel=models.find(model=>professionalModelIsAvailable(model)&&model.modes?.some(mode=>mode.generationType===shot.generation.type&&mode.aspectRatios.includes(shot.aspectRatio)&&mode.durations.includes(Number(shot.duration))&&mode.qualityOptions.includes(shot.generation.quality)));
    const selected=currentModel||compatibleModel||models.find(model=>shot.generation.type==='FIRST&LAST'&&['veo','veo-31'].includes(model.id)&&professionalModelIsAvailable(model))||models.find(professionalModelIsAvailable);
    const modelId=selected?.id||'';
    let parameters=selected?.modes?.find(mode=>mode.generationType===shot.generation.type)||null;
    shot.generation.modelId=modelId;
    normalizeShotVideoParameters(shot,parameters);
    if(parameters?.durationsByQuality) {
      parameters={...parameters,durations:parameters.durationsByQuality[shot.generation.quality]?.[shot.aspectRatio]||[]};
      normalizeShotVideoParameters(shot,parameters);
    }
    if(parameters&&(resetDuration||modelId!==current))shot.duration=defaultVideoDuration(modelId,parameters.durations);
    return {models,parameters,modelId};
  }
  function videoReferencePicker(shot){const selected=new Set(shot.generation.referenceAssetIds||[]);const images=imageAssets().filter(file=>!selected.has(file.id));return `<div class="video-reference-picker"><header><b>添加参考图片</b><button type="button" data-close-video-assets="${shot.id}" aria-label="关闭素材选择">×</button></header>${images.length?`<div>${images.map(file=>`<button type="button" data-add-video-asset="${file.id}" data-shot-id="${shot.id}"><img src="${file.url}" alt="${esc(file.name)}"><span>${esc(file.name)}</span></button>`).join('')}</div>`:'<p>没有其他可添加的图片</p>'}</div>`;}
  function enhanceVideoReferenceEditor(card,shot){if(shot.generation.type!=='REFERENCE')return;const strip=card.querySelector('.video-ref-strip');if(!strip)return;const ids=shotGenerationAssetIds(shot);const refs=ids.map(id=>asset(id)).filter(Boolean);strip.classList.add('editable');strip.dataset.videoReferenceList=shot.id;strip.innerHTML=`${refs.map((file,index)=>`<figure draggable="true" tabindex="0" data-video-reference-id="${file.id}"><img src="${file.url}" alt="${esc(file.name)}"><figcaption>参考 ${index+1}</figcaption><button type="button" data-remove-video-asset="${file.id}" data-shot-id="${shot.id}" aria-label="删除参考 ${index+1}">×</button><i aria-hidden="true">⋮⋮</i></figure>`).join('')}${refs.length<professionalMaxImages(shot)?`<button type="button" class="add-video-reference" data-pick-video-assets="${shot.id}">＋<span>添加</span></button>`:''}`;if(videoAssetPickerShotId===shot.id)strip.insertAdjacentHTML('afterend',videoReferencePicker(shot));}
  async function updateVideoReferenceIds(shotId,ids){const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;shot.generation.referenceAssetIds=[...new Set(ids)].filter(id=>asset(id)?.kind==='image').slice(0,professionalMaxImages(shot));await patch({shots:project.shots});}
  async function addVideoReference(shotId,assetId){const shot=project.shots.find(item=>item.id===shotId);if(!shot||shot.generation.referenceAssetIds.includes(assetId))return;const maxImages=professionalMaxImages(shot);if(shot.generation.referenceAssetIds.length>=maxImages)return toast(`参考图片最多使用 ${maxImages} 张图片`);shot.generation.referenceAssetIds.push(assetId);await patch({shots:project.shots});}
  async function removeVideoReference(shotId,assetId){const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;shot.generation.referenceAssetIds=shot.generation.referenceAssetIds.filter(id=>id!==assetId);await patch({shots:project.shots});}
  function bindVideoReferenceEditors(){document.querySelectorAll('[data-video-shot]').forEach(card=>enhanceVideoReferenceEditor(card,project.shots.find(item=>item.id===card.dataset.videoShot)));document.querySelectorAll('[data-pick-video-assets]').forEach(button=>button.onclick=()=>{videoAssetPickerShotId=videoAssetPickerShotId===button.dataset.pickVideoAssets?'':button.dataset.pickVideoAssets;render();});document.querySelectorAll('[data-close-video-assets]').forEach(button=>button.onclick=()=>{videoAssetPickerShotId='';render();});document.querySelectorAll('[data-add-video-asset]').forEach(button=>button.onclick=()=>addVideoReference(button.dataset.shotId,button.dataset.addVideoAsset));document.querySelectorAll('[data-remove-video-asset]').forEach(button=>button.onclick=()=>removeVideoReference(button.dataset.shotId,button.dataset.removeVideoAsset));document.querySelectorAll('[data-video-reference-list]').forEach(list=>{let dragged=null;list.querySelectorAll('[data-video-reference-id]').forEach(item=>{item.ondragstart=event=>{dragged=item;item.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',item.dataset.videoReferenceId);};item.ondragend=()=>{item.classList.remove('dragging');dragged=null;};item.ondragover=event=>{event.preventDefault();if(!dragged||dragged===item)return;const before=event.clientX<item.getBoundingClientRect().left+item.offsetWidth/2;list.insertBefore(dragged,before?item:item.nextSibling);};item.ondrop=event=>{event.preventDefault();updateVideoReferenceIds(list.dataset.videoReferenceList,[...list.querySelectorAll('[data-video-reference-id]')].map(node=>node.dataset.videoReferenceId));};item.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const ordered=[...list.querySelectorAll('[data-video-reference-id]')];const index=ordered.indexOf(item);const next=event.key==='ArrowLeft'?index-1:index+1;if(next<0||next>=ordered.length)return;const ids=ordered.map(node=>node.dataset.videoReferenceId);[ids[index],ids[next]]=[ids[next],ids[index]];updateVideoReferenceIds(list.dataset.videoReferenceList,ids);};});});}
  async function setGenerationMode(id,mode){const request=projectRequest();try{assertProjectRequest(request);const shot=project.shots.find(x=>x.id===id);if(!shot)return;shot.generation.type=mode;videoAssetPickerShotId='';if(mode==='FIRST&LAST')shot.duration=8;if(mode==='FIRST&LAST'&&!shot.generation.firstFrameAssetId)shot.generation.firstFrameAssetId=selectedResourceAssetIds(shot)[0]||'';if(mode==='REFERENCE'&&!shot.generation.referenceAssetIds.length)shot.generation.referenceAssetIds=selectedResourceAssetIds(shot).slice(0,professionalMaxImages(shot));await patch({shots:project.shots});assertProjectRequest(request);}catch(error){if(error.stale)return;throw error;}}
  async function saveGenerationConfig(id){const request=projectRequest();try{assertProjectRequest(request);const card=document.querySelector(`[data-video-shot="${id}"]`);const shot=project.shots.find(x=>x.id===id);if(!card||!shot)return null;card.querySelectorAll('[data-generation-field]').forEach(field=>shot.generation[field.dataset.generationField]=field.value);card.querySelectorAll('[data-video-field]').forEach(field=>shot[field.dataset.videoField]=field.dataset.videoField==='duration'?Number(field.value):field.value);const promptEditor=card.querySelector('[data-prompt-override]');if(promptEditor){const value=Array.from(promptEditor.value.trim()).slice(0,videoPromptMaxLength(shot.generation.modelId)).join('');shot.promptOverride=value&&value!==promptEditor.dataset.systemPrompt?value:'';}ensureProfessionalVideoSettings(shot);const updated=await patch({shots:project.shots});assertProjectRequest(request);toast('本镜设置已保存');return updated?.shots?.find(item=>item.id===id)||null;}catch(error){if(error.stale)return null;throw error;}}
  async function generateShotVideo(id,button){let shot=project.shots.find(x=>x.id===id);if(!shot)return;const request=projectRequest();shot=await saveGenerationConfig(id)||project.shots.find(x=>x.id===id);if(!shot||!isProjectRequestCurrent(request))return;ensureProfessionalVideoSettings(shot);if(!shot.generation.modelId)return toast('当前没有可用的视频模型，请稍后再试。');const warning=professionalProductionWarning(shot);if(warning)return toast(warning);const referenceAssetIds=shotGenerationAssetIds(shot);const requestShot=videoRequestShot(shot,referenceAssetIds);const checked=await promptPrecheck.check({prompts:[shotVideoPrompt(requestShot)],modelId:shot.generation.modelId,source:'drama',scopeNote:true});if(checked.action==='cancel'||!isProjectRequestCurrent(request))return;const finalPrompt=checked.prompts[0];button=document.querySelector(`[data-generate-shot-video="${id}"]`)||button;button.disabled=true;button.textContent='正在准备…';try{const cloudRefs=await ensureCloudReferenceIds(referenceAssetIds);assertProjectRequest(request);const generation=await api('/api/generations',{method:'POST',body:JSON.stringify({...checked.fields,type:'video',prompt:finalPrompt,dramaProjectId:project.id,dramaShotId:id,modelId:shot.generation.modelId,aspectRatio:shot.aspectRatio,duration:shot.duration,quality:shot.generation.quality,generationType:requestShot.generation.type,referenceAssetIds:cloudRefs})});assertProjectRequest(request);setCreditBalance(generation.balance);state.tasks=[generation,...state.tasks.filter(x=>x.id!==generation.id)];const result=await api(`/api/drama/projects/${project.id}/shots/${id}/videos`,{method:'POST',body:JSON.stringify({taskId:generation.id})});assertProjectRequest(request);project=result.project;state.dramaProject=project;render();toast(`分镜视频已开始生成，预计消耗 ${generation.creditCost} 积分`);}catch(error){if(error.stale)return;toast(error.message);button.disabled=false;button.textContent='重新生成';}}
  async function generateAllVideos(){
    const request=projectRequest();
    const pending=project.shots.filter(shot=>task(shot.selectedVideoTaskId)?.status!=='completed');
    const targets=pending.filter(shot=>{ensureProfessionalVideoSettings(shot);return !professionalProductionWarning(shot)&&shotGenerationReady(shot);});
    if(!pending.length)return toast('所有分镜都已完成');
    if(!targets.length)return toast('请先完成镜头的生成方式配置');
    for(const shot of targets){
      if(!isProjectRequestCurrent(request))return;
      const button=document.querySelector(`[data-generate-shot-video="${shot.id}"]`);
      if(button)await generateShotVideo(shot.id,button);
    }
    if(!isProjectRequestCurrent(request))return;
    toast(targets.length===pending.length?'未完成镜头已全部开始生成':`已开始生成 ${targets.length} 个镜头，其余镜头需要补充参考图片`);
  }
  async function selectVideo(shotId,taskId){const request=projectRequest();try{assertProjectRequest(request);const shot=project.shots.find(x=>x.id===shotId);if(!shot||!taskLocallyReady(taskId))return taskSyncing(taskId)?toast('视频正在准备，请稍后选择'):undefined;shot.selectedVideoTaskId=taskId;await patch({shots:project.shots});assertProjectRequest(request);}catch(error){if(error.stale)return;throw error;}}
  async function extractTail(shotId,button){button.disabled=true;button.textContent='正在提取…';const request=projectRequest();try{const shot=project.shots.find(item=>item.id===shotId);if(!shot)throw new Error('分镜不存在');const result=await extractDramaTailLocally(shot);assertProjectRequest(request);shot.tailFrameAssetId=result.id;const index=project.shots.findIndex(x=>x.id===shotId);if(index>=0&&index<project.shots.length-1){const next=project.shots[index+1];next.generation.type='FIRST&LAST';next.generation.firstFrameAssetId=result.id;next.duration=8;next.lifecycle.staleReasons=[...new Set([...(next.lifecycle.staleReasons||[]),'已接入上一镜尾帧，请确认结束状态'])];await patch({shots:project.shots},{quiet:true});assertProjectRequest(request);}render();toast(index<project.shots.length-1?'尾帧已保存，并设为下一镜首帧':'尾帧已保存到素材库');}catch(error){if(error.stale)return;toast(error.message);button.disabled=false;}}
  async function assemble(){const button=document.querySelector('#assembleProject');button.disabled=true;button.textContent='正在拼接成片…';try{await assembleDramaLocally();render();toast('完整成片已生成并保存在素材库');}catch(error){if(error.stale)return;toast(error.message);button.disabled=false;button.textContent='重新一键成片';}}

  document.querySelector('#dramaTopBack').onclick=closeProject;
  function leaveProjectTitleEdit({focusDisplay=false}={}){
    const display=document.querySelector('#dramaProjectTitleDisplay');
    const input=document.querySelector('#dramaProjectTitle');
    projectTitleEditing=false;
    projectTitleDraft='';
    input?.classList.add('hidden');
    display?.classList.remove('hidden');
    syncProjectHeader();
    if(focusDisplay)display?.focus();
  }
  function beginProjectTitleEdit(){
    const display=document.querySelector('#dramaProjectTitleDisplay');
    const input=document.querySelector('#dramaProjectTitle');
    if(!project||!display||!input||projectTitleEditing)return;
    projectTitleEditing=true;
    projectTitleDraft=project.title||'未命名剧本';
    input.value=projectTitleDraft;
    display.classList.add('hidden');
    input.classList.remove('hidden');
    requestAnimationFrame(()=>{input.focus();input.select();});
  }
  async function saveProjectTitle(input=document.querySelector('#dramaProjectTitle')){
    if(!project||!input||!projectTitleEditing)return;
    const request=projectRequest();
    const previous=projectTitleDraft||project.title||'未命名剧本';
    const title=input.value.trim()||'未命名剧本';
    input.value=title;
    projectTitleEditing=false;
    projectTitleDraft='';
    input.classList.add('hidden');
    document.querySelector('#dramaProjectTitleDisplay')?.classList.remove('hidden');
    if(title===previous){syncProjectHeader();return;}
    project.title=title;
    state.dramaProject=project;
    syncProjectHeader();
    try{
      await patch({title},{quiet:true});
      assertProjectRequest(request);
      syncProjectHeader();
    }catch(error){
      if(error.stale)return;
      if(project?.id===request.projectId){project.title=previous;state.dramaProject=project;syncProjectHeader();}
    }
  }
  const projectTitleInput=document.querySelector('#dramaProjectTitle');
  const projectTitleDisplay=document.querySelector('#dramaProjectTitleDisplay');
  projectTitleDisplay?.addEventListener('click',beginProjectTitleEdit);
  projectTitleInput?.addEventListener('blur',()=>{if(projectTitleEditing)void saveProjectTitle(projectTitleInput);});
  projectTitleInput?.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();leaveProjectTitleEdit({focusDisplay:true});return;}if(event.key==='Enter'){event.preventDefault();event.stopPropagation();void saveProjectTitle(projectTitleInput);}});
  function suspend(){
    styleDialog.close();
    styleButton?.classList.add('hidden');
    promptOptimization.close();
    directorWorkspaceView?.dispose();
    clearInterval(priceRefreshTimer);priceRefreshTimer=0;
    priceRefreshEpoch+=1;priceRefreshPromise=null;priceRefreshAt=0;
    deferredProfessionalRender=false;
    resetWorkbenchVideoObserver();
    resetProjectAssetMediaObserver();
    resetVirtualShotWindow();
    clearTimeout(projectAssetSearchTimer);projectAssetSearchTimer=0;
    closeMentionPicker();
    closeWorkbenchDropdowns();
    ['#projectAssetDialog','#professionalAssetDialog','#professionalGenerationReferenceDialog','#professionalMediaPreviewDialog','#professionalAssemblyDialog','#professionalAssemblyLibraryDialog','#renameDramaProjectDialog'].forEach(selector=>{const dialog=document.querySelector(selector);if(dialog?.open)dialog.close();});
  }
  function resetForAccount(){
    promptOptimization.close();
    suspend();
    clearTimeout(saveTimer);
    saveTimer=0;
    projectLoadToken+=1;
    projectEpoch+=1;
    pendingKeys.clear();
    projectKeyVersions.clear();
    projectAcknowledgedVersions.clear();
    projectMutationChain=Promise.resolve();
    projects=[];
    project=null;
    projectBaseSnapshot=null;
    viewStep=null;
    busy=false;
    busyAccount=null;
    scriptDraft=null;
    assetPickerShotId='';
    videoAssetPickerShotId='';
    professionalAssetGeneration=null;
    professionalPendingImageGenerations=[];
    professionalRecentAssetIds=[];
    professionalAssetSelection=[];
    professionalGenerationReferenceSelection=[];

    professionalPreviewTaskIds.clear();
    professionalGenerationPending.clear();
    shotPreviewSignatures.clear();
    state.dramaProject=null;
  }
  return { load, render, refreshTasks, refreshProject, removeAssemblyVideosForAssets, modelState, suspend, resetForAccount, open:openProject, close:closeProject, create:openCreateProjectDialog, rename:openRenameProjectDialog, remove:deleteProject, get projects(){return projects;}, get project(){return project;} };
}
