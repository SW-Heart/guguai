import { mergeTransientFields } from '../../list-sync.js?v=3';
import { desktopAcknowledgementRetryDelay, desktopHydrationRetryDelay, desktopMediaPayload, mergeDesktopAssetRecord, shouldHydrateDesktopAsset } from '../../desktop-media-sync.js?v=10';

const emptyStorage = Object.freeze({ getItem: () => null, setItem: () => {} });

export function createMediaController({
  state,
  api,
  desktopScope,
  recordIndexes,
  fileById,
  accountSnapshot = () => null,
  isAccountCurrent = () => true,
  getAccountEpoch = () => 0,
  getDesktopSyncInfo = () => ({}),
  setDesktopSyncInfo = () => {},
  getWindow = () => window,
  getFileKind = () => state?.fileKind || 'all',
  getFileSearch = () => '',
  matchesLibraryFile = () => true,
  clearFileReferencesForIds = () => {},
  onChanged = () => {},
  onError = () => {},
  removeDramaAssemblyAssets = async () => {},
  refreshDramaProject = async () => {},
  setTimeoutFn = null,
  clearTimeoutFn = null,
  storage = null,
} = {}) {
  if (!state || !api || !desktopScope || !recordIndexes || !fileById) throw new Error('媒体控制器缺少必要依赖');

  const setTimer = setTimeoutFn || ((callback, delay) => getWindow().setTimeout(callback, delay));
  const clearTimer = clearTimeoutFn || (timer => getWindow().clearTimeout(timer));
  const localStorage = storage || getWindow().localStorage || emptyStorage;
  let libraryFiles = [];
  let localFileCursor = '';
  let localFileHasMore = true;
  let localFileTotal = 0;
  let fileQueryKey = '';
  let fileLoadVersion = 0;
  let localFileStateRevision = 0;
  let desktopSyncRequest = null;
  let desktopSyncRequestEpoch = 0;
  const desktopHydrationQueue = [];
  const desktopHydrationQueued = new Set();
  const desktopHydrationAttempted = new Set();
  const desktopHydrationActive = new Set();
  const desktopHydrationForced = new Set();
  const desktopHydrationFailureCounts = new Map();
  const desktopHydrationRetryTimers = new Map();
  let desktopHydrationRunning = false;
  const desktopAcknowledgementQueue = [];
  const desktopAcknowledgementQueued = new Set();
  const desktopAcknowledgementActive = new Set();
  const desktopAcknowledgementFailureCounts = new Map();
  const desktopAcknowledgementRetryTimers = new Map();
  let desktopAcknowledgementRunning = false;

  const bridge = () => getWindow().guguDesktop;
  const requestIsCurrent = (requestAccount, requestEpoch) => requestEpoch === getAccountEpoch() && isAccountCurrent(requestAccount);
  const syncInfo = () => getDesktopSyncInfo() || {};
  const updateSyncInfo = patch => setDesktopSyncInfo({ ...syncInfo(), ...patch });
  const notifyChanged = () => onChanged();

  function desktopLocalClientAsset(item) {
    return desktopScope.localAsset(item);
  }

  async function listDesktopFiles(options = {}) {
    const localBridge = bridge();
    if (!localBridge?.media?.listLocal) throw new Error('桌面本地文件库尚未就绪');
    const local = await localBridge.media.listLocal(options);
    const page = Array.isArray(local) ? { items:local, nextCursor:'' } : (local || {});
    return {
      items:(Array.isArray(page.items) ? page.items : []).map(desktopLocalClientAsset).filter(Boolean),
      total:Number(page.total) || 0,
      nextCursor:page.nextCursor || '',
    };
  }

  async function acknowledgeDesktopAsset(file, localAsset, { deviceId = syncInfo().deviceId } = {}) {
    await api(`/api/files/${encodeURIComponent(file.id)}/local-ready`, {
      method:'POST',
      responseShape:'object',
      body:JSON.stringify({ size:localAsset.size, sha256:localAsset.sha256, mimeType:localAsset.mimeType || file.mimeType, deviceId }),
    });
  }

  function mergeStateFiles(files) {
    const previousById = new Map(state.files.map(file => [file.id, file]));
    const incoming = mergeTransientFields(state.files, files, ['width','height'])
      .map(file => mergeDesktopAssetRecord(previousById.get(file.id), file));
    const incomingIds = new Set(incoming.map(file => file.id));
    state.files = [...incoming, ...state.files.filter(file => !incomingIds.has(file.id))];
    recordIndexes.invalidateFiles();
  }

  function mergeLocalAssets(files) {
    if (files.length) localFileStateRevision += 1;
    mergeStateFiles(files);
  }

  function applyDesktopLocalAsset(remoteFile, localAsset) {
    const local = desktopLocalClientAsset(localAsset);
    if (!local) return;
    const file = { ...remoteFile, ...local, id:remoteFile.id, localId:local.localId, cloudAssetId:remoteFile.id, remoteUrl:remoteFile.url, localStatus:'saved', localPath:local.relativePath };
    localFileStateRevision += 1;
    const existed = state.files.some(item => item.id === file.id);
    mergeStateFiles([file]);
    if (matchesLibraryFile(file)) {
      libraryFiles = [file, ...libraryFiles.filter(item => item.id !== file.id)];
      if (!existed) localFileTotal += 1;
    }
    notifyChanged();
  }

  function markDesktopAssetReady(assetId) {
    const file = fileById(assetId);
    if (!file) return;
    mergeStateFiles([{ ...file, deliveryStatus:'local_ready', remoteStatus:'ready' }]);
    libraryFiles = libraryFiles.map(item => item.id === assetId ? { ...item, deliveryStatus:'local_ready', remoteStatus:'ready' } : item);
  }

  async function queueDesktopAcknowledgement(file, localAsset = file, { requestAccount = accountSnapshot(), requestEpoch = getAccountEpoch(), attempts = 0, nextAttemptAt = 0 } = {}) {
    const assetId = String(file?.id || '');
    if (!assetId || file?.localOnly || file?.deliveryStatus === 'local_ready' || desktopAcknowledgementQueued.has(assetId) || desktopAcknowledgementActive.has(assetId)) return;
    const currentFile = fileById(assetId) || file;
    if (currentFile.localOnly || currentFile.localStatus !== 'saved' || currentFile.deliveryStatus === 'local_ready') return;
    if (Number(attempts) > 0) desktopAcknowledgementFailureCounts.set(assetId, Math.max(desktopAcknowledgementFailureCounts.get(assetId) || 0, Math.floor(Number(attempts))));
    desktopAcknowledgementQueued.add(assetId);
    desktopAcknowledgementActive.add(assetId);
    const item = { assetId, file:currentFile, localAsset, requestAccount, requestEpoch };
    const localBridge = bridge();
    try {
      await localBridge?.media?.saveDeliveryTask?.({
        assetId,
        workspaceId:String(syncInfo().workspaceId || ''),
        localAssetId:String(localAsset?.localId || localAsset?.id || ''),
        size:Number(localAsset?.size || currentFile.size) || 0,
        sha256:String(localAsset?.sha256 || currentFile.sha256 || ''),
        mimeType:String(localAsset?.mimeType || currentFile.mimeType || ''),
        attempts,
        nextAttemptAt,
      });
    } catch (error) {
      console.warn('[desktop] 本地确认任务持久化失败，将仅保留当前进程重试', { assetId, message:error.message });
    }
    if (!requestIsCurrent(requestAccount, requestEpoch)) {
      desktopAcknowledgementQueued.delete(assetId);
      desktopAcknowledgementActive.delete(assetId);
      return;
    }
    desktopAcknowledgementQueue.push(item);
    notifyChanged();
    void runDesktopAcknowledgementQueue();
  }

  function queueSavedDesktopAcknowledgements(files) {
    for (const file of files) {
      const current = fileById(file?.id) || file;
      if (current?.localStatus === 'saved' && ['awaiting_local', 'remote_backed_up'].includes(current.deliveryStatus)) void queueDesktopAcknowledgement(current, current);
    }
  }

  async function restorePersistedDesktopAcknowledgements(files) {
    const localBridge = bridge();
    if (typeof localBridge?.media?.listDeliveryTasks !== 'function') return;
    let tasks;
    try { tasks = await localBridge.media.listDeliveryTasks(); }
    catch (error) { console.warn('[desktop] 读取本地确认任务失败', error.message); return; }
    const byId = new Map((Array.isArray(files) ? files : []).map(file => [String(file?.id || ''), file]));
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const file = byId.get(String(task?.assetId || '')) || fileById(task?.assetId);
      if (!file || file.localStatus !== 'saved' || file.localOnly || file.deliveryStatus === 'local_ready') continue;
      const localAsset = {
        ...file,
        id:String(task.localAssetId || file.localId || file.id),
        localId:String(task.localAssetId || file.localId || file.id),
        size:Number(task.size || file.size) || 0,
        sha256:String(task.sha256 || file.sha256 || ''),
        mimeType:String(task.mimeType || file.mimeType || ''),
      };
      const delay = Math.max(0, Number(task.nextAttemptAt) - Date.now());
      if (delay) {
        const assetId = String(file.id);
        if (desktopAcknowledgementRetryTimers.has(assetId)) continue;
        const timer = setTimer(() => {
          desktopAcknowledgementRetryTimers.delete(assetId);
          void queueDesktopAcknowledgement(fileById(assetId) || file, localAsset, { attempts:Number(task.attempts) || 0 });
        }, delay);
        desktopAcknowledgementRetryTimers.set(assetId, timer);
      } else {
        void queueDesktopAcknowledgement(file, localAsset, { attempts:Number(task.attempts) || 0 });
      }
    }
  }

  async function runDesktopAcknowledgementQueue() {
    if (desktopAcknowledgementRunning) return;
    const runEpoch = getAccountEpoch();
    desktopAcknowledgementRunning = true;
    try {
      while (desktopAcknowledgementQueue.length && runEpoch === getAccountEpoch()) {
        const item = desktopAcknowledgementQueue.shift();
        try {
          if (!requestIsCurrent(item.requestAccount, item.requestEpoch)) continue;
          const file = fileById(item.assetId) || item.file;
          if (!file || file.localOnly || file.localStatus !== 'saved' || file.deliveryStatus === 'local_ready') continue;
          await acknowledgeDesktopAsset(file, item.localAsset, { deviceId:syncInfo().deviceId });
          if (!requestIsCurrent(item.requestAccount, item.requestEpoch)) continue;
          markDesktopAssetReady(item.assetId);
          try { await bridge()?.media?.completeDeliveryTask?.(item.assetId, syncInfo().workspaceId); }
          catch (error) { console.warn('[desktop] 清理已完成的本地确认任务失败', { assetId:item.assetId, message:error.message }); }
          desktopAcknowledgementFailureCounts.delete(item.assetId);
          const retryTimer = desktopAcknowledgementRetryTimers.get(item.assetId);
          if (retryTimer) clearTimer(retryTimer);
          desktopAcknowledgementRetryTimers.delete(item.assetId);
        } catch (error) {
          if (!requestIsCurrent(item.requestAccount, item.requestEpoch)) continue;
          const failureCount = (desktopAcknowledgementFailureCounts.get(item.assetId) || 0) + 1;
          desktopAcknowledgementFailureCounts.set(item.assetId, failureCount);
          const retryDelay = desktopAcknowledgementRetryDelay(failureCount);
          console.warn('[desktop] 本地文件已保存，但本地接收确认失败', { assetId:item.assetId, message:error.message, failureCount, retryDelay });
          if (item.assetId && retryDelay && !desktopAcknowledgementRetryTimers.has(item.assetId)) {
            const timer = setTimer(() => {
              desktopAcknowledgementRetryTimers.delete(item.assetId);
              const current = fileById(item.assetId) || item.file;
              if (current) void queueDesktopAcknowledgement(current, item.localAsset, { requestAccount:item.requestAccount, requestEpoch:item.requestEpoch, attempts:failureCount });
            }, retryDelay);
            desktopAcknowledgementRetryTimers.set(item.assetId, timer);
          }
          try {
            const current = fileById(item.assetId) || item.file;
            await bridge()?.media?.saveDeliveryTask?.({
              assetId:item.assetId,
              workspaceId:String(syncInfo().workspaceId || ''),
              localAssetId:String(item.localAsset?.localId || item.localAsset?.id || ''),
              size:Number(item.localAsset?.size || current?.size) || 0,
              sha256:String(item.localAsset?.sha256 || current?.sha256 || ''),
              mimeType:String(item.localAsset?.mimeType || current?.mimeType || ''),
              attempts:failureCount,
              nextAttemptAt:Date.now() + retryDelay,
            });
          } catch (persistError) { console.warn('[desktop] 更新本地确认任务失败', { assetId:item.assetId, message:persistError.message }); }
        } finally {
          desktopAcknowledgementQueued.delete(item.assetId);
          desktopAcknowledgementActive.delete(item.assetId);
          notifyChanged();
        }
      }
    } finally {
      if (runEpoch === getAccountEpoch()) {
        desktopAcknowledgementRunning = false;
        if (desktopAcknowledgementQueue.length) void runDesktopAcknowledgementQueue();
      }
    }
  }

  async function removeDesktopCloudAssets(assetIds) {
    const requestAccount = accountSnapshot();
    const requestEpoch = getAccountEpoch();
    const ids = [...new Set((Array.isArray(assetIds) ? assetIds : [assetIds]).map(value => String(value || '')).filter(Boolean))];
    if (!ids.length || !requestIsCurrent(requestAccount, requestEpoch)) return;
    const localBridge = bridge();
    const localFiles = state.files.filter(file => ids.includes(String(file.cloudAssetId || file.id || '')) && !file.localOnly);
    if (localBridge?.media?.removeLocalByCloudIds) {
      await localBridge.media.removeLocalByCloudIds(ids);
    } else if (localBridge?.media?.removeLocal) {
      for (const file of localFiles) {
        try { await localBridge.media.removeLocal(file.localId || file.id); }
        catch (error) { console.warn('[desktop] 清理已删除云端素材失败', { assetId:file.id, message:error.message }); }
      }
    }
    if (!requestIsCurrent(requestAccount, requestEpoch)) return;
    const removed = new Set(ids);
    const matches = file => removed.has(String(file.cloudAssetId || file.id || ''));
    const removedLibraryCount = libraryFiles.filter(matches).length;
    const projectIds = [...new Set(localFiles.map(file => String(file.projectId || '').trim()).filter(Boolean))];
    const projectId = projectIds.length === 1 ? projectIds[0] : '';
    state.files = state.files.filter(file => !matches(file));
    libraryFiles = libraryFiles.filter(file => !matches(file));
    ids.forEach(id => {
      desktopHydrationQueued.delete(id);
      desktopHydrationAttempted.delete(id);
      desktopHydrationActive.delete(id);
      desktopHydrationFailureCounts.delete(id);
      const retryTimer = desktopHydrationRetryTimers.get(id);
      if (retryTimer) clearTimer(retryTimer);
      desktopHydrationRetryTimers.delete(id);
      desktopAcknowledgementQueued.delete(id);
      desktopAcknowledgementActive.delete(id);
      desktopAcknowledgementFailureCounts.delete(id);
      const acknowledgementTimer = desktopAcknowledgementRetryTimers.get(id);
      if (acknowledgementTimer) clearTimer(acknowledgementTimer);
      desktopAcknowledgementRetryTimers.delete(id);
      const completion = localBridge?.media?.completeDeliveryTask?.(id, syncInfo().workspaceId);
      if (completion?.catch) void completion.catch(() => {});
    });
    clearFileReferencesForIds(ids);
    recordIndexes.invalidateFiles();
    await removeDramaAssemblyAssets(ids, projectId);
    localFileTotal = Math.max(0, localFileTotal - removedLibraryCount);
    notifyChanged();
  }

  async function showAssetInFolder(file, control = null) {
    const localBridge = bridge();
    if (!localBridge?.media || !file) return null;
    const wasDisabled = Boolean(control?.disabled);
    if (control) { control.disabled = true; control.setAttribute('aria-disabled', 'true'); }
    try {
      const localAssetId = String(file.localId || (file.localOnly ? file.id : ''));
      if (!localAssetId || !await localBridge.media.showInFolder(localAssetId)) throw new Error('本地素材不存在');
      return true;
    } catch (error) {
      onError(error, { action:'show-folder' });
      return null;
    } finally {
      if (control) { control.disabled = wasDisabled; control.setAttribute('aria-disabled', String(wasDisabled)); }
    }
  }

  async function copyAssetToClipboard(file, control = null) {
    const localBridge = bridge();
    if (!localBridge?.media || !file) return null;
    const wasDisabled = Boolean(control?.disabled);
    if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
    try {
      const localAssetId = String(file.localId || (file.localOnly ? file.id : ''));
      if (!localAssetId || !await localBridge.media.copyToClipboard(localAssetId)) throw new Error('本地素材不存在');
      return true;
    } catch (error) {
      onError(error, { action:'copy-asset' });
      return null;
    } finally {
      if (control) { control.disabled = wasDisabled; control.setAttribute('aria-busy', String(wasDisabled)); }
    }
  }

  async function hydrateDesktopAsset(file, { merge = true } = {}) {
    const requestAccount = accountSnapshot();
    const requestEpoch = getAccountEpoch();
    const localBridge = bridge();
    if (!localBridge || !file || file.localOnly || file.localStatus === 'saved') return;
    if (!requestIsCurrent(requestAccount, requestEpoch)) return null;
    const result = await localBridge.media.downloadRemote(desktopMediaPayload(file));
    if (!requestIsCurrent(requestAccount, requestEpoch)) return null;
    if (result?.unavailable) throw Object.assign(new Error(`远端文件已不存在（${result.status || 404}）`), { unavailable:true });
    if (!result?.id) throw new Error('素材接收后未能写入本地工作区');
    if (merge) applyDesktopLocalAsset(file, result);
    if (!requestIsCurrent(requestAccount, requestEpoch)) return null;
    queueDesktopAcknowledgement(fileById(file.id) || file, result, { requestAccount, requestEpoch });
    return result;
  }

  async function runDesktopHydrationQueue() {
    if (desktopHydrationRunning) return;
    const runEpoch = getAccountEpoch();
    desktopHydrationRunning = true;
    try {
      while (desktopHydrationQueue.length && runEpoch === getAccountEpoch()) {
        const file = desktopHydrationQueue.shift();
        try {
          await hydrateDesktopAsset(file);
          if (runEpoch !== getAccountEpoch()) continue;
          desktopHydrationAttempted.delete(file?.id);
          desktopHydrationForced.delete(file?.id);
          desktopHydrationFailureCounts.delete(file?.id);
          const retryTimer = desktopHydrationRetryTimers.get(file?.id);
          if (retryTimer) clearTimer(retryTimer);
          desktopHydrationRetryTimers.delete(file?.id);
        } catch (error) {
          if (runEpoch !== getAccountEpoch()) continue;
          const assetId = file?.id;
          desktopHydrationAttempted.delete(assetId);
          const failureCount = (desktopHydrationFailureCounts.get(assetId) || 0) + 1;
          desktopHydrationFailureCounts.set(assetId, failureCount);
          const retryDelay = error?.unavailable ? 0 : desktopHydrationRetryDelay(failureCount);
          console.warn('[desktop] 自动同步素材失败', { assetId, message:error.message, failureCount, retryDelay });
          if (!retryDelay) desktopHydrationForced.delete(assetId);
          if (assetId && retryDelay && !desktopHydrationRetryTimers.has(assetId)) {
            const timer = setTimer(() => {
              desktopHydrationRetryTimers.delete(assetId);
              queueDesktopHydration([fileById(assetId) || file]);
            }, retryDelay);
            desktopHydrationRetryTimers.set(assetId, timer);
          }
        } finally {
          if (runEpoch === getAccountEpoch()) {
            desktopHydrationQueued.delete(file?.id);
            desktopHydrationActive.delete(file?.id);
            notifyChanged();
          }
        }
      }
    } finally {
      if (runEpoch === getAccountEpoch()) {
        desktopHydrationRunning = false;
        if (desktopHydrationQueue.length) void runDesktopHydrationQueue();
      }
    }
  }

  function queueDesktopHydration(files, { forceAssetIds = [] } = {}) {
    if (!bridge()) return;
    const forcedIds = new Set((Array.isArray(forceAssetIds) ? forceAssetIds : []).map(value => String(value || '')).filter(Boolean));
    let queued = false;
    for (const file of files) {
      const assetId = String(file?.id || '');
      if (forcedIds.has(assetId)) desktopHydrationForced.add(assetId);
      const forced = desktopHydrationForced.has(assetId);
      if (!shouldHydrateDesktopAsset(file, { force:forced }) || desktopHydrationQueued.has(file.id) || desktopHydrationAttempted.has(file.id) || desktopHydrationRetryTimers.has(file.id)) continue;
      desktopHydrationAttempted.add(file.id);
      desktopHydrationQueued.add(file.id);
      desktopHydrationActive.add(file.id);
      desktopHydrationQueue.push(file);
      queued = true;
    }
    if (queued) notifyChanged();
    if (desktopHydrationQueue.length) void runDesktopHydrationQueue();
  }

  async function syncDesktopDeliveries({ assetIds = [] } = {}) {
    const localBridge = bridge();
    const currentSyncInfo = syncInfo();
    if (!localBridge?.sync || !currentSyncInfo.deviceId || !currentSyncInfo.workspaceId) return null;
    const requestEpoch = getAccountEpoch();
    const requestAccount = accountSnapshot();
    const isCurrentRequest = () => requestIsCurrent(requestAccount, requestEpoch);
    const requestedAssetIds = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(value => String(value || '')).filter(Boolean))].slice(0, 500);
    if (desktopSyncRequest && desktopSyncRequestEpoch === requestEpoch) {
      if (!requestedAssetIds.length) return desktopSyncRequest;
      try { await desktopSyncRequest; } catch {}
      if (!isCurrentRequest()) return null;
    }
    const request = (async () => {
      const query = new URLSearchParams({ deviceId:syncInfo().deviceId, limit:'100' });
      if (syncInfo().cursor) query.set('cursor', syncInfo().cursor);
      if (requestedAssetIds.length) query.set('assetIds', requestedAssetIds.join(','));
      let result;
      try {
        result = await api(`/api/files/sync?${query}`);
      } catch (error) {
        if (!isCurrentRequest()) return null;
        if (error.status !== 400 || !syncInfo().cursor) throw error;
        updateSyncInfo({ cursor:'' });
        await localBridge.sync.setCursor('');
        query.delete('cursor');
        result = await api(`/api/files/sync?${query}`);
      }
      if (!isCurrentRequest()) return null;
      const changes = result.changes || [];
      const deletedCloudAssetIds = [...new Set(changes.filter(change => change?.action === 'delete' && change.assetId).map(change => String(change.assetId)))];
      const changedAssets = changes.filter(change => change?.action === 'upsert' && change.asset?.id).map(change => change.asset);
      if (deletedCloudAssetIds.length) {
        await removeDesktopCloudAssets(deletedCloudAssetIds);
        if (!isCurrentRequest()) return null;
        await refreshDramaProject({ quiet:true });
        if (!isCurrentRequest()) return null;
      }
      if (result.nextCursor) {
        if (!isCurrentRequest()) return null;
        updateSyncInfo({ cursor:result.nextCursor });
        await localBridge.sync.setCursor(result.nextCursor);
        if (!isCurrentRequest()) return null;
      }
      const deliveries = [...new Map([...changedAssets, ...(result.deliveries || [])].filter(file => file?.id).map(file => [file.id, file])).values()];
      if (deliveries.length && isCurrentRequest()) {
        mergeStateFiles(deliveries);
        const currentDeliveries = deliveries.map(file => fileById(file.id) || file);
        queueSavedDesktopAcknowledgements(currentDeliveries);
        queueDesktopHydration(currentDeliveries, { forceAssetIds:requestedAssetIds });
        await restorePersistedDesktopAcknowledgements(currentDeliveries);
        notifyChanged();
      }
      await restorePersistedDesktopAcknowledgements([...deliveries, ...state.files]);
      return result;
    })();
    desktopSyncRequest = request;
    desktopSyncRequestEpoch = requestEpoch;
    try { return await request; }
    finally { if (desktopSyncRequest === request) desktopSyncRequest = null; }
  }

  async function claimLegacyWorkspace(user) {
    const localBridge = bridge();
    const currentSyncInfo = syncInfo();
    if (!localBridge?.media?.listLocal || !user?.id || !currentSyncInfo.workspaceId) return { skipped:true };
    const requestAccount = accountSnapshot();
    const requestEpoch = getAccountEpoch();
    const marker = `gugu:workspace-legacy-claimed-v1:${user.id}:${currentSyncInfo.workspaceId}`;
    if (localStorage.getItem(marker) === 'complete') return { skipped:true };
    const assetIds = new Set();
    let cursor = '';
    do {
      const page = await listDesktopFiles({ limit:200, cursor });
      if (!requestIsCurrent(requestAccount, requestEpoch)) return { stale:true };
      for (const file of page.items) {
        for (const value of [file.id, file.cloudAssetId, file.localId]) {
          const id = String(value || '').trim();
          if (id) assetIds.add(id);
        }
      }
      cursor = String(page.nextCursor || '');
    } while (cursor);
    const result = await api('/api/workspaces/claim-legacy', {
      method:'POST',
      body:JSON.stringify({ assetIds:[...assetIds].slice(0, 5000) }),
    });
    if (!requestIsCurrent(requestAccount, requestEpoch)) return { stale:true };
    localStorage.setItem(marker, 'complete');
    return result;
  }

  async function loadFiles({ background = false, loadMore = false } = {}) {
    const requestAccount = accountSnapshot();
    const search = String(getFileSearch() || '').trim();
    const queryKey = `${getFileKind()}|${search}`;
    const reset = !loadMore || queryKey !== fileQueryKey;
    const requestVersion = reset ? ++fileLoadVersion : fileLoadVersion;
    const requestLocalStateRevision = localFileStateRevision;
    const cursor = reset ? '' : localFileCursor;
    if (reset) {
      fileQueryKey = queryKey;
      localFileCursor = '';
      localFileHasMore = true;
    }
    try {
      const page = await listDesktopFiles({ limit:200, cursor, kind:getFileKind() === 'all' ? '' : getFileKind(), search });
      if (!isAccountCurrent(requestAccount) || requestVersion !== fileLoadVersion || queryKey !== fileQueryKey) return state.files;
      const localStateChanged = requestLocalStateRevision !== localFileStateRevision;
      localFileCursor = page.nextCursor || '';
      localFileHasMore = Boolean(page.nextCursor);
      const pageIds = new Set(page.items.map(file => file.id));
      libraryFiles = reset
        ? localStateChanged ? [...libraryFiles.filter(file => !pageIds.has(file.id)), ...page.items] : page.items
        : [...libraryFiles, ...page.items.filter(file => !libraryFiles.some(item => item.id === file.id))];
      localFileTotal = localStateChanged ? Math.max(page.total, libraryFiles.length) : page.total;
      if (reset && getFileKind() === 'all' && !search) {
        // The local library is paginated, while state.files is also the global
        // lookup used by generation cards. Replacing it with page one makes
        // valid completed assets beyond that page temporarily disappear.
        mergeStateFiles(page.items);
      } else mergeStateFiles(page.items);
      notifyChanged();
      return state.files;
    } catch (error) {
      if (!isAccountCurrent(requestAccount)) return state.files;
      if (!background) onError(error, { action:'load-files' });
      return state.files;
    }
  }

  async function removeLocalAsset(file) {
    const requestAccount = accountSnapshot();
    const requestEpoch = getAccountEpoch();
    const localBridge = bridge();
    if (!localBridge?.media?.removeLocal) throw new Error('桌面文件能力尚未就绪，请重启客户端后再试');
    await localBridge.media.removeLocal(file.localId || file.id);
    if (!requestIsCurrent(requestAccount, requestEpoch)) return;
    clearFileReferencesForIds([file.id]);
    state.files = state.files.filter(item => item.id !== file.id);
    libraryFiles = libraryFiles.filter(item => item.id !== file.id);
    recordIndexes.invalidateFiles();
    if (file.kind === 'video') await removeDramaAssemblyAssets([file.id], file.projectId);
    localFileTotal = Math.max(0, localFileTotal - 1);
    await loadFiles();
  }

  function reset() {
    desktopSyncRequest = null;
    desktopSyncRequestEpoch = getAccountEpoch();
    for (const timer of desktopHydrationRetryTimers.values()) clearTimer(timer);
    desktopHydrationRetryTimers.clear();
    for (const timer of desktopAcknowledgementRetryTimers.values()) clearTimer(timer);
    desktopAcknowledgementRetryTimers.clear();
    desktopHydrationQueue.length = 0;
    desktopHydrationQueued.clear();
    desktopHydrationAttempted.clear();
    desktopHydrationActive.clear();
    desktopHydrationForced.clear();
    desktopHydrationFailureCounts.clear();
    desktopHydrationRunning = false;
    desktopAcknowledgementQueue.length = 0;
    desktopAcknowledgementQueued.clear();
    desktopAcknowledgementActive.clear();
    desktopAcknowledgementFailureCounts.clear();
    desktopAcknowledgementRunning = false;
    localFileCursor = '';
    localFileHasMore = true;
    localFileTotal = 0;
    fileQueryKey = '';
    fileLoadVersion += 1;
    localFileStateRevision = 0;
    libraryFiles = [];
  }

  return Object.freeze({
    desktopLocalClientAsset,
    listDesktopFiles,
    acknowledgeDesktopAsset,
    mergeStateFiles,
    mergeLocalAssets,
    removeDesktopCloudAssets,
    showAssetInFolder,
    copyAssetToClipboard,
    hydrateDesktopAsset,
    queueDesktopHydration,
    syncDesktopDeliveries,
    claimLegacyWorkspace,
    loadFiles,
    removeLocalAsset,
    reset,
    isHydrating: file => Boolean(bridge() && desktopHydrationActive.has(file?.id) && !String(file?.url || '').startsWith('gugu-media://')),
    libraryState: () => ({ files:libraryFiles, cursor:localFileCursor, hasMore:localFileHasMore, total:localFileTotal }),
  });
}
