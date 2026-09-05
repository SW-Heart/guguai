import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient } from '../public/api-client.js';

function response(body, { ok = true, status = 200, nextCursor = '', total = '' } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    headers: { get: name => name === 'X-Next-Cursor' ? nextCursor : name === 'X-Total-Count' ? total : '' },
  };
}

test('API client composes scope and caller headers and parses pages', async () => {
  const calls = [];
  const client = createApiClient({
    scopeHeaders: () => ({ 'X-Workspace': 'workspace-a' }),
    fetchImpl: async (...args) => {
      calls.push(args);
      return response({ items: [{ id: 'a' }] }, { nextCursor: 'next-a', total: '3' });
    },
  });
  assert.deepEqual(await client.page('/api/items', { method:'GET', headers:{ 'X-Custom':'yes' } }), { items:[{ id:'a' }], nextCursor:'next-a', total:3 });
  assert.equal(calls[0][0], '/api/items');
  assert.deepEqual(calls[0][1].headers, { 'X-Workspace':'workspace-a', 'Content-Type':'application/json', 'X-Custom':'yes' });
});

test('API client preserves blob requests and exposes server errors', async () => {
  let request;
  const client = createApiClient({
    fetchImpl: async (...args) => { request = args; return response({ error:'失败', code:'FAILED' }, { ok:false, status:409 }); },
  });
  await assert.rejects(client.request('/api/upload', { method:'POST', body:new Blob(['data']), headers:{ 'X-Upload':'yes' } }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'FAILED');
    return error.message === '失败';
  });
  assert.deepEqual(request[1].headers, { 'X-Upload':'yes' });
});

test('API client aborts timed out requests and preserves caller cancellation', async () => {
  const client = createApiClient({
    timeoutMs:10,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once:true });
    }),
  });
  await assert.rejects(client.request('/api/slow'), error => error.code === 'API_TIMEOUT');

  const abort = new AbortController();
  const pending = client.request('/api/cancel', { signal:abort.signal, timeoutMs:0 });
  abort.abort();
  await assert.rejects(pending, error => error.code === 'API_ABORTED');
});

test('API client validates object, array, and paged response shapes', async () => {
  const responses = [
    response({ value:1 }),
    response([{ id:'a' }]),
    response({ items:[{ id:'a' }] }, { nextCursor:'next', total:'1' }),
  ];
  const client = createApiClient({ fetchImpl:async () => responses.shift() });
  assert.deepEqual(await client.request('/api/object', { responseShape:'object' }), { value:1 });
  assert.deepEqual(await client.request('/api/array', { responseShape:'array' }), [{ id:'a' }]);
  assert.deepEqual(await client.page('/api/page'), { items:[{ id:'a' }], nextCursor:'next', total:1 });

  const invalid = createApiClient({ fetchImpl:async () => response({ value:1 }) });
  await assert.rejects(invalid.request('/api/array', { responseShape:'array' }), error => error.code === 'INVALID_RESPONSE_SCHEMA' && error.status === 502);
});

test('API client applies endpoint response shape defaults without hiding overrides', async () => {
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(String(url).endsWith('/list') ? ['ok'] : { ok:true });
    },
    responseShapeFor: url => String(url).endsWith('/list') ? 'array' : 'object',
  });
  assert.deepEqual(await client.request('/list'), ['ok']);
  await assert.rejects(client.request('/object', { responseShape:'array' }), error => error.code === 'INVALID_RESPONSE_SCHEMA');
  assert.equal(calls.length, 2);
});
