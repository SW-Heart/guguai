export function cloudAssetFromDesktopSync(result) {
  return result?.cloudAsset?.id ? result.cloudAsset : null;
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

export function canRemoveImportedLocalAsset(item) {
  return Boolean(item?.id && !item.reused);
}

export function shouldRemoveUploadJobLocalAsset(job) {
  return Boolean(job?.localAssetId && job.removeLocalOnDiscard && !job.assetId);
}
