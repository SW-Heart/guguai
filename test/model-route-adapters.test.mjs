import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../server.mjs';

const task = {
  model: 'upstream-model', prompt: '镜头推进', duration: 15,
  aspectRatio: '16:9', quality: '720p',
  referenceLimits: { image: 1, video: 1, audio: 1 },
};
const refs = { images: ['image-1', 'image-2'], videos: ['video-1'], audios: ['audio-1'] };

test('dynamic route adapters preserve each supplier field contract', () => {
  assert.deepEqual(__test.routedVideoPayload({ ...task, routeAdapter: 'wj-video' }, refs), {
    model: 'upstream-model', prompt: '镜头推进', seconds: 15, aspect_ratio: '16:9',
    images: ['image-1'], videos: ['video-1'], audios: ['audio-1'],
  });
  assert.deepEqual(__test.routedVideoPayload({ ...task, routeAdapter: 'diw-video' }, refs), {
    model: 'upstream-model', prompt: '镜头推进', duration: 15, aspect_ratio: '16:9', resolution: '720p',
    images: ['image-1'], videos: ['video-1'], audios: ['audio-1'],
  });
  assert.deepEqual(__test.routedVideoPayload({ ...task, routeAdapter: 'cntcn-video' }, refs), {
    model: 'upstream-model', prompt: '镜头推进', seconds: 15, aspect_ratio: '16:9', resolution: '720p',
    reference_image_urls: ['image-1'], reference_videos: ['video-1'], reference_audios: ['audio-1'],
  });
});

test('DIW receives every repeated reference position', () => {
  const repeated = Array(8).fill('https://example.test/same.png');
  const payload = __test.routedVideoPayload({ ...task, routeAdapter:'diw-video', referenceLimits:{ image:9, video:0, audio:0 } }, { images:repeated, videos:[], audios:[] });
  assert.deepEqual(payload.images, repeated);
});

test('1080p routes preserve supplier resolution and the configured upstream model', () => {
  for (const routeAdapter of ['diw-video', 'wj-video', 'cntcn-video']) {
    const payload = __test.routedVideoPayload({ ...task, videoModelId:'seedance-2.0', model:'configured-seedance-1080p', quality:'1080p', routeAdapter }, refs);
    assert.equal(payload.model, 'configured-seedance-1080p');
    if (routeAdapter !== 'wj-video') assert.equal(payload.resolution, '1080p');
  }
});

test('AutoDL routes submit and poll the configured workflow with the route key', async () => {
  const { createRoutedProvider } = await import('../providers/routed.mjs');
  const { createAutodlProvider } = await import('../providers/autodl.mjs');
  const calls = [];
  const fetchJson = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', auth: options.headers?.Authorization, body: options.body ? JSON.parse(options.body) : null });
    return options.method === 'POST'
      ? { code: 'Success', data: { task_id: 'autodl-task-1', status: 'running' } }
      : { code: 'Success', data: { status: 'success', results: [{ type: 'video', url: 'https://cdn.example/out.mp4' }] } };
  };
  const shared = {
    fetchJson, sleep: async () => {}, notifyVideoProgress: async () => {}, errorMessage: (value, fallback) => value?.msg || fallback,
    upstreamRequestErrorDetail: error => error.message, isDefinitiveSubmitRejection: () => false,
    videoPollTimeoutError: () => new Error('timeout'),
  };
  const routed = createRoutedProvider({
    ...shared,
    routeCredential: id => id === 'autodl-backup' ? 'route-key' : '',
    videoPollRemainingMs: () => 60_000, videoPollRequestSignal: () => undefined, videoPollStartedAt: () => Date.now(), videoMaxPollDurationMs: 60_000,
    createAutodlRouteProvider: options => createAutodlProvider({ ...shared, ...options, pollIntervalMs: 0 }),
  });
  const routedTask = {
    provider: 'autodl', model: 'minimax_h3_1440', prompt: '雨夜街头', duration: 10, aspectRatio: '9:16', quality: '1440p',
    referenceLimits: { image: 9, video: 0, audio: 3 }, routeId: 'route-1', routeAdapter: 'autodl-comfyui',
    routeBaseUrl: 'https://autodl.example/', routeCredentialId: 'autodl-backup',
  };
  const submitted = [];
  const result = await routed.createVideo(routedTask, { images: ['https://ref.example/a.png'], videos: [], audios: [] }, { onSubmitted: value => submitted.push(value) });
  assert.equal(result.url, 'https://cdn.example/out.mp4');
  assert.deepEqual(submitted, [{ provider: 'autodl', taskId: 'autodl-task-1' }]);
  assert.equal(calls[0].url, 'https://autodl.example/api/v1/comfyui/comfyui_workflow/minimax_h3_1440');
  assert.equal(calls[0].auth, 'Bearer route-key');
  assert.deepEqual(calls[0].body, { prompt: '雨夜街头', duration: 10, resolution: '1440p竖(1440*2560)', ref_image_0: 'https://ref.example/a.png' });
  assert.equal(calls[1].url, 'https://autodl.example/api/v1/comfyui/comfyui_workflow/result/autodl-task-1');

  for (const references of [[], { images:[], videos:[], audios:[] }, { images:[], videos:[], audios:['https://ref.example/audio.mp3'] }]) {
    calls.length = 0;
    await routed.createVideo({ ...routedTask, videoModelId:'minimax-h3-15s' }, references, { deferPolling:true });
    assert.equal(calls[0].url, 'https://autodl.example/api/v1/comfyui/comfyui_workflow/minimax_h3_z0901');
    assert.equal(calls[0].auth, 'Bearer route-key');
    assert.equal(calls[0].body.resolution, '1440p竖(1440*2560)');
    assert.equal(calls[0].body.ref_image_0, undefined);
    if (references.audios?.length) assert.equal(calls[0].body.ref_audio_0, references.audios[0]);
  }
  calls.length = 0;
  await routed.createVideo({ ...routedTask, videoModelId:'minimax-h3-15s', generationType:'TEXT' }, { images:['https://ref.example/a.png'], audios:[] }, { deferPolling:true });
  assert.equal(calls[0].url, 'https://autodl.example/api/v1/comfyui/comfyui_workflow/minimax_h3_1440', 'actual reference images determine the workflow');
  assert.equal(calls[0].body.ref_image_0, 'https://ref.example/a.png');

  calls.length = 0;
  await routed.createVideo({ ...routedTask, videoModelId:'other-video-model' }, [], { deferPolling:true });
  assert.equal(calls[0].url, 'https://autodl.example/api/v1/comfyui/comfyui_workflow/minimax_h3_1440', 'unrelated custom workflows remain configured');

  const resumed = await routed.pollVideo({ ...routedTask, providerTaskId: 'autodl-task-1' }, {}, { pollOnce: true });
  assert.equal(resumed.url, 'https://cdn.example/out.mp4');

  await assert.rejects(() => routed.createVideo({ ...routedTask, routeCredentialId: 'missing' }, [], {}), error => error.upstreamTerminal === true && error.routeAttempt === true);
});

test('AutoDL resolution labels include frame size for high resolutions', async () => {
  const { createAutodlProvider } = await import('../providers/autodl.mjs');
  const fn = () => {};
  const provider = createAutodlProvider({ baseUrl:'https://autodl.example', workflowId:'wf', apiKey:'k', fetchJson:fn, sleep:fn, notifyVideoProgress:fn, upstreamRequestErrorDetail:fn, isDefinitiveSubmitRejection:fn, errorMessage:fn, videoPollTimeoutError:fn });
  for (const [quality, aspectRatio, resolution] of [
    ['480p', '16:9', '480p横(864*480)'], ['768p', '9:16', '768p竖(768*1376)'],
    ['1088p', '9:16', '1088p竖(1088*1920)'], ['1088p', '16:9', '1088p横(1920*1088)'],
    ['1440p', '9:16', '1440p竖(1440*2560)'], ['1440p', '16:9', '1440p横(2560*1440)'],
  ]) assert.equal(provider.payload({ prompt:'p', duration:5, quality, aspectRatio }, []).resolution, resolution);
});
