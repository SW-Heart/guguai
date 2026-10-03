import { buildPromptOptimizationReferences, promptOptimizationReferenceIds } from '../../lib/prompt-optimization.mjs';
import { videoPromptMaxLength } from '../../public/video-prompt.js';

export function createDramaRouteHandler({
  bodyJson,
  sendJson,
  requireUser,
  requireDesktopWorkspaceScope,
  listDramaProjects,
  deleteDramaProject,
  setPageHeaders,
  publicDramaProject,
  normalizeDramaProject,
  parseLimit,
  randomId,
  createDefaultDramaShot,
  saveDramaProject,
  latestDramaProject,
  loadDramaProject,
  findDramaProject,
  findGeneration,
  safeId,
  dramaStepOrder,
  reconcileDramaProjectGenerationReferences,
  isLlmConfigured,
  llmConfig,
  runSmartDirector,
  planDirectorActions,
  removeGenerationOutput,
  activeGenerations,
  now,
  charLength,
  analyzeScript,
  createStoryboard,
  optimizeShotPrompt,
  getVideoModels = () => [],
  findAsset,
} = {}) {
  return async function handleDramaRoute(req, res, url) {
    const optimizeMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)\/optimize-prompt$/);
    if (optimizeMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = await loadDramaProject(user.id, optimizeMatch[1], scope);
      const shot = project?.shots?.find(item => item.id === optimizeMatch[2]);
      if (!shot) { sendJson(res, 404, { error:'分镜不存在' }); return true; }
      if (project.finalAssetId) { sendJson(res, 409, { error:'请先恢复编辑，再优化分镜内容' }); return true; }
      if (!isLlmConfigured(llmConfig)) { sendJson(res, 503, { error:'AI 优化暂时不可用，请稍后再试' }); return true; }
      const input = await bodyJson(req);
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      const originalPrompt = typeof input.originalPrompt === 'string' ? input.originalPrompt.trim() : prompt;
      const direction = typeof input.direction === 'string' ? input.direction.trim() : '';
      const canonicalModel = value => value === 'grok-15' ? 'minimax-h3-15s' : value;
      const modelId = canonicalModel(String(shot.generation?.modelId || ''));
      if (input.modelId && canonicalModel(String(input.modelId)) !== modelId) { sendJson(res, 409, {error:'模型设置已有变化，请重新打开优化'}); return true; }
      const model = (await getVideoModels()).find(item => item.id === modelId);
      if (!model || model.enabled === false || model.availability === 'coming-soon' || !model.modes?.some(mode => mode.generationType === shot.generation?.type)) { sendJson(res, 400, {error:'当前模型或生成方式不可用，请重新选择'}); return true; }
      const maxLength = videoPromptMaxLength(modelId);
      if (!prompt || !originalPrompt) { sendJson(res, 400, { error:'请先填写分镜内容' }); return true; }
      if (charLength(prompt) > maxLength || charLength(originalPrompt) > maxLength || charLength(direction) > 1000) { sendJson(res, 400, { error:`分镜内容最多 ${maxLength} 字，改进方向最多 1000 字` }); return true; }
      let optimizationShot = {...shot,generation:{...shot.generation,modelId}};
      if (Array.isArray(input.assetMentions)) {
        const allowedIds = new Set([...(project.projectAssetIds || []),...promptOptimizationReferenceIds(shot),...(shot.assetMentions || []).map(item => item.id)]);
        if (input.assetMentions.length > 40 || input.assetMentions.some(item => !item || !allowedIds.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120 || /[@\r\n]/.test(item.label) || !['image','video','audio'].includes(item.kind))) { sendJson(res, 400, {error:'引用素材不可用，请重新选择'}); return true; }
        const assetMentions = input.assetMentions.filter(item => prompt.includes(`@${item.label}`)).map(item => ({id:item.id,label:item.label,kind:item.kind}));
        if (shot.generation.type === 'FIRST&LAST' && assetMentions.some(item => !promptOptimizationReferenceIds(shot).includes(item.id))) { sendJson(res, 400, {error:'请在首尾帧模式中引用已选的首帧或尾帧图片'}); return true; }
        const previousIds = new Set((shot.assetMentions || []).map(item => item.id));
        const type = assetMentions.length && shot.generation.type === 'TEXT' ? 'REFERENCE' : shot.generation.type;
        if (!model.modes.some(item => item.generationType === type)) { sendJson(res, 400, {error:'当前模型不支持这些参考素材，请调整生成方式'}); return true; }
        optimizationShot = {...optimizationShot,assetMentions,referenceAssetIds:[...(shot.referenceAssetIds || []).filter(id => !previousIds.has(id)),...assetMentions.map(item => item.id)],generation:{...optimizationShot.generation,type,referenceAssetIds:(shot.generation.referenceAssetIds || []).filter(id => !previousIds.has(id))}};
      }
      const mode = model.modes.find(item => item.generationType === optimizationShot.generation.type);
      const durations = mode.durationsByQuality?.[shot.generation.quality]?.[shot.aspectRatio] || mode.durations;
      if ((Array.isArray(durations) && !durations.includes(Number(shot.duration))) || (Array.isArray(mode.aspectRatios) && !mode.aspectRatios.includes(shot.aspectRatio)) || (Array.isArray(mode.qualityOptions) && !mode.qualityOptions.includes(shot.generation.quality))) { sendJson(res, 400, {error:'当前模型不支持已选时长、比例或清晰度，请调整后再优化'}); return true; }
      const mentionLabels = [...new Set([...(shot.assetMentions || []).map(item => item.label), ...(Array.isArray(input.mentionLabels) ? input.mentionLabels : [])])].filter(label => typeof label === 'string' && label.length <= 500).slice(0, 80);
      const metadata = new Map((Array.isArray(input.referenceFiles) ? input.referenceFiles : []).slice(0,80).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && ['image','video','audio'].includes(item.kind)).map(item => [item.id,{id:item.id,name:item.name.slice(0,120),kind:item.kind}]));
      const referenceFiles = promptOptimizationReferenceIds(optimizationShot).map(id => findAsset?.(user.id,id,scope) || metadata.get(id)).filter(Boolean);
      const references = buildPromptOptimizationReferences(optimizationShot,referenceFiles);
      sendJson(res, 200, await optimizeShotPrompt({ userId:user.id, project, shot:optimizationShot, originalPrompt, prompt, direction, mentionLabels, references, model, maxLength }));
      return true;
    }
    if (url.pathname === '/api/drama/projects' && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      const page = listDramaProjects(user.id, { deviceId:scope.deviceId, workspaceId:scope.workspaceId, limit:parseLimit(url.searchParams.get('limit')), cursor:url.searchParams.get('cursor') });
      setPageHeaders(res, page);
      sendJson(res, 200, { projects:page.items.map(project => publicDramaProject(normalizeDramaProject(project))) });
      return true;
    }
    if (url.pathname === '/api/drama/projects' && req.method === 'POST') {
      const user = await requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      const input = await bodyJson(req);
      const mode = input.mode === 'professional' ? 'professional' : 'smart';
      const title = String(input.title || '未命名短剧').trim().slice(0, 80);
      const project = normalizeDramaProject({ id:randomId(), ownerId:user.id, originDeviceId:scope.deviceId, originWorkspaceId:scope.workspaceId, title, mode, step:'script', status:'draft', input:'', synopsis:'', script:'', settings:input.settings || {}, resources:[], shots:mode==='smart'?[]:[createDefaultDramaShot()], finalAssetId:'', createdAt:now(), updatedAt:now() });
      await saveDramaProject(user.id, project, { create:true });
      sendJson(res, 201, { project:publicDramaProject(project) });
      return true;
    }
    if (url.pathname === '/api/drama/projects/latest' && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      const project = latestDramaProject(user.id, { deviceId:scope.deviceId, workspaceId:scope.workspaceId });
      sendJson(res, project ? 200 : 404, project ? { project:publicDramaProject(normalizeDramaProject(project)) } : { error:'还没有短剧项目' });
      return true;
    }
    const dramaProjectMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)$/);
    if (dramaProjectMatch && req.method === 'GET') {
      const user = await requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      const project = await loadDramaProject(user.id, dramaProjectMatch[1], scope);
      sendJson(res, project ? 200 : 404, project ? { project:publicDramaProject(project) } : { error:'短剧项目不存在' });
      return true;
    }
    if (dramaProjectMatch && req.method === 'PATCH') {
      const user = await requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      const project = await loadDramaProject(user.id, dramaProjectMatch[1], scope);
      if (!project) { sendJson(res, 404, { error:'短剧项目不存在' }); return true; }
      const input = await bodyJson(req);
      if (input.revision !== undefined && Number(input.revision) !== Number(project.revision)) {
        sendJson(res, 409, { error:'项目已在其他操作中更新，正在合并最新内容', code:'PROJECT_VERSION_CONFLICT', project:publicDramaProject(project) });
        return true;
      }
      if (input.title !== undefined) project.title = String(input.title).trim().slice(0, 80) || project.title;
      if (input.mode !== undefined) project.mode = input.mode === 'professional' ? 'professional' : 'smart';
      if (dramaStepOrder.includes(input.step)) {
        project.step = input.step;
        project.maxStep = dramaStepOrder[Math.max(dramaStepOrder.indexOf(project.maxStep || 'script'), dramaStepOrder.indexOf(input.step))];
      }
      for (const key of ['input', 'synopsis', 'script']) if (input[key] !== undefined) project[key] = String(input[key]).slice(0, key === 'script' ? 120000 : 10000);
      if (input.finalAssetId !== undefined) project.finalAssetId = String(input.finalAssetId || '').trim().slice(0, 200);
      if (input.directorWorkspace) project.directorWorkspace = input.directorWorkspace;
      if (input.settings) project.settings = { ...project.settings, ...input.settings };
      if (Array.isArray(input.scenes)) project.scenes = input.scenes;
      if (Array.isArray(input.resources)) project.resources = input.resources;
      if (Array.isArray(input.shots)) project.shots = input.shots;
      if (Array.isArray(input.projectAssetIds)) project.projectAssetIds = input.projectAssetIds;
      if (input.projectAssetCategories && typeof input.projectAssetCategories === 'object' && !Array.isArray(input.projectAssetCategories)) project.projectAssetCategories = input.projectAssetCategories;
      if (Array.isArray(input.assemblyVideos)) project.assemblyVideos = input.assemblyVideos;
      normalizeDramaProject(project);
      reconcileDramaProjectGenerationReferences(user.id, project, scope);
      try {
        await saveDramaProject(user.id, project);
      } catch (error) {
        if (error.code !== 'PROJECT_VERSION_CONFLICT') throw error;
        const latest = findDramaProject(user.id, dramaProjectMatch[1], scope);
        if (latest) {
          normalizeDramaProject(latest);
          error.publicData = { project:publicDramaProject(latest) };
        }
        throw error;
      }
      sendJson(res, 200, { project:publicDramaProject(project) });
      return true;
    }
    if (dramaProjectMatch && req.method === 'DELETE') {
      const user = await requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      const deleted = deleteDramaProject(user.id, dramaProjectMatch[1], scope);
      if (!deleted) { sendJson(res, 404, { error:'短剧项目不存在' }); return true; }
      // A project is only metadata. Its generations and media assets are
      // intentionally kept so deleting a project never deletes produced video.
      sendJson(res, 200, { deleted:true, id:dramaProjectMatch[1] });
      return true;
    }
    const agentMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/agent-plan$/);
    if (agentMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      if (!isLlmConfigured(llmConfig)) { sendJson(res,503,{error:'导演服务尚未配置'}); return true; }
      const project = await loadDramaProject(user.id,agentMatch[1],scope);
      if (!project) { sendJson(res,404,{error:'短剧项目不存在'}); return true; }
      const input = await bodyJson(req);
      if (!String(input.message||'').trim()) { sendJson(res,400,{error:'请输入创作目标'}); return true; }
      sendJson(res,200,await planDirectorActions({userId:user.id,project,message:String(input.message).slice(0,10000)}));
      return true;
    }
    const directorMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/direct$/);
    if (directorMatch && req.method === 'POST') {
      const user = await requireUser(req, res);
      if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res);
      if (!scope) return true;
      if (!isLlmConfigured(llmConfig)) { sendJson(res, 503, { error:'导演服务尚未配置' }); return true; }
      const project = await loadDramaProject(user.id, directorMatch[1], scope);
      if (!project) { sendJson(res, 404, { error:'短剧项目不存在' }); return true; }
      const input = await bodyJson(req);
      sendJson(res, 200, await runSmartDirector({ userId:user.id, project, input, saveProject:saveDramaProject }));
      return true;
    }
    const resourceVersionMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/resources\/([\w-]+)\/versions$/);
    if (resourceVersionMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = await loadDramaProject(user.id, resourceVersionMatch[1], scope);
      const resource = project?.resources.find(item => item.id === resourceVersionMatch[2]);
      if (!resource) { sendJson(res, 404, { error:'资源不存在' }); return true; }
      const input = await bodyJson(req);
      const task = findGeneration(user.id, safeId(input.taskId), scope);
      if (!task || task.type !== 'image') { sendJson(res, 400, { error:'图片任务不存在' }); return true; }
      if (!resource.versions.includes(task.id)) resource.versions.push(task.id);
      if (!resource.selectedTaskId) resource.selectedTaskId = task.id;
      await saveDramaProject(user.id, project);
      sendJson(res, 200, { project:publicDramaProject(project) });
      return true;
    }
    const resourceSelectMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/resources\/([\w-]+)\/select$/);
    if (resourceSelectMatch && req.method === 'PATCH') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = await loadDramaProject(user.id, resourceSelectMatch[1], scope);
      const resource = project?.resources.find(item => item.id === resourceSelectMatch[2]);
      if (!resource) { sendJson(res, 404, { error:'资源不存在' }); return true; }
      const input = await bodyJson(req);
      if (!resource.versions.includes(input.taskId)) { sendJson(res, 400, { error:'该版本不属于此资源' }); return true; }
      if (resource.selectedTaskId !== input.taskId) {
        resource.selectedTaskId = input.taskId;
        resource.lifecycle = { ...resource.lifecycle, status:'approved', revision:(resource.lifecycle?.revision || 1) + 1, approvedAt:now() };
        project.shots.filter(shot => shot.resourceIds.includes(resource.id)).forEach(shot => { shot.lifecycle.staleReasons = [...new Set([...(shot.lifecycle.staleReasons || []), `${resource.name} 视觉版本已变更`])]; });
      }
      await saveDramaProject(user.id, project);
      sendJson(res, 200, { project:publicDramaProject(project) });
      return true;
    }
    const shotVideoMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)\/videos$/);
    if (shotVideoMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = await loadDramaProject(user.id, shotVideoMatch[1], scope);
      const shot = project?.shots.find(item => item.id === shotVideoMatch[2]);
      if (!shot) { sendJson(res, 404, { error:'分镜不存在' }); return true; }
      const input = await bodyJson(req);
      const task = findGeneration(user.id, safeId(input.taskId), scope);
      if (!task || task.type !== 'video') { sendJson(res, 400, { error:'视频任务不存在' }); return true; }
      if (!shot.videoVersions.includes(task.id)) shot.videoVersions.push(task.id);
      shot.selectedVideoTaskId = task.id;
      await saveDramaProject(user.id, project);
      sendJson(res, 200, { project:publicDramaProject(project) });
      return true;
    }
    const shotVideoDeleteMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)\/videos\/([\w-]+)$/);
    if (shotVideoDeleteMatch && req.method === 'DELETE') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = await loadDramaProject(user.id, shotVideoDeleteMatch[1], scope);
      const shot = project?.shots.find(item => item.id === shotVideoDeleteMatch[2]);
      if (!shot) { sendJson(res, 404, { error:'分镜不存在' }); return true; }
      const id = safeId(shotVideoDeleteMatch[3]);
      if (!shot.videoVersions.includes(id)) { sendJson(res, 404, { error:'视频版本不存在' }); return true; }
      const task = findGeneration(user.id, id, scope);
      if (!task || task.type !== 'video') { sendJson(res, 404, { error:'视频任务不存在' }); return true; }
      if (activeGenerations.has(id) || ['queued', 'running'].includes(task.status)) { sendJson(res, 409, { error:'任务正在生成中，完成后才能删除' }); return true; }
      const deleted = await removeGenerationOutput(user.id, task, { project });
      sendJson(res, 200, { project:publicDramaProject(project), ...deleted });
      return true;
    }
    const professionalShotDeleteMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)$/);
    if (professionalShotDeleteMatch && req.method === 'DELETE') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = await loadDramaProject(user.id, professionalShotDeleteMatch[1], scope);
      const shot = project?.shots.find(item => item.id === professionalShotDeleteMatch[2]);
      if (!project || !shot) { sendJson(res, 404, { error:'分镜不存在' }); return true; }
      if (project.mode !== 'professional') { sendJson(res, 409, { error:'该删除接口仅用于专业编辑模式' }); return true; }
      const generationIds = [...new Set([...(shot.videoVersions || []), shot.selectedVideoTaskId, ...(shot.pendingImageGenerations || []).map(item => item?.taskId)].map(value => String(value || '')).filter(Boolean))];
      const tasks = generationIds.map(id => findGeneration(user.id, id, scope)).filter(Boolean);
      if (tasks.some(task => activeGenerations.has(task.id) || ['queued', 'running'].includes(task.status))) { sendJson(res, 409, { error:'分镜仍有任务正在生成，请等待完成后再删除' }); return true; }
      project.shots = project.shots.filter(item => item.id !== shot.id);
      normalizeDramaProject(project);
      await saveDramaProject(user.id, project);
      const deletedAssetIds = [];
      for (const task of tasks) {
        const deleted = await removeGenerationOutput(user.id, task);
        if (deleted.deletedAssetId) deletedAssetIds.push(deleted.deletedAssetId);
      }
      const latest = await loadDramaProject(user.id, project.id, scope);
      sendJson(res, 200, { project:publicDramaProject(latest || project), deletedTaskIds:tasks.map(task => task.id), deletedAssetIds });
      return true;
    }
    if (url.pathname === '/api/drama/analyze-script' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      if (!isLlmConfigured(llmConfig)) { sendJson(res, 503, { error:'LLM 服务尚未配置' }); return true; }
      const input = await bodyJson(req);
      const script = String(input.script || '').trim();
      if (!script) { sendJson(res, 400, { error:'请输入剧本内容' }); return true; }
      if (charLength(script) > 80_000) { sendJson(res, 400, { error:'单次剧本分析不能超过 80,000 个字符' }); return true; }
      sendJson(res, 200, await analyzeScript({ userId:user.id, script, scope, saveProject:saveDramaProject }));
      return true;
    }
    const storyboardMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/storyboard$/);
    if (storyboardMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      if (!isLlmConfigured(llmConfig)) { sendJson(res, 503, { error:'导演服务尚未配置' }); return true; }
      const project = findDramaProject(user.id, storyboardMatch[1], scope);
      if (!project) { sendJson(res, 404, { error:'短剧项目不存在' }); return true; }
      sendJson(res, 200, await createStoryboard({ userId:user.id, project, saveProject:saveDramaProject }));
      return true;
    }
    const shotBindingMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)$/);
    if (shotBindingMatch && req.method === 'PATCH') {
      const user = await requireUser(req, res); if (!user) return true;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
      const project = findDramaProject(user.id, shotBindingMatch[1], scope);
      if (!project?.storyboard?.shots) { sendJson(res, 404, { error:'短剧项目或分镜不存在' }); return true; }
      const shot = project.storyboard.shots.find(item => item.id === shotBindingMatch[2]);
      if (!shot) { sendJson(res, 404, { error:'镜头不存在' }); return true; }
      const input = await bodyJson(req);
      const field = input.kind === 'video' ? 'videoTaskId' : input.kind === 'keyframe' ? 'keyframeTaskId' : '';
      if (!field) { sendJson(res, 400, { error:'只支持绑定关键帧或视频任务' }); return true; }
      const taskId = safeId(input.taskId);
      const task = findGeneration(user.id, taskId, scope);
      const expectedType = field === 'keyframeTaskId' ? 'image' : 'video';
      if (!task || task.type !== expectedType) { sendJson(res, 400, { error:'生成任务不存在或类型不匹配' }); return true; }
      shot[field] = taskId;
      await saveDramaProject(user.id, project);
      sendJson(res, 200, { project:publicDramaProject(project) });
      return true;
    }
    return false;
  };
}
