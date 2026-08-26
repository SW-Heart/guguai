const VIDEO_GENERATION_TYPES = Object.freeze({
  TEXT: 'TEXT',
  FIRST_LAST: 'FIRST&LAST',
  REFERENCE: 'REFERENCE',
});

export const VIDEO_MODEL_IDS = Object.freeze({
  GROK: 'grok',
  MINIMAX_H3_15S: 'minimax-h3-15s',
  VEO: 'veo',
  VEO_31: 'veo-31',
  OAI: 'oai',
  MINIMAX_H3: 'minimax-h3',
  SEEDANCE_2: 'seedance-2.0',
  SEEDANCE_25: 'seedance-2.5',
  SEEDANCE_2_FAST: 'seedance-2.0-fast',
});

// Kept only so persisted pre-rename tasks and old clients can be recognized safely.
export const LEGACY_VIDEO_MODEL_IDS = Object.freeze({
  GUGU_2: 'grok-15',
  GROK_VIDEO_1_5: 'legacy-grok-video-1.5',
});

const ttapiFastModel = process.env.TTAPI_GROK_VIDEO_FAST_MODEL || 'grok-imagine-video-1.5-fast';
const duomiVeoModel = process.env.DUOMI_VEO_MODEL || process.env.VIDEO_VEO_MODEL || process.env.DRAMA_CONTINUITY_VIDEO_MODEL || 'veo-fast';
const autodlWorkflowId = process.env.AUTODL_MINIMAX_H3_15S_WORKFLOW_ID || process.env.AUTODL_MINIMAX_H3_ID || 'minimax_h3_image_audio_to_video_v2_15s';
const autodlMinimaxH315sPricing = Object.freeze({ currency: 'credit', amount: 0.5, unit: 'second' });
const autodlMinimaxH315sReferenceLimits = Object.freeze({ image: 9, video: 0, audio: 3, total: 12 });
const oaiOmniFastModel = process.env.OAI_OMNI_FAST_MODEL || 'omni-fast';
const ttapiFastPricing = Object.freeze({ currency: 'credit', amount: 1.5, unit: 'second' });
const oaiVeo31Model = process.env.OAI_VEO_31_MODEL || 'firefly-veo-3.1';
const cntcnSeedanceModel = process.env.CNTCN_SD2_MODEL || 'seedance-2.0';
const oaiMinimaxH3Models = Object.freeze({
  '768p': process.env.OAI_MINIMAX_H3_768_MODEL || 'minimax-h3-768p',
  '2k': process.env.OAI_MINIMAX_H3_2K_MODEL || 'minimax-h3-2k',
});
const minimaxH3PricingByQuality = Object.freeze({
  '768p': Object.freeze({ currency: 'credit', amount: 2, unit: 'second' }),
  '2k': Object.freeze({ currency: 'credit', amount: 3, unit: 'second' }),
});
const seedanceReferenceLimits = Object.freeze({ image: 9, video: 3, audio: 3, total: 15 });
const seedanceFastReferenceLimits = Object.freeze({ image: 9, video: 3, audio: 3, total: 15 });
const seedance25ReferenceLimits = Object.freeze({ image: 30, video: 10, audio: 10, total: 50 });
const minimaxReferenceLimits = Object.freeze({ image: 5, video: 3, audio: 3, total: 15 });

const profiles = Object.freeze({
  standard: Object.freeze({
    key: 'standard',
    modelId: VIDEO_MODEL_IDS.GROK,
    provider: 'ttapi',
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    durations: [10, 15, 20, 30],
    maxImages: 7,
    qualities: ['480p', '720p'],
    pricing: ttapiFastPricing,
  }),
  minimaxH315s: Object.freeze({
    key: 'minimax-h3-15s',
    modelId: VIDEO_MODEL_IDS.MINIMAX_H3_15S,
    provider: 'autodl',
    model: autodlWorkflowId,
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['16:9', '9:16'],
    durations: Array.from({ length: 15 }, (_, index) => index + 1),
    defaultDuration: 5,
    maxImages: 9,
    qualities: ['768p', '480p'],
    pricing: autodlMinimaxH315sPricing,
    referenceLimits: autodlMinimaxH315sReferenceLimits,
  }),
  // Legacy automatic routing keeps its historical limits for existing clients.
  veo: Object.freeze({
    key: 'veo',
    modelId: VIDEO_MODEL_IDS.VEO,
    provider: 'duomi',
    model: duomiVeoModel,
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    durations: [8],
    maxImages: 7,
    qualities: ['720p'],
  }),
  continuity: Object.freeze({
    key: 'continuity',
    modelId: VIDEO_MODEL_IDS.VEO,
    provider: 'duomi',
    model: duomiVeoModel,
    generationTypes: ['FIRST&LAST'],
    aspectRatios: ['16:9', '9:16'],
    durations: [8],
    maxImages: 2,
    qualities: ['720p', '1080p', '4k'],
  }),
  veoFastText: Object.freeze({
    key: 'veo-fast-text', modelId: VIDEO_MODEL_IDS.VEO, provider: 'duomi', model: duomiVeoModel,
    generationTypes: ['TEXT'], aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'], durations: [8], maxImages: 0, qualities: ['720p'],
  }),
  veoFastReference: Object.freeze({
    key: 'veo-fast-reference', modelId: VIDEO_MODEL_IDS.VEO, provider: 'duomi', model: duomiVeoModel,
    generationTypes: ['REFERENCE'], aspectRatios: ['2:3', '3:2', '1:1', '16:9'], durations: [8], maxImages: 3, qualities: ['720p'],
  }),
  veoFastFirstLast: Object.freeze({
    key: 'veo-fast-first-last', modelId: VIDEO_MODEL_IDS.VEO, provider: 'duomi', model: duomiVeoModel,
    generationTypes: ['FIRST&LAST'], aspectRatios: ['16:9', '9:16'], durations: [8], maxImages: 2, qualities: ['720p'],
  }),
  oai: Object.freeze({
    key: 'oai',
    modelId: VIDEO_MODEL_IDS.OAI,
    provider: 'oai',
    model: oaiOmniFastModel,
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['16:9', '9:16'],
    durations: [10],
    maxImages: 5,
    qualities: ['720p'],
  }),
  veo31Text: Object.freeze({
    key: 'veo-31-text', modelId: VIDEO_MODEL_IDS.VEO_31, provider: 'oai', model: oaiVeo31Model,
    generationTypes: ['TEXT'], aspectRatios: ['16:9', '9:16'], durations: [8], maxImages: 0, qualities: ['720p', '1080p'],
  }),
  veo31Reference: Object.freeze({
    key: 'veo-31-reference', modelId: VIDEO_MODEL_IDS.VEO_31, provider: 'oai', model: oaiVeo31Model,
    generationTypes: ['REFERENCE'], aspectRatios: ['16:9'], durations: [8], maxImages: 3, qualities: ['720p', '1080p'],
  }),
  veo31FirstLast: Object.freeze({
    key: 'veo-31-first-last', modelId: VIDEO_MODEL_IDS.VEO_31, provider: 'oai', model: oaiVeo31Model,
    generationTypes: ['FIRST&LAST'], aspectRatios: ['16:9', '9:16'], durations: [8], maxImages: 2, qualities: ['720p', '1080p'],
  }),
  minimaxH3Text: Object.freeze({
    key: 'minimax-h3-text', modelId: VIDEO_MODEL_IDS.MINIMAX_H3, provider: 'oai',
    generationTypes: ['TEXT'], aspectRatios: ['16:9', '9:16', '1:1', '21:9', '4:3', '3:4'],
    durations: Array.from({ length: 12 }, (_, index) => index + 4), maxImages: 0, qualities: ['768p', '2k'],
    pricingByQuality: minimaxH3PricingByQuality, referenceLimits: minimaxReferenceLimits,
  }),
  minimaxH3Reference: Object.freeze({
    key: 'minimax-h3-reference', modelId: VIDEO_MODEL_IDS.MINIMAX_H3, provider: 'oai',
    generationTypes: ['REFERENCE'], aspectRatios: ['16:9', '9:16', '1:1', '21:9', '4:3', '3:4'],
    durations: Array.from({ length: 12 }, (_, index) => index + 4), maxImages: 5, qualities: ['768p', '2k'], referenceLimits: minimaxReferenceLimits,
    pricingByQuality: minimaxH3PricingByQuality,
  }),
  minimaxH3FirstLast: Object.freeze({
    key: 'minimax-h3-first-last', modelId: VIDEO_MODEL_IDS.MINIMAX_H3, provider: 'oai',
    generationTypes: ['FIRST&LAST'], aspectRatios: ['16:9', '9:16', '1:1', '21:9', '4:3', '3:4'],
    durations: Array.from({ length: 12 }, (_, index) => index + 4), maxImages: 2, qualities: ['768p', '2k'],
    pricingByQuality: minimaxH3PricingByQuality,
  }),
  seedance2Text: Object.freeze({
    key: 'seedance-2.0-text', modelId: VIDEO_MODEL_IDS.SEEDANCE_2, provider: 'route', model: '',
    generationTypes: ['TEXT'], aspectRatios: ['16:9', '9:16', '1:1'], durations: [15], maxImages: 0, qualities: ['480p', '720p'], referenceLimits: seedanceReferenceLimits,
  }),
  seedance2Reference: Object.freeze({
    key: 'seedance-2.0-reference', modelId: VIDEO_MODEL_IDS.SEEDANCE_2, provider: 'route', model: '',
    generationTypes: ['REFERENCE'], aspectRatios: ['16:9', '9:16', '1:1'], durations: [15], maxImages: 9, qualities: ['480p', '720p'], referenceLimits: seedanceReferenceLimits,
  }),
  seedance25Text: Object.freeze({
    key: 'seedance-2.5-text', modelId: VIDEO_MODEL_IDS.SEEDANCE_25, provider: 'route', model: '',
    generationTypes: ['TEXT'], aspectRatios: ['16:9', '9:16', '1:1'], durations: [30], maxImages: 0, qualities: ['480p', '720p'], referenceLimits: seedance25ReferenceLimits,
  }),
  seedance25Reference: Object.freeze({
    key: 'seedance-2.5-reference', modelId: VIDEO_MODEL_IDS.SEEDANCE_25, provider: 'route', model: '',
    generationTypes: ['REFERENCE'], aspectRatios: ['16:9', '9:16', '1:1'], durations: [30], maxImages: 30, qualities: ['480p', '720p'], referenceLimits: seedance25ReferenceLimits,
  }),
  seedance2FastText: Object.freeze({
    key: 'seedance-2.0-fast-text', modelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, provider: 'route', model: '',
    generationTypes: ['TEXT'], aspectRatios: ['16:9', '1:1', '9:16'], durations: [15], maxImages: 0, qualities: ['720p'], referenceLimits: seedanceFastReferenceLimits,
  }),
  seedance2FastReference: Object.freeze({
    key: 'seedance-2.0-fast-reference', modelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, provider: 'route', model: '',
    generationTypes: ['REFERENCE'], aspectRatios: ['16:9', '1:1', '9:16'], durations: [15], maxImages: 9, qualities: ['720p'], referenceLimits: seedanceFastReferenceLimits,
  }),
});

const modelCatalog = Object.freeze([
  // GuGu 2.0：通过 AutoDL ComfyUI 工作流提交异步任务。
  Object.freeze({ id: VIDEO_MODEL_IDS.MINIMAX_H3_15S, label: 'GuGu 2.0', description: '支持最多 9 张参考图片 + 3 段参考音频，1～15 秒视频生成', iconKey: 'minimax', profiles: Object.freeze({ TEXT: profiles.minimaxH315s, REFERENCE: profiles.minimaxH315s }) }),
  // GuGu 1.5：支持文生视频（TEXT）和参考图（REFERENCE），不支持首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.GROK, label: 'GuGu 1.5', description: '全能视频模型，支持最长30秒视频，7张参考图', profiles: Object.freeze({ TEXT: profiles.standard, REFERENCE: profiles.standard }) }),
  // Seedance 2.0：通过动态线路选择器提交并轮询。
  Object.freeze({ id: VIDEO_MODEL_IDS.SEEDANCE_2, label: 'Seedance 2.0', description: '支持 15 秒、1:1/16:9/9:16 文生视频与参考图视频', iconKey: 'bytedance', profiles: Object.freeze({ TEXT: profiles.seedance2Text, REFERENCE: profiles.seedance2Reference }) }),
  Object.freeze({ id: VIDEO_MODEL_IDS.SEEDANCE_25, label: 'Seedance 2.5', description: '固定 30 秒，支持最多 30 张图片、10 段视频和 10 段音频', iconKey: 'bytedance', profiles: Object.freeze({ TEXT: profiles.seedance25Text, REFERENCE: profiles.seedance25Reference }) }),
  // Seedance 2.0 Fast：通过 DIW 动态线路提交。
  Object.freeze({ id: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, label: 'Seedance 2.0 Fast', description: '固定 15 秒、720p，支持 9 张图片 + 3 段视频 + 3 段音频参考', iconKey: 'bytedance', profiles: Object.freeze({ TEXT: profiles.seedance2FastText, REFERENCE: profiles.seedance2FastReference }) }),
  // MiniMax H3：平台统一展示为一个模型，按清晰度路由到上游的 768p/2k 模型。
  Object.freeze({ id: VIDEO_MODEL_IDS.MINIMAX_H3, label: 'MiniMax H3', description: '支持 768p 与 2K，4～15 秒视频', iconKey: 'minimax', profiles: Object.freeze({ TEXT: profiles.minimaxH3Text, REFERENCE: profiles.minimaxH3Reference, 'FIRST&LAST': profiles.minimaxH3FirstLast }) }),
  // Omni Flash：支持文生视频（TEXT）和参考图（REFERENCE），不支持首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.OAI, label: 'Omni Flash', description: 'Google 最新视频模型，高质量，英文支持效果好', profiles: Object.freeze({ TEXT: profiles.oai, REFERENCE: profiles.oai }) }),
  // Veo 3.1：支持文生视频（TEXT）、参考图（REFERENCE）和首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.VEO_31, label: 'Veo 3.1', description: '支持首尾帧、支持1080P', profiles: Object.freeze({ TEXT: profiles.veo31Text, REFERENCE: profiles.veo31Reference, 'FIRST&LAST': profiles.veo31FirstLast }) }),
  // Veo 3.1 Fast：即将上线，暂不可选择或使用。
  Object.freeze({ id: VIDEO_MODEL_IDS.VEO, label: 'Veo 3.1 Fast', description: '支持首尾帧模式，固定8秒，速度快', availability: 'coming-soon', profiles: Object.freeze({ TEXT: profiles.veoFastText, REFERENCE: profiles.veoFastReference, 'FIRST&LAST': profiles.veoFastFirstLast }) }),
]);

function standardModelForDuration() {
  return ttapiFastModel;
}

function publicMode(profile, generationType) {
  const minImages = generationType === 'TEXT' ? 0 : 1;
  return {
    generationType,
    aspectRatios: [...profile.aspectRatios],
    durations: [...profile.durations],
    qualityOptions: [...profile.qualities],
    pricing: profile.pricing || null,
    referenceLimits: profile.referenceLimits ? { ...profile.referenceLimits } : null,
    pricingByQuality: profile.pricingByQuality
      ? Object.fromEntries(Object.entries(profile.pricingByQuality).map(([quality, pricing]) => [quality, { ...pricing }]))
      : undefined,
    minImages,
    maxImages: generationType === 'TEXT' ? 0 : profile.maxImages,
  };
}

function modelForId(modelId) {
  return modelCatalog.find(model => model.id === modelId);
}

function normalizedModelId(input) {
  const value = String(input.videoModel ?? input.modelId ?? '').trim().toLowerCase();
  if (value === LEGACY_VIDEO_MODEL_IDS.GUGU_2 || value === 'grok-imagine-video' || value === 'grok-imagine-video-1.5' || value === 'grok-video-1.5') return VIDEO_MODEL_IDS.MINIMAX_H3_15S;
  if (value === 'firefly-veo-3.1') return VIDEO_MODEL_IDS.VEO_31;
  return value || '';
}

function profileFor(modelId, generationType, duration) {
  if (modelId) {
    const selected = modelForId(modelId);
    if (!selected) throw Object.assign(new Error('不支持的视频模型'), { statusCode: 400 });
    const profile = selected.profiles[generationType];
    if (!profile) throw Object.assign(new Error(`${selected.label} 不支持${generationType === 'FIRST&LAST' ? '首尾帧' : generationType === 'REFERENCE' ? '参考元素' : '文本生成'}模式`), { statusCode: 400 });
    return { profile, selected };
  }

  // Existing short-drama projects and clients created before the model picker
  // continue to use the prior automatic routing. New UI requests always send
  // a modelId, so its selected model is the source of truth.
  const profile = generationType === 'FIRST&LAST' ? profiles.continuity : duration === 8 ? profiles.veo : profiles.standard;
  return { profile, selected: modelForId(profile.modelId) };
}

export function publicVideoCapabilities() {
  return {
    models: modelCatalog.map(model => ({
      id: model.id,
      label: model.label,
      description: model.description || '',
      providerLabel: model.providerLabel,
      availability: model.availability || 'available',
      iconKey: model.iconKey || model.id,
      modes: Object.entries(model.profiles).map(([generationType, profile]) => publicMode(profile, generationType)),
    })),
    generationTypes: [
      { value: 'TEXT', label: '文本生成', description: '不锁定画面，以镜头提示词直接生成。', minImages: 0, maxImages: 0 },
      { value: 'FIRST&LAST', label: '首尾帧', description: '锁定开始与结束画面，适合连续动作和镜头衔接。', minImages: 1, maxImages: 2 },
      { value: 'REFERENCE', label: '参考元素', description: '将角色、场景或物品作为画面元素参考。', minImages: 1, maxImages: 7 },
    ],
    qualityOptions: ['480p', '720p', '768p', '1080p', '4k'],
    continuityDuration: 8,
    continuityRatios: ['16:9', '9:16'],
    standardDurations: [...profiles.standard.durations],
    veoDurations: [...profiles.veo.durations],
    standardRatios: [...profiles.standard.aspectRatios],
    routing: [
      { modelId: VIDEO_MODEL_IDS.GROK, label: 'GuGu 1.5', mode: 'TEXT|REFERENCE', durations: [10, 15, 20, 30], model: ttapiFastModel, qualities: ['480p', '720p'], pricing: ttapiFastPricing },
      { modelId: VIDEO_MODEL_IDS.SEEDANCE_2, label: 'Seedance 2.0', mode: 'TEXT|REFERENCE', duration: 15, model: 'dynamic-route', qualities: ['480p', '720p'] },
      { modelId: VIDEO_MODEL_IDS.SEEDANCE_25, label: 'Seedance 2.5', mode: 'TEXT|REFERENCE', duration: 30, model: 'dynamic-route', qualities: ['480p', '720p'] },
      { modelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, label: 'Seedance 2.0 Fast', mode: 'TEXT|REFERENCE', duration: 15, model: 'dynamic-route', qualities: ['720p'] },
      { modelId: VIDEO_MODEL_IDS.OAI, label: 'Omni Flash', mode: 'TEXT|REFERENCE', duration: 10, model: oaiOmniFastModel },
      { modelId: VIDEO_MODEL_IDS.VEO_31, label: 'Veo 3.1', mode: 'TEXT|REFERENCE|FIRST&LAST', duration: 8, model: oaiVeo31Model, qualities: ['720p', '1080p'] },
      { modelId: VIDEO_MODEL_IDS.MINIMAX_H3_15S, label: 'GuGu 2.0', mode: 'TEXT|REFERENCE', durations: [...profiles.minimaxH315s.durations], model: autodlWorkflowId, qualities: [...profiles.minimaxH315s.qualities], pricing: autodlMinimaxH315sPricing },
      { modelId: VIDEO_MODEL_IDS.VEO, label: 'Veo 3.1 Fast', mode: 'TEXT|REFERENCE|FIRST&LAST', duration: 8, model: duomiVeoModel, qualities: ['720p'], availability: 'coming-soon' },
    ],
    restrictions: { referencePortraitUnsupported: false },
  };
}

export function validateVideoRequest(input, referenceCount = 0) {
  const requestedType = String(input.generationType || (referenceCount ? 'REFERENCE' : 'TEXT')).toUpperCase();
  if (!Object.values(VIDEO_GENERATION_TYPES).includes(requestedType)) throw Object.assign(new Error('不支持的视频生成模式'), { statusCode: 400 });
  const modelId = normalizedModelId(input);
  const defaultDuration = [VIDEO_MODEL_IDS.VEO, VIDEO_MODEL_IDS.VEO_31].includes(modelId)
    ? 8
    : modelId === VIDEO_MODEL_IDS.MINIMAX_H3_15S
      ? profiles.minimaxH315s.defaultDuration
      : modelId === VIDEO_MODEL_IDS.SEEDANCE_2
        ? profiles.seedance2Text.durations[0]
        : modelId === VIDEO_MODEL_IDS.SEEDANCE_25
          ? profiles.seedance25Text.durations[0]
        : modelId === VIDEO_MODEL_IDS.SEEDANCE_2_FAST
          ? profiles.seedance2FastText.durations[0]
        : requestedType === 'FIRST&LAST' ? profiles.continuity.durations[0] : profiles.standard.durations[0];
  const requestedDuration = Number(input.duration ?? defaultDuration);
  const { profile, selected } = profileFor(modelId, requestedType, requestedDuration);
  if (modelId && selected?.availability === 'coming-soon') {
    throw Object.assign(new Error(`${selected.label} 即将上线，当前不可用`), { statusCode: 503 });
  }
  const aspectRatio = String(input.aspectRatio ?? input.aspect_ratio ?? '16:9');
  const duration = requestedDuration;
  const requestedQuality = input.quality !== undefined ? input.quality : input.resolution;
  const quality = requestedQuality === undefined
    ? profile.qualities[0] || '720p'
    : String(requestedQuality);
  const modelLabel = selected?.label || '当前模型';

  if (!profile.aspectRatios.includes(aspectRatio)) throw Object.assign(new Error(`${requestedType === 'FIRST&LAST' ? '首尾帧' : modelLabel} 模式不支持 ${aspectRatio} 画幅`), { statusCode: 400 });
  if (!profile.durations.includes(duration)) throw Object.assign(new Error(`${requestedType === 'FIRST&LAST' ? '首尾帧模式时长固定为 8 秒' : `${modelLabel} 不支持 ${duration} 秒`}`), { statusCode: 400 });
  if (!profile.qualities.includes(quality)) throw Object.assign(new Error(`${modelLabel} 当前模式不支持所选清晰度`), { statusCode: 400 });
  if (requestedType === 'TEXT' && referenceCount) throw Object.assign(new Error('文本生成模式不能添加参考图片'), { statusCode: 400 });
  if (requestedType === 'FIRST&LAST' && (referenceCount < 1 || referenceCount > profile.maxImages)) throw Object.assign(new Error('首尾帧模式需要 1～2 张图片'), { statusCode: 400 });
  const referenceMax = profile.referenceLimits?.total || profile.maxImages;
  if (requestedType === 'REFERENCE' && (referenceCount < 1 || referenceCount > referenceMax)) throw Object.assign(new Error(`参考元素模式需要 1～${referenceMax} 个参考素材`), { statusCode: 400 });

  return {
    profileKey: profile.key,
    modelId: profile.modelId,
    provider: profile.provider,
    model: profile.modelId === VIDEO_MODEL_IDS.MINIMAX_H3
      ? oaiMinimaxH3Models[quality]
      : profile.key === 'standard' ? standardModelForDuration() : profile.model,
    generationType: requestedType,
    aspectRatio,
    duration,
    quality,
    pricing: profile.pricingByQuality?.[quality] || profile.pricing || null,
    pricingByQuality: profile.pricingByQuality || null,
    maxImages: profile.maxImages,
    referenceLimits: profile.referenceLimits ? { ...profile.referenceLimits } : null,
  };
}

export function buildVideoPayload(task, refs) {
  const referenceGroups = Array.isArray(refs) ? { images: refs, videos: [], audios: [] } : (refs || { images: [], videos: [], audios: [] });
  if (task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2 || task.videoProfile?.startsWith('seedance-2.0-')) {
    const payload = { model: task.model, prompt: task.prompt, aspect_ratio: task.aspectRatio, seconds: task.duration, resolution: task.quality || '720p' };
    if (referenceGroups.images?.length) payload.reference_image_urls = referenceGroups.images.slice(0, task.referenceLimits?.image || task.maxReferenceImages || 9);
    if (referenceGroups.videos?.length) payload.reference_videos = referenceGroups.videos.slice(0, task.referenceLimits?.video || 3);
    if (referenceGroups.audios?.length) payload.reference_audios = referenceGroups.audios.slice(0, task.referenceLimits?.audio || 3);
    return payload;
  }
  const isMinimaxH3 = task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3 || task.videoProfile?.startsWith('minimax-h3-');
  if (isMinimaxH3) {
    const payload = { model: task.model, prompt: task.prompt, duration: task.duration, ratio: task.aspectRatio };
    if (task.generationType === 'FIRST&LAST') {
      if (referenceGroups.images?.[0]) payload.first_image = referenceGroups.images[0];
      if (referenceGroups.images?.[1]) payload.last_image = referenceGroups.images[1];
    } else if (referenceGroups.images?.length) {
      payload.referenceImages = referenceGroups.images.slice(0, task.referenceLimits?.image || task.maxReferenceImages || 5);
    }
    if (referenceGroups.videos?.length) payload.referenceVideos = referenceGroups.videos.slice(0, task.referenceLimits?.video || 3);
    if (referenceGroups.audios?.length) payload.referenceAudios = referenceGroups.audios.slice(0, task.referenceLimits?.audio || 3);
    return payload;
  }
  const payload = {
    model: task.model,
    prompt: task.prompt,
    aspect_ratio: task.aspectRatio,
    duration: task.duration,
    quality: task.quality || '720p',
  };
  const isVeoModel = [VIDEO_MODEL_IDS.VEO, VIDEO_MODEL_IDS.VEO_31].includes(task.videoModelId) || ['veo', 'continuity', 'veo-31'].includes(task.videoProfile);
  if (isVeoModel) payload.generation_type = task.generationType || (refs.length ? 'REFERENCE' : 'TEXT');
  if (refs.length) payload.image_urls = refs.slice(0, task.maxReferenceImages || (isVeoModel ? 3 : task.videoProfile === 'continuity' ? 2 : 7));
  if (task.videoProfile === 'standard') payload.oversea = false;
  return payload;
}
