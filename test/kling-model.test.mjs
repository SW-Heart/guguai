import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase, closeDatabase, resetForTests } from '../lib/db.mjs';
import { ensureDefaultModelRoutes, createModelRouteCredential, createModelRoute, checkModelRoutes, selectModelRoute, publicModelPrices } from '../lib/model-routes.mjs';
import { modelControl, publicVideoCapabilitiesWithControls, validateControlledVideoRequest } from '../lib/model-controls.mjs';
import { modelLogoUrl } from '../public/components/model-logo.js';

test('Kling 4.0 stays hidden until an admin route is configured, then follows the shared video rules', async () => {
  resetForTests();
  openDatabase({ file: ':memory:' });
  const originalSecret = process.env.MODEL_ROUTE_CREDENTIAL_SECRET;
  process.env.MODEL_ROUTE_CREDENTIAL_SECRET = 'kling-test-secret';
  try {
    ensureDefaultModelRoutes();
    assert.ok(modelControl('kling-4.0').enabled);
    assert.ok(!publicVideoCapabilitiesWithControls().models.some(model => model.id === 'kling-4.0'));
    const credential = createModelRouteCredential({ channelName: 'Kling', label: 'Kling', provider: 'diw', adapterType: 'diw-video', baseUrl: 'https://kling.example.com', apiKey: 'kling-test-key' });
    const routes = ['480p', '720p', '1080p'].map(quality => createModelRoute({ logicalModelId: 'kling-4.0', quality, credentialId: credential.id, upstreamModelId: `kling-4.0-${quality}`, durations: [5, 10, 15], priority: 1, costYuan: 0.1, salePriceYuan: 0.2 }));
    await checkModelRoutes({ routeIds: routes.map(route => route.id), fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ data: routes.map(route => ({ id: route.upstreamModelId })) }) }) });
    const model = publicVideoCapabilitiesWithControls().models.find(model => model.id === 'kling-4.0');
    assert.equal(model.label, 'Kling 4.0');
    assert.equal(model.iconKey, 'kling');
    for (const mode of model.modes) {
      assert.deepEqual(mode.qualityOptions, ['480p', '720p', '1080p']);
      assert.deepEqual(mode.durations, [5, 10, 15]);
    }
    for (const route of routes) {
      const request = validateControlledVideoRequest({ modelId: 'kling-4.0', quality: route.quality });
      assert.equal(request.provider, 'route');
      assert.equal(request.duration, 15);
      assert.equal(selectModelRoute({ logicalModelId: 'kling-4.0', quality: route.quality, duration: 10, aspectRatio: '16:9' }).id, route.id);
      assert.equal(publicModelPrices().find(price => price.modelId === 'kling-4.0' && price.quality === route.quality).label, 'Kling 4.0');
    }
    const reference = validateControlledVideoRequest({ modelId: 'kling-4.0', generationType: 'REFERENCE', quality: '720p' }, 3);
    assert.equal(reference.generationType, 'REFERENCE');
  } finally {
    closeDatabase({ checkpoint: false });
    resetForTests();
    if (originalSecret === undefined) delete process.env.MODEL_ROUTE_CREDENTIAL_SECRET;
    else process.env.MODEL_ROUTE_CREDENTIAL_SECRET = originalSecret;
  }
});

test('Kling 4.0 is routed in the clients, listed in admin, and has its own logo', () => {
  const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
  assert.match(read('guguadmin.js'), /'kling-4\.0': 'Kling 4\.0'/);
  assert.match(read('guguadmin.js'), /const families = \[[^\]]*'kling-4\.0'/);
  for (const path of ['app.js', 'drama-studio.js']) assert.match(read(path), /'kling-4\.0'/);
  assert.equal(modelLogoUrl('kling-4.0'), '/icons/models/kling-color.svg?v=1');
  assert.equal(modelLogoUrl('custom-kling', 'KLING'), modelLogoUrl('kling-4.0'));
});
