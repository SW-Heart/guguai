const LEGACY_GUGU_2_MODEL_ID = 'grok-15';
const MINIMAX_H3_15S_MODEL_ID = 'minimax-h3-15s';
const canonicalVideoModelId = value => String(value || '').trim().toLowerCase() === LEGACY_GUGU_2_MODEL_ID ? MINIMAX_H3_15S_MODEL_ID : String(value || '').trim();

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
  const referenceCounts = { image: 0, video: 0, audio: 0 };
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
    canonicalVideoModelId(input?.modelId), String(input?.generationType || ''), String(input?.aspectRatio || ''), Number(input?.duration), String(input?.quality || ''),
    Number(counts.image || 0), Number(counts.video || 0), Number(counts.audio || 0),
  ]);
}

export function videoPreviewVersionState(task, { ready = false, syncing = false } = {}) {
  if (task?.status === 'failed') return 'failed';
  if (ready) return 'ready';
  if (syncing) return 'syncing';
  if (['queued', 'running'].includes(task?.status)) return 'pending';
  if (task?.status === 'completed' && task.assetId) return 'syncing';
  return 'missing';
}

export function generationNeedsLocalAssetSync(task, file, isAssetSyncing = () => false) {
  return task?.status === 'completed' && Boolean(task.assetId) && (!file || isAssetSyncing(file));
}

function shotPreviewRenderSignatureFromMaps(shot, taskById, fileById, isAssetSyncing = () => false) {
  const ids = [...new Set([shot?.selectedVideoTaskId, ...(shot?.videoVersions || [])].filter(Boolean))];
  return [shot?.selectedVideoTaskId || '', ...ids.map(id => {
    const generation = taskById.get(id);
    const file = fileById.get(generation?.assetId);
    return `${id}:${generation?.status || ''}:${generation?.progress ?? ''}:${generation?.progressStage || ''}:${generation?.failure?.code || ''}:${generation?.error || ''}:${generation?.assetId || ''}:${file?.url || ''}:${file?.localStatus || ''}:${isAssetSyncing(file) ? 'syncing' : ''}`;
  })].join('|');
}

export function shotPreviewContentSignatureFromMaps(shot, taskById, fileById, isAssetSyncing = () => false, previewTaskId = shot?.selectedVideoTaskId) {
  const ids = [...new Set([previewTaskId, shot?.selectedVideoTaskId, ...(shot?.videoVersions || [])].filter(Boolean))];
  const previewTask = taskById.get(previewTaskId);
  const progressMode = previewTask?.type === 'video' && ['queued', 'running'].includes(previewTask.status) && videoTaskProgress(previewTask) !== null ? 'progress' : 'empty';
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
export function removeAssemblyVideoAssets(project, assetIds) {
  const ids = new Set((Array.isArray(assetIds) ? assetIds : [assetIds])
    .map(value => String(value || '').trim())
    .filter(Boolean));
  if (!project || !ids.size) return { project, changed:false };
  const assemblyVideos = Array.isArray(project.assemblyVideos) ? project.assemblyVideos : [];
  const nextAssemblyVideos = assemblyVideos.filter(item => !ids.has(String(item?.assetId || item?.id || '').trim()));
  const finalAssetId = String(project.finalAssetId || '').trim();
  const finalAssetRemoved = Boolean(finalAssetId && ids.has(finalAssetId));
  if (nextAssemblyVideos.length === assemblyVideos.length && !finalAssetRemoved) return { project, changed:false };
  return {
    project: {
      ...project,
      assemblyVideos:nextAssemblyVideos,
      ...(finalAssetRemoved ? { finalAssetId:'' } : {}),
    },
    changed:true,
  };
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
  while (first < values.length && offset + heightAt(first) <= top) { offset += heightAt(first); first += 1; }
  let last = first;
  while (last < values.length && offset < bottom) { offset += heightAt(last); last += 1; }
  return { start: Math.max(0, first - Math.max(0, overscan)), end: Math.min(values.length, last + Math.max(0, overscan)) };
}
export function clampVirtualScrollOffset(offset, scrollHeight, clientHeight) {
  const maximum = Math.max(0, (Number(scrollHeight) || 0) - (Number(clientHeight) || 0));
  return Math.max(0, Math.min(Number(offset) || 0, maximum));
}
export function isMountedVirtualShotScroll(root, scroll) {
  return Boolean(root && scroll && typeof root.contains === 'function' && root.contains(scroll) && typeof scroll.matches === 'function' && scroll.matches('.wb-shot-scroll'));
}
