const allowedQualities = new Set(['480p', '720p', '1080p', '4k']);

export const VIDEO_GENERATION_TYPES = Object.freeze({
  TEXT: 'TEXT',
  FIRST_LAST: 'FIRST&LAST',
  REFERENCE: 'REFERENCE',
});

export const VIDEO_MODEL_IDS = Object.freeze({
  GROK: 'grok',
  GROK_15: 'grok-15',
  VEO: 'veo',
  VEO_31: 'veo-31',
  OAI: 'oai',
  MINIMAX_H3: 'minimax-h3',
  SEEDANCE_2: 'seedance-2.0',
});

const ttapiFastModel = process.env.TTAPI_GROK_VIDEO_FAST_MODEL || 'grok-imagine-video-1.5-fast';
const duomiVeoModel = process.env.DUOMI_VEO_MODEL || process.env.VIDEO_VEO_MODEL || process.env.DRAMA_CONTINUITY_VIDEO_MODEL || 'veo-fast';
const oaiOmniFastModel = process.env.OAI_OMNI_FAST_MODEL || 'omni-fast';
const oaiGrok15Model = process.env.OAI_GROK_MODEL || process.env.OAI_GROK_15_MODEL || 'grok-imagine-video';
const ttapiFastPricing = Object.freeze({ currency: 'credit', amount: 1.5, unit: 'second' });
const oaiGrokPricing = Object.freeze({ currency: 'credit', amount: 1, unit: 'second' });
const oaiVeo31Model = process.env.OAI_VEO_31_MODEL || 'firefly-veo-3.1';

const profiles = Object.freeze({
  standard: Object.freeze({
    key: 'standard',
    modelId: VIDEO_MODEL_IDS.GROK,
    provider: 'ttapi',
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    durations: [10, 20, 30],
    maxImages: 7,
    qualities: ['480p', '720p'],
    pricing: ttapiFastPricing,
  }),
  grok15: Object.freeze({
    key: 'grok-15',
    modelId: VIDEO_MODEL_IDS.GROK_15,
    provider: 'oai',
    model: oaiGrok15Model,
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2'],
    durations: [6, 12],
    maxImages: 1,
    qualities: ['480p', '720p'],
    pricing: oaiGrokPricing,
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
});

const modelCatalog = Object.freeze([
  // GuGu 1.5：支持文生视频（TEXT）和参考图（REFERENCE），不支持首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.GROK, label: 'GuGu 1.5', description: '全能视频模型，支持最长30秒视频，7张参考图', profiles: Object.freeze({ TEXT: profiles.standard, REFERENCE: profiles.standard }) }),
  // GuGu 1.0：支持文生视频（TEXT）和参考图（REFERENCE），不支持首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.GROK_15, label: 'GuGu 1.0', availability: 'coming-soon', iconKey: 'grok', profiles: Object.freeze({ TEXT: profiles.grok15, REFERENCE: profiles.grok15 }) }),
  // Omni Flash：支持文生视频（TEXT）和参考图（REFERENCE），不支持首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.OAI, label: 'Omni Flash', description: 'Google 最新视频模型，高质量，英文支持效果好', profiles: Object.freeze({ TEXT: profiles.oai, REFERENCE: profiles.oai }) }),
  // Veo 3.1 Fast：即将上线，暂不可选择或使用。
  Object.freeze({ id: VIDEO_MODEL_IDS.VEO, label: 'Veo 3.1 Fast', description: '支持首尾帧模式，固定8秒，速度快', availability: 'coming-soon', profiles: Object.freeze({ TEXT: profiles.veoFastText, REFERENCE: profiles.veoFastReference, 'FIRST&LAST': profiles.veoFastFirstLast }) }),
  // Veo 3.1：支持文生视频（TEXT）、参考图（REFERENCE）和首尾帧（FIRST&LAST）。
  Object.freeze({ id: VIDEO_MODEL_IDS.VEO_31, label: 'Veo 3.1', description: '支持首尾帧、支持1080P', profiles: Object.freeze({ TEXT: profiles.veo31Text, REFERENCE: profiles.veo31Reference, 'FIRST&LAST': profiles.veo31FirstLast }) }),
  // MiniMax H3：暂未开放，当前没有可用模式。
  Object.freeze({ id: VIDEO_MODEL_IDS.MINIMAX_H3, label: 'MiniMax H3', availability: 'coming-soon', iconKey: 'minimax', profiles: Object.freeze({}) }),
  // Seedance 2.0：暂未开放，当前没有可用模式。
  Object.freeze({ id: VIDEO_MODEL_IDS.SEEDANCE_2, label: 'Seedance 2.0', availability: 'coming-soon', iconKey: 'bytedance', profiles: Object.freeze({}) }),
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
    minImages,
    maxImages: generationType === 'TEXT' ? 0 : profile.maxImages,
  };
}

function modelForId(modelId) {
  return modelCatalog.find(model => model.id === modelId);
}

function normalizedModelId(input) {
  const value = String(input.videoModel ?? input.modelId ?? '').trim().toLowerCase();
  if (value === 'grok-imagine-video' || value === 'grok-imagine-video-1.5' || value === 'grok-video-1.5') return VIDEO_MODEL_IDS.GROK_15;
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
    qualityOptions: ['480p', '720p', '1080p', '4k'],
    continuityDuration: 8,
    continuityRatios: ['16:9', '9:16'],
    standardDurations: [...profiles.standard.durations],
    veoDurations: [...profiles.veo.durations],
    standardRatios: [...profiles.standard.aspectRatios],
    routing: [
      { modelId: VIDEO_MODEL_IDS.GROK_15, label: 'GuGu 1.0', mode: 'TEXT|REFERENCE', durations: [6, 12], model: oaiGrok15Model, qualities: ['480p', '720p'], pricing: oaiGrokPricing },
      { modelId: VIDEO_MODEL_IDS.GROK, label: 'GuGu 1.5', mode: 'TEXT|REFERENCE', durations: [10, 20, 30], model: ttapiFastModel, qualities: ['480p', '720p'], pricing: ttapiFastPricing },
      { modelId: VIDEO_MODEL_IDS.VEO, label: 'Veo 3.1 Fast', mode: 'TEXT|REFERENCE|FIRST&LAST', duration: 8, model: duomiVeoModel, qualities: ['720p'], availability: 'coming-soon' },
      { modelId: VIDEO_MODEL_IDS.OAI, label: 'Omni Flash', mode: 'TEXT|REFERENCE', duration: 10, model: oaiOmniFastModel },
      { modelId: VIDEO_MODEL_IDS.VEO_31, label: 'Veo 3.1', mode: 'TEXT|REFERENCE|FIRST&LAST', duration: 8, model: oaiVeo31Model, qualities: ['720p', '1080p'] },
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
    : modelId === VIDEO_MODEL_IDS.GROK_15
      ? profiles.grok15.durations[0]
      : requestedType === 'FIRST&LAST' ? profiles.continuity.durations[0] : profiles.standard.durations[0];
  const requestedDuration = Number(input.duration ?? defaultDuration);
  const { profile, selected } = profileFor(modelId, requestedType, requestedDuration);
  if (modelId && selected?.availability === 'coming-soon') {
    throw Object.assign(new Error(`${selected.label} 即将上线，当前不可用`), { statusCode: 503 });
  }
  const aspectRatio = String(input.aspectRatio ?? input.aspect_ratio ?? '16:9');
  const duration = requestedDuration;
  const requestedQuality = input.quality ?? input.resolution;
  const quality = allowedQualities.has(requestedQuality) ? requestedQuality : '720p';
  const modelLabel = selected?.label || '当前模型';

  if (!profile.aspectRatios.includes(aspectRatio)) throw Object.assign(new Error(`${requestedType === 'FIRST&LAST' ? '首尾帧' : modelLabel} 模式不支持 ${aspectRatio} 画幅`), { statusCode: 400 });
  if (!profile.durations.includes(duration)) throw Object.assign(new Error(`${requestedType === 'FIRST&LAST' ? '首尾帧模式时长固定为 8 秒' : `${modelLabel} 不支持 ${duration} 秒`}`), { statusCode: 400 });
  if (!profile.qualities.includes(quality)) throw Object.assign(new Error(`${modelLabel} 当前模式不支持所选清晰度`), { statusCode: 400 });
  if (requestedType === 'TEXT' && referenceCount) throw Object.assign(new Error('文本生成模式不能添加参考图片'), { statusCode: 400 });
  if (requestedType === 'FIRST&LAST' && (referenceCount < 1 || referenceCount > profile.maxImages)) throw Object.assign(new Error('首尾帧模式需要 1～2 张图片'), { statusCode: 400 });
  if (requestedType === 'REFERENCE' && (referenceCount < 1 || referenceCount > profile.maxImages)) throw Object.assign(new Error(`参考元素模式需要 1～${profile.maxImages} 张图片`), { statusCode: 400 });

  return {
    profileKey: profile.key,
    modelId: profile.modelId,
    provider: profile.provider,
    model: profile.key === 'standard' ? standardModelForDuration() : profile.model,
    generationType: requestedType,
    aspectRatio,
    duration,
    quality,
    pricing: profile.pricing || null,
    maxImages: profile.maxImages,
  };
}

export function buildVideoPayload(task, refs) {
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
