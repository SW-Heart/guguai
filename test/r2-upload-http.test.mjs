import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { insertUser } from '../lib/store.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(child, base) {
  let output = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(`GuGu AI: ${base}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`测试服务退出 ${code}：${output}`));
    });
  });
}

async function startR2Stub() {
  const objects = new Map();
  const bodyOf = async request => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://r2.test');
      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      const bucket = parts.shift() || '';
      const key = parts.join('/');
      const objectId = `${bucket}/${key}`;
      if (request.method === 'PUT' && request.headers['x-amz-copy-source']) {
        await bodyOf(request);
        const source = decodeURIComponent(String(request.headers['x-amz-copy-source'])).replace(/^\/+/, '').split('?')[0];
        const stored = objects.get(source);
        if (!stored) {
          response.writeHead(404, { 'x-amz-request-id': 'r2-stub-copy-missing' });
          return response.end();
        }
        const copied = { ...stored, mimeType: String(request.headers['content-type'] || stored.mimeType), etag: `copy-${stored.etag}` };
        objects.set(objectId, copied);
        response.writeHead(200, { 'Content-Type': 'application/xml', 'x-amz-request-id': 'r2-stub-copy' });
        return response.end(`<CopyObjectResult><ETag>&quot;${copied.etag}&quot;</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`);
      }
      if (request.method === 'PUT') {
        const body = await bodyOf(request);
        const stored = { body, mimeType: String(request.headers['content-type'] || 'application/octet-stream'), etag: `etag-${body.length}` };
        objects.set(objectId, stored);
        response.writeHead(200, { ETag: `"${stored.etag}"`, 'x-amz-request-id': 'r2-stub-put' });
        return response.end();
      }
      const stored = objects.get(objectId);
      if (request.method === 'HEAD') {
        if (!stored) {
          response.writeHead(404, { 'x-amz-request-id': 'r2-stub-head-missing' });
          return response.end();
        }
        response.writeHead(200, {
          'Content-Length': stored.body.length,
          'Content-Type': stored.mimeType,
          ETag: `"${stored.etag}"`,
          'x-amz-request-id': 'r2-stub-head',
        });
        return response.end();
      }
      if (request.method === 'GET') {
        if (!stored) {
          response.writeHead(404, { 'x-amz-request-id': 'r2-stub-get-missing' });
          return response.end();
        }
        const range = /^bytes=(\d+)-(\d+)?$/.exec(String(request.headers.range || ''));
        const start = range ? Number(range[1]) : 0;
        const end = range ? Math.min(stored.body.length - 1, Number(range[2] || stored.body.length - 1)) : stored.body.length - 1;
        const body = stored.body.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, {
          'Content-Length': body.length,
          'Content-Type': stored.mimeType,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stored.body.length}` } : {}),
          'x-amz-request-id': 'r2-stub-get',
        });
        return response.end(body);
      }
      if (request.method === 'DELETE') {
        objects.delete(objectId);
        response.writeHead(204, { 'x-amz-request-id': 'r2-stub-delete' });
        return response.end();
      }
      response.writeHead(405);
      response.end();
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(error.stack || error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, objects, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test('R2-only HTTP upload verifies, promotes, cleans up, and completes idempotently', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'r2-upload-http-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const username = 'r2_upload_http_user';
  const password = 'r2-upload-http-password-123';
  const r2Stub = await startR2Stub();

  resetForTests();
  openDatabase({ file: path.join(dataDir, 'studio.db') });
  const createdAt = new Date().toISOString();
  insertUser({
    id: 'r2-upload-http-user',
    username,
    role: 'user',
    status: 'active',
    passwordHash: await hashPassword(password),
    credits: 0,
    creditBalanceMicro: 0,
    creditHeldMicro: 0,
    createdAt,
    updatedAt: createdAt,
  });
  closeDatabase({ checkpoint: false });

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      GUGU_TEST_ALLOW_BROWSER_WORKSPACE: '1',
      DATA_DIR: dataDir,
      PORT: String(port),
      DIRECT_UPLOAD_ENABLED: 'true',
      R2_ACCESS_KEY_ID: 'test-r2-access-key',
      R2_SECRET_ACCESS_KEY: 'test-r2-secret-key',
      R2_ENDPOINT: r2Stub.endpoint,
      R2_BUCKET: 'test-private-media',
      R2_REGION: 'auto',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => r2Stub.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(child, base);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const configResponse = await fetch(`${base}/api/config`, { headers: { Cookie: cookie } });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.mediaStorageReady, true);
  assert.equal(config.directUpload, true);
  assert.equal('oss' in config, false);
  assert.equal('directOssUpload' in config, false);
  assert.equal('storageProvider' in config, false);

  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('r2-only-upload')]);
  const initResponse = await fetch(`${base}/api/files/uploads/init`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'sample.png',
      mimeType: 'image/png',
      size: png.length,
      sha256: 'a'.repeat(64),
      width: 1,
      height: 1,
    }),
  });
  assert.equal(initResponse.status, 201);
  const intent = await initResponse.json();
  assert.equal(intent.method, 'PUT');
  assert.match(intent.uploadUrl, new RegExp(`^${r2Stub.endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  assert.deepEqual(intent.headers, { 'Content-Type': 'image/png' });
  assert.equal('fields' in intent, false);
  assert.ok(intent.uploadId);
  assert.ok(intent.assetId);
  assert.ok(intent.expiresAt);

  const storageUpload = await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: png });
  assert.equal(storageUpload.status, 200);

  const completeResponse = await fetch(`${base}/api/files/uploads/${intent.uploadId}/complete`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(completeResponse.status, 201);
  const asset = await completeResponse.json();
  assert.equal(asset.id, intent.assetId);
  assert.equal(asset.remoteStatus, 'ready');
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.size, png.length);
  assert.equal('objectKey' in asset, false);

  const objectIds = [...r2Stub.objects.keys()];
  assert.equal(objectIds.some(value => value.includes('/pending/')), false);
  assert.equal(objectIds.some(value => value.includes('/assets/') && value.endsWith(`/${asset.id}.png`)), true);

  const repeated = await fetch(`${base}/api/files/uploads/${intent.uploadId}/complete`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).id, asset.id);

  const contentResponse = await fetch(`${base}/api/files/${asset.id}/content`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(contentResponse.status, 302);
  const signedContentUrl = contentResponse.headers.get('location');
  assert.match(signedContentUrl, /^http:\/\/127\.0\.0\.1:/);
  const downloaded = await fetch(signedContentUrl);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);

  const deletion = await fetch(`${base}/api/files/${asset.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(deletion.status, 200);
  assert.equal(r2Stub.objects.size, 0);
});
