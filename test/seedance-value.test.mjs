import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { publicVideoCapabilities, validateVideoRequest } from '../lib/video-capabilities.mjs';
import { modelControl, publicVideoCapabilitiesWithControls } from '../lib/model-controls.mjs';
import { createModelRoute, ensureDefaultModelRoutes, listModelRoutes, publicModelPrices, selectModelRoute, updateRoutePolicy, updateModelRoute, modelRouteCharge } from '../lib/model-routes.mjs';
import { canvasGenerationModels, canvasGenerationOptions, canvasGenerationPayload } from '../public/features/drama/canvas-generation.js';

const description = '价格低，稳定性和质量略低于满血版，生成时间稍长，适合对实效性和质量要求不高的任务';

for (const version of ['2.0', '2.5']) {
  test(`Seedance ${version} 特价 has matching capabilities and independent configurable routes`, () => {
    const originalKey = process.env.DIW_KEY;
    resetForTests();
    openDatabase({ file: ':memory:' });
    process.env.DIW_KEY = 'test-value-key';
    try {
      ensureDefaultModelRoutes();
      const modelId = `seedance-${version}-value`;
      const baseId = `seedance-${version}`;
      const catalog = publicVideoCapabilities().models;
      const value = catalog.find(model => model.id === modelId);
      assert.equal(value.label, `Seedance ${version} 特价`);
      assert.equal(value.description, description);
      assert.deepEqual(value.modes, catalog.find(model => model.id === baseId).modes);
      assert.equal(modelControl(modelId).enabled, true);
      assert.equal(listModelRoutes().filter(route => route.logicalModelId === modelId).length, 0);
      assert.ok(publicModelPrices().filter(price => price.modelId === modelId).every(price => !price.available));
      const baseRoutes = listModelRoutes().filter(route => route.logicalModelId === baseId);
      const route = createModelRoute({ logicalModelId:modelId, quality:'1080p', credentialId:'diw-main', upstreamModelId:`my-${version}-value`, priority:1, durations:[5,10,15,30], costYuan:0.1, salePriceYuan:0.2 });
      assert.ok(!publicVideoCapabilitiesWithControls().models.some(model => model.id === modelId));
      sql("UPDATE model_routes SET catalog_status='available' WHERE id=:id").run({id:route.id});
      updateRoutePolicy(modelId, '1080p', route.id);
      for (const generationType of ['TEXT', 'REFERENCE']) {
        const request = validateVideoRequest({modelId, generationType, quality:'1080p', duration:10, aspectRatio:'1:1'}, generationType === 'REFERENCE' ? 1 : 0);
        assert.equal(request.modelId, modelId);
        assert.equal(request.provider, 'route');
        assert.equal(request.referenceLimits.image, version === '2.0' ? 9 : 30);
        assert.equal(selectModelRoute({logicalModelId:modelId, quality:'1080p', duration:10, aspectRatio:'1:1', referenceCounts:{image:generationType === 'REFERENCE' ? 1 : 0}}).id, route.id);
      }
      assert.equal(modelRouteCharge(route, 10).total, 20);
      const config = {videoCapabilities:publicVideoCapabilitiesWithControls()};
      assert.ok(canvasGenerationModels('video', config).some(model => model.id === modelId));
      const draft = {type:'video', modelId, mode:'TEXT', prompt:'风吹树叶', aspect:'1:1', quality:'1080p', duration:10, attachments:[]};
      assert.deepEqual(canvasGenerationOptions(draft, config).qualities, ['1080p']);
      assert.equal(canvasGenerationPayload(draft, config).modelId, modelId);
      assert.equal(publicModelPrices().find(price => price.modelId === modelId && price.quality === '1080p').yuan, 0.2);
      assert.deepEqual(listModelRoutes().filter(item => item.logicalModelId === baseId), baseRoutes);
      updateModelRoute(route.id, {adminEnabled:false});
      assert.equal(selectModelRoute({logicalModelId:modelId, quality:'1080p'}), null);
      assert.ok(!publicVideoCapabilitiesWithControls().models.some(model => model.id === modelId));
    } finally {
      closeDatabase({checkpoint:false});
      resetForTests();
      if (originalKey === undefined) delete process.env.DIW_KEY; else process.env.DIW_KEY = originalKey;
    }
  });
}
