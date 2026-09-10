import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuziProvider } from '../providers/tuzi.mjs';

function provider(fetchJson) {
  return createTuziProvider({
    baseUrl:'https://tuzi.example', apiKey:'tuzi-test-key', fetchJson,
    trackProviderSubmission:operation => operation, sleep:async () => {},
    videoPollRemainingMs:() => 1000, videoPollRequestSignal:() => undefined,
    videoPollTimeoutError:() => new Error('timeout'), videoPollStartedAt:() => Date.now(),
    imageMaxPollDurationMs:1000, errorMessage:value => String(value),
    upstreamRequestErrorDetail:error => error.message,
  });
}

test('Tuzi image submission uses bearer-authenticated multipart form data', async () => {
  const events = [];
  const tuzi = provider(async (url, options) => {
    assert.equal(url, 'https://tuzi.example/v1/videos');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tuzi-test-key');
    assert.equal(options.headers['Content-Type'], undefined);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('model'), 'gpt-image-2.5');
    assert.equal(options.body.get('prompt'), '一只奔跑的小兔子');
    assert.equal(options.body.get('size'), '2048x1152');
    assert.deepEqual(options.body.getAll('input_reference'), ['https://cdn.example/ref-1.png', 'https://cdn.example/ref-2.png']);
    events.push('submitted');
    return { id:'tuzi-task-1', status:'queued', progress:0 };
  });
  const task = { model:'gpt-image-2.5', prompt:'一只奔跑的小兔子', size:'2048x1152' };
  const refs = ['https://cdn.example/ref-1.png', 'https://cdn.example/ref-2.png'];
  const result = await tuzi.createImage(task, refs, {
    deferPolling:true,
    onSubmitted:async ({ provider:providerName, taskId }) => {
      assert.equal(providerName, 'tuzi');
      assert.equal(taskId, 'tuzi-task-1');
      events.push('persisted');
    },
  });
  assert.deepEqual(events, ['submitted', 'persisted']);
  assert.deepEqual(result, { pending:true, provider:'tuzi', taskId:'tuzi-task-1' });
});

test('Tuzi polling returns video_url and reports progress', async () => {
  const tuzi = provider(async (url, options) => {
    assert.equal(url, 'https://tuzi.example/v1/videos/tuzi-task-2');
    assert.equal(options.headers.Authorization, 'Bearer tuzi-test-key');
    return { id:'tuzi-task-2', status:'completed', progress:100, video_url:'https://cdn.example/result.jpg' };
  });
  const progress = [];
  const result = await tuzi.pollImage('tuzi-task-2', { onProgress:async value => progress.push(value.progress) }, Date.now(), { immediate:true });
  assert.deepEqual(progress, [100]);
  assert.deepEqual(result, { provider:'tuzi', taskId:'tuzi-task-2', url:'https://cdn.example/result.jpg' });
});
