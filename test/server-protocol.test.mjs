import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import test from 'node:test';

import { bodyJson, mutationAllowed, publicHttpErrorBody, requestTraceId, sendJson } from '../server/http-protocol.mjs';
import { parseByteRange, servePublicFile, serveStatic, staticCacheControl, staticEncoding, staticEntryFile } from '../server/static.mjs';

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
  assert.equal(staticEntryFile('/lab', { desktop:true }), 'index.html', '旧实验室链接仍进入应用');
  assert.equal(staticCacheControl('.js', { production:true, versioned:true }), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('.js', { production:false, versioned:true }), 'no-cache');
});

const recordingResponse = (headers = {}) => ({ status:0, headers:null, body:null, preset:headers, getHeader(name) { return this.preset[name]; }, writeHead(status, values) { this.status = status; this.headers = values; }, end(value) { this.body = value; } });

test('JSON responses are gzip-compressed only for clients that accept it and only when worthwhile', () => {
  const large = { items:Array.from({ length:200 }, (_, index) => ({ id:index, title:'公告标题'.repeat(4) })) };
  const plain = recordingResponse();
  sendJson(plain, 200, large);
  assert.equal(plain.headers['Content-Encoding'], undefined);
  const compressed = Object.assign(recordingResponse(), { req:{ headers:{ 'accept-encoding':'gzip, deflate, br' } } });
  sendJson(compressed, 200, large, { 'X-Test':'1' });
  assert.equal(compressed.headers['Content-Encoding'], 'gzip');
  assert.equal(compressed.headers['X-Test'], '1');
  assert.equal(compressed.headers['Content-Length'], compressed.body.length);
  assert.ok(compressed.body.length < JSON.stringify(large).length / 4);
  assert.deepEqual(JSON.parse(gunzipSync(compressed.body).toString('utf8')), large);
  const small = Object.assign(recordingResponse(), { req:{ headers:{ 'accept-encoding':'gzip' } } });
  sendJson(small, 200, { ok:true });
  assert.equal(small.body, '{"ok":true}');
});

test('public text files are compressed once and pictures answer 304 when unchanged', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gugu-static-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const script = path.join(dir, 'app.js');
  const source = `export const value = ${JSON.stringify('x'.repeat(4000))};\n`;
  writeFileSync(script, source);
  assert.equal(staticEncoding('gzip, deflate, br'), 'br');
  assert.equal(staticEncoding('gzip'), 'gzip');
  assert.equal(staticEncoding(''), '');

  const br = recordingResponse({ Vary:'X-GuGu-Desktop' });
  await servePublicFile(br, script, 'text/javascript', 'public, max-age=31536000, immutable', { headers:{ 'accept-encoding':'gzip, br' } });
  assert.equal(br.headers['Content-Encoding'], 'br');
  assert.equal(br.headers.Vary, 'X-GuGu-Desktop, Accept-Encoding');
  assert.equal(br.headers.ETag, undefined, 'immutable files need no validator');
  assert.equal(brotliDecompressSync(br.body).toString('utf8'), source);

  const gzip = recordingResponse();
  await servePublicFile(gzip, script, 'text/javascript', 'no-cache', { headers:{ 'accept-encoding':'gzip' } });
  assert.equal(gzip.headers['Content-Encoding'], 'gzip');
  assert.equal(gunzipSync(gzip.body).toString('utf8'), source);
  assert.match(gzip.headers.ETag, /-gzip"$/);

  writeFileSync(script, `${source}// changed\n`);
  utimesSync(script, new Date(), new Date(Date.now() + 5000));
  const updated = recordingResponse();
  await servePublicFile(updated, script, 'text/javascript', 'no-cache', { headers:{ 'accept-encoding':'gzip' } });
  assert.match(gunzipSync(updated.body).toString('utf8'), /changed/, 'a changed file is never served from the old compressed copy');

  const picture = path.join(dir, 'cover.webp');
  writeFileSync(picture, Buffer.alloc(2048, 1));
  const first = Object.assign(new PassThrough(), { preset:{}, getHeader:() => undefined, writeHead(status, values) { this.status = status; this.headers = values; } });
  first.resume();
  const finished = new Promise(resolve => first.on('end', resolve));
  await servePublicFile(first, picture, 'image/webp', 'no-cache', { headers:{ 'accept-encoding':'gzip' } });
  await finished;
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Encoding'], undefined);
  assert.ok(first.headers.ETag);
  const repeat = recordingResponse();
  await servePublicFile(repeat, picture, 'image/webp', 'no-cache', { headers:{ 'if-none-match':first.headers.ETag } });
  assert.equal(repeat.status, 304);
  assert.equal(repeat.body, undefined);
});

test('static directory requests answer 404 instead of crashing the server', async () => {
  const publicDir = mkdtempSync(path.join(tmpdir(), 'gugu-static-dir-'));
  try {
    mkdirSync(path.join(publicDir, 'images'));
    const sent = [];
    const res = { setHeader() {}, getHeader() {}, writeHead() { throw new Error('目录不应被发送'); } };
    await serveStatic(res, '/images/', { headers:{}, url:'/images/' }, { publicDir, sendJson:(_, status, body) => sent.push({ status, body }) });
    assert.deepEqual(sent, [{ status:404, body:{ error:'静态文件不存在' } }]);
  } finally { rmSync(publicDir, { recursive:true, force:true }); }
});

test('videos answer byte ranges so every browser can play and seek them', async t => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start:0, end:99 });
  assert.deepEqual(parseByteRange('bytes=900-', 1000), { start:900, end:999 });
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start:900, end:999 });
  assert.deepEqual(parseByteRange('bytes=0-5000', 1000), { start:0, end:999 });
  assert.deepEqual(parseByteRange('bytes=1000-', 1000), { unsatisfiable:true });
  assert.equal(parseByteRange('bytes=0-1,5-9', 1000), null, 'multi-range falls back to the whole file');
  assert.equal(staticCacheControl('.mp4', { production:true, versioned:true }), 'public, max-age=31536000, immutable');

  const dir = mkdtempSync(path.join(tmpdir(), 'gugu-video-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const video = path.join(dir, 'film.mp4');
  writeFileSync(video, Buffer.from(Array.from({ length:1000 }, (_, index) => index % 256)));
  const collect = () => {
    const res = Object.assign(new PassThrough(), { preset:{}, getHeader:() => undefined, writeHead(status, values) { this.status = status; this.headers = values; } });
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    return { res, done:new Promise(resolve => res.on('end', () => resolve(Buffer.concat(chunks)))) };
  };
  const partial = collect();
  await servePublicFile(partial.res, video, 'video/mp4', 'no-cache', { headers:{ range:'bytes=10-19' } });
  const body = await partial.done;
  assert.equal(partial.res.status, 206);
  assert.equal(partial.res.headers['Content-Range'], 'bytes 10-19/1000');
  assert.equal(partial.res.headers['Content-Length'], 10);
  assert.deepEqual([...body], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const whole = collect();
  await servePublicFile(whole.res, video, 'video/mp4', 'no-cache', { headers:{} });
  assert.equal((await whole.done).length, 1000);
  assert.equal(whole.res.headers['Accept-Ranges'], 'bytes');
  const outside = recordingResponse();
  await servePublicFile(outside, video, 'video/mp4', 'no-cache', { headers:{ range:'bytes=2000-' } });
  assert.equal(outside.status, 416);
  assert.equal(outside.headers['Content-Range'], 'bytes */1000');
});
