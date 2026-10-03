import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGenerationRetry, generationRequestLog, generationAttemptContext, refreshGenerationRetryRoute } from '../services/generation-retry.mjs';
import { createGenerationRecoveryService } from '../services/generation-recovery.mjs';

for (const type of ['image', 'video']) test(`${type}: three persistent retries reset deadlines and retain the original charge`, () => {
  let task = { id:'g', type, createdAt:'2026-01-01T00:00:00Z', creditStatus:'charged' };
  for (let retry = 1; retry <= 3; retry++) {
    Object.assign(task, { providerTaskId:`upstream-${retry}`, submittedAt:task.createdAt, status:'running', progress:80 });
    assert.equal(prepareGenerationRetry(task, Object.assign(new Error('failed'), { upstreamTerminal:true }), `2026-01-01T00:0${retry}:00Z`), true);
    assert.equal(task.status, 'queued');
    assert.equal(task.generationRetryCount, retry);
    assert.equal(task.providerTaskId, '');
    assert.equal(task.submittedAt, null);
    assert.equal(task.creditStatus, 'charged');
    assert.equal(task.finishedAt, null);
    assert.equal(task.error, '');
    assert.equal(task.progress, null);
    task = JSON.parse(JSON.stringify(task));
  }
  assert.equal(prepareGenerationRetry(task, { upstreamTerminal:true }), false);
  assert.equal(task.generationAttempts.length, 3);
});

test('pending, ambiguous submissions, local errors, timeouts and delivered results are not replayed', () => {
  for (const error of [{}, { submissionUncertain:true, upstreamTerminal:true }, { pollTimedOut:true, upstreamTerminal:true }]) {
    assert.equal(prepareGenerationRetry({ type:'video' }, error), false);
  }
  assert.equal(prepareGenerationRetry({ type:'image', sourceUrl:'https://result' }, { upstreamTerminal:true }), false);
});

for (const type of ['image', 'video']) test(`${type}: content review failures receive up to three retries without another charge`, () => {
  for (const error of [
    Object.assign(new Error('request rejected'), { upstreamStatus:451 }),
    Object.assign(new Error('content_policy_violation'), { upstreamStatus:400 }),
    Object.assign(new Error('The generated images appear to be unsafe'), { upstreamTerminal:true }),
    Object.assign(new Error('视频内容审核未通过，涉及敏感内容'), { upstreamTerminal:true }),
    Object.assign(new Error('content review failed: moderation / nsfw'), { upstreamTerminal:true }),
  ]) {
    const task = { type, status:'running', creditStatus:'charged', creditCostMicro:1230000 };
    for (let retry = 1; retry <= 3; retry++) {
      task.providerTaskId = `review-failed-${retry}`;
      assert.equal(prepareGenerationRetry(task, error), true);
      assert.equal(task.generationRetryCount, retry);
      assert.equal(task.status, 'queued');
      assert.equal(task.providerTaskId, '');
      assert.equal(task.error, '');
      assert.equal(task.creditStatus, 'charged');
      assert.equal(task.creditCostMicro, 1230000);
    }
    assert.equal(prepareGenerationRetry(task, error), false);
    assert.equal(task.generationAttempts.length, 3);
    assert.ok(task.generationAttempts.every(attempt => attempt.error === error.message));
  }
});

test('recovery keeps a terminal provider failure pending when a retry is scheduled', async () => {
  const task = { id:'g', type:'video', providerTaskId:'old' };
  const service = createGenerationRecoveryService({ activeGenerations:new Map(), now:() => 'now', saveGeneration:async () => {}, saveGenerationWithRetry:async () => {}, completeGenerationResult:async () => assert.fail(), failGeneration:async (_, task, error) => prepareGenerationRetry(task, error) });
  await service.resume('u', task, { poll:async () => { throw Object.assign(new Error('视频内容审核未通过'), { upstreamTerminal:true }); } });
  assert.equal(task.status, 'queued');
  assert.equal(task.finishedAt, null);
});

test('request logs retain full payloads and mark retries without exposing credentials', async () => {
  const body = new FormData(); body.append('prompt', 'full prompt'); body.append('input_reference', 'https://reference'); body.append('input_reference', 'https://second');
  const log = await generationRequestLog('https://provider', { method:'POST', headers:{ Authorization:'secret' }, body }, { id:'g', generationRetryCount:2 });
  assert.equal(log.attempt, 3); assert.equal(log.isRetry, true);
  assert.equal(log.headers.authorization, '[REDACTED]'); assert.deepEqual(log.body, [...body.entries()]);
  await Promise.all([1, 2].map(id => generationAttemptContext.run({ id }, async () => { await Promise.resolve(); assert.equal(generationAttemptContext.getStore().id, id); })));
});

test('a routed fallback selects the next channel once without changing its charge', () => {
  const task = {
    id:'g', type:'video', generationRetryCount:4, routeId:'route-1', routePriority:1, videoModelId:'seedance-2.5',
    model:'old-upstream', provider:'old-provider', quality:'720p', duration:30, aspectRatio:'9:16',
    pricingSnapshot:{ routeId:'route-1', totalMicro:1230000 }, creditCostMicro:1230000,
  };
  let request;
  const route = refreshGenerationRetryRoute(task, {
    referenceCounts:{ image:2, video:1, audio:0 },
    selectModelRoute(value) {
      request = value;
      return {
        id:'route-2', version:7, priority:2, displayName:'当前最优渠道', provider:'new-provider', adapterType:'new-video',
        baseUrl:'https://new.example.com', credentialId:'credential-2', upstreamModelId:'new-upstream',
        capabilities:{ image:3, video:1, audio:1 },
      };
    },
  });
  assert.equal(route.id, 'route-2');
  assert.deepEqual(request, {
    logicalModelId:'seedance-2.5', quality:'720p', duration:30, aspectRatio:'9:16',
    referenceCounts:{ image:2, video:1, audio:0 },
    excludeRouteIds:['route-1'], afterPriority:1,
  });
  assert.deepEqual({
    routeId:task.routeId, routeVersion:task.routeVersion, provider:task.provider, model:task.model,
    routeDisplayName:task.routeDisplayName, routeAdapter:task.routeAdapter, routeBaseUrl:task.routeBaseUrl,
    routeCredentialId:task.routeCredentialId, referenceLimits:task.referenceLimits,
  }, {
    routeId:'route-2', routeVersion:7, provider:'new-provider', model:'new-upstream',
    routeDisplayName:'当前最优渠道', routeAdapter:'new-video', routeBaseUrl:'https://new.example.com',
    routeCredentialId:'credential-2', referenceLimits:{ image:3, video:1, audio:1, total:5 },
  });
  assert.deepEqual(task.pricingSnapshot, { routeId:'route-1', totalMicro:1230000 });
  assert.equal(task.creditCostMicro, 1230000);
  assert.equal(task.generationFallbackRouteId, 'route-2');
  assert.equal(task.routePriority, 2);
  const persisted = JSON.parse(JSON.stringify(task));
  assert.equal(refreshGenerationRetryRoute(persisted, { selectModelRoute:() => assert.fail('fallback must stay pinned after a restart') }).id, 'route-2');
  assert.equal(prepareGenerationRetry(persisted, { upstreamTerminal:true }), false);
});

test('all three primary retries keep the original channel snapshot and charge', () => {
  let task = {
    id:'g', type:'video', routeId:'route-1', routeVersion:6, routePriority:1,
    model:'bd-seedance-2.5-720p', routeBaseUrl:'https://original.example.com',
    creditStatus:'charged', creditCost:108, creditCostMicro:108000000,
    pricingSnapshot:{ routeId:'route-1', totalMicro:108000000 },
  };
  for (let retry = 1; retry <= 3; retry++) {
    task.providerTaskId = `primary-${retry}`;
    assert.equal(prepareGenerationRetry(task, { upstreamTerminal:true, message:'UPSTREAM_ATTEMPTS_EXHAUSTED' }), true);
    task = JSON.parse(JSON.stringify(task));
    assert.equal(refreshGenerationRetryRoute(task, { selectModelRoute:() => assert.fail('primary retries must not reselect') }).id, 'route-1');
    assert.equal(task.generationRetryCount, retry);
    assert.equal(task.routeVersion, 6);
    assert.equal(task.model, 'bd-seedance-2.5-720p');
    assert.equal(task.creditCostMicro, 108000000);
    assert.deepEqual(task.pricingSnapshot, { routeId:'route-1', totalMicro:108000000 });
  }
  assert.equal(prepareGenerationRetry(task, { upstreamTerminal:true }), true);
  assert.equal(task.generationRetryCount, 4);
  assert.throws(() => refreshGenerationRetryRoute(task, { selectModelRoute:() => null }), /暂无其他可用/);
  assert.equal(prepareGenerationRetry(task, { upstreamTerminal:true }), false);
  assert.equal(task.routeId, 'route-1');
});

test('initial submissions and non-routed retries do not select another channel', () => {
  const selectModelRoute = () => assert.fail('route selection should be skipped');
  assert.equal(refreshGenerationRetryRoute({ routeId:'route-1', generationRetryCount:0 }, { selectModelRoute }), null);
  assert.equal(refreshGenerationRetryRoute({ generationRetryCount:1 }, { selectModelRoute }), null);
});

test('failed routed attempts preserve the model and price before a retry changes channels', () => {
  const task = {
    id:'g', type:'video', routeId:'bd-route', routeVersion:6,
    routeDisplayName:'BD 720p', provider:'diw', model:'bd-seedance-2.5-720p',
    providerTaskId:'first-upstream', creditCostMicro:108000000,
    pricingSnapshot:{ routeId:'bd-route', unitPrice:3.6, quantity:30, totalMicro:108000000 },
  };
  assert.equal(prepareGenerationRetry(task, new Error('local failure')), false);
  assert.equal(prepareGenerationRetry(task, Object.assign(new Error('UPSTREAM_ATTEMPTS_EXHAUSTED'), { upstreamTerminal:true })), true);
  task.routeId = 'tx-route';
  task.model = 'TX官方-seedance-2.5-720p';
  task.pricingSnapshot.unitPrice = 8.6;
  const [attempt] = JSON.parse(JSON.stringify(task)).generationAttempts;
  assert.equal(attempt.routeId, 'bd-route');
  assert.equal(attempt.routeVersion, 6);
  assert.equal(attempt.routeDisplayName, 'BD 720p');
  assert.equal(attempt.provider, 'diw');
  assert.equal(attempt.model, 'bd-seedance-2.5-720p');
  assert.equal(attempt.providerTaskId, 'first-upstream');
  assert.equal(attempt.creditCostMicro, 108000000);
  assert.equal(attempt.pricingSnapshot.unitPrice, 3.6);
  assert.equal(attempt.pricingSnapshot.totalMicro, 108000000);
});
