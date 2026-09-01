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

export function shouldHydrateDesktopAsset(file) {
  return Boolean(file?.id && isAwaitingDesktopDelivery(file) && !file.localOnly && file.localStatus !== 'saved');
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
