import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoPayload, publicVideoCapabilities, validateVideoRequest, VIDEO_MODEL_IDS } from '../lib/video-capabilities.mjs';

test('video catalog exposes GuGu 2.0 as available in launch order', () => {
  const models = publicVideoCapabilities().models;
  assert.deepEqual(models.map(model => model.label), [
    'GuGu 2.0', 'GuGu 1.5', 'Seedance 2.0', 'Seedance 2.5', 'Seedance 2.0 Fast', 'MiniMax H3', 'Omni Flash', 'Veo 3.1', 'Veo 3.1 Fast',
  ]);
  const minimaxH315s = models.find(model => model.id === VIDEO_MODEL_IDS.MINIMAX_H3_15S);
  assert.equal(minimaxH315s?.availability, 'available');
  assert.equal(minimaxH315s?.description, '支持最多 9 张参考图片 + 3 段参考音频，1～15 秒视频生成');
  assert.equal(minimaxH315s?.modes.find(mode => mode.generationType === 'TEXT')?.pricing.amount, 0.5);
  assert.deepEqual(minimaxH315s?.modes.find(mode => mode.generationType === 'REFERENCE')?.referenceLimits, { image: 9, video: 0, audio: 3, total: 12 });
  const request = validateVideoRequest({ modelId: VIDEO_MODEL_IDS.MINIMAX_H3_15S, generationType: 'TEXT', aspectRatio: '16:9', duration: 5, quality: '768p' });
  assert.equal(request.modelId, VIDEO_MODEL_IDS.MINIMAX_H3_15S);
  assert.equal(request.profileKey, 'minimax-h3-15s');
  assert.equal(request.provider, 'autodl');
  assert.equal(request.model, 'minimax_h3_image_audio_to_video_v2_15s');
  const legacyRequest = validateVideoRequest({ modelId: 'grok-15', generationType: 'TEXT', aspectRatio: '16:9', duration: 5, quality: '768p' });
  assert.equal(legacyRequest.modelId, VIDEO_MODEL_IDS.MINIMAX_H3_15S);
  assert.throws(
    () => validateVideoRequest({ modelId: VIDEO_MODEL_IDS.MINIMAX_H3_15S, generationType: 'TEXT', aspectRatio: '16:9', duration: 5, quality: '1080p' }),
    error => error.statusCode === 400 && /不支持所选清晰度/.test(error.message),
  );
});

test('first and last frame mode selects continuity profile and enforces eight seconds', () => {
  const request = validateVideoRequest({ generationType:'FIRST&LAST', aspectRatio:'9:16', duration:8, quality:'1080p' }, 2);
  assert.equal(request.profileKey, 'continuity');
  assert.equal(request.provider, 'duomi');
  assert.equal(request.model, 'veo-fast');
  assert.equal(request.generationType, 'FIRST&LAST');
  assert.equal(request.duration, 8);
  assert.throws(() => validateVideoRequest({ generationType:'FIRST&LAST', aspectRatio:'9:16', duration:10 }, 2), /固定为 8 秒/);
});

test('eight-second text and reference modes select the Veo routing', () => {
  const reference = validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'9:16', duration:8 }, 4);
  const text = validateVideoRequest({ generationType:'TEXT', aspectRatio:'16:9', duration:8 }, 0);
  assert.equal(reference.profileKey, 'veo');
  assert.equal(reference.provider, 'duomi');
  assert.equal(reference.model, 'veo-fast');
  assert.equal(text.profileKey, 'veo');
  assert.equal(text.provider, 'duomi');
  assert.equal(text.model, 'veo-fast');
  assert.throws(() => validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'16:9', duration:8 }, 8), /1～7 个参考素材/);
});

test('standard Grok requests support the TTAPI Fast model durations', () => {
  for (const duration of [10, 15, 20, 30]) {
    const request = validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'9:16', duration }, 1);
    assert.equal(request.profileKey, 'standard');
    assert.equal(request.provider, 'ttapi');
    assert.equal(request.model, 'grok-imagine-video-1.5-fast');
  }
  for (const duration of [4, 6, 25]) {
    assert.throws(() => validateVideoRequest({ generationType:'TEXT', aspectRatio:'16:9', duration }, 0), new RegExp(`不支持 ${duration} 秒`));
  }
});

test('reference image order is preserved in the provider payload', () => {
  const request = validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'16:9', duration:20 }, 3);
  const ordered = ['prop-url', 'character-url', 'location-url'];
  const payload = buildVideoPayload({ model:request.model, prompt:'test', aspectRatio:request.aspectRatio, duration:request.duration, quality:request.quality, generationType:request.generationType, videoProfile:request.profileKey, maxReferenceImages:request.maxImages }, ordered);
  assert.deepEqual(payload.image_urls, ordered);
});

test('legacy image to video requests retain standard model compatibility', () => {
  const request = validateVideoRequest({ aspectRatio:'9:16', duration:20 }, 4);
  assert.equal(request.profileKey, 'standard');
  assert.equal(request.provider, 'ttapi');
  assert.equal(request.model, 'grok-imagine-video-1.5-fast');
  const payload = buildVideoPayload({ model:request.model, prompt:'test', aspectRatio:request.aspectRatio, duration:request.duration, quality:request.quality, generationType:request.generationType, videoProfile:request.profileKey, maxReferenceImages:request.maxImages }, ['a','b','c','d']);
  assert.equal(payload.generation_type, undefined);
  assert.equal(payload.image_urls.length, 4);
});

test('continuity payload follows provider field contract', () => {
  const payload = buildVideoPayload({ model:'configured-in-env', prompt:'广告', aspectRatio:'16:9', duration:8, quality:'4k', generationType:'FIRST&LAST', videoProfile:'continuity', maxReferenceImages:3 }, ['first','last']);
  assert.deepEqual(payload, { model:'configured-in-env', prompt:'广告', aspect_ratio:'16:9', duration:8, quality:'4k', generation_type:'FIRST&LAST', image_urls:['first','last'] });
});

test('MiniMax H3 exposes one model with resolution-specific pricing and routing', () => {
  const model = publicVideoCapabilities().models.find(item => item.id === VIDEO_MODEL_IDS.MINIMAX_H3);
  assert.ok(model);
  assert.deepEqual(model.modes.find(mode => mode.generationType === 'TEXT').qualityOptions, ['768p', '2k']);
  assert.equal(model.modes.find(mode => mode.generationType === 'TEXT').pricingByQuality['768p'].amount, 2);
  assert.equal(model.modes.find(mode => mode.generationType === 'TEXT').pricingByQuality['2k'].amount, 3);

  const low = validateVideoRequest({ modelId: 'minimax-h3', generationType: 'TEXT', aspectRatio: '21:9', duration: 4, quality: '768p' });
  assert.equal(low.provider, 'oai');
  assert.equal(low.model, 'minimax-h3-768p');
  assert.equal(low.pricing.amount, 2);
  assert.equal(low.duration, 4);

  const high = validateVideoRequest({ modelId: 'minimax-h3', generationType: 'REFERENCE', aspectRatio: '3:4', duration: 15, quality: '2k' }, 5);
  assert.equal(high.model, 'minimax-h3-2k');
  assert.equal(high.pricing.amount, 3);
  assert.equal(high.maxImages, 5);
});

test('MiniMax H3 payload follows its ratio and reference field contract', () => {
  const payload = buildVideoPayload({
    model: 'minimax-h3-2k', videoModelId: 'minimax-h3', videoProfile: 'minimax-h3-reference',
    prompt: '角色转身', aspectRatio: '9:16', duration: 6, generationType: 'REFERENCE', maxReferenceImages: 5,
  }, ['ref-1', 'ref-2']);
  assert.deepEqual(payload, { model: 'minimax-h3-2k', prompt: '角色转身', duration: 6, ratio: '9:16', referenceImages: ['ref-1', 'ref-2'] });

  const frames = buildVideoPayload({
    model: 'minimax-h3-768p', videoModelId: 'minimax-h3', videoProfile: 'minimax-h3-first-last',
    prompt: '镜头推进', aspectRatio: '16:9', duration: 8, generationType: 'FIRST&LAST', maxReferenceImages: 2,
  }, ['first', 'last']);
  assert.deepEqual(frames, { model: 'minimax-h3-768p', prompt: '镜头推进', duration: 8, ratio: '16:9', first_image: 'first', last_image: 'last' });
});

test('Seedance 2.0 exposes the dynamic route capabilities', () => {
  const model = publicVideoCapabilities().models.find(item => item.id === VIDEO_MODEL_IDS.SEEDANCE_2);
  assert.ok(model);
  assert.equal(model.availability, 'available');
  assert.deepEqual(model.modes.map(mode => mode.generationType), ['TEXT', 'REFERENCE']);
  assert.deepEqual(model.modes[0].aspectRatios, ['16:9', '9:16', '1:1']);
  assert.deepEqual(model.modes[0].durations, [15]);
  assert.deepEqual(model.modes[0].qualityOptions, ['480p', '720p']);
  assert.equal(model.modes[0].pricing, null);
  assert.deepEqual(model.modes[1].referenceLimits, { image: 9, video: 3, audio: 3, total: 15 });

  const request = validateVideoRequest({ modelId: VIDEO_MODEL_IDS.SEEDANCE_2, generationType: 'REFERENCE', aspectRatio: '1:1', duration: 15, quality: '720p' }, 2);
  assert.equal(request.provider, 'route');
  assert.equal(request.model, '');
  assert.throws(() => validateVideoRequest({ modelId: VIDEO_MODEL_IDS.SEEDANCE_2, generationType: 'TEXT', aspectRatio: '16:9', duration: 10, quality: '720p' }), /不支持 10 秒/);
  assert.deepEqual(buildVideoPayload({
    videoModelId: VIDEO_MODEL_IDS.SEEDANCE_2, model: request.model, prompt: '混合参考', aspectRatio: '16:9', duration: 15, quality: '720p', referenceLimits: request.referenceLimits,
  }, { images: ['image-url'], videos: ['video-url'], audios: ['audio-url'] }), {
    model: request.model, prompt: '混合参考', aspect_ratio: '16:9', seconds: 15, resolution: '720p',
    reference_image_urls: ['image-url'], reference_videos: ['video-url'], reference_audios: ['audio-url'],
  });
});

test('Seedance 2.0 Fast exposes the DIW fixed 15-second model capabilities', () => {
  const model = publicVideoCapabilities().models.find(item => item.id === VIDEO_MODEL_IDS.SEEDANCE_2_FAST);
  assert.ok(model);
  assert.equal(model.label, 'Seedance 2.0 Fast');
  assert.match(model.description, /固定 15 秒、720p/);
  assert.deepEqual(model.modes[0].aspectRatios, ['16:9', '1:1', '9:16']);
  assert.deepEqual(model.modes[0].durations, [15]);
  assert.equal(model.modes[0].qualityOptions[0], '720p');
  assert.deepEqual(model.modes[1].referenceLimits, { image: 9, video: 3, audio: 3, total: 15 });

  const request = validateVideoRequest({ modelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, generationType: 'REFERENCE', aspectRatio: '1:1', duration: 15, quality: '720p' }, 15);
  assert.equal(request.provider, 'route');
  assert.equal(request.model, '');
  assert.equal(request.referenceLimits.total, 15);
  assert.throws(() => validateVideoRequest({ modelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, generationType: 'REFERENCE', aspectRatio: '16:9', duration: 14, quality: '720p' }), /不支持 14 秒/);
  assert.throws(() => validateVideoRequest({ modelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST, generationType: 'REFERENCE', aspectRatio: '16:9', duration: 15, quality: '720p' }, 16), /1～15 个参考素材/);

  assert.deepEqual(buildVideoPayload({
    videoModelId: VIDEO_MODEL_IDS.SEEDANCE_2_FAST,
    videoProfile: request.profileKey,
    model: request.model,
    prompt: '@图片1 @视频1 @音频1',
    aspectRatio: request.aspectRatio,
    duration: request.duration,
    quality: request.quality,
    referenceLimits: request.referenceLimits,
  }, { images: ['image-url'], videos: ['video-url'], audios: ['audio-url'] }), {
    model: request.model, prompt: '@图片1 @视频1 @音频1', aspect_ratio: '1:1', seconds: 15, resolution: '720p',
    reference_image_urls: ['image-url'], reference_videos: ['video-url'], reference_audios: ['audio-url'],
  });
});
