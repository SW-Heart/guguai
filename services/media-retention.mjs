// Cloud copies of media are transfer buffers, not storage. Users keep their
// files locally, so a cloud copy is deleted a few days after any device has
// saved it. Diagnostic logs and desktop installers live outside these rules.
const dayMs = 24 * 3600_000;

export const MEDIA_RETENTION_DEFAULTS = Object.freeze({
  localCopyMs: 6 * dayMs,
  undeliveredMs: 30 * dayMs,
  referenceMs: dayMs,
});

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

// Returns when the cloud copy of an asset may be deleted (ms since epoch).
// - Files the user uploaded came from their own computer: countdown starts at upload.
// - Anything the platform produced starts counting once a device saved it.
// - Output no device ever saved is kept longer, for that rare case only.
export function cloudCopyExpiresAt(asset, { localCopyMs = MEDIA_RETENTION_DEFAULTS.localCopyMs, undeliveredMs = MEDIA_RETENTION_DEFAULTS.undeliveredMs } = {}) {
  if (!asset?.objectKey) return null;
  const savedLocally = timestamp(asset.localReadyAt);
  if (savedLocally !== null) return savedLocally + localCopyMs;
  const uploadedAt = timestamp(asset.objectUploadedAt) ?? timestamp(asset.createdAt);
  if (uploadedAt === null) return null;
  return uploadedAt + (asset.source === 'upload' ? localCopyMs : undeliveredMs);
}

export function createMediaRetentionService({
  listAssetsWithObjects,
  saveAsset,
  deleteObject,
  removeServerCopy,
  activeReferenceAssetIds,
  listReferenceObjects,
  deleteReferenceObject,
  now = Date.now,
  localCopyMs = MEDIA_RETENTION_DEFAULTS.localCopyMs,
  undeliveredMs = MEDIA_RETENTION_DEFAULTS.undeliveredMs,
  referenceMs = MEDIA_RETENTION_DEFAULTS.referenceMs,
  pageSize = 500,
  logger = console,
} = {}) {
  for (const [name, dependency] of Object.entries({ listAssetsWithObjects, saveAsset, deleteObject, removeServerCopy, activeReferenceAssetIds })) {
    if (typeof dependency !== 'function') throw new TypeError(`媒体保留期服务缺少 ${name} 依赖`);
  }

  async function expireCloudCopy(userId, asset, at = now()) {
    const objectKey = asset.objectKey;
    await deleteObject(objectKey);
    await removeServerCopy(userId, asset);
    const expired = { ...asset, updatedAt:new Date(at).toISOString(), remoteExpiredAt:new Date(at).toISOString() };
    delete expired.objectKey;
    // Saved somewhere means the file still exists on that device; otherwise
    // the copy is gone for good and the client must not wait for it.
    expired.remoteStatus = expired.localReadyAt || expired.source === 'upload' ? 'local_only' : 'expired';
    await saveAsset(userId, expired);
    return { objectKey };
  }

  // `before` forces expiry of every cloud copy uploaded before that time,
  // used once to clear data stored before these rules existed.
  async function sweepExpiredAssets({ dryRun = false, before = null, limit = Infinity } = {}) {
    const at = now();
    const inUse = new Set(await activeReferenceAssetIds());
    const result = { scanned:0, expired:0, skippedInUse:0, failed:0, items:[] };
    let afterId = '';
    for (;;) {
      const page = listAssetsWithObjects({ afterId, limit:pageSize });
      if (!page.length) break;
      afterId = page.at(-1).id;
      for (const { userId, asset } of page) {
        result.scanned++;
        const expiresAt = cloudCopyExpiresAt(asset, { localCopyMs, undeliveredMs });
        const uploadedAt = timestamp(asset.objectUploadedAt) ?? timestamp(asset.createdAt);
        const due = (expiresAt !== null && expiresAt <= at) || (before !== null && uploadedAt !== null && uploadedAt < before);
        if (!due) continue;
        if (inUse.has(asset.id)) { result.skippedInUse++; continue; }
        if (result.expired >= limit) return result;
        result.items.push({ userId, assetId:asset.id, objectKey:asset.objectKey, size:Number(asset.size) || 0, kind:asset.kind });
        if (dryRun) { result.expired++; continue; }
        try {
          await expireCloudCopy(userId, asset, at);
          result.expired++;
        } catch (error) {
          result.failed++;
          logger.error?.('[retention] 云端副本删除失败', { assetId:asset.id, message:error.message });
        }
      }
    }
    return result;
  }

  // Reference images normally disappear an hour after use; this catches the
  // ones whose in-process timer was lost to a restart.
  async function sweepReferenceObjects({ dryRun = false } = {}) {
    if (typeof listReferenceObjects !== 'function' || typeof deleteReferenceObject !== 'function') return { deleted:0 };
    const cutoff = now() - referenceMs;
    let deleted = 0;
    for await (const object of listReferenceObjects()) {
      if (!(object.lastModified instanceof Date) || object.lastModified.getTime() > cutoff) continue;
      if (!dryRun) await deleteReferenceObject(object.key);
      deleted++;
    }
    return { deleted };
  }

  return Object.freeze({ sweepExpiredAssets, sweepReferenceObjects, expireCloudCopy });
}
