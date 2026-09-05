import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerationRecoveryService } from '../services/generation-recovery.mjs';

function recoveryDependencies(overrides = {}) {
  const activeGenerations = new Map();
  const saved = [];
  return {
    activeGenerations,
    now: () => '2026-09-05T00:00:00.000Z',
    saveGeneration: async (_userId, task) => saved.push(`save:${task.id}`),
    saveGenerationWithRetry: async (_userId, task, phase) => saved.push(`retry:${phase}:${task.id}`),
    completeGenerationResult: async (_userId, task) => { task.status = 'completed'; },
    failGeneration: async (_userId, task) => { task.status = 'failed'; },
    saved,
    ...overrides,
  };
}

test('generation recovery deduplicates active work and persists the final state', async () => {
  const dependencies = recoveryDependencies();
  const service = createGenerationRecoveryService(dependencies);
  const task = { id: 'generation-1', status: 'queued' };
  let release;
  const first = service.resume('user-1', task, {
    startPhase: 'start',
    finalPhase: 'final',
    poll: () => new Promise(resolve => { release = resolve; }),
  });
  const second = service.resume('user-1', task, { poll: async () => ({ url: 'unused' }) });
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  release({ url: 'https://cdn.example/result.mp4' });
  await first;
  assert.equal(task.status, 'completed');
  assert.equal(task.finishedAt, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(dependencies.saved, ['save:generation-1', 'retry:final:generation-1']);
  assert.equal(dependencies.activeGenerations.size, 0);
});

test('generation recovery pauses non-terminal provider failures without refunding', async () => {
  const dependencies = recoveryDependencies();
  const service = createGenerationRecoveryService(dependencies);
  const task = { id: 'generation-2', status: 'queued', creditStatus: 'reserved' };
  await service.resume('user-1', task, {
    finalPhase: 'final',
    pauseMessage: error => `paused:${error.message}`,
    poll: async () => { throw new Error('temporary network error'); },
  });
  assert.equal(task.status, 'running');
  assert.equal(task.creditStatus, 'charged');
  assert.equal(task.error, 'paused:temporary network error');
  assert.equal(task.finishedAt, null);
  assert.deepEqual(dependencies.saved, ['save:generation-2', 'retry:final:generation-2']);
});
