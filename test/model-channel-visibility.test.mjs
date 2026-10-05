import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { publicVideoCapabilitiesWithControls, isImageModelAvailable, updateModelControl } from '../lib/model-controls.mjs';
import { ensureDefaultModelRoutes, createModelRoute, updateModelRouteCredential } from '../lib/model-routes.mjs';
import { videoModelProviderConfigured } from '../lib/video-capabilities.mjs';

test('all Seedance models disappear without a healthy channel and return after recovery', () => {
  const key = process.env.DIW_KEY;
  resetForTests();
  openDatabase({file:':memory:'});
  process.env.DIW_KEY = 'visibility-test-key';
  try {
    ensureDefaultModelRoutes();
    const visible = id => publicVideoCapabilitiesWithControls().models.some(model => model.id === id);
    for (const id of ['seedance-2.0','seedance-2.0-mini','seedance-2.5','seedance-2.0-fast','seedance-2.0-value','seedance-2.5-value']) {
      updateModelControl(id, {enabled:true, userVisible:true}, {actorUserId:null});
      assert.equal(visible(id), false);
      const route = createModelRoute({logicalModelId:id, quality:'720p', credentialId:'diw-main', upstreamModelId:`visibility-${id}`, durations:[5,15], priority:1, costYuan:0.1, salePriceYuan:0.2});
      assert.equal(visible(id), false);
      for (const status of ['available','missing','credential_error','probe_error','unknown','available']) {
        sql('UPDATE model_routes SET catalog_status=:status WHERE id=:id').run({status, id:route.id});
        assert.equal(visible(id), status === 'available', `${id}: ${status}`);
      }
      updateModelRouteCredential('diw-main', {enabled:false});
      assert.equal(visible(id), false);
      updateModelRouteCredential('diw-main', {enabled:true});
      assert.equal(visible(id), true);
      delete process.env.DIW_KEY;
      assert.equal(visible(id), false);
      process.env.DIW_KEY = 'visibility-test-key';
      sql('UPDATE model_routes SET admin_enabled=0 WHERE id=:id').run({id:route.id});
      assert.equal(visible(id), false);
    }
  } finally {
    closeDatabase({checkpoint:false}); resetForTests();
    if (key === undefined) delete process.env.DIW_KEY; else process.env.DIW_KEY = key;
  }
});

test('fixed video and image models require their own provider credential', () => {
  for (const [modelId, key] of [['grok','TTAPI_API_KEY'],['minimax-h3-15s','AUTODL_COMFYUI_KEY'],['oai','OAIAPI_GEMINI_KEY'],['veo-31','OAIAPI_VEO_KEY'],['veo','DUOMI_API_KEY']]) {
    assert.equal(videoModelProviderConfigured(modelId, {}), false);
    assert.equal(videoModelProviderConfigured(modelId, {[key]:'   '}), false);
    assert.equal(videoModelProviderConfigured(modelId, {[key]:'configured'}), true);
    assert.equal(videoModelProviderConfigured(modelId, {UNRELATED_KEY:'configured'}), false);
  }
  resetForTests(); openDatabase({file:':memory:'});
  try {
    for (const [modelId,key] of [['gpt-image-2','DUOMI_API_KEY'],['gpt-image-2.5','TUZI_DEFAULT_API_KEY'],['midjourney','DUOMI_API_KEY']]) {
      assert.equal(isImageModelAvailable(modelId, {}), false);
      assert.equal(isImageModelAvailable(modelId, {[key]:'configured'}), true);
      updateModelControl(modelId, {userVisible:false}, {actorUserId:null});
      assert.equal(isImageModelAvailable(modelId, {[key]:'configured'}), false);
    }
  } finally { closeDatabase({checkpoint:false}); resetForTests(); }
});
