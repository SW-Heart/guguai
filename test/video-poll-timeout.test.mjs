import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../server.mjs');

test('OAI video polling defaults to a 30-minute task budget', () => {
  assert.equal(__test.oaiMaxPollDurationMs, 30 * 60_000);
  assert.equal(__test.oaiMaxPolls, 450);
});
