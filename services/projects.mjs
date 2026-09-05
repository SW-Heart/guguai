import { randomUUID } from 'node:crypto';

import { normalizeMotionPlan, normalizeProductionScenes, productionQualitySummary } from '../lib/storyboard-engine.mjs';

const publicDramaProjectFields = Object.freeze([
  'id', 'title', 'mode', 'step', 'maxStep', 'status', 'input', 'synopsis', 'script', 'settings',
  'analysis', 'analysisUsage', 'storyboard', 'storyboardUsage', 'resources', 'scenes', 'shots',
  'projectAssetIds', 'projectAssetCategories', 'productionQuality', 'finalAssetId', 'assemblyVideos', 'workflowVersion',
  'schemaVersion', 'revision', 'episodes', 'createdAt', 'updatedAt',
]);

export function createProjectService({
  now = () => new Date().toISOString(),
  videoAspectRatios,
  dramaVideoDurations,
  dramaStepOrder,
  canonicalVideoModelId,
  publicLlmUsage,
} = {}) {
  for (const [name, dependency] of Object.entries({ videoAspectRatios, dramaVideoDurations, dramaStepOrder, canonicalVideoModelId, publicLlmUsage })) {
    if (!dependency || (typeof dependency !== 'function' && typeof dependency.has !== 'function' && !Array.isArray(dependency))) {
      throw new TypeError(`项目服务缺少 ${name} 依赖`);
    }
  }

  function publicDramaProject(project) {
    return Object.fromEntries(publicDramaProjectFields
      .filter(field => Object.hasOwn(project, field))
      .map(field => [field, ['analysisUsage', 'storyboardUsage'].includes(field) ? publicLlmUsage(project[field]) : project[field]]));
  }

  function createDefaultDramaShot() {
    return { id: randomUUID(), title: '分镜 1' };
  }

  function normalizeDramaAssemblyVideos(project) {
    const source = Array.isArray(project.assemblyVideos) ? [...project.assemblyVideos] : [];
    const legacyId = String(project.finalAssetId || '').trim();
    if (legacyId && !source.some(item => String(item?.assetId || item?.id || '') === legacyId)) {
      source.unshift({ id: legacyId, assetId: legacyId, name: '完整成片', createdAt: project.updatedAt || now(), shotCount: project.shots?.length || 0, shotIds: [] });
    }
    project.assemblyVideos = source.map(item => {
      const assetId = String(item?.assetId || item?.id || '').trim().slice(0, 200);
      if (!assetId) return null;
      return {
        id: String(item?.id || assetId).trim().slice(0, 200) || assetId,
        assetId,
        name: String(item?.name || '完整成片').trim().slice(0, 120) || '完整成片',
        createdAt: String(item?.createdAt || project.updatedAt || now()).slice(0, 80),
        shotCount: Math.max(0, Math.min(120, Number(item?.shotCount) || 0)),
        shotIds: [...new Set((Array.isArray(item?.shotIds) ? item.shotIds : []).map(String).filter(Boolean))].slice(0, 120),
      };
    }).filter(Boolean).slice(0, 50);
  }

  function normalizeDramaProject(project) {
    const legacyMaxStep = !dramaStepOrder.includes(project.maxStep);
    project.schemaVersion = 5;
    project.revision = Math.max(1, Number(project.revision) || 1);
    project.workflowVersion = Number(project.workflowVersion) || 1;
    project.mode ||= 'smart';
    if (project.mode === 'professional' && project.workflowVersion < 2) project.workflowVersion = 2;
    project.step ||= project.storyboard ? 'storyboard' : 'script';
    project.input ||= project.script || '';
    project.synopsis ||= project.analysis?.logline || '';
    project.settings = {
      shotCount: Math.max(1, Math.min(120, Number(project.settings?.shotCount) || project.storyboard?.shots?.length || 5)),
      totalDuration: Math.max(20, Math.min(3600, Number(project.settings?.totalDuration) || (project.storyboard?.shots?.length || 5) * 20)),
      shotDuration: dramaVideoDurations.has(Number(project.settings?.shotDuration)) ? Number(project.settings.shotDuration) : 20,
      aspectRatio: videoAspectRatios.has(project.settings?.aspectRatio) ? project.settings.aspectRatio : '9:16',
    };
    project.projectAssetIds = Array.isArray(project.projectAssetIds) ? [...new Set(project.projectAssetIds.map(String).filter(Boolean))].slice(0, 200) : [];
    project.projectAssetCategories = project.projectAssetCategories && typeof project.projectAssetCategories === 'object' && !Array.isArray(project.projectAssetCategories)
      ? Object.fromEntries(Object.entries(project.projectAssetCategories).filter(([id, category]) => project.projectAssetIds.includes(String(id)) && ['characters', 'locations', 'props', 'other'].includes(category)).slice(0, 200))
      : {};
    if (!Array.isArray(project.episodes)) project.episodes = [{ id: randomUUID(), number: 1, title: '第 1 集', synopsis: project.synopsis, status: 'draft' }];
    project.episodes = project.episodes.map((episode, index) => ({
      id: episode.id || randomUUID(), number: index + 1, title: String(episode.title || `第 ${index + 1} 集`),
      synopsis: String(episode.synopsis || ''), status: String(episode.status || 'draft'),
    }));
    if (!Array.isArray(project.scenes)) project.scenes = [];
    project.scenes = normalizeProductionScenes(project.scenes.map((scene, index) => ({
      id: scene.id || randomUUID(), sceneNumber: index + 1, heading: String(scene.heading || `场次 ${index + 1}`),
      location: String(scene.location || ''), timeOfDay: String(scene.timeOfDay || '日'), dramaticFunction: String(scene.dramaticFunction || ''),
      geography: String(scene.geography || ''), lighting: String(scene.lighting || ''), continuityNotes: String(scene.continuityNotes || ''),
      beats: Array.isArray(scene.beats) ? scene.beats : [],
    })), project.settings);
    if (!Array.isArray(project.resources)) {
      const mapping = { characters: 'character', locations: 'location', props: 'prop' };
      project.resources = Object.entries(mapping).flatMap(([key, type]) => (project.analysis?.assets?.[key] || []).map(item => ({
        id: randomUUID(), type, name: typeof item === 'string' ? item : item.name,
        description: typeof item === 'string' ? '' : item.description || '',
        prompt: `${typeof item === 'string' ? item : item.name}，${typeof item === 'string' ? '' : item.description || ''}，真人短剧设定图，9:16`,
        versions: [], selectedTaskId: '',
      })));
    }
    project.resources = project.resources.map(item => ({
      id: item.id || randomUUID(), type: ['character', 'location', 'prop'].includes(item.type) ? item.type : 'prop',
      name: String(item.name || '未命名资源'), description: String(item.description || ''), prompt: String(item.prompt || ''),
      bible: {
        identity: String(item.bible?.identity || item.description || ''), dramaticGoal: String(item.bible?.dramaticGoal || ''),
        appearance: String(item.bible?.appearance || ''), costume: String(item.bible?.costume || ''),
        canonicalViews: String(item.bible?.canonicalViews || ''), stateNotes: String(item.bible?.stateNotes || ''),
      },
      lifecycle: {
        status: String(item.lifecycle?.status || (item.selectedTaskId ? 'approved' : 'draft')),
        revision: Math.max(1, Number(item.lifecycle?.revision) || 1), approvedAt: String(item.lifecycle?.approvedAt || ''),
      },
      versions: Array.isArray(item.versions) ? item.versions : [], selectedTaskId: String(item.selectedTaskId || ''),
    }));
    if (!Array.isArray(project.shots)) {
      project.shots = (project.storyboard?.shots || []).map((shot, index) => ({
        id: shot.id || randomUUID(), shotNumber: index + 1, title: shot.title,
        script: [shot.action, shot.dialogue].filter(Boolean).join('\n'), prompt: shot.videoPrompt, duration: shot.duration || 6,
        aspectRatio: '9:16', resourceIds: [], referenceAssetIds: [], videoVersions: shot.videoTaskId ? [shot.videoTaskId] : [],
        selectedVideoTaskId: shot.videoTaskId || '', tailFrameAssetId: '',
      }));
    }
    const dramaPromptOverrides = project.shots.map(shot => String(shot?.promptOverride || '').slice(0, 4000));
    project.shots = project.shots.map((shot, index) => {
      const professionalAssets = {
        characters: [...new Set(Array.isArray(shot.professionalAssets?.characters) ? shot.professionalAssets.characters.map(String) : [])],
        locations: [...new Set(Array.isArray(shot.professionalAssets?.locations) ? shot.professionalAssets.locations.map(String) : [])],
      };
      const categorizedIds = [...professionalAssets.characters, ...professionalAssets.locations];
      const assetMentions = Array.isArray(shot.assetMentions)
        ? shot.assetMentions.map(item => ({
          id: String(item?.id || ''), label: String(item?.label || '').replace(/^@/, '').trim().slice(0, 120),
          kind: ['image', 'video', 'audio'].includes(item?.kind) ? item.kind : 'image',
        })).filter(item => item.id && item.label).slice(0, 40)
        : [];
      const mentionedIds = assetMentions.map(item => item.id);
      const referenceAssetIds = [...new Set([...(Array.isArray(shot.referenceAssetIds) ? shot.referenceAssetIds.map(String) : []), ...categorizedIds, ...mentionedIds])];
      const generationType = ['TEXT', 'FIRST&LAST', 'REFERENCE'].includes(shot.generation?.type)
        ? shot.generation.type
        : (referenceAssetIds.length ? 'REFERENCE' : 'TEXT');
      const professionalShot = project.mode === 'professional';
      const firstFrameAssetId = String(shot.generation?.firstFrameAssetId || (!professionalShot ? referenceAssetIds[0] : '') || '');
      const lastFrameAssetId = String(shot.generation?.lastFrameAssetId || '');
      const explicitReferences = Array.isArray(shot.generation?.referenceAssetIds) ? shot.generation.referenceAssetIds.map(String) : [];
      const generationReferenceAssetIds = generationType === 'TEXT'
        ? []
        : generationType === 'FIRST&LAST'
          ? [firstFrameAssetId, lastFrameAssetId].filter(Boolean).slice(0, 2)
          : [...new Set([...explicitReferences, ...referenceAssetIds])];
      const pendingImageGenerations = professionalShot && Array.isArray(shot.pendingImageGenerations)
        ? shot.pendingImageGenerations.slice(0, 20).map(item => ({
          id: String(item.id || item.taskId || randomUUID()), taskId: String(item.taskId || ''),
          targetType: item.targetType === 'frame' ? 'frame' : 'category', kind: item.kind === 'locations' ? 'locations' : 'characters',
          frameField: item.frameField === 'lastFrameAssetId' ? 'lastFrameAssetId' : 'firstFrameAssetId', label: String(item.label || '图片').slice(0, 40),
          prompt: String(item.prompt || '').slice(0, 4000), size: ['1:1', '3:2', '2:3', '16:9', '9:16', '1:2', '2:1', '4:3', '3:4', '5:4', '4:5'].includes(item.size) ? item.size : '1:1',
          quality: ['low', 'medium', 'high'].includes(item.quality) ? item.quality : 'medium',
          referenceAssetIds: Array.isArray(item.referenceAssetIds) ? item.referenceAssetIds.map(String).slice(0, 7) : [],
        }))
        : [];
      return {
        id: shot.id || randomUUID(), shotNumber: index + 1,
        sceneNumber: Math.max(1, Number(shot.sceneNumber) || Math.max(1, project.scenes.findIndex(scene => scene.id === shot.sceneId) + 1)),
        sceneId: String(shot.sceneId || project.scenes[Math.max(0, (Number(shot.sceneNumber) || 1) - 1)]?.id || project.scenes[0]?.id || ''),
        title: String(shot.title || `分镜 ${index + 1}`), sourceBeatIds: Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds.map(String) : [],
        script: String(shot.script || ''), assetMentions, prompt: String(shot.prompt || shot.visualDirection || ''), visualDirection: String(shot.visualDirection || shot.prompt || ''),
        narrativeFunction: String(shot.narrativeFunction || ''), shotSize: String(shot.shotSize || '中景'), cameraMovement: String(shot.cameraMovement || '固定'),
        framing: String(shot.framing || ''), startStateId: String(shot.startStateId || ''), startState: String(shot.startState || ''),
        action: String(shot.action || shot.script || ''), endStateId: String(shot.endStateId || ''), endState: String(shot.endState || ''),
        continuityNotes: String(shot.continuityNotes || ''), sound: String(shot.sound || ''), negativePrompt: String(shot.negativePrompt || '禁止人物变脸、服装变化、道具消失、空间轴线跳变'),
        motionPlan: normalizeMotionPlan(shot.motionPlan), duration: dramaVideoDurations.has(Number(shot.duration)) ? Number(shot.duration) : project.settings.shotDuration,
        aspectRatio: videoAspectRatios.has(shot.aspectRatio) ? shot.aspectRatio : project.settings.aspectRatio, resourceIds: Array.isArray(shot.resourceIds) ? shot.resourceIds : [],
        referenceAssetIds, professionalAssets, pendingImageGenerations,
        generation: {
          type: generationType, modelId: canonicalVideoModelId(shot.generation?.modelId), firstFrameAssetId, lastFrameAssetId,
          referenceAssetIds: generationReferenceAssetIds, quality: ['480p', '720p', '768p', '1080p', '2k', '4k'].includes(shot.generation?.quality) ? shot.generation.quality : '720p',
          count: [1, 2, 4].includes(Number(shot.generation?.count)) ? Number(shot.generation.count) : 1,
        },
        lifecycle: {
          status: String(shot.lifecycle?.status || (shot.selectedVideoTaskId ? 'generated' : 'draft')),
          revision: Math.max(1, Number(shot.lifecycle?.revision) || 1), staleReasons: Array.isArray(shot.lifecycle?.staleReasons) ? shot.lifecycle.staleReasons.map(String) : [],
        },
        videoVersions: Array.isArray(shot.videoVersions) ? shot.videoVersions : [], selectedVideoTaskId: String(shot.selectedVideoTaskId || ''), tailFrameAssetId: String(shot.tailFrameAssetId || ''),
      };
    });
    project.shots.forEach((shot, index) => { shot.promptOverride = dramaPromptOverrides[index] || ''; });
    project.productionQuality = productionQualitySummary({ scenes: project.scenes, shots: project.shots }, project.settings);
    let inferredStep = dramaStepOrder.includes(project.step) ? project.step : 'script';
    if (project.resources.some(item => item.selectedTaskId || item.lifecycle.revision > 1)) inferredStep = dramaStepOrder[Math.max(dramaStepOrder.indexOf(inferredStep), 1)];
    if (project.shots.some(shot => shot.selectedVideoTaskId || shot.videoVersions.length)) inferredStep = 'video';
    else if (project.shots.some(shot => shot.lifecycle.status === 'reviewed' || shot.lifecycle.revision > 1 || shot.referenceAssetIds.length)) inferredStep = dramaStepOrder[Math.max(dramaStepOrder.indexOf(inferredStep), 2)];
    project.maxStep = legacyMaxStep ? inferredStep : dramaStepOrder[Math.max(dramaStepOrder.indexOf(project.maxStep), dramaStepOrder.indexOf(inferredStep))];
    if (legacyMaxStep && dramaStepOrder.indexOf(project.step) < dramaStepOrder.indexOf(project.maxStep)) project.step = project.maxStep;
    normalizeDramaAssemblyVideos(project);
    return project;
  }

  function dramaProjectGenerationIds(project) {
    return [...new Set([
      ...(project?.resources || []).flatMap(resource => [resource.selectedTaskId, ...(resource.versions || [])]),
      ...(project?.shots || []).flatMap(shot => [shot.selectedVideoTaskId, ...(shot.videoVersions || []), ...(shot.pendingImageGenerations || []).map(item => item?.taskId)]),
      ...(project?.storyboard?.shots || []).flatMap(shot => [shot.keyframeTaskId, shot.videoTaskId]),
    ].map(value => String(value || '')).filter(Boolean))];
  }

  function removeGenerationFromDramaProject(project, taskId) {
    const id = String(taskId || '');
    if (!project || !id) return false;
    let changed = false;
    const removeFromList = (value, assign) => {
      if (!Array.isArray(value) || !value.some(item => String(item) === id)) return;
      assign(value.filter(item => String(item) !== id));
      changed = true;
    };
    (Array.isArray(project.resources) ? project.resources : []).forEach(resource => {
      removeFromList(resource.versions || [], next => { resource.versions = next; });
      if (String(resource.selectedTaskId || '') === id) {
        resource.selectedTaskId = resource.versions.at(-1) || '';
        resource.lifecycle = { ...resource.lifecycle, status: resource.selectedTaskId ? 'approved' : 'draft', approvedAt: resource.selectedTaskId ? resource.lifecycle?.approvedAt || '' : '' };
        changed = true;
      }
    });
    (Array.isArray(project.shots) ? project.shots : []).forEach(shot => {
      removeFromList(shot.videoVersions || [], next => { shot.videoVersions = next; });
      if (String(shot.selectedVideoTaskId || '') === id) { shot.selectedVideoTaskId = shot.videoVersions.at(-1) || ''; changed = true; }
      if (Array.isArray(shot.pendingImageGenerations) && shot.pendingImageGenerations.some(item => String(item?.taskId || '') === id)) {
        shot.pendingImageGenerations = shot.pendingImageGenerations.filter(item => String(item?.taskId || '') !== id);
        changed = true;
      }
    });
    (Array.isArray(project.storyboard?.shots) ? project.storyboard.shots : []).forEach(shot => {
      if (String(shot.videoTaskId || '') === id) { shot.videoTaskId = ''; changed = true; }
      if (String(shot.keyframeTaskId || '') === id) { shot.keyframeTaskId = ''; changed = true; }
    });
    if (changed) normalizeDramaProject(project);
    return changed;
  }

  return { publicDramaProject, createDefaultDramaShot, normalizeDramaAssemblyVideos, normalizeDramaProject, dramaProjectGenerationIds, removeGenerationFromDramaProject };
}
