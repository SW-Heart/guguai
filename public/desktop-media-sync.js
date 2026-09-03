export function cloudAssetFromDesktopSync(result) {
  return result?.cloudAsset?.id ? result.cloudAsset : null;
}

export function desktopMediaPayload(file) {
  const localOnly = Boolean(file?.localOnly);
  const assetId = String(file?.cloudAssetId || (!localOnly ? file?.id : '') || '');
  const localAssetId = String(file?.localId || (localOnly ? file?.id : '') || '');
  return {
    assetId,
    localAssetId,
    url: assetId ? String(file?.directUrl || `/api/files/${encodeURIComponent(assetId)}/direct`) : '',
    name: String(file?.name || '未命名文件'),
    kind: String(file?.kind || ''),
    mimeType: String(file?.mimeType || ''),
  };
}

// Cloud change records describe remote metadata only. Once the desktop has
// verified a local file, a later server upsert must not replace its local URL
// or readiness fields and make a completed generation look unsynced again.
export function mergeDesktopAssetRecord(existing, incoming) {
  if (!existing || !incoming) return incoming;
  const locallySaved = existing.localStatus === 'saved' && String(existing.url || '').startsWith('gugu-media://');
  if (!locallySaved) return incoming;
  const remoteUrl = String(incoming.remoteUrl || incoming.url || existing.remoteUrl || '');
  return {
    ...incoming,
    ...(existing.localId ? { localId:existing.localId } : {}),
    ...(existing.cloudAssetId ? { cloudAssetId:existing.cloudAssetId } : {}),
    url: existing.url,
    localStatus: 'saved',
    ...(existing.localPath ? { localPath:existing.localPath } : {}),
    ...(existing.relativePath ? { relativePath:existing.relativePath } : {}),
    localOnly: Boolean(existing.localOnly),
    ...(remoteUrl ? { remoteUrl } : {}),
  };
}

export function isRemoteReferenceReady(file) {
  return Boolean(file && !file.localOnly && (file.remoteStatus === 'ready' || file.referenceSourceAvailable));
}

export function needsReferenceUpload(file) {
  return Boolean(file && !isRemoteReferenceReady(file) && (file.localOnly || file.localId || file.remoteStatus === 'local_only'));
}

export function isAwaitingDesktopDelivery(file) {
  return Boolean(
    (file?.deliveryStatus === 'awaiting_local' && file?.remoteStatus === 'pending')
    || (file?.deliveryStatus === 'remote_backed_up' && file?.remoteStatus === 'ready')
  );
}

export function shouldHydrateDesktopAsset(file, { force = false } = {}) {
  return Boolean(file?.id && (force || isAwaitingDesktopDelivery(file)) && !file.localOnly && file.localStatus !== 'saved');
}

export function desktopHydrationRetryDelay(failureCount, { baseDelay = 750, maxFailures = 3 } = {}) {
  const count = Math.max(1, Math.floor(Number(failureCount) || 1));
  if (count >= Math.max(1, Math.floor(Number(maxFailures) || 3))) return 0;
  return Math.min(5000, Math.max(100, Number(baseDelay) || 750) * (2 ** (count - 1)));
}

export function canRemoveImportedLocalAsset(item) {
  return Boolean(item?.id && !item.reused);
}

export function shouldRemoveUploadJobLocalAsset(job) {
  return Boolean(job?.localAssetId && job.removeLocalOnDiscard && !job.assetId);
}
