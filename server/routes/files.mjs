import path from 'node:path';

export function createFilesRouteHandler({
  bodyJson,
  bodyBuffer,
  sendJson,
  serveFile,
  requireUser,
  requireDesktopWorkspaceScope,
  normalizeDeviceId,
  listAssetChanges,
  listPendingAssetDeliveries,
  findCloudAssets,
  markAssetDeliveryPending,
  publicAsset,
  parseLimit,
  encodeCursor,
  decodeCursor,
  findAsset,
  listAssets,
  setPageHeaders,
  supportLogStorageReady,
  supportLogRateAllowed,
  supportLogMime,
  supportLogMaxBytes,
  supportLogObjectKey,
  putSupportLogObject,
  appendSystemEvent,
  directUploadEnabled,
  r2Configured,
  uploadMaxPendingPerUser,
  uploadIntentExpiresSeconds,
  uploadUrlExpiresSeconds,
  uploadInitRateAllowed,
  countActiveUploadIntents,
  normalizeUploadMime,
  imageTypes,
  videoTypes,
  audioTypes,
  uploadSizeLimit,
  findAssetBySha256,
  uploadKind,
  randomId,
  pendingUploadKey,
  finalUploadKey,
  now,
  createUploadIntent,
  signedUploadUrl,
  findUploadIntent,
  expireUploadIntent,
  deleteObject,
  claimUploadIntent,
  verifyUploadedObject,
  promoteUploadedObject,
  uploadExtension,
  completeUploadIntentWithAsset,
  markUploadIntentFailed,
  assetFilesDir,
  assetPreviewCacheSeconds,
  fs,
  signedAssetUrl,
  localReadyBatchLimit,
  applyLocalReadyAcknowledgement,
  requestGenerationArchive,
  servePendingGenerationSource,
  safeId,
  saveAsset,
  findGeneration,
  activeGenerations,
  removeGenerationOutput,
  deleteAssetRecord,
} = {}) {
  return async function handleFilesRoute(req, res, url) {
    if (url.pathname === '/api/files/sync' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const deviceId = scope.deviceId || normalizeDeviceId(url.searchParams.get('deviceId'));
      if (!deviceId) { sendJson(res, 400, { error:'设备标识无效' }); return true; }
      const page = listAssetChanges(user.id, { deviceId, workspaceId:scope.workspaceId, cursor:url.searchParams.get('cursor'), limit:parseLimit(url.searchParams.get('limit')) });
      const requestedAssetIds = [...new Set(String(url.searchParams.get('assetIds') || '').split(',').map(safeId).filter(Boolean))].slice(0, 500);
      const deliveryLimit = Math.min(200, parseLimit(url.searchParams.get('limit')));
      const deliveryCursorScope = `delivery:${user.id}:${deviceId}:${scope.workspaceId}`;
      const before = decodeCursor(deliveryCursorScope, url.searchParams.get('deliveryCursor'));
      const pendingDeliveries = listPendingAssetDeliveries(user.id, deviceId, { workspaceId:scope.workspaceId, limit:deliveryLimit, before });
      const lastDelivery = pendingDeliveries.at(-1);
      const nextDeliveryCursor = lastDelivery ? encodeCursor(deliveryCursorScope, { t:lastDelivery.createdAt, i:lastDelivery.id }) : url.searchParams.get('deliveryCursor') || '';
      const requestedDeliveries = requestedAssetIds.length ? findCloudAssets(user.id, requestedAssetIds, { deviceId, workspaceId:scope.workspaceId }) : [];
      const deliveries = [...new Map([...pendingDeliveries, ...requestedDeliveries].map(asset => [asset.id, asset])).values()];
      deliveries.forEach(asset => markAssetDeliveryPending(user.id, deviceId, asset.id));
      sendJson(res, 200, {
        deviceId,
        changes:page.items.map(change => ({ seq:change.seq, action:change.action, assetId:change.assetId, asset:change.action === 'delete' ? null : publicAsset(change.asset) })),
        deliveries:deliveries.map(publicAsset),
        nextCursor:page.nextCursor,
        hasMore:page.hasMore,
        nextDeliveryCursor,
        deliveriesHasMore:pendingDeliveries.length === deliveryLimit,
      });
      return true;
    }
    const singleAssetMatch = url.pathname.match(/^\/api\/files\/([\w-]+)$/);
    if (singleAssetMatch && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const asset = findAsset(user.id, singleAssetMatch[1], scope);
      sendJson(res, asset ? 200 : 404, asset ? publicAsset(asset) : { error:'文件不存在' });
      return true;
    }
    if (url.pathname === '/api/files' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const cursor = url.searchParams.get('cursor');
      const page = listAssets(user.id, { kind:url.searchParams.get('kind'), search:url.searchParams.get('search'), deviceId:scope.deviceId, workspaceId:scope.workspaceId, limit:parseLimit(url.searchParams.get('limit')), cursor, includeTotal:!cursor || url.searchParams.get('includeTotal') === '1' });
      setPageHeaders(res, page);
      sendJson(res, 200, page.items.map(publicAsset));
      return true;
    }
    if (url.pathname === '/api/support/logs' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      if (!supportLogStorageReady) { sendJson(res, 503, { error:'诊断日志上传服务尚未配置' }); return true; }
      if (!supportLogRateAllowed(user.id)) { sendJson(res, 429, { error:'日志上传过于频繁，请稍后再试' }); return true; }
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== supportLogMime) { sendJson(res, 415, { error:'日志包必须以 application/gzip 提交' }); return true; }
      const bundle = await bodyBuffer(req, supportLogMaxBytes, `日志包不能超过 ${Math.round(supportLogMaxBytes / (1024 * 1024))} MB`);
      if (bundle.length < 3) { sendJson(res, 400, { error:'日志包为空' }); return true; }
      if (bundle[0] !== 0x1f || bundle[1] !== 0x8b) { sendJson(res, 415, { error:'日志包必须是 gzip 数据' }); return true; }
      const note = String(url.searchParams.get('note') || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, 500);
      const objectKey = supportLogObjectKey(user.id);
      await putSupportLogObject(objectKey, bundle);
      const event = appendSystemEvent({ level:'info', category:'client_log', userId:user.id, message:note || '客户端上传诊断日志', details:{ objectKey, size:bundle.length, note, username:user.username, appVersion:String(url.searchParams.get('version') || '').trim().slice(0, 40), platform:String(url.searchParams.get('platform') || '').trim().slice(0, 40), deviceId:normalizeDeviceId(url.searchParams.get('deviceId')), userAgent:String(req.headers['user-agent'] || '').slice(0, 300) } });
      sendJson(res, 201, { ok:true, reference:event.id.slice(0, 8), size:bundle.length, uploadedAt:event.createdAt });
      return true;
    }
    if (url.pathname === '/api/files/uploads/init' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      if (!directUploadEnabled || !r2Configured) { sendJson(res, 503, { error:'直传暂未启用' }); return true; }
      if (!uploadInitRateAllowed(user.id)) { sendJson(res, 429, { error:'上传请求过于频繁，请稍后再试' }); return true; }
      if (countActiveUploadIntents(user.id) >= uploadMaxPendingPerUser) { sendJson(res, 429, { error:'未完成上传数量过多，请先完成或稍后重试' }); return true; }
      const input = await bodyJson(req, 32_000);
      const mimeType = normalizeUploadMime(input.mimeType, input.name);
      if (![...imageTypes, ...videoTypes, ...audioTypes].includes(mimeType)) { sendJson(res, 415, { error:'只支持 PNG、JPEG、WebP、MP4、WebM、MOV 或音频文件' }); return true; }
      const size = Number(input.size);
      const sizeLimit = uploadSizeLimit(mimeType);
      if (!Number.isSafeInteger(size) || size <= 0) { sendJson(res, 400, { error:'文件大小无效' }); return true; }
      if (size > sizeLimit) { sendJson(res, 413, { error:imageTypes.has(mimeType) ? '单张图片不能超过 20 MB' : '视频或音频不能超过 25 MB' }); return true; }
      const name = String(input.name || 'file').replace(/[\r\n\u0000-\u001f]/g, '').trim().slice(0, 160) || 'file';
      const suppliedHash = input.sha256 === undefined || input.sha256 === null || input.sha256 === '' ? '' : String(input.sha256).trim().toLowerCase();
      if (suppliedHash && !/^[a-f0-9]{64}$/.test(suppliedHash)) { sendJson(res, 400, { error:'sha256 格式无效' }); return true; }
      if (suppliedHash) {
        const existingAsset = findAssetBySha256(user.id, suppliedHash, size, { requireRemote:true, deviceId:scope.deviceId, workspaceId:scope.workspaceId });
        if (existingAsset && existingAsset.mimeType === mimeType && existingAsset.kind === uploadKind(mimeType)) { sendJson(res, 200, { mode:'reuse', asset:publicAsset(existingAsset), sha256:suppliedHash }); return true; }
      }
      const uploadId = randomId();
      const assetId = randomId();
      const createdAt = now();
      const expiresAt = new Date(Date.now() + Math.min(uploadIntentExpiresSeconds, uploadUrlExpiresSeconds) * 1000).toISOString();
      const intent = { id:uploadId, userId:user.id, assetId, temporaryObjectKey:pendingUploadKey(user.id, uploadId, mimeType, name), finalObjectKey:finalUploadKey(user.id, assetId, mimeType, name), name, kind:uploadKind(mimeType), mimeType, expectedSize:size, sha256:suppliedHash || null, clientWidth:imageTypes.has(mimeType) ? Math.max(0, Math.min(100000, Math.round(Number(input.width) || 0))) || null : null, clientHeight:imageTypes.has(mimeType) ? Math.max(0, Math.min(100000, Math.round(Number(input.height) || 0))) || null : null, status:'pending', expiresAt, createdAt, updatedAt:createdAt };
      createUploadIntent(intent);
      const uploadUrl = await signedUploadUrl(intent.temporaryObjectKey, mimeType, Math.min(uploadIntentExpiresSeconds, uploadUrlExpiresSeconds));
      sendJson(res, 201, { uploadId, assetId, method:'PUT', uploadUrl, headers:{ 'Content-Type':mimeType }, expiresAt });
      return true;
    }
    const uploadStatusMatch = url.pathname.match(/^\/api\/files\/uploads\/([\w-]+)$/);
    if (uploadStatusMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const intent = findUploadIntent(user.id, uploadStatusMatch[1]);
      if (!intent) { sendJson(res, 404, { error:'上传任务不存在' }); return true; }
      const asset = intent.status === 'completed' ? findAsset(user.id, intent.assetId, scope) : null;
      sendJson(res, 200, { uploadId:intent.id, assetId:intent.assetId, status:intent.status, expiresAt:intent.expiresAt, asset:asset ? publicAsset(asset) : null });
      return true;
    }
    const uploadCompleteMatch = url.pathname.match(/^\/api\/files\/uploads\/([\w-]+)\/complete$/);
    if (uploadCompleteMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      if (!directUploadEnabled || !r2Configured) { sendJson(res, 503, { error:'直传暂未启用' }); return true; }
      const uploadId = uploadCompleteMatch[1];
      const existing = findUploadIntent(user.id, uploadId);
      if (!existing) { sendJson(res, 404, { error:'上传任务不存在' }); return true; }
      if (existing.status === 'completed') {
        const asset = findAsset(user.id, existing.assetId, scope);
        sendJson(res, asset ? 200 : 409, asset ? publicAsset(asset) : { error:'上传记录不完整，请联系支持' });
        return true;
      }
      if (existing.status === 'expired') { sendJson(res, 410, { error:'上传凭证已过期，请重新选择文件' }); return true; }
      if (existing.status === 'failed') { sendJson(res, 422, { error:'上传文件验证失败，请重新选择文件' }); return true; }
      const nowIso = now();
      if (existing.expiresAt <= nowIso) {
        const expired = expireUploadIntent(user.id, uploadId, nowIso);
        if (expired) await deleteObject(expired.temporaryObjectKey).catch(error => console.warn(`[upload] 清理过期 pending 失败 uploadId=${uploadId}`, error.message));
        sendJson(res, 410, { error:'上传凭证已过期，请重新选择文件' });
        return true;
      }
      if (!claimUploadIntent(user.id, uploadId, nowIso)) {
        const current = findUploadIntent(user.id, uploadId);
        if (current?.status === 'completed') {
          const asset = findAsset(user.id, current.assetId, scope);
          sendJson(res, asset ? 200 : 409, asset ? publicAsset(asset) : { error:'上传记录不完整，请联系支持' });
          return true;
        }
        sendJson(res, 202, { uploadId, assetId:existing.assetId, status:current?.status || 'verifying' });
        return true;
      }
      const intent = findUploadIntent(user.id, uploadId);
      let meta;
      try {
        meta = await verifyUploadedObject(intent);
        const finalMeta = await promoteUploadedObject(intent);
        const extension = uploadExtension(intent.mimeType, intent.name);
        const asset = { id:intent.assetId, ownerId:user.id, name:intent.name, kind:intent.kind, mimeType:intent.mimeType, size:meta.size, ...(intent.sha256 ? { sha256:intent.sha256 } : {}), storageName:`${intent.assetId}${extension}`, source:'upload', sourceGenerationId:'', sourceUrl:'', objectKey:intent.finalObjectKey, objectUploadedAt:nowIso, ...(scope.desktop ? { originDeviceId:scope.deviceId, originWorkspaceId:scope.workspaceId } : {}), ...(intent.kind === 'image' && intent.clientWidth && intent.clientHeight ? { width:intent.clientWidth, height:intent.clientHeight } : {}), createdAt:nowIso, updatedAt:nowIso };
        completeUploadIntentWithAsset(user.id, uploadId, { actualSize:finalMeta.size || meta.size, objectEtag:finalMeta.etag || meta.etag, asset, nowIso });
        await deleteObject(intent.temporaryObjectKey).catch(error => console.warn(`[upload] 清理 pending 失败 uploadId=${uploadId}`, error.message));
        sendJson(res, 201, publicAsset(asset));
      } catch (error) {
        const code = error.code || 'UPLOAD_VERIFY_FAILED';
        if (code.startsWith('UPLOAD_')) {
          markUploadIntentFailed(user.id, uploadId, { errorCode:code, actualSize:error.actualSize ?? meta?.size ?? null, objectEtag:error.objectEtag ?? meta?.etag ?? null, nowIso:now() });
          await deleteObject(intent.temporaryObjectKey).catch(() => {});
          sendJson(res, error.statusCode || 422, { error:error.message || '上传文件验证失败', code });
        } else throw Object.assign(new Error(`上传文件归档失败：${error.message}`), { statusCode:502, cause:error });
      }
      return true;
    }
    const assetPreviewMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/preview$/);
    if (assetPreviewMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const asset = findAsset(user.id, assetPreviewMatch[1], scope);
      if (!asset) { sendJson(res, 404, { error:'文件不存在' }); return true; }
      if (asset.kind !== 'image') { sendJson(res, 415, { error:'只有图片支持缩略图预览' }); return true; }
      const localFile = path.join(assetFilesDir(user.id), asset.storageName);
      if (await fs.access(localFile).then(() => true).catch(() => false)) { serveFile(res, localFile, asset.mimeType, `private, max-age=${assetPreviewCacheSeconds}`); return true; }
      if (asset.objectKey) { const previewUrl = await signedAssetUrl(asset.objectKey, assetPreviewCacheSeconds + 60, { cacheControl:`private, max-age=${assetPreviewCacheSeconds}` }); res.writeHead(302, { Location:previewUrl, 'Cache-Control':`private, max-age=${assetPreviewCacheSeconds}` }); res.end(); return true; }
      sendJson(res, 404, { error:'文件内容不存在' });
      return true;
    }
    if (url.pathname === '/api/files/local-ready' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const input = await bodyJson(req);
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length) { sendJson(res, 400, { error:'缺少本地接收确认条目' }); return true; }
      if (items.length > localReadyBatchLimit) { sendJson(res, 400, { error:`单次最多确认 ${localReadyBatchLimit} 个素材` }); return true; }
      const deviceId = scope.deviceId || normalizeDeviceId(input.deviceId);
      const results = [];
      for (const item of items) {
        const assetId = safeId(item?.id);
        const asset = assetId ? findAsset(user.id, assetId, scope) : null;
        if (!asset) { results.push({ id:String(item?.id || ''), ok:false, error:'文件不存在' }); continue; }
        const outcome = await applyLocalReadyAcknowledgement(user.id, asset, { ...item, deviceId });
        results.push(outcome.error ? { id:asset.id, ok:false, error:outcome.error } : { id:asset.id, ok:true });
      }
      sendJson(res, 200, { deviceId, acknowledged:results.filter(result => result.ok).length, results });
      return true;
    }
    const archiveMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/archive$/);
    if (archiveMatch && req.method === 'POST') {
      const user = requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const asset = findAsset(user.id, archiveMatch[1], scope);
      if (!asset) { sendJson(res, 404, { error:'文件不存在' }); return true; }
      const outcome = requestGenerationArchive(user.id, asset);
      sendJson(res, outcome.error ? 409 : 200, outcome);
      return true;
    }
    const localReadyMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/local-ready$/);
    if (localReadyMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const input = await bodyJson(req);
      const asset = findAsset(user.id, localReadyMatch[1], scope);
      if (!asset) { sendJson(res, 404, { error:'文件不存在' }); return true; }
      const outcome = await applyLocalReadyAcknowledgement(user.id, asset, { ...input, deviceId:scope.deviceId || normalizeDeviceId(input.deviceId) });
      if (outcome.error) { sendJson(res, outcome.status, { error:outcome.error }); return true; }
      sendJson(res, 200, publicAsset(outcome.asset));
      return true;
    }
    const directMediaMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/direct$/);
    if (directMediaMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const asset = findAsset(user.id, directMediaMatch[1], scope);
      if (!asset) { sendJson(res, 404, { error:'文件不存在' }); return true; }
      const localFile = path.join(assetFilesDir(user.id), asset.storageName);
      if (await fs.access(localFile).then(() => true).catch(() => false)) { res.writeHead(302, { Location:`/api/files/${asset.id}/content`, 'Cache-Control':'private, no-store' }); res.end(); return true; }
      if (asset.objectKey) { res.writeHead(302, { Location:await signedAssetUrl(asset.objectKey), 'Cache-Control':'private, no-store' }); res.end(); return true; }
      if (await servePendingGenerationSource(res, asset)) return true;
      sendJson(res, 404, { error:'文件内容不存在' });
      return true;
    }
    const fileMatch = url.pathname.match(/^\/api\/files\/([\w-]+)(?:\/(content))?$/);
    if (fileMatch) {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const asset = findAsset(user.id, fileMatch[1], scope);
      if (!asset) { sendJson(res, 404, { error:'文件不存在' }); return true; }
      if (req.method === 'GET' && fileMatch[2]) {
        const localFile = path.join(assetFilesDir(user.id), asset.storageName);
        if (await fs.access(localFile).then(() => true).catch(() => false)) { serveFile(res, localFile, asset.mimeType); return true; }
        if (asset.objectKey) { res.writeHead(302, { Location:await signedAssetUrl(asset.objectKey), 'Cache-Control':'private, no-store' }); res.end(); return true; }
        if (await servePendingGenerationSource(res, asset)) return true;
        sendJson(res, 404, { error:'文件内容不存在' });
        return true;
      }
      if (req.method === 'PATCH' && !fileMatch[2]) {
        const input = await bodyJson(req);
        const name = String(input.name || '').trim().replace(/[\r\n]/g, '').slice(0, 160);
        if (!name) { sendJson(res, 400, { error:'文件名不能为空' }); return true; }
        asset.name = name;
        await saveAsset(user.id, asset);
        sendJson(res, 200, publicAsset(asset));
        return true;
      }
      if (req.method === 'DELETE' && !fileMatch[2]) {
        const task = asset.sourceGenerationId ? findGeneration(user.id, asset.sourceGenerationId, scope) : null;
        if (task) {
          if (activeGenerations.has(task.id) || ['queued', 'running'].includes(task.status)) { sendJson(res, 409, { error:'任务正在生成中，完成后才能删除' }); return true; }
          const deleted = await removeGenerationOutput(user.id, task);
          sendJson(res, 200, { ok:true, ...deleted });
          return true;
        }
        await deleteAssetRecord(user.id, asset);
        sendJson(res, 200, { ok:true, deletedAssetId:asset.id });
        return true;
      }
    }
    return false;
  };
}
