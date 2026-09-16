import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGenerationRetry, generationRequestLog, generationAttemptContext } from '../services/generation-retry.mjs';
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
