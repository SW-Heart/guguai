import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http, { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { insertUser } from '../lib/store.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4590000000049454e44ae426082', 'hex');

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(child, base) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 15_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`GuGu AI: ${base}`)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); if (process.env.API_TEST_DEBUG) process.stderr.write(chunk); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}：${output}`)); });
  });
}

function rawRequest(base, pathname, { host, headers = {} } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname:url.hostname, port:url.port, path:url.pathname + url.search, method:'GET', headers:{ ...headers, Host:host } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status:response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('OpenAI-compatible API: keys, async image tasks, billing, logs and isolation', { timeout:90_000 }, async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'api-platform-'));
  let upstreamSubmissions = 0;
  const upstream = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/v1/images/generations')) {
      upstreamSubmissions++;
      req.resume();
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({ id:`up-${upstreamSubmissions}` }));
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/tasks/')) {
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({ status:'succeeded', image_url:`${upstreamBase}/result.png` }));
    }
    if (req.url === '/result.png') {
      res.writeHead(200, { 'Content-Type':'image/png', 'Content-Length':PNG.length });
      return res.end(PNG);
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamBase = await listen(upstream);
  const port = await freePort();
  const apiSitePort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const createdAt = new Date().toISOString();

  resetForTests();
  openDatabase({ file:path.join(dataDir, 'studio.db') });
  insertUser({ id:'api-user', username:'api_user', role:'user', status:'active', passwordHash:await hashPassword('api-password-123'), credits:10, creditBalanceMicro:10_000_000, creditHeldMicro:0, createdAt, updatedAt:createdAt });
  closeDatabase({ checkpoint:true });

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd:path.resolve(import.meta.dirname, '..'),
    env:{
      ...process.env,
      NODE_ENV:'development',
      DATA_DIR:dataDir,
      PORT:String(port),
      DUOMI_API_KEY:'test-duomi-key',
      DUOMI_API_BASE:upstreamBase,
      API_SITE_HOSTS:'127.0.0.1',
      API_PUBLIC_BASE_URL:'',
      API_SITE_PORT:String(apiSitePort),
      MEDIA_RETENTION_ENABLED:'0',
    },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dataDir, { recursive:true, force:true });
  });
  await waitForServer(child, base);

  let cookie = '';
  const call = async (method, pathname, { body, bearer, headers = {}, redirect = 'manual' } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      redirect,
      headers:{
        ...(body ? { 'Content-Type':'application/json' } : {}),
        ...(bearer ? { Authorization:`Bearer ${bearer}` } : cookie ? { Cookie:cookie } : {}),
        ...headers,
      },
      body:body ? JSON.stringify(body) : undefined,
    });
    for (const value of response.headers.getSetCookie?.() ?? []) if (value.startsWith('studio_session=')) cookie = value.split(';')[0];
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status:response.status, body:data, headers:response.headers };
  };

  const links = await rawRequest(base, '/api/public/site-links', { host:`localhost:${port}` });
  assert.deepEqual(JSON.parse(links.body), { apiSiteUrl:`http://localhost:${apiSitePort}` }, 'the website links to this environment\'s API site');
  let localSite = null;
  for (let attempt = 0; attempt < 20 && !localSite; attempt++) {
    localSite = await rawRequest(`http://127.0.0.1:${apiSitePort}`, '/keys', { host:`localhost:${apiSitePort}` }).catch(() => null);
    if (!localSite) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(localSite.body, /<title>GuGu AI API<\/title>/, 'the local API port serves the console without a domain');
  const mainHome = await rawRequest(base, '/', { host:`localhost:${port}` });
  assert.doesNotMatch(mainHome.body, /<title>GuGu AI API<\/title>/);

  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>GuGu AI API<\/title>/);
  assert.equal((await call('GET', '/api/generations')).status, 404, 'creator workspace APIs stay off the API site');

  const catalog = await call('GET', '/api/public/api-models');
  assert.equal(catalog.status, 200);
  const gptImage = catalog.body.models.find(model => model.id === 'gpt-image-2');
  assert.ok(gptImage, 'available image models are listed');
  assert.ok(gptImage.parameters.some(param => param.name === 'size'));
  assert.equal(catalog.body.baseUrl, `${base}/v1`);

  assert.equal((await call('POST', '/api/auth/login', { body:{ identifier:'api_user', password:'api-password-123' } })).status, 200);
  const created = await call('POST', '/api/console/keys', { body:{ name:'生产环境' } });
  assert.equal(created.status, 201);
  const secret = created.body.secret;
  assert.match(secret, /^sk-gugu-/);
  assert.equal(created.body.key.hint.includes(secret), false, 'the full key is only returned once');

  const missing = await call('GET', '/v1/models');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'missing_api_key');
  assert.equal((await call('GET', '/v1/models', { bearer:'sk-gugu-wrong' })).body.error.code, 'invalid_api_key');

  const preflight = await fetch(`${base}/v1/images/generations`, { method:'OPTIONS', headers:{ Origin:'https://example.com', 'Access-Control-Request-Headers':'authorization,content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const models = await call('GET', '/v1/models', { bearer:secret });
  assert.equal(models.status, 200);
  assert.equal(models.body.object, 'list');
  assert.ok(models.body.data.some(model => model.id === 'gpt-image-2' && model.object === 'model'));
  const detail = await call('GET', '/v1/models/gpt-image-2', { bearer:secret });
  assert.equal(detail.body.id, 'gpt-image-2');
  assert.ok(Array.isArray(detail.body.pricing));

  const badSize = await call('POST', '/v1/images/generations', { bearer:secret, body:{ model:'gpt-image-2', prompt:'猫', size:'7:3' } });
  assert.equal(badSize.status, 400);
  assert.equal(badSize.body.error.param, 'size');
  const wrongEndpoint = await call('POST', '/v1/videos', { bearer:secret, body:{ model:'gpt-image-2', prompt:'猫' } });
  assert.equal(wrongEndpoint.status, 400);
  assert.equal(wrongEndpoint.body.error.code, 'invalid_model_for_endpoint');
  const unknownModel = await call('POST', '/v1/images/generations', { bearer:secret, body:{ model:'no-such-model', prompt:'猫' } });
  assert.equal(unknownModel.status, 404);
  assert.equal(unknownModel.body.error.code, 'model_not_found');
  const privateReference = await call('POST', '/v1/images/edits', { bearer:secret, body:{ model:'gpt-image-2', prompt:'猫', image:'http://127.0.0.1:1/a.png' } });
  assert.equal(privateReference.status, 400);
  assert.equal(privateReference.body.error.code, 'invalid_reference');

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', '把这张图改成水彩风格');
  form.append('image[]', new Blob([PNG], { type:'image/png' }), 'ref.png');
  const multipart = await fetch(`${base}/v1/images/edits`, { method:'POST', headers:{ Authorization:`Bearer ${secret}` }, body:form });
  const multipartBody = await multipart.json();
  // Test servers have no reference storage; the upload is parsed, validated
  // and then released without charging.
  assert.equal(multipart.status, 503, JSON.stringify(multipartBody));
  assert.equal(multipartBody.error.code, 'model_unavailable');
  const notImage = new FormData();
  notImage.append('model', 'gpt-image-2');
  notImage.append('prompt', '猫');
  notImage.append('image', new Blob(['<svg/>'], { type:'image/png' }), 'fake.png');
  const rejected = await fetch(`${base}/v1/images/edits`, { method:'POST', headers:{ Authorization:`Bearer ${secret}` }, body:notImage });
  assert.equal((await rejected.json()).error.param, 'image');

  const request = { model:'gpt-image-2', prompt:'一只在雨夜霓虹街头散步的橘猫', size:'16:9', n:1 };
  const task = await call('POST', '/v1/images/generations', { bearer:secret, body:request, headers:{ 'Idempotency-Key':'order-42' } });
  assert.equal(task.status, 200, JSON.stringify(task.body));
  assert.match(task.body.id, /^img_[a-f0-9]+$/);
  assert.equal(task.body.object, 'image');
  assert.ok(['queued', 'in_progress', 'completed'].includes(task.body.status));
  assert.deepEqual(task.body.data, task.body.status === 'completed' ? task.body.data : []);

  const replay = await call('POST', '/v1/images/generations', { bearer:secret, body:request, headers:{ 'Idempotency-Key':'order-42' } });
  assert.equal(replay.body.id, task.body.id, 'retrying with the same key returns the same task');
  const reused = await call('POST', '/v1/images/generations', { bearer:secret, body:{ ...request, prompt:'另一张' }, headers:{ 'Idempotency-Key':'order-42' } });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, 'idempotency_key_reused');

  let finished = task.body;
  for (let attempt = 0; attempt < 60 && !['completed', 'failed'].includes(finished.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    finished = (await call('GET', `/v1/images/${task.body.id}`, { bearer:secret })).body;
  }
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.data.length, 1);
  assert.equal(finished.data[0].url, `${base}/v1/images/${task.body.id}/content?index=0`);
  assert.equal(upstreamSubmissions, 1, 'idempotent retries never resubmit');

  const content = await call('GET', `/v1/images/${task.body.id}/content?index=0`, { bearer:secret });
  assert.ok([200, 302].includes(content.status));
  if (content.status === 302) assert.equal(content.headers.get('location'), `${upstreamBase}/result.png`);

  const listed = await call('GET', '/v1/images?limit=10', { bearer:secret });
  assert.equal(listed.body.object, 'list');
  assert.deepEqual(listed.body.data.map(item => item.id), [task.body.id]);
  assert.equal((await call('GET', '/v1/videos', { bearer:secret })).body.data.length, 0);

  const credits = await call('GET', '/api/credits');
  assert.equal(credits.body.balance, 10 - finished.credits, 'API usage draws on the shared balance');

  const limited = await call('POST', '/api/console/keys', { body:{ name:'限额', creditLimit:0.5 } });
  const overLimit = await call('POST', '/v1/images/generations', { bearer:limited.body.secret, body:request });
  assert.equal(overLimit.status, 429);
  assert.equal(overLimit.body.error.code, 'key_quota_exceeded');
  assert.equal((await call('GET', '/api/credits')).body.balance, 10 - finished.credits, 'rejected requests are not charged');

  assert.equal((await call('PATCH', `/api/console/keys/${limited.body.key.id}`, { body:{ status:'disabled' } })).status, 200);
  assert.equal((await call('GET', '/v1/models', { bearer:limited.body.secret })).body.error.code, 'api_key_disabled');
  assert.equal((await call('DELETE', `/api/console/keys/${limited.body.key.id}`)).status, 200);
  assert.equal((await call('GET', '/v1/models', { bearer:limited.body.secret })).body.error.code, 'invalid_api_key');

  const keys = await call('GET', '/api/console/keys');
  assert.deepEqual(keys.body.keys.map(key => key.name), ['生产环境']);
  assert.equal(keys.body.keys[0].usedCredits, finished.credits);

  const logs = await call('GET', '/api/console/logs');
  const creation = logs.body.logs.find(log => log.taskId === task.body.id && log.statusCode === 200 && log.method === 'POST');
  assert.ok(creation, 'task creation is logged');
  assert.equal(creation.model, 'gpt-image-2');
  assert.equal(creation.taskStatus.status, 'completed');
  assert.ok(logs.body.logs.some(log => log.errorCode === 'idempotency_key_reused'), 'failed requests are logged');
  assert.equal(logs.body.logs.some(log => log.method === 'GET' && log.statusCode < 400), false, 'successful reads are not logged');
  const errorsOnly = await call('GET', '/api/console/logs?outcome=error');
  assert.ok(errorsOnly.body.logs.length > 0 && errorsOnly.body.logs.every(log => log.statusCode >= 400));

  const overview = await call('GET', '/api/console/overview');
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.equal(overview.body.keys.active, 1);

  const desktopList = await rawRequest(base, '/api/generations?limit=50', { host:`localhost:${port}`, headers:{ Cookie:cookie, 'X-GuGu-Desktop':'1', 'X-GuGu-Device-Id':'desktop-device-1', 'X-GuGu-Workspace-Id':'desktop-workspace-1' } });
  assert.equal(desktopList.status, 200, desktopList.body);
  const desktopItems = JSON.parse(desktopList.body);
  assert.equal((desktopItems.items || desktopItems).length, 0, 'API output never appears in the desktop workspace');

  const removed = await call('DELETE', `/v1/images/${task.body.id}`, { bearer:secret });
  assert.deepEqual(removed.body, { id:task.body.id, object:'image.deleted', deleted:true });
  assert.equal((await call('GET', `/v1/images/${task.body.id}`, { bearer:secret })).status, 404);
});
