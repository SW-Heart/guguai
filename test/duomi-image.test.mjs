import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DUOMI_API_BASE = 'https://duomi.example';
process.env.IMAGE_POLL_INTERVAL_MS = '10';
process.env.IMAGE_MAX_POLL_DURATION_MS = '1000';

const { __test } = await import('../server.mjs');

test('Duomi image task ID is persisted before result polling starts', async t => {
  const originalFetch = globalThis.fetch;
  const events = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/v1/images/generations?async=true')) {
      events.push('submitted');
      assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({ id:'upstream-image-1' }), { status:200 });
    }
    if (String(url).endsWith('/v1/tasks/upstream-image-1')) {
      events.push('polled');
      return new Response(JSON.stringify({ state:'succeeded', data:{ images:[{ url:'https://cdn.example/result.png' }] } }), { status:200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await __test.createImage({
    id:'generation-1', model:'gpt-image-2', prompt:'test', size:'1:1', quality:'medium', createdAt:new Date().toISOString(),
  }, [], {
    onSubmitted: async ({ provider, taskId }) => {
      assert.equal(provider, 'duomi');
      assert.equal(taskId, 'upstream-image-1');
      events.push('persisted');
    },
  });

  assert.deepEqual(events, ['submitted', 'persisted', 'polled']);
  assert.deepEqual(result, { provider:'duomi', taskId:'upstream-image-1', url:'https://cdn.example/result.png' });
});

test('shutdown grace waits for an in-flight provider submission checkpoint', async () => {
  let release;
  const tracked = __test.trackProviderSubmission(new Promise(resolve => { release = resolve; }));
  const waiting = __test.waitForProviderSubmissions(100);
  setTimeout(() => release('upstream-image-2'), 10);

  assert.deepEqual(await waiting, { pending:0, timedOut:false });
  assert.equal(await tracked, 'upstream-image-2');
});

test('restart performs one final upstream lookup even after the local polling deadline', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    assert.match(String(url), /\/v1\/tasks\/upstream-image-expired$/);
    return new Response(JSON.stringify({ state:'succeeded', data:{ images:[{ url:'https://cdn.example/recovered.png' }] } }), { status:200 });
  };

  const result = await __test.pollDuomiImage('upstream-image-expired', {}, Date.now() - 2_000, {
    immediate:true,
    allowExpiredFinalCheck:true,
  });
  assert.equal(result.url, 'https://cdn.example/recovered.png');
});
