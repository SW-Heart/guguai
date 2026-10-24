import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase, closeDatabase, resetForTests } from '../lib/db.mjs';
import { ensureDefaultModelRoutes, createModelRouteCredential, createModelRoute, checkModelRoutes, selectModelRoute, updateModelRoute, updateRoutePolicy, deleteModelRoute, publicModelPrices, modelRouteCharge, routeCredential } from '../lib/model-routes.mjs';
import { modelControl, updateModelControl, publicVideoCapabilitiesWithControls, validateControlledVideoRequest } from '../lib/model-controls.mjs';
import { createRoutedProvider } from '../providers/routed.mjs';

test('Wan admin configuration covers all resolutions, routing, billing, and generation protocol', async () => {
  resetForTests();
  openDatabase({ file: ':memory:' });
  const originalSecret = process.env.MODEL_ROUTE_CREDENTIAL_SECRET;
  process.env.MODEL_ROUTE_CREDENTIAL_SECRET = 'wan-test-secret';
  try {
    ensureDefaultModelRoutes();
    assert.ok(modelControl('wan-3.0').enabled);
    assert.ok(!publicVideoCapabilitiesWithControls().models.some(model => model.id === 'wan-3.0'));
    const credential = createModelRouteCredential({ channelName: 'UNMAU', label: 'Wan', provider: 'unmau', adapterType: 'diw-video', baseUrl: 'https://mjnewapi.unmau.com', apiKey: 'wan-test-key' });
    const routes = ['480p', '720p', '1080p'].map(quality => createModelRoute({ logicalModelId: 'wan-3.0', quality, credentialId: credential.id, upstreamModelId: `wd-wan-3.0-${quality}`, durations: [5, 10, 15], priority: 1, costYuan: 0.1, salePriceYuan: 0.2 }));
    await checkModelRoutes({ routeIds: routes.map(route => route.id), fetchImpl: async url => {
      assert.equal(url, 'https://mjnewapi.unmau.com/v1/models');
      return { ok: true, text: async () => JSON.stringify({ data: routes.map(route => ({ id: route.upstreamModelId })) }) };
    } });
    const model = publicVideoCapabilitiesWithControls().models.find(model => model.id === 'wan-3.0');
    assert.equal(model.label, 'Wan 3.0');
    assert.equal(model.iconKey, 'wan');
    assert.match(model.description, /图片、视频和音频/);
    assert.match(model.description, /480p、720p、1080p/);
    for (const mode of model.modes) {
      assert.deepEqual(mode.qualityOptions, ['480p', '720p', '1080p']);
      assert.deepEqual(mode.durations, [5, 10, 15]);
    }
    for (const route of routes) {
      const request = validateControlledVideoRequest({ modelId: 'wan-3.0', quality: route.quality });
      assert.equal(request.provider, 'route');
      assert.equal(request.duration, 15);
      assert.equal(selectModelRoute({ logicalModelId: 'wan-3.0', quality: route.quality, duration: 10, aspectRatio: '16:9' }).id, route.id);
      assert.equal(publicModelPrices().find(price => price.modelId === 'wan-3.0' && price.quality === route.quality).label, 'Wan 3.0');
    }
    for (const route of routes) updateModelRoute(route.id, { aspectRatios: ['16:9', '9:16'], referenceLimits: { image: 2, video: 1, audio: 1 } });
    const request = validateControlledVideoRequest({ modelId: 'wan-3.0', generationType: 'REFERENCE', quality: '720p' }, 3);
    assert.deepEqual(request.referenceLimits, { image: 2, video: 1, audio: 1, total: 4 });
    const selected = routes[1];
    updateRoutePolicy('wan-3.0', '720p', selected.id);
    const changed = updateModelRoute(selected.id, { billingUnit: 'request', salePriceYuan: 2 });
    assert.equal(modelRouteCharge(changed, 15).total, 20);
    const calls = [];
    const provider = createRoutedProvider({
      fetchJson: async (url, options) => {
        calls.push({ url, options });
        return options.method === 'POST' ? { id: 'task_wan', object: 'video', status: 'queued', progress: 0 }
          : { id: 'task_wan', status: 'completed', progress: 100, url: '/v1/videos/task_wan/content' };
      }, sleep: async () => {}, routeCredential,
      videoPollRemainingMs: () => 10000, videoPollRequestSignal: () => undefined,
      videoPollTimeoutError: () => new Error('timeout'), videoPollStartedAt: () => 0, videoMaxPollDurationMs: 10000,
      notifyVideoProgress: async () => {}, upstreamRequestErrorDetail: error => error.message,
      isDefinitiveSubmitRejection: () => false, errorMessage: value => String(value),
    });
    const task = { ...request, provider: selected.provider, model: selected.upstreamModelId, prompt: '电影感产品展示镜头', routeAdapter: selected.adapterType, routeBaseUrl: selected.baseUrl, routeCredentialId: credential.id };
    const refs = { images: ['https://cdn.example.com/image.png'], videos: ['https://cdn.example.com/video.mp4'], audios: ['https://cdn.example.com/audio.mp3'] };
    const result = await provider.createVideo(task, refs);
    assert.equal(calls[0].url, 'https://mjnewapi.unmau.com/v1/videos');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer wan-test-key');
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'wd-wan-3.0-720p', prompt: task.prompt, duration: 15, aspect_ratio: '16:9', resolution: '720p', ...refs });
    assert.equal(calls[1].url, 'https://mjnewapi.unmau.com/v1/videos/task_wan');
    assert.equal(result.url, 'https://mjnewapi.unmau.com/v1/videos/task_wan/content');
    assert.equal(result.requiresAuth, true);
    const disabled = updateModelRoute(selected.id, { adminEnabled: false });
    assert.equal(selectModelRoute({ logicalModelId: 'wan-3.0', quality: '720p', duration: 15, aspectRatio: '16:9' }), null);
    deleteModelRoute(selected.id, { expectedVersion: disabled.version });
    updateModelControl('wan-3.0', { userVisible: false });
    assert.ok(!publicVideoCapabilitiesWithControls().models.some(model => model.id === 'wan-3.0'));
  } finally {
    closeDatabase({ checkpoint: false });
    resetForTests();
    if (originalSecret === undefined) delete process.env.MODEL_ROUTE_CREDENTIAL_SECRET;
    else process.env.MODEL_ROUTE_CREDENTIAL_SECRET = originalSecret;
  }
});

test('Wan admin route groups and cache version are available', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  assert.match(source, /'wan-3\.0': 'Wan 3\.0'/);
  assert.match(source, /const families = \['wan-3\.0'/);
  assert.match(source, /wd-wan-3\.0-720p/);
  const html = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/guguadmin.js?v=65'));
  assert.ok(!html.includes('/guguadmin.js?v=41'));
});
