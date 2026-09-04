import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import {
  __test as routeTest,
  checkModelRoutes,
  createModelRoute,
  createModelRouteCredential,
  ensureDefaultModelRoutes,
  listModelRouteChannels,
  listModelRoutes,
  publicModelPrices,
  routeCredential,
  SEEDANCE_ROUTE_MODEL_IDS,
  selectModelRoute,
  updateModelRoute,
  updateRoutePolicy,
} from '../lib/model-routes.mjs';

const originalKeys = {};
for (const name of ['DIW_KEY', 'WJ_TJWD_KEY', 'WJ_SD_PY_900_KEY', 'CNTCN_KEY', 'MODEL_ROUTE_CREDENTIAL_SECRET']) originalKeys[name] = process.env[name];

function freshDb() {
  resetForTests();
  openDatabase({ file: ':memory:' });
  process.env.DIW_KEY = 'diw-test';
  process.env.WJ_TJWD_KEY = 'wj-test';
  process.env.WJ_SD_PY_900_KEY = 'wj-py-test';
  process.env.CNTCN_KEY = 'cntcn-test';
  process.env.MODEL_ROUTE_CREDENTIAL_SECRET = 'model-route-test-secret';
  ensureDefaultModelRoutes();
}

function cleanupDb() {
  closeDatabase({ checkpoint: false });
  resetForTests();
  for (const [name, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

test('Seedance route selection, pricing and catalog health', async t => {
  t.beforeEach(freshDb);
  t.afterEach(cleanupDb);

  await t.test('seeds all priority routes and calculates the exact 20% markup', () => {
    assert.equal(listModelRoutes().length, 25);
    assert.equal(routeTest.saleMicroFromCostFen(215), 25_800_000);
    const selected = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' });
    assert.equal(selected.id, 'sd20-480-diw-nd');
    assert.equal(selected.salePriceYuan, 2.58);
    assert.equal(selected.salePriceCredits, 25.8);
    const fast = selectModelRoute({ logicalModelId: 'seedance-2.0-fast', quality: '720p', duration: 15, aspectRatio: '16:9' });
    assert.equal(fast.id, 'sd20-fast-720-diw-ed');
    assert.equal(fast.provider, 'diw');
    assert.equal(fast.upstreamModelId, 'ed-seedance 2.0 fast 720p');
    assert.equal(fast.costYuan, 1.5);
    assert.equal(fast.salePriceYuan, 1.8);
    assert.equal(fast.salePriceCredits, 18);
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.5' && item.quality === '720p').yuan, 7.2);
  });

  await t.test('Fast route is included in the public dynamic price catalog', () => {
    const price = publicModelPrices().find(item => item.modelId === 'seedance-2.0-fast' && item.quality === '720p');
    assert.deepEqual(price && {
      label: price.label,
      duration: price.duration,
      available: price.available,
      credits: price.credits,
      yuan: price.yuan,
      selectedRouteId: price.selectedRouteId,
    }, {
      label: 'Seedance 2.0 Fast', duration: 15, available: true, credits: 18, yuan: 1.8,
      selectedRouteId: 'sd20-fast-720-diw-ed',
    });
  });

  await t.test('Seedance 2.0 selects independent text and image pools while displaying text pricing', () => {
    const text = createModelRoute({
      logicalModelId: SEEDANCE_ROUTE_MODEL_IDS.TEXT, quality: '720p', credentialId: 'diw-main', upstreamModelId: 'seedance-text-test',
      priority: 1, costYuan: 1, salePriceYuan: 2,
    });
    const image = createModelRoute({
      logicalModelId: 'seedance2.0_img', quality: '720p', credentialId: 'diw-main', upstreamModelId: 'seedance-image-test',
      priority: 1, costYuan: 1.5, salePriceYuan: 3,
    });
    assert.equal(text.logicalModelId, SEEDANCE_ROUTE_MODEL_IDS.TEXT);
    assert.equal(image.logicalModelId, SEEDANCE_ROUTE_MODEL_IDS.IMAGE);
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '16:9', referenceCounts: { image: 0 } }).id, text.id);
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '16:9', referenceCounts: { image: 1 } }).id, image.id);
    assert.notEqual(selectModelRoute({ logicalModelId: SEEDANCE_ROUTE_MODEL_IDS.IMAGE, quality: '720p', duration: 15, aspectRatio: '16:9', referenceCounts: { image: 0 } })?.id, image.id);
    const publicPrice = publicModelPrices().find(item => item.modelId === 'seedance-2.0' && item.quality === '720p');
    assert.equal(publicPrice.selectedRouteId, text.id);
    assert.equal(publicPrice.yuan, 2);
    assert.equal(publicPrice.credits, 20);
  });

  await t.test('manual choice is preferred but still falls back after it is disabled', () => {
    const policy = updateRoutePolicy('seedance-2.0', '720p', 'sd20-720-diw-ed', { expectedVersion: 1 });
    assert.equal(policy.forcedRouteId, 'sd20-720-diw-ed');
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-720-diw-ed');
    const route = listModelRoutes().find(item => item.id === 'sd20-720-diw-ed');
    updateModelRoute(route.id, { adminEnabled: false }, { expectedVersion: route.version });
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-720-diw-md');
  });

  await t.test('route-specific reference limits skip the WJ image-only key', () => {
    updateRoutePolicy('seedance-2.0', '720p', 'sd20-720-wj-py900', { expectedVersion: 1 });
    const imageOnly = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '1:1', referenceCounts: { image: 9 } });
    assert.equal(imageOnly.id, 'sd20-720-wj-py900');
    const withVideo = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '1:1', referenceCounts: { image: 1, video: 1 } });
    assert.equal(withVideo.id, 'sd20-720-diw-cd');
  });

  await t.test('CD route is selected only when at least one reference image is present', () => {
    const text = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '9:16', referenceCounts: { image: 0 } });
    assert.notEqual(text.id, 'sd20-720-diw-cd');
    const reference = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '9:16', referenceCounts: { image: 1 } });
    assert.equal(reference.id, 'sd20-720-diw-cd');
  });

  await t.test('missing catalog models are disabled and automatically return when listed again', async () => {
    const response = ids => async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    await checkModelRoutes({ routeIds: ['sd20-480-diw-nd'], fetchImpl: response([]) });
    assert.equal(sql("SELECT catalog_status FROM model_routes WHERE id='sd20-480-diw-nd'").get().catalog_status, 'missing');
    assert.notEqual(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-480-diw-nd');
    await checkModelRoutes({ routeIds: ['sd20-480-diw-nd'], fetchImpl: response(['nd-seedance-2.0 480p']) });
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-480-diw-nd');
  });

  await t.test('Fast route visibility follows the DIW model catalog monitor', async () => {
    const response = ids => async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    await checkModelRoutes({ routeIds: ['sd20-fast-720-diw-ed'], fetchImpl: response([]) });
    assert.equal(sql("SELECT catalog_status FROM model_routes WHERE id='sd20-fast-720-diw-ed'").get().catalog_status, 'missing');
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.0-fast' && item.quality === '720p').available, false);
    await checkModelRoutes({ routeIds: ['sd20-fast-720-diw-ed'], fetchImpl: response(['ed-seedance 2.0 fast 720p']) });
    assert.equal(sql("SELECT catalog_status FROM model_routes WHERE id='sd20-fast-720-diw-ed'").get().catalog_status, 'available');
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.0-fast' && item.quality === '720p').available, true);
  });

  await t.test('admin can add a channel route with an independent user price', () => {
    const channels = listModelRouteChannels();
    assert.equal(channels.find(item => item.id === 'wj-py900').configured, true);
    const created = createModelRoute({
      logicalModelId: 'seedance-2.0', quality: '720p', credentialId: 'wj-py900', upstreamModelId: 'custom-seedance-720p',
      priority: 12, costYuan: 1.23, salePriceYuan: 4.56,
    }, { actorUserId: 'admin' });
    assert.equal(created.costYuan, 1.23);
    assert.equal(created.salePriceYuan, 4.56);
    assert.equal(created.salePriceCredits, 45.6);
    assert.equal(created.salePriceConfigured, true);
    assert.equal(created.catalogStatus, 'unknown');
    assert.throws(() => createModelRoute({
      logicalModelId: 'seedance-2.0', quality: '720p', credentialId: 'wj-py900', upstreamModelId: 'custom-seedance-720p',
      priority: 13, costYuan: 1, salePriceYuan: 2,
    }), /相同的上游模型 ID/);
  });

  await t.test('multiple WJ credentials can be added and keep independent model catalogs', async () => {
    const credential = createModelRouteCredential({ channelName: 'WJ', label: 'Seedance 2.5 专用 Key', provider: 'wj', adapterType: 'wj-video', baseUrl: 'https://www.weijinapi.top', apiKey: 'wj-new-model-key' }, { actorUserId: 'admin' });
    assert.equal(credential.channelName, 'WJ');
    assert.equal(credential.configured, true);
    assert.equal(credential.keyHint, '••••••••••••-key');
    assert.equal(Object.hasOwn(credential, 'apiKey'), false);
    assert.notEqual(sql('SELECT api_key_ciphertext FROM model_route_credentials WHERE id = :id').get({ id: credential.id }).api_key_ciphertext, 'wj-new-model-key');
    assert.equal(routeCredential(credential.id), 'wj-new-model-key');
    const created = createModelRoute({ logicalModelId: 'seedance-2.5', quality: '720p', credentialId: credential.id, upstreamModelId: 'seedance2.5-new-model', priority: 1, costYuan: 8, salePriceYuan: 10 });
    let authorization = '';
    await checkModelRoutes({ routeIds: [created.id], fetchImpl: async (_url, options) => { authorization = options.headers.Authorization; return new Response(JSON.stringify({ data: [{ id: 'seedance2.5-new-model' }] }), { status: 200 }); } });
    assert.equal(authorization, 'Bearer wj-new-model-key');
    assert.equal(listModelRouteChannels().find(item => item.id === credential.id).label, 'WJ · Seedance 2.5 专用 Key');
  });
});
