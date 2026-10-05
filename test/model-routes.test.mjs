import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import {
  __test as routeTest,
  checkModelRoutes,
  consolidateSeedanceModelRoutes,
  createModelRoute,
  deleteModelRoute,
  createModelRouteCredential,
  ensureDefaultModelRoutes,
  listModelRouteChannels,
  listModelRoutes,
  availableModelRouteQualities,
  publicModelPrices,
  modelRouteCharge,
  routeCredential,
  SEEDANCE_ROUTE_MODEL_IDS,
  selectModelRoute,
  updateModelRoute,
  updateModelRouteCredential,
  updateRoutePolicy,
} from '../lib/model-routes.mjs';
import { publicVideoCapabilitiesWithControls } from '../lib/model-controls.mjs';
import { canvasGenerationOptions, canvasGenerationPayload, reconcileCanvasGenerationDraft } from '../public/features/drama/canvas-generation.js';
import { normalizeShotVideoParameters } from '../public/features/drama/pure.js';

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
  sql("UPDATE model_routes SET catalog_status='available'").run();
}

function cleanupDb() {
  closeDatabase({ checkpoint: false });
  resetForTests();
  for (const [name, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function createAvailableRoute(input) {
  const route = createModelRoute(input);
  sql("UPDATE model_routes SET catalog_status='available' WHERE id=:id").run({id:route.id});
  return route;
}

test('Seedance route selection, pricing and catalog health', async t => {
  t.beforeEach(freshDb);
  t.afterEach(cleanupDb);

  await t.test('deleting a route resets forced selection and survives default initialization', () => {
    const route = listModelRoutes()[0];
    updateRoutePolicy(route.logicalModelId, route.quality, route.id);
    assert.throws(() => deleteModelRoute(route.id, { expectedVersion: route.version + 1 }), { statusCode: 409 });
    assert.ok(listModelRoutes().some(item => item.id === route.id));
    deleteModelRoute(route.id, { expectedVersion: route.version });
    assert.equal(sql('SELECT forced_route_id FROM model_route_policies WHERE logical_model_id=:modelId AND quality=:quality').get({ modelId: route.logicalModelId, quality: route.quality }).forced_route_id, null);
    ensureDefaultModelRoutes();
    assert.ok(!listModelRoutes().some(item => item.id === route.id));
    assert.ok(selectModelRoute({ logicalModelId: route.logicalModelId, quality: route.quality, duration: route.durationSeconds, aspectRatio: '16:9' }).id !== route.id);
    assert.equal(sql("SELECT COUNT(*) AS count FROM audit_events WHERE action='model_route.delete'").get().count, 1);
    assert.throws(() => deleteModelRoute(route.id, { expectedVersion: route.version }), { statusCode: 404 });
  });

  await t.test('seeds all priority routes and calculates the exact 20% markup', () => {
    assert.equal(listModelRoutes().length, 25);
    assert.equal(routeTest.saleMicroFromCostFen(215), 25_800_000);
    const selected = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' });
    assert.equal(selected.id, 'sd20-480-diw-nd');
    assert.equal(selected.salePriceYuan, 0.172);
    assert.equal(selected.salePriceCredits, 1.72);
    const fast = selectModelRoute({ logicalModelId: 'seedance-2.0-fast', quality: '720p', duration: 15, aspectRatio: '16:9' });
    assert.equal(fast.id, 'sd20-fast-720-diw-ed');
    assert.equal(fast.provider, 'diw');
    assert.equal(fast.upstreamModelId, 'ed-seedance 2.0 fast 720p');
    assert.equal(fast.costYuan, 0.1);
    assert.equal(fast.salePriceYuan, 0.12);
    assert.equal(fast.salePriceCredits, 1.2);
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.5' && item.quality === '720p').yuan, 0.24);
  });

  await t.test('Seedance Mini uses configured routes, durations, prices and fallback independently', () => {
    const modelId = 'seedance-2.0-mini';
    const visible = () => publicVideoCapabilitiesWithControls().models.find(model => model.id === modelId);
    assert.equal(visible(), undefined);
    const primary = createAvailableRoute({ logicalModelId:modelId, quality:'1080p', credentialId:'diw-main', upstreamModelId:'mini-primary', durations:[5,10,15], priority:1, costYuan:0.5, salePriceYuan:1 });
    const fallback = createAvailableRoute({ logicalModelId:modelId, quality:'1080p', credentialId:'wj-tjwd', upstreamModelId:'mini-fallback', durations:[5,10], priority:2, costYuan:0.6, salePriceYuan:1.2 });
    assert.equal(visible().label, 'Seedance 2.0 Mini');
    for (const mode of visible().modes) {
      assert.deepEqual(mode.qualityOptions, ['1080p']);
      assert.deepEqual(mode.durations, [5,10,15]);
    }
    const request = { logicalModelId:modelId, quality:'1080p', duration:10, aspectRatio:'16:9' };
    for (const image of [0,9]) assert.equal(selectModelRoute({ ...request, referenceCounts:{image,video:3,audio:3} }).id, primary.id);
    const price = publicModelPrices().find(item => item.modelId === modelId && item.quality === '1080p');
    assert.equal(price.label, 'Seedance 2.0 Mini');
    assert.equal(price.yuan, 1);
    assert.equal(modelRouteCharge(primary, 10).total, 100);
    updateRoutePolicy(modelId, '1080p', fallback.id);
    assert.equal(selectModelRoute(request).id, fallback.id);
    updateModelRoute(fallback.id, { adminEnabled:false }, { expectedVersion:fallback.version });
    assert.equal(selectModelRoute(request).id, primary.id);
    updateModelRoute(primary.id, { adminEnabled:false }, { expectedVersion:primary.version });
    assert.equal(visible(), undefined);
  });

  await t.test('Seedance 2.5 1080p appears only with an available configured route', () => {
    const qualities = modelId => publicVideoCapabilitiesWithControls().models.find(model => model.id === modelId).modes.map(mode => mode.qualityOptions);
    assert.ok(qualities('seedance-2.5').every(options => !options.includes('1080p')));
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.5' && item.quality === '1080p').available, false);
    const route = createAvailableRoute({ logicalModelId:'seedance-2.5', quality:'1080p', credentialId:'diw-main', upstreamModelId:'seedance-2.5-1080p-test', priority:1, costYuan:10, salePriceYuan:12 });
    assert.ok(qualities('seedance-2.5').every(options => options.includes('1080p')));
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.5' && item.quality === '1080p').yuan, 12);
    assert.equal(selectModelRoute({ logicalModelId:'seedance-2.5', quality:'1080p', duration:30, aspectRatio:'16:9' }).id, route.id);
    updateRoutePolicy('seedance-2.5', '1080p', route.id);
    updateModelRoute(route.id, { adminEnabled:false }, { expectedVersion:route.version });
    assert.ok(qualities('seedance-2.5').every(options => !options.includes('1080p')));
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.5' && item.quality === '1080p').available, false);
    assert.throws(() => createModelRoute({ logicalModelId:'seedance-2.0-fast', quality:'1080p', credentialId:'diw-main', upstreamModelId:'invalid-1080p', priority:1, costYuan:1, salePriceYuan:2 }), { statusCode:400 });
  });

  await t.test('Seedance 2.0 hides a resolution when its routes are unavailable', () => {
    assert.ok(availableModelRouteQualities('seedance-2.0').includes('480p'));
    for (const route of listModelRoutes().filter(item => item.logicalModelId === 'seedance-2.0' && item.quality === '480p')) {
      updateModelRoute(route.id, { adminEnabled:false }, { expectedVersion:route.version });
    }
    const model = publicVideoCapabilitiesWithControls().models.find(item => item.id === 'seedance-2.0');
    assert.ok(model.modes.every(mode => !mode.qualityOptions.includes('480p')));
    assert.ok(model.modes.every(mode => mode.qualityOptions.includes('720p')));
  });

  await t.test('Seedance 2.0 shares 1080p routes across text and reference requests', () => {
    const mode = type => publicVideoCapabilitiesWithControls().models.find(model => model.id === 'seedance-2.0')?.modes.find(mode => mode.generationType === type) || {qualityOptions:[]};
    const price = () => publicModelPrices().find(item => item.modelId === 'seedance-2.0' && item.quality === '1080p');
    assert.ok(!mode('TEXT').qualityOptions.includes('1080p'));
    assert.ok(!mode('REFERENCE').qualityOptions.includes('1080p'));
    const route = createAvailableRoute({ logicalModelId:SEEDANCE_ROUTE_MODEL_IDS.TEXT, quality:'1080p', credentialId:'diw-main', upstreamModelId:'sd20-1080p', durations:[5,10,15], priority:1, costYuan:1, salePriceYuan:2 });
    assert.equal(route.logicalModelId, 'seedance-2.0');
    for (const type of ['TEXT', 'REFERENCE']) assert.ok(mode(type).qualityOptions.includes('1080p'));
    assert.deepEqual(mode('TEXT').durationsByQuality['1080p']['16:9'], [5,10,15]);
    assert.equal(price().yuan, 2);
    assert.equal(modelRouteCharge(route, 10).total, 200);
    updateRoutePolicy(SEEDANCE_ROUTE_MODEL_IDS.IMAGE, '1080p', route.id);
    const fallback = createAvailableRoute({ logicalModelId:SEEDANCE_ROUTE_MODEL_IDS.IMAGE, quality:'1080p', credentialId:'wj-tjwd', upstreamModelId:'sd20-fallback-1080p', priority:2, costYuan:1, salePriceYuan:3 });
    for (const image of [0, 1]) assert.equal(selectModelRoute({ logicalModelId:'seedance-2.0', quality:'1080p', duration:15, aspectRatio:'16:9', referenceCounts:{image} }).id, route.id);
    assert.throws(() => updateModelRoute(route.id, { logicalModelId:'seedance-2.0-fast' }), { statusCode:400 });
    updateModelRouteCredential('diw-main', { enabled:false });
    for (const type of ['TEXT', 'REFERENCE']) assert.ok(mode(type).qualityOptions.includes('1080p'));
    assert.equal(price().yuan, 3);
    updateModelRoute(fallback.id, { adminEnabled:false });
    for (const type of ['TEXT', 'REFERENCE']) assert.ok(!mode(type).qualityOptions.includes('1080p'));
    assert.equal(price().available, false);
    updateModelRouteCredential('diw-main', { enabled:true });
    for (const type of ['TEXT', 'REFERENCE']) assert.ok(mode(type).qualityOptions.includes('1080p'));
    delete process.env.DIW_KEY;
    for (const type of ['TEXT', 'REFERENCE']) assert.ok(!mode(type).qualityOptions.includes('1080p'));
    process.env.DIW_KEY = 'diw-test';
    const restored = listModelRoutes().find(item => item.id === route.id);
    deleteModelRoute(route.id, { expectedVersion:restored.version });
    for (const type of ['TEXT', 'REFERENCE']) assert.ok(!mode(type).qualityOptions.includes('1080p'));
  });

  await t.test('Seedance 2.0 frontend choices follow live 1080p availability', () => {
    const config = () => ({ videoCapabilities:publicVideoCapabilitiesWithControls() });
    const draft = { type:'video', modelId:'seedance-2.0', mode:'TEXT', prompt:'镜头推进', aspect:'16:9', quality:'1080p', duration:10, attachments:[] };
    assert.ok(!canvasGenerationOptions(draft, config()).qualities.includes('1080p'));
    const route = createAvailableRoute({ logicalModelId:SEEDANCE_ROUTE_MODEL_IDS.TEXT, quality:'1080p', credentialId:'diw-main', upstreamModelId:'sd20-1080p', durations:[5,10,15], priority:1, costYuan:1, salePriceYuan:2 });
    assert.ok(canvasGenerationOptions(draft, config()).qualities.includes('1080p'));
    assert.equal(canvasGenerationPayload(draft, config()).quality, '1080p');
    const shot = { aspectRatio:'16:9', duration:10, generation:{ quality:'1080p' } };
    const mode = () => config().videoCapabilities.models.find(model => model.id === 'seedance-2.0').modes.find(mode => mode.generationType === 'TEXT');
    normalizeShotVideoParameters(shot, mode());
    assert.equal(shot.generation.quality, '1080p');
    updateModelRoute(route.id, { adminEnabled:false });
    assert.ok(!canvasGenerationOptions(draft, config()).qualities.includes('1080p'));
    reconcileCanvasGenerationDraft(draft, config());
    normalizeShotVideoParameters(shot, mode());
    assert.notEqual(draft.quality, '1080p');
    assert.notEqual(shot.generation.quality, '1080p');
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
      label: 'Seedance 2.0 Fast', duration: 15, available: true, credits: 1.2, yuan: 0.12,
      selectedRouteId: 'sd20-fast-720-diw-ed',
    });
  });

  await t.test('historical Seedance aliases share selection, pricing and duplicate checks', () => {
    const route = createAvailableRoute({ logicalModelId:'seedance2.0_img', quality:'720p', credentialId:'diw-main', upstreamModelId:'seedance-shared-test', priority:1, costYuan:1, salePriceYuan:2 });
    assert.equal(route.logicalModelId, 'seedance-2.0');
    for (const logicalModelId of ['seedance-2.0', SEEDANCE_ROUTE_MODEL_IDS.TEXT, SEEDANCE_ROUTE_MODEL_IDS.IMAGE]) {
      for (const image of [0, 1]) assert.equal(selectModelRoute({ logicalModelId, quality:'720p', duration:15, aspectRatio:'16:9', referenceCounts:{image} }).id, route.id);
      assert.throws(() => createModelRoute({ logicalModelId, quality:'720p', credentialId:'diw-main', upstreamModelId:'seedance-shared-test', priority:2, costYuan:1, salePriceYuan:2 }), { statusCode:409 });
    }
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.0' && item.quality === '720p').selectedRouteId, route.id);
  });

  await t.test('consolidation merges historical routes without startup and survives reseeding', () => {
    const id = 'sd20-480-diw-nd';
    sql(`INSERT INTO model_routes(id, logical_model_id, display_name, provider, adapter_type, base_url, credential_id, upstream_model_id, quality, duration_seconds, priority, cost_fen, sale_price_fen, admin_enabled, catalog_status, catalog_message, catalog_details_json, catalog_checked_at, consecutive_failures, version, updated_by, updated_at, runtime_failures, auto_disabled_at, auto_disabled_reason, durations_json, billing_unit) SELECT 'historical-image', 'seedance-2.0-img', display_name, provider, adapter_type, base_url, credential_id, upstream_model_id, quality, duration_seconds, priority, 300, 400, admin_enabled, catalog_status, catalog_message, catalog_details_json, catalog_checked_at, consecutive_failures, 7, 'admin', '2099-01-01', runtime_failures, auto_disabled_at, auto_disabled_reason, '[5,15]', 'second' FROM model_routes WHERE id=:id`).run({id});
    sql(`INSERT INTO model_route_policies(logical_model_id, quality, forced_route_id, version, updated_at) VALUES('seedance-2.0-text', '480p', :id, 4, '2098-01-01')`).run({id});
    sql(`INSERT INTO model_route_policies(logical_model_id, quality, forced_route_id, version, updated_at) VALUES('seedance-2.0-img', '480p', 'historical-image', 5, '2099-01-01')`).run();
    consolidateSeedanceModelRoutes();
    assert.ok(!listModelRoutes().some(route => route.id === id));
    const retained = listModelRoutes().find(route => route.id === 'historical-image');
    assert.equal(retained.logicalModelId, 'seedance-2.0');
    assert.equal(retained.costFen, 300);
    assert.equal(retained.salePriceYuan, 4);
    assert.deepEqual(retained.durations, [5,15]);
    assert.equal(sql("SELECT forced_route_id FROM model_route_policies WHERE logical_model_id='seedance-2.0' AND quality='480p'").get().forced_route_id, retained.id);
    assert.equal(sql("SELECT COUNT(*) AS n FROM model_route_policies WHERE logical_model_id IN ('seedance-2.0-text','seedance-2.0-img')").get().n, 0);
    const before = listModelRoutes();
    ensureDefaultModelRoutes();
    assert.deepEqual(listModelRoutes(), before);
    assert.equal(sql("SELECT COUNT(*) AS n FROM audit_events WHERE action='model_route.consolidate'").get().n, 1);
  });

  await t.test('route priorities stay unique inside a pool and other routes make room', () => {
    const pool = { logicalModelId: 'seedance-2.5', quality: '720p' };
    const priorities = () => listModelRoutes().filter(item => item.logicalModelId === pool.logicalModelId && item.quality === pool.quality).map(item => [item.id, item.priority]);
    for (const route of listModelRoutes().filter(item => item.logicalModelId === pool.logicalModelId && item.quality === pool.quality)) deleteModelRoute(route.id, { expectedVersion: route.version });
    const make = (name, priority) => createModelRoute({ ...pool, credentialId: 'diw-main', upstreamModelId: name, priority, costYuan: 1, salePriceYuan: 2 });
    const [a, b, c] = [make('a', 1), make('b', 2), make('c', 3)];
    const d = make('d', 1);
    assert.deepEqual(priorities(), [[d.id, 1], [a.id, 2], [b.id, 3], [c.id, 4]]);
    const current = listModelRoutes().find(item => item.id === c.id);
    updateModelRoute(c.id, { priority: 1 }, { expectedVersion: current.version });
    assert.deepEqual(priorities(), [[c.id, 1], [d.id, 2], [a.id, 3], [b.id, 4]]);
    assert.equal(selectModelRoute({ ...pool, duration: c.durationSeconds, aspectRatio: '16:9' }).id, c.id);
    // Routes of other pools keep their priorities.
    const outside = () => listModelRoutes().filter(item => item.logicalModelId !== pool.logicalModelId || item.quality !== pool.quality).map(item => [item.id, item.priority, item.version]);
    const before = outside();
    assert.ok(before.length > 0);
    make('e', 1);
    assert.deepEqual(outside(), before);
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


test('channel durations are editable for historical routes and drive selected capabilities', () => {
  freshDb();
  try {
    const id = 'sd25-480-diw-vd';
    const historical = listModelRoutes().find(route => route.id === id);
    assert.deepEqual(historical.durations, [30]);
    assert.equal(historical.costYuan, 0.15);
    const edited = updateModelRoute(id, { durations: '30, 5, 6, 7, 15, 20, 5', costYuan: 0.125, salePriceYuan: 0.25 });
    assert.deepEqual(edited.durations, [5,6,7,15,20,30]);
    assert.equal(edited.costYuan, 0.125);
    assert.equal(edited.salePriceMicro * 7, 17_500_000);
    assert.equal(modelRouteCharge(edited, 7).totalMicro, 17_500_000);
    assert.equal(modelRouteCharge(edited, 7).costYuan, 0.875);
    assert.equal(modelRouteCharge(edited, 30).total, 75);
    assert.throws(() => modelRouteCharge(edited, 8), /不支持所选时长/);
    const parameters = publicVideoCapabilitiesWithControls().models.find(model => model.id === 'seedance-2.5').modes[0];
    assert.deepEqual(parameters.durationsByQuality['480p']['16:9'], edited.durations);
    assert.equal(selectModelRoute({ logicalModelId:'seedance-2.5', quality:'480p', duration:7 }).id, id);
    assert.equal(selectModelRoute({ logicalModelId:'seedance-2.5', quality:'480p', duration:8 }), null);
    updateModelRoute(id, { durations:[30] });
    assert.equal(selectModelRoute({ logicalModelId:'seedance-2.5', quality:'480p', duration:7 }), null);
    assert.throws(() => updateModelRoute(id, { durations:[] }), /整数秒数/);
    assert.deepEqual(listModelRoutes().find(route => route.id === id).durations, [30]);
    const created = createModelRoute({ logicalModelId:'seedance-2.5', quality:'720p', credentialId:'diw-main', upstreamModelId:'custom-duration', priority:1, costYuan:0.1, salePriceYuan:0.2, durations:[5,7] });
    assert.deepEqual(created.durations, [5,7]);
    assert.equal(created.salePriceMicro * 5, 10_000_000);
    assert.ok(availableModelRouteQualities('seedance-2.5').includes('720p'));
  } finally { cleanupDb(); }
});
