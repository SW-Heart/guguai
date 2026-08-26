import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import {
  __test as routeTest,
  checkModelRoutes,
  ensureDefaultModelRoutes,
  listModelRoutes,
  publicModelPrices,
  selectModelRoute,
  updateModelRoute,
  updateRoutePolicy,
} from '../lib/model-routes.mjs';

const originalKeys = {};
for (const name of ['DIW_KEY', 'WJ_TJWD_KEY', 'WJ_SD_PY_900_KEY', 'CNTCN_KEY']) originalKeys[name] = process.env[name];

function freshDb() {
  resetForTests();
  openDatabase({ file: ':memory:' });
  process.env.DIW_KEY = 'diw-test';
  process.env.WJ_TJWD_KEY = 'wj-test';
  process.env.WJ_SD_PY_900_KEY = 'wj-py-test';
  process.env.CNTCN_KEY = 'cntcn-test';
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
    assert.equal(listModelRoutes().length, 24);
    assert.equal(routeTest.saleMicroFromCostFen(215), 25_800_000);
    const selected = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' });
    assert.equal(selected.id, 'sd20-480-diw-nd');
    assert.equal(selected.salePriceYuan, 2.58);
    assert.equal(selected.salePriceCredits, 25.8);
    assert.equal(publicModelPrices().find(item => item.modelId === 'seedance-2.5' && item.quality === '720p').yuan, 7.2);
  });

  await t.test('manual choice is preferred but still falls back after it is disabled', () => {
    const policy = updateRoutePolicy('seedance-2.0', '720p', 'sd20-720-diw-ed', { expectedVersion: 1 });
    assert.equal(policy.forcedRouteId, 'sd20-720-diw-ed');
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-720-diw-ed');
    const route = listModelRoutes().find(item => item.id === 'sd20-720-diw-ed');
    updateModelRoute(route.id, { adminEnabled: false }, { expectedVersion: route.version });
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-720-diw-cd');
  });

  await t.test('route-specific reference limits skip the WJ image-only key', () => {
    updateRoutePolicy('seedance-2.0', '720p', 'sd20-720-wj-py900', { expectedVersion: 1 });
    const imageOnly = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '1:1', referenceCounts: { image: 9 } });
    assert.equal(imageOnly.id, 'sd20-720-wj-py900');
    const withVideo = selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '720p', duration: 15, aspectRatio: '1:1', referenceCounts: { image: 1, video: 1 } });
    assert.equal(withVideo.id, 'sd20-720-diw-cd');
  });

  await t.test('missing catalog models are disabled and automatically return when listed again', async () => {
    const response = ids => async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    await checkModelRoutes({ routeIds: ['sd20-480-diw-nd'], fetchImpl: response([]) });
    assert.equal(sql("SELECT catalog_status FROM model_routes WHERE id='sd20-480-diw-nd'").get().catalog_status, 'missing');
    assert.notEqual(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-480-diw-nd');
    await checkModelRoutes({ routeIds: ['sd20-480-diw-nd'], fetchImpl: response(['nd-seedance-2.0 480p']) });
    assert.equal(selectModelRoute({ logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' }).id, 'sd20-480-diw-nd');
  });
});
