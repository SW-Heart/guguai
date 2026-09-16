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

test('recovery keeps a terminal provider failure pending when a retry is scheduled', async () => {
  const task = { id:'g', type:'video', providerTaskId:'old' };
  const service = createGenerationRecoveryService({ activeGenerations:new Map(), now:() => 'now', saveGeneration:async () => {}, saveGenerationWithRetry:async () => {}, completeGenerationResult:async () => assert.fail(), failGeneration:async (_, task, error) => prepareGenerationRetry(task, error) });
  await service.resume('u', task, { poll:async () => { throw Object.assign(new Error('provider failed'), { upstreamTerminal:true }); } });
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

test('a routed retry selects and applies the latest highest-priority channel without changing its charge', () => {
  const task = {
    id:'g', type:'video', generationRetryCount:2, routeId:'route-1', videoModelId:'seedance-2.5',
    model:'old-upstream', provider:'old-provider', quality:'720p', duration:30, aspectRatio:'9:16',
    pricingSnapshot:{ routeId:'route-1', totalMicro:1230000 }, creditCostMicro:1230000,
  };
  let request;
  const route = refreshGenerationRetryRoute(task, {
    referenceCounts:{ image:2, video:1, audio:0 },
    selectModelRoute(value) {
      request = value;
      return {
        id:'route-2', version:7, displayName:'当前最优渠道', provider:'new-provider', adapterType:'new-video',
        baseUrl:'https://new.example.com', credentialId:'credential-2', upstreamModelId:'new-upstream',
        capabilities:{ image:3, video:1, audio:1 },
      };
    },
  });
  assert.equal(route.id, 'route-2');
  assert.deepEqual(request, {
    logicalModelId:'seedance-2.5', quality:'720p', duration:30, aspectRatio:'9:16',
    referenceCounts:{ image:2, video:1, audio:0 },
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
});

test('initial submissions and non-routed retries do not select another channel', () => {
  const selectModelRoute = () => assert.fail('route selection should be skipped');
  assert.equal(refreshGenerationRetryRoute({ routeId:'route-1', generationRetryCount:0 }, { selectModelRoute }), null);
  assert.equal(refreshGenerationRetryRoute({ generationRetryCount:1 }, { selectModelRoute }), null);
});
