import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DUOMI_API_BASE = 'https://duomi.example';
process.env.IMAGE_POLL_INTERVAL_MS = '10';
process.env.IMAGE_MAX_POLL_DURATION_MS = '1000';

const { __test } = await import('../server.mjs');
import { sql } from '../lib/db.mjs';
import { findGeneration, generationQueueStats, saveGenerationRecord } from '../lib/store.mjs';

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

test('durable image submission stops after persisting the upstream task ID', async t => {
  const originalFetch = globalThis.fetch;
  let pollCalls = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    if (String(url).endsWith('/v1/images/generations?async=true')) return new Response(JSON.stringify({ id:'upstream-image-submit-only' }), { status:200 });
    pollCalls++;
    throw new Error('submit job must not poll inline');
  };
  const result = await __test.createImage({ id:'generation-submit-only', model:'gpt-image-2', prompt:'test', size:'1:1', quality:'medium', createdAt:new Date().toISOString() }, [], { deferPolling:true });
  assert.deepEqual(result, { pending:true, provider:'duomi', taskId:'upstream-image-submit-only' });
  assert.equal(pollCalls, 0);
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

test('poll scheduling performs one upstream lookup per durable job', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    calls++;
    assert.match(String(url), /\/v1\/tasks\/upstream-image-pending$/);
    return new Response(JSON.stringify({ state:'running' }), { status:200 });
  };

  const result = await __test.pollDuomiImage('upstream-image-pending', {}, Date.now(), { immediate:true, pollOnce:true });
  assert.deepEqual(result, { pending:true, provider:'duomi', taskId:'upstream-image-pending' });
  assert.equal(calls, 1);
});

test('recovery leaves deferred reference uploads waiting for the client', async () => {
  const userId = 'recovery-deferred-user';
  const generationId = 'recovery-deferred-generation';
  sql(`INSERT INTO users(id, username, password_hash, role, credit_balance_micro, credit_held_micro, created_at, doc_json)
       VALUES(:id, :username, 'scrypt:x:y', 'user', 0, 0, :createdAt, :docJson)`)
    .run({ id:userId, username:userId, createdAt:new Date().toISOString(), docJson:JSON.stringify({ id:userId }) });
  try {
    saveGenerationRecord(userId, {
      id:generationId, type:'video', status:'queued', creditStatus:'charged', awaitingReferences:true,
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    });
    await __test.recoverPendingGenerations();
    const task = findGeneration(userId, generationId);
    assert.equal(task.status, 'queued');
    assert.equal(task.awaitingReferences, true);
    assert.equal(generationQueueStats().pendingJobs, 0);
  } finally {
    sql('DELETE FROM users WHERE id = :id').run({ id:userId });
  }
});
