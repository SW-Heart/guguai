import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../server.mjs';

const {
  autodlRetryableResponseError,
  buildAutodlPayload,
  createAutodlVideo,
  pollAutodlVideo,
} = __test;

test('AutoDL payload maps every supported resolution and caps typed references', () => {
  for (const [quality, aspectRatio, resolution] of [
    ['480p', '16:9', '480p横'],
    ['480p', '9:16', '480p竖'],
    ['768p', '16:9', '768p横'],
    ['768p', '9:16', '768p竖'],
  ]) {
    const payload = buildAutodlPayload({ prompt: '测试', duration: 5, quality, aspectRatio }, []);
    assert.equal(payload.resolution, resolution);
  }

  const images = Array.from({ length: 11 }, (_, index) => `image-${index}`);
  const audios = Array.from({ length: 5 }, (_, index) => `audio-${index}`);
  const payload = buildAutodlPayload({
    prompt: '多素材', duration: 15, quality: '768p', aspectRatio: '16:9',
    referenceLimits: { image: 9, audio: 3 },
  }, { images, audios });

  assert.equal(payload.ref_image_0, 'image-0');
  assert.equal(payload.ref_image_8, 'image-8');
  assert.equal(payload.ref_image_9, undefined);
  assert.equal(payload.ref_audio_0, 'audio-0');
  assert.equal(payload.ref_audio_2, 'audio-2');
  assert.equal(payload.ref_audio_3, undefined);
});

test('AutoDL only classifies a non-success code with null data as retryable', () => {
  const error = autodlRetryableResponseError({ code: 'InternalError', data: null, msg: '工作流不可用' });
  assert.equal(error?.message, '工作流不可用');
  assert.equal(error?.retryableBusinessResponse, true);
  assert.equal(autodlRetryableResponseError({ code: 'success', data: null }), null);
  assert.equal(autodlRetryableResponseError({ code: 'InternalError', data: { status: 'running' } }), null);
  assert.equal(autodlRetryableResponseError({ data: null, msg: '暂时无数据' }), null);
});

test('AutoDL retries an HTTP-200 business error, persists it, then reports recovery', async () => {
  const responses = [
    { code: 'InternalError', data: null, msg: '工作流不可用' },
    { code: 'Success', data: { status: 'success', results: [{ type: 'video', url: 'https://example.com/result.mp4' }] } },
  ];
  const pollErrors = [];
  let recovered = 0;
  let clock = 0;

  const result = await pollAutodlVideo('task-1', {
    onPollError: value => pollErrors.push(value),
    onPollRecovered: () => { recovered++; },
  }, {
    fetchJson: async () => responses.shift(),
    sleep: async ms => { clock += ms; },
    now: () => clock,
    pollIntervalMs: 10,
    maxDurationMs: 1_000,
    maxPolls: 5,
  });

  assert.deepEqual(result, { provider: 'autodl', taskId: 'task-1', url: 'https://example.com/result.mp4' });
  assert.equal(pollErrors.length, 1);
  assert.match(pollErrors[0].detail, /工作流不可用/);
  assert.equal(pollErrors[0].consecutiveErrors, 1);
  assert.equal(recovered, 1);
  assert.equal(clock, 30, '第二次轮询应按连续错误指数退避');
});

test('AutoDL retry backoff remains bounded by the maximum poll duration', async () => {
  let calls = 0;
  let clock = 0;
  await assert.rejects(() => pollAutodlVideo('task-timeout', {}, {
    fetchJson: async () => { calls++; return { code: 'InternalError', data: null, msg: '不可用' }; },
    sleep: async ms => { clock += ms; },
    now: () => clock,
    pollIntervalMs: 10,
    maxDurationMs: 25,
    maxPolls: 100,
  }), /等待超时/);
  assert.equal(clock, 25);
  assert.equal(calls, 2);
});

test('AutoDL submit persists the provider task before polling and does not resubmit', async () => {
  const calls = [];
  const submitted = [];
  const result = await createAutodlVideo({
    prompt: '提交测试', duration: 5, quality: '768p', aspectRatio: '16:9',
  }, [], {
    onSubmitted: value => submitted.push(value),
  }, {
    fetchJson: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (options.method === 'POST') return { code: 'Success', data: { task_id: 'provider-task-1', status: 'running' } };
      return { code: 'Success', data: { status: 'success', results: [{ url: 'https://example.com/final.mp4' }] } };
    },
    sleep: async () => {},
    maxDurationMs: 1_000,
    maxPolls: 2,
  });

  assert.deepEqual(submitted, [{ provider: 'autodl', taskId: 'provider-task-1' }]);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(result.url, 'https://example.com/final.mp4');
});

test('resumed AutoDL polling only queries the existing provider task', async () => {
  const calls = [];
  await pollAutodlVideo('existing-task', {}, {
    fetchJson: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      return { code: 'Success', data: { status: 'success', results: [{ url: 'https://example.com/resumed.mp4' }] } };
    },
    sleep: async () => {},
    maxDurationMs: 1_000,
    maxPolls: 1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/result\/existing-task$/);
});

test('AutoDL submission without a task id remains awaiting reconciliation', async () => {
  await assert.rejects(() => createAutodlVideo({
    prompt: '提交失败', duration: 5, quality: '768p', aspectRatio: '16:9',
  }, [], {}, {
    fetchJson: async () => ({ code: 'InternalError', data: null, msg: '工作流不可用' }),
  }), error => error.submissionUncertain === true && /没有返回任务 ID/.test(error.message));
});

test('AutoDL definitive submit rejection is terminal', async () => {
  await assert.rejects(() => createAutodlVideo({
    prompt: '参数错误', duration: 5, quality: '768p', aspectRatio: '16:9',
  }, [], {}, {
    fetchJson: async () => {
      throw Object.assign(new Error('400 invalid parameter'), { upstreamStatus: 400, upstreamMessage: 'invalid parameter' });
    },
  }), error => error.provider === 'autodl' && error.upstreamTerminal === true);
});

test('AutoDL terminal poll status fails immediately without retrying', async () => {
  let calls = 0;
  await assert.rejects(() => pollAutodlVideo('failed-task', {}, {
    fetchJson: async () => {
      calls++;
      return { code: 'Success', data: { status: 'failed' }, msg: '生成失败' };
    },
    sleep: async () => {},
    maxDurationMs: 1_000,
    maxPolls: 5,
  }), error => error.provider === 'autodl' && error.providerTaskId === 'failed-task' && error.upstreamTerminal === true);
  assert.equal(calls, 1);
});
