export function createGenerationRouteHandler({
  bodyJson,
  sendJson,
  requireUser,
  requireDesktopWorkspaceScope,
  findGeneration,
  listGenerations,
  setPageHeaders,
  parseLimit,
  safeId,
  publicGeneration,
  publicDramaProject,
  loadDramaProject,
  validateVideoRequest,
  validateReferenceAssets,
  referenceAssetCounts,
  normalizeQuoteReferenceCounts,
  assertReferenceCountsWithinLimits,
  selectModelRoute,
  publicRoutePriceVersion,
  currentPricing,
  pricingSnapshot,
  staticPriceVersion,
  creditsToMicro,
  charLength,
  walletOf,
  chargeGenerationMicro,
  chargeGenerationBatchMicro,
  createGenerationRequest,
  findGenerationRequest,
  generationRequestFingerprint,
  enqueueGenerationJob,
  saveGeneration,
  failGeneration,
  saveDramaProject,
  ensureUserDirs,
  randomId,
  now,
  resolveVideoPrompt,
  buildShotVideoPrompt,
  isModelEnabled,
  fixedModels,
  imageSizes,
  videoModelIds,
  legacyVideoModelIds,
  storyboardEngineVersion,
  r2ReferenceConfigured,
  r2ReferencePublicBaseUrl,
  providerAvailability,
  runtimeMetrics,
  activeGenerations,
}) {
  function providerReady(provider, type, videoRequest) {
    if (provider === 'duomi') return providerAvailability.duomi;
    if (provider === 'ttapi') return providerAvailability.ttapi;
    if (provider === 'cntcn') return providerAvailability.cntcn;
    if (provider === 'autodl') return providerAvailability.autodl;
    if (provider === 'oai') {
      if (videoRequest?.modelId === videoModelIds.VEO_31) return providerAvailability.oaiVeo;
      if (videoRequest?.modelId === videoModelIds.MINIMAX_H3) return providerAvailability.oaiMinimax;
      return providerAvailability.oai;
    }
    return type === 'image' ? providerAvailability.duomi : true;
  }

  async function handleModelQuote(req, res, url) {
    if (url.pathname !== '/api/model-quote' || req.method !== 'POST') return false;
    const user = await requireUser(req, res); if (!user) return true;
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    const input = await bodyJson(req);
    const requestedReferenceCount = Array.isArray(input.referenceAssetIds)
      ? new Set(input.referenceAssetIds.map(safeId).filter(Boolean)).size
      : 0;
    const suppliedReferenceCounts = normalizeQuoteReferenceCounts(input.referenceCounts);
    const suppliedReferenceCount = Object.values(suppliedReferenceCounts).reduce((sum, count) => sum + count, 0);
    const generationType = String(input.generationType || '').toUpperCase();
    const quoteReferenceCount = requestedReferenceCount || suppliedReferenceCount || (['REFERENCE', 'FIRST&LAST'].includes(generationType) ? 1 : 0);
    const request = validateVideoRequest(input, quoteReferenceCount);
    const referenceAssetIds = await validateReferenceAssets(user.id, input.referenceAssetIds, request.referenceLimits, { requireReadable:false, scope });
    const quotedReferenceCounts = referenceAssetIds.length ? referenceAssetCounts(user.id, referenceAssetIds, scope) : suppliedReferenceCounts;
    assertReferenceCountsWithinLimits(quotedReferenceCounts, request.referenceLimits);
    const route = request.provider === 'route'
      ? selectModelRoute({ logicalModelId:request.modelId, quality:request.quality, duration:request.duration, aspectRatio:request.aspectRatio, referenceCounts:quotedReferenceCounts })
      : null;
    if (request.provider === 'route' && !route) return sendJson(res, 503, { error:'当前模型暂不可用，请稍后重试' }), true;
    if (route) {
      const displayRoute = request.modelId === videoModelIds.SEEDANCE_2
        ? selectModelRoute({ logicalModelId:request.modelId, quality:request.quality, duration:request.duration, aspectRatio:request.aspectRatio, referenceCounts:{} })
        : route;
      const visiblePrice = displayRoute || route;
      return sendJson(res, 200, { modelId:request.modelId, quality:request.quality, duration:request.duration, aspectRatio:request.aspectRatio, available:true, credits:visiblePrice.salePriceCredits, yuan:visiblePrice.salePriceYuan, priceVersion:publicRoutePriceVersion(route) }), true;
    }
    const selectedPricing = request.pricingByQuality?.[request.quality] || request.pricing;
    const credits = selectedPricing?.unit === 'second' ? Number(selectedPricing.amount) * request.duration : currentPricing().videoPerSecond * request.duration;
    return sendJson(res, 200, { modelId:request.modelId, quality:request.quality, duration:request.duration, aspectRatio:request.aspectRatio, available:true, credits, yuan:credits * 0.1, priceVersion:staticPriceVersion(request) }), true;
  }

  async function handleGenerations(req, res, url) {
    if (url.pathname === '/api/generations' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      if (url.searchParams.has('ids')) {
        const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map(safeId).filter(Boolean))].slice(0, 200);
        return sendJson(res, 200, ids.map(id => findGeneration(user.id, id, scope)).filter(Boolean).map(publicGeneration)), true;
      }
      const view = String(url.searchParams.get('view') || 'all').trim().toLowerCase();
      if (!['all', 'works', 'history'].includes(view)) return sendJson(res, 400, { error:'生成记录视图无效' }), true;
      const cursor = url.searchParams.get('cursor');
      const page = listGenerations(user.id, { type:url.searchParams.get('type'), view, deviceId:scope.deviceId, workspaceId:scope.workspaceId, limit:parseLimit(url.searchParams.get('limit')), cursor, includeTotal:!cursor || url.searchParams.get('includeTotal') === '1' });
      setPageHeaders(res, page);
      return sendJson(res, 200, page.items.map(publicGeneration)), true;
    }
    if (url.pathname === '/api/generations/references/complete' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const input = await bodyJson(req);
      const taskIds = [...new Set((Array.isArray(input.taskIds) ? input.taskIds : []).map(safeId).filter(Boolean))];
      if (!taskIds.length || taskIds.length > 10) return sendJson(res, 400, { error:'待启动生成任务无效' }), true;
      const tasks = taskIds.map(id => findGeneration(user.id, id, scope));
      if (tasks.some(task => !task || !task.awaitingReferences || task.status !== 'queued')) return sendJson(res, 409, { error:'生成任务已启动或不再等待素材' }), true;
      const first = tasks[0];
      if (tasks.some(task => task.type !== first.type || task.requestId !== first.requestId)) return sendJson(res, 400, { error:'待启动生成任务不属于同一批次' }), true;
      const referenceAssetIds = await validateReferenceAssets(user.id, input.referenceAssetIds, first.referenceLimits, { scope });
      const actualCounts = referenceAssetCounts(user.id, referenceAssetIds, scope);
      const expectedCounts = normalizeQuoteReferenceCounts(first.expectedReferenceCounts);
      if (['image','video','audio'].some(kind => actualCounts[kind] !== expectedCounts[kind])) return sendJson(res, 409, { error:'上传后的素材类型或数量与扣费时不一致，请重新生成' }), true;
      for (const task of tasks) {
        task.referenceAssetIds = referenceAssetIds;
        task.awaitingReferences = false;
        task.progressStage = 'submitting';
        saveGeneration(user.id, task);
        enqueueGenerationJob({ userId:user.id, generationId:task.id });
      }
      return sendJson(res, 202, { tasks:tasks.map(publicGeneration), balance:walletOf(user.id).balance }), true;
    }
    if (url.pathname === '/api/generations/references/cancel' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const input = await bodyJson(req);
      const taskIds = [...new Set((Array.isArray(input.taskIds) ? input.taskIds : []).map(safeId).filter(Boolean))];
      if (!taskIds.length || taskIds.length > 10) return sendJson(res, 400, { error:'待取消生成任务无效' }), true;
      const tasks = taskIds.map(id => findGeneration(user.id, id, scope)).filter(task => task?.awaitingReferences && task.status === 'queued');
      for (const task of tasks) {
        task.awaitingReferences = false;
        await failGeneration(user.id, task, new Error(String(input.error || '素材准备失败').slice(0, 300)));
        task.finishedAt = now();
        saveGeneration(user.id, task);
      }
      return sendJson(res, 200, { tasks:tasks.map(publicGeneration), balance:walletOf(user.id).balance }), true;
    }
    const generationMatch = url.pathname.match(/^\/api\/generations\/([\w-]+)$/);
    if (generationMatch && req.method === 'DELETE') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      return sendJson(res, 405, { error:'生成日志不可删除', code:'GENERATION_LOG_IMMUTABLE' }), true;
    }
    return false;
  }

  async function handleGenerationSubmit(req, res) {
    const user = await requireUser(req, res); if (!user) return true;
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    const input = await bodyJson(req); const type = input.type;
    const headerRequestId = String(req.headers['idempotency-key'] || '').trim();
    const bodyRequestId = String(input.requestId || '').trim();
    if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) return sendJson(res, 400, { error:'请求幂等键不一致' }), true;
    const generationRequestId = headerRequestId || bodyRequestId;
    if (generationRequestId && !/^[a-zA-Z0-9_-]{8,80}$/.test(generationRequestId)) return sendJson(res, 400, { error:'生成请求 ID 无效' }), true;
    const requestInput = { ...input };
    delete requestInput.requestId;
    delete requestInput.expectedPriceVersion;
    const requestFingerprint = generationRequestId ? generationRequestFingerprint({ version:2, input:requestInput, scope:{ deviceId:scope.deviceId, workspaceId:scope.workspaceId } }) : '';
    const storedRequest = generationRequestId ? findGenerationRequest(user.id, generationRequestId) : null;
    if (storedRequest) {
      if (storedRequest.requestHash !== requestFingerprint) {
        runtimeMetrics.idempotencyConflicts++;
        return sendJson(res, 409, { error:'同一个幂等键不能用于不同请求', code:'IDEMPOTENCY_KEY_REUSED' }), true;
      }
      const replayTasks = storedRequest.generationIds.map(id => findGeneration(user.id, id, scope));
      if (replayTasks.some(task => !task)) return sendJson(res, 409, { error:'重复生成请求的任务记录不完整，请联系支持' }), true;
      const replayProjectId = replayTasks[0]?.dramaProjectId;
      const replayProject = replayProjectId ? await loadDramaProject(user.id, replayProjectId, scope) : null;
      const replayProjectData = replayProject ? { project:publicDramaProject(replayProject) } : {};
      const wallet = walletOf(user.id);
      if (replayTasks.length === 1) return sendJson(res, 202, { ...publicGeneration(replayTasks[0]), balance:wallet.balance, ...replayProjectData }), true;
      return sendJson(res, 202, { tasks:replayTasks.map(publicGeneration), quantity:replayTasks.length, balance:wallet.balance, ...replayProjectData }), true;
    }
    if (!['image','video'].includes(type)) return sendJson(res, 400, { error:'只支持图片或视频生成' }), true;
    let prompt = String(input.prompt ?? '');
    await ensureUserDirs(user.id);
    let dramaProjectId = ''; let dramaShotId = ''; let dramaProject = null; let dramaShot = null;
    if (type === 'video' && input.dramaProjectId && input.dramaShotId) {
      dramaProjectId = safeId(input.dramaProjectId); dramaShotId = safeId(input.dramaShotId);
      dramaProject = await loadDramaProject(user.id, dramaProjectId, scope);
      dramaShot = dramaProject?.shots.find(shot => shot.id === dramaShotId);
      if (!dramaProject || !dramaShot) return sendJson(res, 404, { error:'短剧项目或分镜不存在' }), true;
      if (dramaProject.workflowVersion >= storyboardEngineVersion && !dramaProject.productionQuality?.passed) {
        const first = dramaProject.productionQuality?.gates?.find(gate => !gate.ok)?.problems?.[0] || '分镜方案未通过质量检查';
        return sendJson(res, 409, { error:`不能生成视频：${first}` }), true;
      }
      if (!prompt.trim()) {
        const scene = dramaProject.scenes.find(item => item.id === dramaShot.sceneId);
        const resources = (dramaShot.resourceIds || []).map(id => dramaProject.resources.find(item => item.id === id)).filter(Boolean);
        prompt = resolveVideoPrompt(prompt, buildShotVideoPrompt({ project:dramaProject, shot:dramaShot, scene, resources }));
      }
    }
    if (!prompt.trim()) return sendJson(res, 400, { error:'请输入提示词' }), true;
    const requestedVideoModelId = String(input.modelId ?? input.videoModel ?? '').trim().toLowerCase();
    const promptMaxLength = type === 'image' ? 5000 : [videoModelIds.MINIMAX_H3_15S, legacyVideoModelIds.GUGU_2].includes(requestedVideoModelId) ? 10000 : 4096;
    if (charLength(prompt) > promptMaxLength) return sendJson(res, 400, { error:`${type === 'image' ? '图片' : '视频'}提示词不能超过 ${promptMaxLength} 个字符` }), true;
    if (type === 'video' && !dramaProjectId && !String(input.modelId ?? input.videoModel ?? '').trim()) return sendJson(res, 400, { error:'请选择视频模型' }), true;
    if (type === 'video' && dramaShot) {
      const requestedDuration = Number(input.duration ?? dramaShot.duration);
      if (!Number.isFinite(requestedDuration) || requestedDuration !== Number(dramaShot.duration)) return sendJson(res, 409, { error:`分镜时长已保存为 ${dramaShot.duration} 秒，请刷新页面后再生成` }), true;
      input.duration = Number(dramaShot.duration);
    }
    const size = type === 'image' ? String(input.size || '16:9') : null;
    if (type === 'image' && !imageSizes.has(size)) return sendJson(res, 400, { error:'不支持的图片比例' }), true;
    const requestedReferenceCount = Array.isArray(input.referenceAssetIds) ? new Set(input.referenceAssetIds.map(safeId).filter(Boolean)).size : 0;
    const suppliedReferenceCounts = normalizeQuoteReferenceCounts(input.referenceCounts);
    const suppliedReferenceCount = Object.values(suppliedReferenceCounts).reduce((sum, count) => sum + count, 0);
    const deferredReferences = Boolean(input.deferReferenceUpload) && requestedReferenceCount === 0 && suppliedReferenceCount > 0;
    let aspectRatio = null; let duration = null; let videoRequest = null;
    if (type === 'video') { videoRequest = validateVideoRequest(input, requestedReferenceCount || suppliedReferenceCount); aspectRatio = videoRequest.aspectRatio; duration = videoRequest.duration; }
    const referenceAssetIds = deferredReferences ? [] : await validateReferenceAssets(user.id, input.referenceAssetIds, videoRequest?.referenceLimits, { scope });
    const referenceCounts = deferredReferences ? suppliedReferenceCounts : referenceAssetCounts(user.id, referenceAssetIds, scope);
    assertReferenceCountsWithinLimits(referenceCounts, videoRequest?.referenceLimits);
    if (referenceCounts.image && !r2ReferenceConfigured) return sendJson(res, 503, { error:`${type === 'image' ? '图生图' : '图生视频'}参考图片暂时不可用，请稍后重试或联系支持` }), true;
    const modelId = type === 'image' ? fixedModels.image : videoRequest.modelId;
    if (!isModelEnabled(modelId)) return sendJson(res, 503, { error:'当前模型暂不可用' }), true;
    const routeSelection = type === 'video' && videoRequest.provider === 'route' ? selectModelRoute({ logicalModelId:modelId, quality:videoRequest.quality, duration, aspectRatio, referenceCounts }) : null;
    if (type === 'video' && videoRequest.provider === 'route' && !routeSelection) return sendJson(res, 503, { error:'当前模型暂不可用，请稍后重试' }), true;
    const provider = type === 'image' ? 'duomi' : routeSelection?.provider || videoRequest.provider;
    if (type === 'video' && referenceCounts.image && !r2ReferencePublicBaseUrl) return sendJson(res, 503, { error:'图生视频参考图片暂时不可用，请稍后重试或联系支持' }), true;
    if (!providerReady(provider, type, videoRequest)) return sendJson(res, 503, { error:provider === 'cntcn' ? `${type === 'image' ? '图片' : '视频'}生成服务尚未配置` : '视频生成服务尚未配置' }), true;
    const pricing = currentPricing();
    const pricingForTask = type === 'video' && videoRequest.pricing?.unit === 'second' ? { ...pricing, videoPerSecondMicro:creditsToMicro(videoRequest.pricing.amount) } : pricing;
    const quantity = input.quantity === undefined ? 1 : Number(input.quantity);
    const maxQuantity = type === 'image' ? 10 : 4;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxQuantity) return sendJson(res, 400, { error:`${type === 'image' ? '图片' : '视频'}生成数量需为 1–${maxQuantity} 的整数` }), true;
    const taskIds = generationRequestId ? Array.from({ length:quantity }, (_, index) => quantity === 1 ? generationRequestId : `${generationRequestId}-${index + 1}`) : Array.from({ length:quantity }, () => randomId());
    const bindDramaTasks = Boolean(dramaProject && dramaShot && input.quantity !== undefined);
    const pricingSnapshotValue = routeSelection
      ? { version:pricing.version, contentType:type, billingUnit:'request', quantity:1, unitPriceMicro:routeSelection.salePriceMicro, totalMicro:routeSelection.salePriceMicro, unitPrice:routeSelection.salePriceCredits, total:routeSelection.salePriceCredits, routeId:routeSelection.id, routeVersion:routeSelection.version, upstreamModelId:routeSelection.upstreamModelId, costYuan:routeSelection.costYuan, markupPercent:20, salePriceYuan:routeSelection.salePriceYuan, priceVersion:publicRoutePriceVersion(routeSelection) }
      : pricingSnapshot(pricingForTask, type, type === 'video' ? duration : 1);
    if (routeSelection && input.expectedPriceVersion && input.expectedPriceVersion !== pricingSnapshotValue.priceVersion) return sendJson(res, 409, { error:'当前价格已变化，请刷新价格后重试', code:'PRICE_CHANGED', price:{ credits:pricingSnapshotValue.total, yuan:pricingSnapshotValue.salePriceYuan, priceVersion:pricingSnapshotValue.priceVersion } }), true;
    const batchId = quantity > 1 ? randomId() : '';
    const tasks = Array.from({ length:quantity }, (_, index) => ({
      id:taskIds[index], ownerId:user.id, originDeviceId:scope.deviceId, originWorkspaceId:scope.workspaceId, type, prompt, referenceAssetIds, provider,
      model:type === 'video' ? routeSelection?.upstreamModelId || videoRequest.model : fixedModels.image, modelId, size,
      quality:type === 'image' ? String(input.quality || 'medium') : videoRequest.quality, aspectRatio, duration,
      ...(type === 'video' ? { videoModelId:videoRequest.modelId, generationType:videoRequest.generationType, videoProfile:videoRequest.profileKey, maxReferenceImages:videoRequest.maxImages, referenceLimits:routeSelection ? { image:routeSelection.capabilities.image, video:routeSelection.capabilities.video, audio:routeSelection.capabilities.audio, total:routeSelection.capabilities.image + routeSelection.capabilities.video + routeSelection.capabilities.audio } : videoRequest.referenceLimits, dramaProjectId, dramaShotId } : {}),
      ...(routeSelection ? { routeId:routeSelection.id, routeVersion:routeSelection.version, routeDisplayName:routeSelection.displayName, routeAdapter:routeSelection.adapterType, routeBaseUrl:routeSelection.baseUrl, routeCredentialId:routeSelection.credentialId } : {}),
      ...(generationRequestId ? { requestId:generationRequestId } : {}), ...(requestFingerprint ? { requestFingerprint } : {}), ...(quantity > 1 ? { batchId:generationRequestId || batchId, batchIndex:index + 1, batchSize:quantity } : {}),
      creditCost:pricingSnapshotValue.total, creditCostMicro:pricingSnapshotValue.totalMicro, pricingVersion:pricingSnapshotValue.version, pricingSnapshot:pricingSnapshotValue,
      creditStatus:'charged', status:'queued', providerTaskId:'', assetId:'', error:'', ...(deferredReferences ? { awaitingReferences:true, expectedReferenceCounts:referenceCounts, progressStage:'preparing_references' } : {}), createdAt:now(), updatedAt:now(), finishedAt:null,
    }));
    const existingTasks = tasks.map(task => findGeneration(user.id, task.id, scope));
    if (existingTasks.some(Boolean)) {
      if (!existingTasks.every(Boolean)) return sendJson(res, 409, { error:'重复生成请求的任务记录不完整，请联系支持' }), true;
      if (requestFingerprint && existingTasks.some(task => task.requestFingerprint && task.requestFingerprint !== requestFingerprint)) return sendJson(res, 409, { error:'同一个幂等键不能用于不同请求', code:'IDEMPOTENCY_KEY_REUSED' }), true;
      if (bindDramaTasks) { for (const task of existingTasks) if (!dramaShot.videoVersions.includes(task.id)) dramaShot.videoVersions.push(task.id); dramaShot.selectedVideoTaskId = existingTasks.at(-1).id; await saveDramaProject(user.id, dramaProject); }
      const boundProject = bindDramaTasks ? { project:publicDramaProject(dramaProject) } : {};
      if (quantity === 1) return sendJson(res, 202, { ...publicGeneration(existingTasks[0]), balance:walletOf(user.id).balance, ...boundProject }), true;
      return sendJson(res, 202, { tasks:existingTasks.map(publicGeneration), quantity, balance:walletOf(user.id).balance, ...boundProject }), true;
    }
    const chargeItems = tasks.map((task, index) => ({ generationId:task.id, costMicro:task.creditCostMicro, metadata:{ modelId, contentType:type, provider, pricingVersion:task.pricingVersion, onCharged:() => { saveGeneration(user.id, task); if (generationRequestId && index === 0) createGenerationRequest({ userId:user.id, idempotencyKey:generationRequestId, requestHash:requestFingerprint, generationIds:taskIds }); if (!task.awaitingReferences) enqueueGenerationJob({ userId:user.id, generationId:task.id }); } } }));
    const charged = quantity === 1 ? await chargeGenerationMicro(user.id, tasks[0].id, tasks[0].creditCostMicro, chargeItems[0].metadata) : await chargeGenerationBatchMicro(user.id, chargeItems);
    if (charged.error) return sendJson(res, charged.status, { error:charged.error, balance:charged.balance }), true;
    const effectiveTasks = tasks.map(task => findGeneration(user.id, task.id, scope) || task);
    if (bindDramaTasks) { for (const task of effectiveTasks) if (!dramaShot.videoVersions.includes(task.id)) dramaShot.videoVersions.push(task.id); dramaShot.selectedVideoTaskId = effectiveTasks.at(-1).id; await saveDramaProject(user.id, dramaProject); }
    effectiveTasks.forEach(task => { if (task.status === 'queued' && !task.awaitingReferences) enqueueGenerationJob({ userId:user.id, generationId:task.id }); });
    const boundProject = bindDramaTasks ? { project:publicDramaProject(dramaProject) } : {};
    if (quantity === 1) return sendJson(res, 202, { ...publicGeneration(effectiveTasks[0]), balance:charged.balance, ...boundProject }), true;
    return sendJson(res, 202, { tasks:effectiveTasks.map(publicGeneration), quantity, balance:charged.balance, ...boundProject }), true;
  }

  return async function generationRoute(req, res, url) {
    if (await handleModelQuote(req, res, url)) return true;
    if (url.pathname === '/api/generations' && req.method === 'POST') return handleGenerationSubmit(req, res);
    return handleGenerations(req, res, url);
  };
}
