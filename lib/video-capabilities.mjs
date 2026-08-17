const allowedQualities = new Set(['720p', '1080p', '4k']);

export const VIDEO_GENERATION_TYPES = Object.freeze({
  TEXT: 'TEXT',
  FIRST_LAST: 'FIRST&LAST',
  REFERENCE: 'REFERENCE',
});

const profiles = Object.freeze({
  standard: Object.freeze({
    key: 'standard',
    model: process.env.VIDEO_MODEL || 'grok-video-1.5',
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    durations: [6, 10, 15, 20, 25, 30],
    maxImages: 7,
    qualities: ['720p'],
  }),
  veo: Object.freeze({
    key: 'veo',
    model: process.env.VIDEO_VEO_MODEL || process.env.DRAMA_CONTINUITY_VIDEO_MODEL || 'veo3.1-fast',
    generationTypes: ['TEXT', 'REFERENCE'],
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    durations: [8],
    maxImages: 7,
    qualities: ['720p'],
  }),
  continuity: Object.freeze({
    key: 'continuity',
    model: process.env.DRAMA_CONTINUITY_VIDEO_MODEL || 'veo3.1-fast',
    generationTypes: ['FIRST&LAST'],
    aspectRatios: ['16:9', '9:16'],
    durations: [8],
    maxImages: 3,
    qualities: ['720p', '1080p', '4k'],
  }),
});

export function publicVideoCapabilities() {
  return {
    generationTypes: [
      { value: 'TEXT', label: '文本生成', description: '不锁定画面，以镜头提示词直接生成。', minImages: 0, maxImages: 0 },
      { value: 'FIRST&LAST', label: '首尾帧', description: '锁定开始与结束画面，适合连续动作和镜头衔接。', minImages: 1, maxImages: 2 },
      { value: 'REFERENCE', label: '参考元素', description: '将角色、场景或物品作为画面元素参考。', minImages: 1, maxImages: 3 },
    ],
    qualityOptions: ['720p', '1080p', '4k'],
    continuityDuration: 8,
    continuityRatios: ['16:9', '9:16'],
    standardDurations: [...profiles.standard.durations],
    veoDurations: [...profiles.veo.durations],
    standardRatios: [...profiles.standard.aspectRatios],
    routing: [
      { mode:'FIRST&LAST', duration:8, engine:'Veo Fast' },
      { mode:'TEXT|REFERENCE', duration:8, engine:'Veo Fast' },
      { mode:'*', duration:'*', engine:'Grok 1.5' },
    ],
    restrictions: { referencePortraitUnsupported: false },
  };
}

export function validateVideoRequest(input, referenceCount = 0) {
  const requestedType = String(input.generationType || (referenceCount ? 'REFERENCE' : 'TEXT')).toUpperCase();
  if (!Object.values(VIDEO_GENERATION_TYPES).includes(requestedType)) throw Object.assign(new Error('不支持的视频生成模式'), { statusCode: 400 });
  const requestedDuration = Number(input.duration ?? (requestedType === 'FIRST&LAST' ? profiles.continuity.durations[0] : profiles.standard.durations[0]));
  const profile = requestedType === 'FIRST&LAST' ? profiles.continuity : requestedDuration === 8 ? profiles.veo : profiles.standard;
  const aspectRatio = String(input.aspectRatio || '16:9');
  const duration = requestedDuration;
  const quality = allowedQualities.has(input.quality) ? input.quality : '720p';
  if (!profile.aspectRatios.includes(aspectRatio)) throw Object.assign(new Error(`${requestedType === 'FIRST&LAST' ? '首尾帧' : '当前'}模式不支持 ${aspectRatio} 画幅`), { statusCode: 400 });
  if (!profile.durations.includes(duration)) throw Object.assign(new Error(`${requestedType === 'FIRST&LAST' ? '首尾帧模式时长固定为 8 秒' : `当前模式不支持 ${duration} 秒`}`), { statusCode: 400 });
  if (!profile.qualities.includes(quality)) throw Object.assign(new Error('当前视频模式不支持所选清晰度'), { statusCode: 400 });
  if (requestedType === 'TEXT' && referenceCount) throw Object.assign(new Error('文本生成模式不能添加参考图片'), { statusCode: 400 });
  if (requestedType === 'FIRST&LAST' && (referenceCount < 1 || referenceCount > 2)) throw Object.assign(new Error('首尾帧模式需要 1～2 张图片'), { statusCode: 400 });
  if (requestedType === 'REFERENCE' && (referenceCount < 1 || referenceCount > profile.maxImages)) throw Object.assign(new Error(`参考元素模式需要 1～${profile.maxImages} 张图片`), { statusCode: 400 });
  return { profileKey: profile.key, model: profile.model, generationType: requestedType, aspectRatio, duration, quality, maxImages: profile.maxImages };
}

export function buildVideoPayload(task, refs) {
  const payload = {
    model: task.model,
    prompt: task.prompt,
    aspect_ratio: task.aspectRatio,
    duration: task.duration,
    quality: task.quality || '720p',
  };
  if (task.videoProfile === 'continuity') payload.generation_type = task.generationType || (refs.length ? 'REFERENCE' : 'TEXT');
  if (refs.length) payload.image_urls = refs.slice(0, task.maxReferenceImages || 3);
  if (task.videoProfile === 'standard') payload.oversea = false;
  return payload;
}
