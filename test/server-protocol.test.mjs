import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { bodyJson, mutationAllowed, publicHttpErrorBody, requestTraceId, sendJson } from '../server/http-protocol.mjs';
import { staticCacheControl, staticEntryFile } from '../server/static.mjs';

test('HTTP protocol readers and writers keep one response contract', async () => {
  assert.deepEqual(await bodyJson(Readable.from(['{"ok":true}'])), { ok:true });
  assert.equal((await bodyJson(Readable.from([]))).constructor, Object);
  const response = { headers:null, body:null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = value; } };
  sendJson(response, 200, { ok:true });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(response.body, '{"ok":true}');
});

test('HTTP protocol preserves safe error codes and rejects unsafe origins', () => {
  assert.deepEqual(publicHttpErrorBody(Object.assign(new Error('项目冲突'), { code:'PROJECT_VERSION_CONFLICT', publicData:{ project:{ revision:2 } } })), { error:'项目冲突', project:{ revision:2 }, code:'PROJECT_VERSION_CONFLICT' });
  assert.deepEqual(publicHttpErrorBody(Object.assign(new Error('内部细节'), { code:'DATABASE_INTERNAL_ERROR' })), { error:'内部细节' });
  assert.equal(mutationAllowed({ method:'PATCH', headers:{ origin:'https://evil.example', host:'localhost' } }), false);
  assert.equal(mutationAllowed({ method:'PATCH', headers:{ origin:'http://localhost/path', host:'localhost' } }), true);
  assert.match(requestTraceId({ headers:{ 'x-request-id':'request-123' } }), /^request-123$/);
});

test('static routing keeps desktop separation and production cache policy', () => {
  assert.equal(staticEntryFile('/', { desktop:false, appOnly:true }), 'home.html');
  assert.equal(staticEntryFile('/', { desktop:true, appOnly:true }), 'index.html');
  assert.equal(staticEntryFile('/pricing', { desktop:false, appOnly:true }), 'pricing.html');
  assert.equal(staticCacheControl('.js', { production:true, versioned:true }), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('.js', { production:false, versioned:true }), 'no-cache');
});
