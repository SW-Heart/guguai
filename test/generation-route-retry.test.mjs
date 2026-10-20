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
    createdAt:new Date().toISOString(),
    creditCost:108, creditCostMicro:108000000, creditStatus:'charged',
    pricingSnapshot:{ ...modelRouteCharge(route, 30), routeId:route.id },
  });

  await t.test('each channel is tried twice in priority order, survives reloads and refunds only the original 108 credits', async () => {
    const first = addRoute('bd-seedance-2.5-720p', 1, 0.36);
    const next = addRoute('TX官方-seedance-2.5-720p', 2, 0.86);
    const third = addRoute('third-channel', 3, 0.9);
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
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (attempt > 1) refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts });
      const error = await provider.createVideo(task, [], { onSubmitted:({ taskId }) => { task.providerTaskId = taskId; } })
        .then(() => assert.fail('provider should fail'), error => error);
      // The server reports a job once per channel.
      if (!(task.generationAttempts || []).some(item => item.routeId === task.routeId)) recordModelRouteFailure({ routeId:task.routeId, error, generationId:task.id });
      assert.equal(prepareGenerationRetry(task, error), true);
      assert.equal(task.creditCostMicro, 108000000);
      assert.deepEqual(task.pricingSnapshot, acceptedPrice);
      assert.equal(walletOf('u').balance, 892);
      task = JSON.parse(JSON.stringify(task));
    }
    assert.deepEqual(submittedModels, [first, first, next, next, third, third].map(route => route.upstreamModelId));
    assert.equal(modelRoute(first.id).autoDisabled, false, 'one job alone never pauses a channel');
    assert.equal(modelRoute(first.id).runtimeFailures, 1);
    let exhausted;
    try { refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts }); } catch (error) { exhausted = error; }
    // The job ends with the last real failure, not a generic "try later".
    assert.equal(exhausted.message, '503 service unavailable');
    assert.equal(prepareGenerationRetry(task, exhausted), false);
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
    const task = { ...makeTask(first), generationRetryCount:2, generationAttempts:[{ routeId:first.id }, { routeId:first.id }] };
    assert.equal(refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts }).id, next.id);
    assert.equal(task.creditCost, 108);
    assert.equal(task.pricingSnapshot.routeId, first.id);
  });

  await t.test('no remaining channel ends the job instead of replaying the primary or resetting its retry budget', () => {
    const first = addRoute('only-primary', 1, 0.36);
    const task = { ...makeTask(first), generationRetryCount:2, generationAttempts:[{ routeId:first.id }, { routeId:first.id }] };
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
    const task = { ...makeTask(primary), generationRetryCount:2, generationAttempts:[{ routeId:primary.id }, { routeId:primary.id }] };
    delete task.routePriority;
    assert.equal(refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts:request.referenceCounts }).id, next.id);
  });
});
