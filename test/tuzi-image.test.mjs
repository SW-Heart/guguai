import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuziProvider } from '../providers/tuzi.mjs';
import { createProviderTransport, isPreconnectFailure } from '../providers/transport.mjs';

function provider(fetchJson, options = {}) {
  return createTuziProvider({
    ...options,
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

test('Tuzi stops after five preconnect failures without marking acceptance uncertain', async () => {
  let calls = 0;
  const tuzi = provider(async () => {
    calls++;
    throw new TypeError('fetch failed', { cause:Object.assign(new Error('DNS failure'), { code:'EAI_AGAIN' }) });
  });
  await assert.rejects(tuzi.createImage({ prompt:'test' }, []), error => isPreconnectFailure(error) && !error.submissionUncertain);
  assert.equal(calls, 5);
});

test('Tuzi retries a TLS reset before any HTTP request and records each attempt', async () => {
  let calls = 0;
  const transport = createProviderTransport({
    fetchImpl:async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed', { cause:Object.assign(
        new Error('Client network socket disconnected before secure TLS connection was established'),
        { code:'ECONNRESET' },
      ) });
      return new Response(JSON.stringify({ id:'recovered-after-tls-reset' }), { status:200 });
    },
    errorMessage:(_value, fallback) => fallback, videoProgress:value => value, sleep:async () => {},
  });
  const task = { id:'tls-reset', prompt:'test' };
  const result = await provider(transport.fetchJson).createImage(task, [], { deferPolling:true });
  assert.equal(result.taskId, 'recovered-after-tls-reset');
  assert.equal(calls, 3);
  assert.equal(task.submissionAttemptCount, 3);
  assert.deepEqual(task.submissionAttempts.map(({ attempt, phase, codes, safeToRetry }) => ({ attempt, phase, codes, safeToRetry })), [
    { attempt:1, phase:'connect', codes:['ECONNRESET'], safeToRetry:true },
    { attempt:2, phase:'connect', codes:['ECONNRESET'], safeToRetry:true },
  ]);
});

test('Tuzi never replays uncertain submissions or explicit HTTP rejections', async () => {
  for (const failure of [
    new TypeError('fetch failed', { cause:Object.assign(new Error('socket hang up'), { code:'ECONNRESET' }) }),
    Object.assign(new Error('headers timeout'), { code:'UND_ERR_HEADERS_TIMEOUT' }),
    Object.assign(new Error('gateway failure'), { upstreamStatus:502 }),
    Object.assign(new Error('invalid request'), { upstreamStatus:400 }),
    Object.assign(new Error('rate limited'), { upstreamStatus:429 }),
  ]) {
    let calls = 0;
    const tuzi = provider(async () => { calls++; throw failure; });
    await assert.rejects(tuzi.createImage({ prompt:'test' }, []), error => {
      assert.equal(Boolean(error.submissionUncertain), ![400, 429, 502].includes(failure.upstreamStatus));
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

test('Tuzi waits for slow task IDs up to the configured submit timeout', async () => {
  const slow = provider(async (_url, options) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(options.signal.aborted, false);
    return { id:'slow-task' };
  }, { imageSubmitTimeoutMs:200 });
  const result = await slow.createImage({ prompt:'test' }, [], { deferPolling:true });
  assert.equal(result.taskId, 'slow-task');

  const expired = provider((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once:true });
  }), { imageSubmitTimeoutMs:20 });
  // AbortSignal.timeout does not keep the event loop alive on its own.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(expired.createImage({ prompt:'test' }, []), error => error.submissionUncertain === true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('Seedream 5.0 uses synchronous JSON generations for text and reference images', async () => {
  for (const refs of [[], ['https://cdn.example/ref.png'], ['https://cdn.example/one.png', 'https://cdn.example/two.png']]) {
    let calls = 0;
    const tuzi = provider(async (url, options) => {
      calls++;
      assert.equal(url, 'https://tuzi.example/v1/images/generations');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer tuzi-test-key');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), {
        model:'doubao-seedream-5-0-260128', prompt:'一只小兔子', size:'2048x2048', response_format:'url',
        ...(refs.length ? { image:refs.length === 1 ? refs[0] : refs } : {}),
      });
      return { data:[{ url:'https://cdn.example/seedream.png' }] };
    });
    const result = await tuzi.createImage({ model:'seedream-5.0', prompt:'一只小兔子', size:'1:1' }, refs, {
      deferPolling:true, onSubmitted:() => assert.fail('synchronous result must not create a polling task'),
    });
    assert.deepEqual(result, { provider:'tuzi', taskId:'', url:'https://cdn.example/seedream.png' });
    assert.equal(calls, 1);
  }
});

test('Seedream preserves guarded retries and never polls an incomplete synchronous response', async () => {
  let calls = 0;
  const tuzi = provider(async () => {
    if (++calls === 1) throw Object.assign(new Error('DNS failure'), { code:'EAI_AGAIN' });
    return { data:[{ url:'https://cdn.example/result.png' }] };
  });
  assert.equal((await tuzi.createImage({ model:'seedream-5.0', prompt:'test' }, [])).url, 'https://cdn.example/result.png');
  assert.equal(calls, 2);
  for (const response of [{}, { id:'unexpected-task' }, { data:[] }]) {
    await assert.rejects(provider(async () => response).createImage({ model:'seedream-5.0', prompt:'test' }, []), error => error.submissionUncertain === true);
  }
  calls = 0;
  await assert.rejects(provider(async () => { calls++; throw new Error('response lost'); }).createImage({ model:'seedream-5.0', prompt:'test' }, []), error => error.submissionUncertain === true);
  assert.equal(calls, 1);
});

test('Seedream submits the selected 2K, 3K or 4K pixel dimensions', async () => {
  for (const [quality, size] of [['2k','2048x2048'], ['3k','3072x3072'], ['4k','4096x4096']]) {
    const tuzi = provider(async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.size, size);
      assert.equal(body.model, 'doubao-seedream-5-0-260128');
      return { data:[{ url:'https://cdn.example/result.png' }] };
    });
    await tuzi.createImage({ model:'seedream-5.0', prompt:'test', size:'1:1', quality }, []);
    await tuzi.createImage({ model:'seedream-5.0', prompt:'test', size, quality }, []);
  }
  const tuzi = provider(() => assert.fail('invalid dimensions must not be submitted'));
  await assert.rejects(tuzi.createImage({ model:'seedream-5.0', prompt:'test', size:'4096x4096', quality:'2k' }, []), /尺寸/);
});

test('Seedream records a socket disconnect separately from the local deadline and does not replay it', async () => {
  let calls = 0;
  const task = { model:'seedream-5.0', prompt:'test' };
  const tuzi = provider(async () => {
    calls++;
    const socketError = Object.assign(new Error('other side closed'), {
      name:'SocketError', code:'UND_ERR_SOCKET',
      socket:{ remoteAddress:'203.0.113.1', remotePort:443, bytesWritten:100, bytesRead:0, privateField:'must not persist' },
    });
    throw new TypeError('fetch failed', { cause:socketError });
  });
  await assert.rejects(tuzi.createImage(task, []), error => error.submissionUncertain === true);
  assert.equal(calls, 1);
  const [failure] = task.submissionAttempts;
  assert.equal(failure.deadlineAborted, false);
  assert.equal(failure.timeoutMs, 360_000);
  assert.ok(failure.elapsedMs >= 0 && failure.elapsedMs < failure.timeoutMs);
  assert.equal(failure.causes.at(-1).message, 'other side closed');
  assert.deepEqual(failure.socket, { remoteAddress:'203.0.113.1', remotePort:443, bytesWritten:100, bytesRead:0 });
});

test('Seedream timeout diagnostics record when the configured local deadline actually expires', async () => {
  const task = { model:'seedream-5.0', prompt:'test' };
  const tuzi = provider((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once:true });
  }), { imageSubmitTimeoutMs:20 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(tuzi.createImage(task, []), error => error.submissionUncertain === true);
    const [failure] = task.submissionAttempts;
    assert.equal(failure.deadlineAborted, true);
    assert.equal(failure.abortReason, 'TimeoutError');
    assert.equal(failure.timeoutMs, 20);
  } finally { clearTimeout(keepAlive); }
});
