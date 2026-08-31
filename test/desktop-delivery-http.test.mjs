import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { insertUser, saveAssetRecord, saveGenerationRecord } from '../lib/store.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitForServer(child, base) {
  let output = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(`GuGu AI: ${base}`)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}：${output}`)); });
  });
}

test('desktop delivery prefers local copies, falls back upstream, and acknowledges persistence', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'desktop-delivery-'));
  const upstreamPayload = Buffer.from('upstream-video-payload');
  const authenticatedPayload = Buffer.from('authenticated-upstream-video-payload');
  let authenticatedRequestSeen = false;
  const upstream = createServer((req, res) => {
    if (req.url === '/v1/videos/auth-task/content') {
      authenticatedRequestSeen = true;
      if (req.headers.authorization !== 'Bearer test-oai-key') {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        return res.end('missing upstream authorization');
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': authenticatedPayload.length });
      return res.end(authenticatedPayload);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': upstreamPayload.length });
    res.end(upstreamPayload);
  });
  const upstreamBase = await listen(upstream);
  const port = await (async () => {
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const value = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return value;
  })();
  const base = `http://127.0.0.1:${port}`;
  const userId = 'delivery-user';
  const assetId = 'delivery-asset';
  const taskId = 'delivery-task';
  const authenticatedAssetId = 'authenticated-delivery-asset';
  const authenticatedTaskId = 'authenticated-delivery-task';
  const remoteBackedAssetId = 'remote-backed-delivery-asset';
  const localAssetId = 'local-delivery-asset';
  const localPayload = Buffer.from('local-video-payload');
  const createdAt = new Date().toISOString();
  const sourceUrl = `${upstreamBase}/result.mp4`;
  const authenticatedSourceUrl = `${upstreamBase}/v1/videos/auth-task/content`;
  const localDeliveryDeadlineAt = new Date(Date.now() + 60 * 60_000).toISOString();

  resetForTests();
  openDatabase({ file: path.join(dataDir, 'studio.db') });
  insertUser({ id: userId, username: 'delivery_user', role: 'user', status: 'active', passwordHash: await hashPassword('delivery-password-123'), credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  saveAssetRecord(userId, {
    id: assetId, ownerId: userId, name: '生成视频.mp4', kind: 'video', mimeType: 'video/mp4', size: 0,
    storageName: `${assetId}.mp4`, source: 'generation', sourceGenerationId: taskId, sourceUrl,
    sourceRequiresAuth: false, deliveryStatus: 'awaiting_local', remoteStatus: 'pending', createdAt, updatedAt: createdAt,
  });
  saveAssetRecord(userId, {
    id: localAssetId, ownerId: userId, name: '本地视频.mp4', kind: 'video', mimeType: 'video/mp4', size: localPayload.length,
    storageName: `${localAssetId}.mp4`, source: 'generation', sourceGenerationId: '', sourceUrl: '',
    remoteStatus: 'local_only', createdAt, updatedAt: createdAt,
  });
  const localDir = path.join(dataDir, 'users', userId, 'files');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(path.join(localDir, `${localAssetId}.mp4`), localPayload);
  saveAssetRecord(userId, {
    id: authenticatedAssetId, ownerId: userId, name: '鉴权生成视频.mp4', kind: 'video', mimeType: 'video/mp4', size: 0,
    storageName: `${authenticatedAssetId}.mp4`, source: 'generation', sourceGenerationId: authenticatedTaskId, sourceUrl: authenticatedSourceUrl,
    sourceRequiresAuth: true, deliveryStatus: 'awaiting_local', remoteStatus: 'pending', createdAt, updatedAt: createdAt,
  });
  saveAssetRecord(userId, {
    id: remoteBackedAssetId, ownerId: userId, name: '已归档视频.mp4', kind: 'video', mimeType: 'video/mp4', size: upstreamPayload.length,
    storageName: `${remoteBackedAssetId}.mp4`, objectKey: `assets/${remoteBackedAssetId}.mp4`, source: 'generation', sourceGenerationId: 'remote-backed-task',
    sourceUrl: '', sourceRequiresAuth: false, deliveryStatus: 'remote_backed_up', remoteStatus: 'ready', createdAt, updatedAt: createdAt,
  });
  saveGenerationRecord(userId, {
    id: taskId, ownerId: userId, type: 'video', status: 'completed', provider: 'duomi', providerTaskId: 'upstream-task',
    assetId, sourceUrl, sourceRequiresAuth: false, archivePending: true, localDeliveryDeadlineAt, creditStatus: 'charged', creditCost: 0,
    createdAt, updatedAt: createdAt,
  });
  saveGenerationRecord(userId, {
    id: authenticatedTaskId, ownerId: userId, type: 'video', status: 'completed', provider: 'oai', providerTaskId: 'auth-task',
    assetId: authenticatedAssetId, sourceUrl: authenticatedSourceUrl, sourceRequiresAuth: true, archivePending: true, localDeliveryDeadlineAt, creditStatus: 'charged', creditCost: 0,
    createdAt, updatedAt: createdAt,
  });
  closeDatabase({ checkpoint: false });

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: { ...process.env, NODE_ENV: 'development', DESKTOP_APP_ONLY: 'false', DATA_DIR: dataDir, PORT: String(port), OAI_API_BASE: `${upstreamBase}/v1`, OAIAPI_GEMINI_KEY: 'test-oai-key', DESKTOP_DIRECT_DELIVERY_GRACE_SECONDS: '3600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(child, base);

  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'delivery_user', password: 'delivery-password-123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie };

  const list = await fetch(`${base}/api/files`, { headers });
  assert.equal(list.status, 200);
  const files = await list.json();
  const plainFile = files.find(file => file.id === assetId);
  const authenticatedFile = files.find(file => file.id === authenticatedAssetId);
  const localFile = files.find(file => file.id === localAssetId);
  assert.equal(plainFile.directUrl, `/api/files/${assetId}/direct`);
  assert.equal(plainFile.sourceUrl, undefined);
  assert.equal(authenticatedFile.directUrl, `/api/files/${authenticatedAssetId}/direct`);
  assert.equal(authenticatedFile.sourceUrl, undefined);

  const firstSync = await fetch(`${base}/api/files/sync?deviceId=device-a-123456&limit=20`, { headers });
  assert.equal(firstSync.status, 200);
  const firstSyncData = await firstSync.json();
  assert.deepEqual(firstSyncData.changes, [], '首个设备游标从当前检查点开始');
  assert.ok(firstSyncData.deliveries.some(file => file.id === remoteBackedAssetId));
  assert.ok(firstSyncData.nextCursor);

  const single = await fetch(`${base}/api/files/${assetId}`, { headers });
  assert.equal(single.status, 200);
  assert.equal((await single.json()).id, assetId);

  const localDirect = await fetch(`${base}${localFile.directUrl}`, { headers, redirect: 'manual' });
  assert.equal(localDirect.status, 302);
  assert.equal(localDirect.headers.get('location'), `/api/files/${localAssetId}/content`);
  const localDownloaded = await fetch(`${base}${localFile.directUrl}`, { headers });
  assert.equal(localDownloaded.status, 200);
  assert.deepEqual(Buffer.from(await localDownloaded.arrayBuffer()), localPayload);

  const direct = await fetch(`${base}${plainFile.directUrl}`, { headers, redirect: 'manual' });
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.get('location'), sourceUrl);

  const authenticatedDirect = await fetch(`${base}${authenticatedFile.directUrl}`, { headers });
  assert.equal(authenticatedDirect.status, 200);
  assert.deepEqual(Buffer.from(await authenticatedDirect.arrayBuffer()), authenticatedPayload);
  assert.equal(authenticatedRequestSeen, true);

  const digest = createHash('sha256').update(upstreamPayload).digest('hex');
  const acknowledged = await fetch(`${base}/api/files/${assetId}/local-ready`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: upstreamPayload.length, sha256: digest, mimeType: 'video/mp4', deviceId: 'device-a-123456' }),
  });
  assert.equal(acknowledged.status, 200);
  const acknowledgedAsset = await acknowledged.json();
  assert.equal(acknowledgedAsset.deliveryStatus, 'local_ready');
  assert.equal(acknowledgedAsset.size, upstreamPayload.length);
  const generations = await fetch(`${base}/api/generations`, { headers });
  const generation = (await generations.json()).find(item => item.id === taskId);
  assert.equal(generation.status, 'completed');
  assert.equal(generation.progressStage, 'completed');

  const secondSync = await fetch(`${base}/api/files/sync?deviceId=device-a-123456&cursor=${encodeURIComponent(firstSyncData.nextCursor)}&limit=20`, { headers });
  assert.equal(secondSync.status, 200);
  const secondSyncData = await secondSync.json();
  assert.ok(secondSyncData.changes.some(change => change.assetId === assetId));
  assert.equal(secondSyncData.deliveries.some(file => file.id === remoteBackedAssetId), true);

  const acknowledgedRemote = await fetch(`${base}/api/files/${remoteBackedAssetId}/local-ready`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: upstreamPayload.length, sha256: digest, mimeType: 'video/mp4', deviceId: 'device-a-123456' }),
  });
  assert.equal(acknowledgedRemote.status, 200);
  const thirdSync = await fetch(`${base}/api/files/sync?deviceId=device-a-123456&cursor=${encodeURIComponent(secondSyncData.nextCursor)}&limit=20`, { headers });
  assert.equal(thirdSync.status, 200);
  assert.equal((await thirdSync.json()).deliveries.some(file => file.id === remoteBackedAssetId), false, '同一设备确认后不应重复投递');
});
