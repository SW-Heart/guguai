import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationLifecycleService } from '../services/generations.mjs';

test('generation lifecycle service owns durable state markers', async () => {
  const saved = [];
  const service = createGenerationLifecycleService({
    now: () => '2026-09-05T00:00:00.000Z',
    saveGenerationWithRetry: async (...args) => { saved.push(args); return true; },
    providerTaskIdDeadline: () => 100,
  });
  const task = { id: 'generation-1', status: 'queued', creditStatus: 'held' };
  service.markRunning(task);
  assert.deepEqual(task, { id: 'generation-1', status: 'running', creditStatus: 'held', finishedAt: null });
  service.markSubmissionUncertain(task, new Error('提交结果待确认'));
  assert.equal(task.submissionUncertain, true);
  assert.equal(task.creditStatus, 'charged');
  assert.equal(task.lastSubmissionError, '提交结果待确认');
  service.markProviderTaskPaused(task, new Error('网络中断'));
  assert.match(task.error, /网络中断/);
  service.markFinished({ status: 'completed' });
  service.markSubmissionTimedOut(task);
  assert.equal(task.submissionUncertain, false);
  assert.equal(task.submissionTimedOut, true);
  assert.equal(service.isSubmissionTimedOut({ status: 'running', submissionUncertain: true }, 100), true);
  await service.persist('user-1', task, 'test');
  assert.deepEqual(saved, [['user-1', task, 'test']]);
});
