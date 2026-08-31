export function cloudAssetFromDesktopSync(result) {
  if (result?.cloudAsset?.id) return result.cloudAsset;
  if (result?.asset?.id) return result.asset;
  if (!result?.cloudAssetId) return null;
  return {
    ...result,
    id: result.cloudAssetId,
    url: result.remoteUrl || '',
  };
}

export function isRemoteReferenceReady(file) {
  return Boolean(file && !file.localOnly && (file.remoteStatus !== 'local_only' || file.referenceSourceAvailable));
}

export function canRemoveImportedLocalAsset(item) {
  return Boolean(item?.id && !item.reused);
}

export function shouldRemoveUploadJobLocalAsset(job) {
  return Boolean(job?.localAssetId && job.removeLocalOnDiscard && !job.assetId);
}
