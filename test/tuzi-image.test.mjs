import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuziProvider } from '../providers/tuzi.mjs';
import { createProviderTransport, isPreconnectFailure } from '../providers/transport.mjs';

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

test('Tuzi retries only failed connections and persists one successful submission', async () => {
  let calls = 0, submitted = 0;
  const tuzi = provider(async (_url, options) => {
    assert.equal(options.body.get('prompt'), 'test');
    if (++calls < 3) throw new TypeError('fetch failed', { cause:Object.assign(new Error('connect failed'), { code:'ETIMEDOUT', syscall:'connect' }) });
    return { id:'recovered' };
  });
  const result = await tuzi.createImage({ prompt:'test' }, [], { deferPolling:true, onSubmitted:async () => submitted++ });
  assert.equal(calls, 3);
  assert.equal(submitted, 1);
  assert.equal(result.taskId, 'recovered');
});

test('Tuzi stops after three preconnect failures without marking acceptance uncertain', async () => {
  let calls = 0;
  const tuzi = provider(async () => {
    calls++;
    throw new TypeError('fetch failed', { cause:Object.assign(new Error('DNS failure'), { code:'EAI_AGAIN' }) });
  });
  await assert.rejects(tuzi.createImage({ prompt:'test' }, []), error => isPreconnectFailure(error) && !error.submissionUncertain);
  assert.equal(calls, 3);
});

test('Tuzi never replays uncertain submissions or explicit HTTP rejections', async () => {
  for (const failure of [
    new TypeError('fetch failed', { cause:Object.assign(new Error('socket closed'), { code:'ECONNRESET' }) }),
    Object.assign(new Error('headers timeout'), { code:'UND_ERR_HEADERS_TIMEOUT' }),
    Object.assign(new Error('gateway failure'), { upstreamStatus:502 }),
    Object.assign(new Error('invalid request'), { upstreamStatus:400 }),
    Object.assign(new Error('rate limited'), { upstreamStatus:429 }),
  ]) {
    let calls = 0;
    const tuzi = provider(async () => { calls++; throw failure; });
    await assert.rejects(tuzi.createImage({ prompt:'test' }, []), error => {
      assert.equal(Boolean(error.submissionUncertain), ![400, 429].includes(failure.upstreamStatus));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Tuzi missing task ID is uncertain and persistence failures do not resubmit', async () => {
  await assert.rejects(provider(async () => ({})).createImage({ prompt:'test' }, []), error => error.submissionUncertain === true);
  let calls = 0;
  await assert.rejects(provider(async () => { calls++; return { id:'accepted' }; }).createImage({ prompt:'test' }, [], {
    onSubmitted:async () => { throw new Error('database unavailable'); },
  }), /database unavailable/);
  assert.equal(calls, 1);
});

test('transport preserves aggregate connection codes and rejects mixed-phase retries', async () => {
  const connect = Object.assign(new Error('connection refused'), { code:'ECONNREFUSED', syscall:'connect' });
  const dns = Object.assign(new Error('dns failed'), { code:'ENOTFOUND' });
  const cause = new AggregateError([connect, dns]);
  assert.equal(isPreconnectFailure(cause), true);
  assert.equal(isPreconnectFailure(new AggregateError([connect, Object.assign(new Error('reset'), { code:'ECONNRESET' })])), false);
  const transport = createProviderTransport({
    fetchImpl:async () => { throw new TypeError('fetch failed', { cause }); },
    errorMessage:(_value, fallback) => fallback, videoProgress:value => value, sleep:async () => {},
  });
  await assert.rejects(transport.fetchJson('https://example.test'), error => {
    assert.equal(error.requestPhase, 'connect');
    assert.deepEqual(error.transportCodes, ['ECONNREFUSED', 'ENOTFOUND']);
    assert.match(error.message, /fetch failed.*ECONNREFUSED.*ENOTFOUND/);
    assert.match(transport.upstreamRequestErrorDetail(error), /ECONNREFUSED/);
    assert.equal(isPreconnectFailure(error), true);
    return true;
  });
});

test('transport response body failures cannot authorize POST replay', async () => {
  const transport = createProviderTransport({
    fetchImpl:async () => ({ text:async () => { throw Object.assign(new Error('body failed'), { code:'UND_ERR_CONNECT_TIMEOUT' }); } }),
    errorMessage:(_value, fallback) => fallback, videoProgress:value => value, sleep:async () => {},
  });
  await assert.rejects(transport.fetchJson('https://example.test'), error => {
    assert.equal(error.requestPhase, 'response_body');
    assert.equal(isPreconnectFailure(error), false);
    return true;
  });
});
