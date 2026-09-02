import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../server.mjs');

test('all video polling defaults to a 60-minute task budget', () => {
  assert.equal(__test.videoMaxPollDurationMs, 60 * 60_000);
  assert.equal(__test.oaiMaxPollDurationMs, 60 * 60_000);
  assert.equal(__test.autodlMaxPollDurationMs, 60 * 60_000);
  assert.equal(__test.oaiMaxPolls, 900);
});

test('video polling timeouts are terminal and retain the provider task id', () => {
  const error = __test.videoPollTimeoutError('TTAPI', 'provider-task-1');
  assert.equal(error.message, 'TTAPI任务等待超时');
  assert.equal(error.providerTaskId, 'provider-task-1');
  assert.equal(error.pollTimedOut, true);
  assert.equal(error.upstreamTerminal, true);
});

test('persisted submission time survives process restarts', () => {
  const submittedAt = '2026-09-02T01:02:03.000Z';
  assert.equal(__test.videoPollStartedAt({ submittedAt, createdAt:'2026-09-01T00:00:00.000Z' }), Date.parse(submittedAt));
  assert.equal(__test.videoPollStartedAt({ createdAt:'2026-09-01T00:00:00.000Z' }), Date.parse('2026-09-01T00:00:00.000Z'));
  assert.equal(__test.videoPollStartedAt({}, 123), 123);
});
