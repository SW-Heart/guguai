import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationJobPolicy } from '../jobs/generation-policy.mjs';

const policy = createGenerationJobPolicy({
  imagePollIntervalMs: 10,
  oaiPollIntervalMs: 20,
  autodlPollIntervalMs: 30,
  ttapiPollIntervalMs: 40,
  cntcnPollIntervalMs: 50,
  defaultPollIntervalMs: 60,
  recoverySweepMs: 70,
  archiveRescheduleMs: 100,
  providerTaskIdDeadline: task => task.deadline,
});

test('generation job policy chooses provider intervals without side effects', () => {
  assert.equal(policy.pollInterval({ type: 'image', provider: 'duomi' }), 10);
  assert.equal(policy.pollInterval({ provider: 'oai' }), 20);
  assert.equal(policy.pollInterval({ provider: 'autodl' }), 30);
  assert.equal(policy.pollInterval({ provider: 'ttapi' }), 40);
  assert.equal(policy.pollInterval({ provider: 'cntcn' }), 50);
  assert.equal(policy.pollInterval({ provider: 'duomi', type: 'video' }), 8_000);
  assert.equal(policy.pollInterval({ provider: 'other' }), 60);
});

test('generation job policy keeps recovery kind and bounded backoff deterministic', () => {
  assert.equal(policy.recoveryKind({ archivePending: true, providerTaskId: 'task' }), 'archive');
  assert.equal(policy.recoveryKind({ submissionUncertain: true }), 'reconcile_submission');
  assert.equal(policy.recoveryKind({ providerTaskId: 'task' }), 'poll');
  assert.equal(policy.recoveryKind({}), 'generation');
  assert.equal(policy.nextRunAt({ archiveFailureCount: 2 }, 'archive', 1_000), 1_200);
  assert.equal(policy.nextRunAt({ pollFailureCount: 2, provider: 'oai' }, 'poll', 1_000), 1_080);
  assert.equal(policy.nextRunAt({ deadline: 1_234 }, 'reconcile_submission', 1_000), 1_234);
});
