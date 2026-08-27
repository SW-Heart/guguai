import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../server.mjs');

test('uncertain async submission times out five minutes after task creation', () => {
  const createdAt = '2026-08-24T06:44:07.975Z';
  const task = {
    id: 'generation-1', provider: 'cntcn', status: 'running', providerTaskId: '',
    submissionUncertain: true, createdAt,
  };
  const created = Date.parse(createdAt);

  assert.equal(__test.awaitingProviderTaskId(task), true);
  assert.equal(__test.providerTaskIdDeadline(task), created + 5 * 60_000);
  assert.equal(__test.providerTaskIdTimedOut(task, created + 5 * 60_000 - 1), false);
  assert.equal(__test.providerTaskIdTimedOut(task, created + 5 * 60_000), true);
});

test('routed video submission timeout leaves margin for slow channel responses', () => {
  assert.equal(__test.routedVideoSubmitTimeoutMs, 180_000);
});

test('task with an upstream task ID is never treated as a submission timeout', () => {
  const task = {
    provider: 'cntcn', status: 'running', providerTaskId: 'upstream-123',
    submissionUncertain: true, createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.awaitingProviderTaskId(task), false);
  assert.equal(__test.providerTaskIdTimedOut(task, Date.parse('2026-08-25T06:44:07.975Z')), false);
});

test('startup recovery grace also covers non-durable providers without a task ID', () => {
  const task = {
    id: 'image-generation-1', type: 'image', provider: 'duomi', status: 'running',
    providerTaskId: '', sourceUrl: '', submissionUncertain: true,
    createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.awaitingProviderTaskId(task), true);
  assert.equal(__test.providerTaskIdTimedOut(task, Date.parse('2026-08-24T06:49:07.974Z')), false);
  assert.equal(__test.providerTaskIdTimedOut(task, Date.parse('2026-08-24T06:49:07.975Z')), true);
});

test('a generation result awaiting archive is not treated as a missing-task-ID timeout', () => {
  const task = {
    provider: 'duomi', status: 'running', providerTaskId: '',
    sourceUrl: 'https://example.com/result.png', submissionUncertain: true,
    createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.awaitingProviderTaskId(task), false);
});

test('model-unresponsive failures expose the dedicated public failure message', () => {
  const task = {
    status: 'failed', error: '模型无响应：超过5分钟未获得上游任务 ID',
    creditStatus: 'refunded', createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.generationFailureCode(task), 'MODEL_UNRESPONSIVE');
  const value = __test.publicGeneration(task);
  assert.equal(value.failure.code, 'MODEL_UNRESPONSIVE');
  assert.match(value.error, /^模型无响应。/);
  assert.match(value.error, /预扣积分已退回/);
});

test('public assets expose authenticated delivery endpoints without leaking upstream URLs', () => {
  const value = __test.publicAsset({
    id: 'generation-1', ownerId: 'user-1', storageName: 'generation-1.mp4',
    sourceUrl: 'https://upstream.example/result.mp4', sourceRequiresAuth: true,
    sourceGenerationId: 'generation-task-1', kind: 'video', mimeType: 'video/mp4',
    size: 42, createdAt: '2026-08-24T06:44:07.975Z', updatedAt: '2026-08-24T06:44:07.975Z',
  });

  assert.equal(value.url, '/api/files/generation-1/content');
  assert.equal(value.directUrl, '/api/files/generation-1/direct');
  assert.equal(value.sourceUrl, undefined);
  assert.equal(value.sourceRequiresAuth, undefined);
});
