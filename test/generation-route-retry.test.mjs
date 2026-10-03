import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, closeDatabase, resetForTests, sql } from '../lib/db.mjs';
import { createModelRoute, ensureDefaultModelRoutes, modelRoute, modelRouteCharge, selectModelRoute, updateModelRoute, updateRoutePolicy } from '../lib/model-routes.mjs';
import { recordModelRouteFailure } from '../lib/model-route-health.mjs';
import { chargeGenerationMicro, refundGenerationMicro, grantSignupBonus, walletOf, recentCreditEntries } from '../lib/ledger.mjs';
import { prepareGenerationRetry, refreshGenerationRetryRoute } from '../services/generation-retry.mjs';
import { createRoutedProvider } from '../providers/routed.mjs';

const request = { logicalModelId:'seedance-2.5', quality:'1080p', duration:30, aspectRatio:'9:16', referenceCounts:{ image:4 } };

test('routed generation retry order and fixed billing', async t => {
  const originalKey = process.env.DIW_KEY;
  t.beforeEach(() => {
    resetForTests();
    openDatabase({ file:':memory:' });
    process.env.DIW_KEY = 'test-key';
    ensureDefaultModelRoutes();
  });
  t.afterEach(() => {
    closeDatabase({ checkpoint:false });
    if (originalKey === undefined) delete process.env.DIW_KEY;
    else process.env.DIW_KEY = originalKey;
  });

  const addRoute = (upstreamModelId, priority, salePriceYuan, durations = [30]) => createModelRoute({
    logicalModelId:request.logicalModelId, quality:request.quality, credentialId:'diw-main',
    upstreamModelId, priority, salePriceYuan, costYuan:salePriceYuan, durations,
  });
  const makeTask = route => ({
    id:'generation-test', type:'video', modelId:request.logicalModelId, quality:request.quality,
    duration:30, aspectRatio:'9:16', provider:route.provider, model:route.upstreamModelId,
    routeId:route.id, routeVersion:route.version, routePriority:route.priority,
    routeDisplayName:route.displayName, routeAdapter:route.adapterType,
    routeBaseUrl:route.baseUrl, routeCredentialId:route.credentialId,
    referenceLimits:{ image:30, video:10, audio:10, total:50 },
    creditCost:108, creditCostMicro:108000000, creditStatus:'charged',
    pricingSnapshot:{ ...modelRouteCharge(route, 30), routeId:route.id },
  });

  await t.test('four primary submissions then one fallback survive reloads and refund only the original 108 credits', async () => {
    const first = addRoute('bd-seedance-2.5-720p', 1, 0.36);
    const next = addRoute('TX官方-seedance-2.5-720p', 2, 0.86);
    addRoute('third-channel', 3, 0.9);
    sql(`INSERT INTO users(id, username, password_hash, created_at, doc_json) VALUES('u', 'retry-user', 'hash', 'now', '{}')`).run();
    await grantSignupBonus('u', 1000);
    let task = makeTask(first);
    await chargeGenerationMicro('u', task.id, task.creditCostMicro);
    const acceptedPrice = structuredClone(task.pricingSnapshot);
    const submittedModels = [];
    const provider = createRoutedProvider({
      fetchJson:async (_, options) => {
        if (options.method === 'POST') {
          submittedModels.push(JSON.parse(options.body).model);
          return { id:`upstream-${submittedModels.length}` };
        }
        return { status:'failed', error:'503 service unavailable' };
      },
      sleep:async () => {}, routeCredential:() => 'test-key',
      videoPollRemainingMs:() => 1000, videoPollRequestSignal:() => undefined,
      videoPollTimeoutError:() => new Error('timeout'), videoPollStartedAt:() => 0,
      videoMaxPollDurationMs:1000, notifyVideoProgress:async () => {},
      upstreamRequestErrorDetail:error => error.message, isDefinitiveSubmitRejection:() => true,
      errorMessage:value => String(value),
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts });
      }
      const error = await provider.createVideo(task, [], { onSubmitted:({ taskId }) => { task.providerTaskId = taskId; } })
        .then(() => assert.fail('provider should fail'), error => error);
      recordModelRouteFailure({ routeId:task.routeId, error, generationId:task.id });
      assert.equal(prepareGenerationRetry(task, error), attempt < 5);
      assert.equal(task.creditCostMicro, 108000000);
      assert.deepEqual(task.pricingSnapshot, acceptedPrice);
      assert.equal(walletOf('u').balance, 892);
      if (attempt === 3) {
        assert.equal(modelRoute(first.id).autoDisabled, true);
        assert.equal(selectModelRoute(request).id, next.id);
      }
      task = JSON.parse(JSON.stringify(task));
    }
    assert.deepEqual(submittedModels, [first.upstreamModelId, first.upstreamModelId, first.upstreamModelId, first.upstreamModelId, next.upstreamModelId]);
    assert.equal(task.generationRetryCount, 4);
    assert.equal(task.generationFallbackRouteId, next.id);
    assert.equal(modelRouteCharge(next, 30).total, 258);
    await refundGenerationMicro('u', task.id, task.creditCostMicro);
    await refundGenerationMicro('u', task.id, task.creditCostMicro);
    assert.equal(walletOf('u').balance, 1000);
    const entries = recentCreditEntries('u', 100);
    assert.equal(entries.filter(entry => entry.type === 'generation_charge').length, 1);
    assert.equal(entries.filter(entry => entry.type === 'generation_refund').length, 1);
    assert.equal(entries.reduce((sum, entry) => sum + entry.amountMicro, 0), walletOf('u').balanceMicro);
  });

  await t.test('fallback skips unavailable and incompatible channels in priority order, even under a forced policy', () => {
    const first = addRoute('primary', 1, 0.36);
    const disabled = addRoute('disabled', 2, 0.5);
    addRoute('wrong-duration', 3, 0.6, [5]);
    const next = addRoute('compatible', 4, 0.86);
    updateModelRoute(disabled.id, { adminEnabled:false });
    updateRoutePolicy(request.logicalModelId, request.quality, first.id);
    const task = { ...makeTask(first), generationRetryCount:4 };
    assert.equal(refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts }).id, next.id);
    assert.equal(task.creditCost, 108);
    assert.equal(task.pricingSnapshot.routeId, first.id);
  });

  await t.test('no remaining channel ends the job instead of replaying the primary or resetting its retry budget', () => {
    const first = addRoute('only-primary', 1, 0.36);
    const task = { ...makeTask(first), generationRetryCount:4 };
    let error;
    try { refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts }); }
    catch (failure) { error = failure; }
    assert.match(error.message, /暂无其他可用/);
    assert.equal(prepareGenerationRetry(task, error), false);
    assert.equal(task.routeId, first.id);
    assert.equal(task.creditCostMicro, 108000000);
  });

  await t.test('legacy jobs without a saved priority fall back after their current channel', () => {
    addRoute('higher-priority', 1, 0.36);
    const primary = addRoute('accepted-channel', 2, 0.36);
    const next = addRoute('next-channel', 3, 0.86);
    const task = { ...makeTask(primary), generationRetryCount:4 };
    delete task.routePriority;
    assert.equal(refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts }).id, next.id);
  });
});
