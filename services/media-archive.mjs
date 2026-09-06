import path from 'node:path';

export function createMediaArchiveService({
  assertGenerationJobLease,
  findAsset,
  findGeneration,
  saveAsset,
  saveGenerationAsset,
  withMediaTempDir,
  generationAssetExtension,
  generationAssetName,
  generationSourceHeaders,
  assetObjectKey,
  download,
  put,
  remove,
  now,
}) {
  async function prepareGenerationAsset(userId, task, result) {
    const assetId = task.assetId || `generation-${task.id}`;
    const extension = generationAssetExtension(task);
    const existing = findAsset(userId, assetId);
    if (existing?.sourceGenerationId === task.id && existing.objectKey) return existing;
    const asset = {
      ...(existing || {}),
      id: assetId,
      ownerId: userId,
      name: existing?.name || generationAssetName(task, extension),
      kind: task.type,
      mimeType: existing?.mimeType || (task.type === 'image' ? 'image/png' : 'video/mp4'),
      size: Number(existing?.size) || 0,
      storageName: existing?.storageName || `${assetId}${extension}`,
      source: 'generation',
      sourceGenerationId: task.id,
      originDeviceId: String(task.originDeviceId || ''),
      originWorkspaceId: String(task.originWorkspaceId || ''),
      sourceUrl: result.url,
      sourceRequiresAuth: Boolean(result.requiresAuth),
      deliveryStatus: existing?.deliveryStatus === 'local_ready' ? 'local_ready' : 'awaiting_local',
      remoteStatus: existing?.objectKey ? 'ready' : 'pending',
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    await saveAsset(userId, asset);
    return asset;
  }

  async function archiveGenerationResult(userId, task, resultUrl, overrides = {}) {
    const downloadFile = overrides.download || download;
    const putFile = overrides.put || put;
    const removeFile = overrides.remove || remove;
    const leaseGuard = overrides.leaseGuard;
    assertGenerationJobLease(task, leaseGuard);
    const assetId = task.assetId || `generation-${task.id}`;
    const existing = findAsset(userId, assetId);
    if (existing?.sourceGenerationId === task.id && existing.objectKey) {
      task.assetId = assetId;
      task.status = 'completed';
      task.error = '';
      return;
    }
    return withMediaTempDir(`generation-${task.id}`, async jobDir => {
      const extension = generationAssetExtension(task);
      const storageName = `${assetId}${extension}`;
      const localFile = path.join(jobDir, storageName);
      const saved = await downloadFile(resultUrl, localFile, 4, { headers:generationSourceHeaders(task, resultUrl) });
      assertGenerationJobLease(task, leaseGuard);
      const beforeUpload = findAsset(userId, assetId);
      const currentTask = findGeneration(userId, task.id);
      if (beforeUpload?.deliveryStatus === 'local_ready' || currentTask?.localReadyAt) return;
      const objectKey = beforeUpload?.objectKey || assetObjectKey(userId, storageName);
      await putFile(objectKey, localFile, saved.contentType);
      try { assertGenerationJobLease(task, leaseGuard); }
      catch (error) {
        if (!beforeUpload?.objectKey) await removeFile(objectKey).catch(cleanupError => console.warn('[generation] 清理失效租约对象失败', { generationId:task.id, message:cleanupError.message }));
        throw error;
      }
      const latest = findAsset(userId, assetId);
      const latestTask = findGeneration(userId, task.id);
      if (latest?.deliveryStatus === 'local_ready' || latestTask?.localReadyAt) {
        if (!beforeUpload?.objectKey) await removeFile(objectKey).catch(error => console.warn('[generation] 清理并发归档对象失败', { generationId:task.id, message:error.message }));
        return;
      }
      const asset = {
        ...(latest || beforeUpload || existing || {}),
        id: assetId,
        ownerId: userId,
        name: latest?.name || beforeUpload?.name || existing?.name || generationAssetName(task, extension),
        kind: task.type,
        mimeType: saved.contentType,
        size: saved.size,
        storageName,
        source: 'generation',
        sourceGenerationId: task.id,
        sourceUrl: resultUrl,
        sourceRequiresAuth: Boolean(task.sourceRequiresAuth),
        originDeviceId: String(task.originDeviceId || ''),
        originWorkspaceId: String(task.originWorkspaceId || ''),
        deliveryStatus: 'remote_backed_up',
        remoteStatus: 'ready',
        objectKey,
        objectUploadedAt: now(),
        createdAt: latest?.createdAt || beforeUpload?.createdAt || existing?.createdAt || now(),
        updatedAt: now(),
      };
      try { saveGenerationAsset(userId, asset, task, leaseGuard); }
      catch (error) {
        if (error.code === 'GENERATION_JOB_LEASE_LOST' && !beforeUpload?.objectKey) await removeFile(objectKey).catch(cleanupError => console.warn('[generation] 清理失效租约对象失败', { generationId:task.id, message:cleanupError.message }));
        throw error;
      }
      task.assetId = assetId;
      task.status = 'completed';
      task.error = '';
    });
  }

  return Object.freeze({ prepareGenerationAsset, archiveGenerationResult });
}
