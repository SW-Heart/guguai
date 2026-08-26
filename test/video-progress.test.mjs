import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../server.mjs');

test('video progress accepts a top-level provider progress value', () => {
  assert.equal(__test.videoProgress({ status: 'processing', progress: 68 }), 68);
  assert.equal(__test.videoProgress({ status: 'processing', progress: 0 }), 0);
  assert.equal(__test.videoProgress({ status: 'processing', progress: 100 }), 100);
});

test('video progress also accepts nested provider data and ignores invalid values', () => {
  assert.equal(__test.videoProgress({ data: { progress: 42.6 } }), 43);
  assert.equal(__test.videoProgress({ status: 'processing' }), null);
  assert.equal(__test.videoProgress({ progress: 'unknown' }), null);
  assert.equal(__test.videoProgress({ progress: 140 }), 100);
});

test('public generation preserves an optional progress value', () => {
  const value = __test.publicGeneration({ id: 'task-1', type: 'video', status: 'running', progress: 68 });
  assert.equal(value.progress, 68);
  assert.equal(value.progressStage, 'submitting');
});
