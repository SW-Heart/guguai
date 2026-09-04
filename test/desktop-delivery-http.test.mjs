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
import { insertUser, saveAssetRecord, saveDramaProjectRecord, saveGenerationRecord } from '../lib/store.mjs';

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
  const dramaAssetId = 'drama-delete-asset';
  const dramaTaskId = 'drama-delete-task';
  const dramaProjectId = 'drama-delete-project';
  const dramaShotId = 'drama-delete-shot';
  const wholeShotAssetId = 'drama-whole-shot-asset';
  const wholeShotTaskId = 'drama-whole-shot-task';
  const wholeShotId = 'drama-whole-shot';
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
  saveAssetRecord(userId, {
    id: dramaAssetId, ownerId: userId, name: '短剧版本.mp4', kind: 'video', mimeType: 'video/mp4', size: 0,
    storageName: `${dramaAssetId}.mp4`, source: 'generation', sourceGenerationId: dramaTaskId,
    remoteStatus: 'pending', deliveryStatus: 'awaiting_local', createdAt, updatedAt: createdAt,
  });
  saveGenerationRecord(userId, {
    id: dramaTaskId, ownerId: userId, type: 'video', status: 'completed', provider: 'duomi', providerTaskId: 'drama-delete-provider-task',
    assetId: dramaAssetId, dramaProjectId, dramaShotId, archivePending: false, creditStatus: 'charged', creditCost: 0,
    createdAt, updatedAt: createdAt,
  });
  saveAssetRecord(userId, {
    id: wholeShotAssetId, ownerId: userId, name: '整镜删除版本.mp4', kind: 'video', mimeType: 'video/mp4', size: 0,
    storageName: `${wholeShotAssetId}.mp4`, source: 'generation', sourceGenerationId: wholeShotTaskId,
    remoteStatus: 'pending', deliveryStatus: 'awaiting_local', createdAt, updatedAt: createdAt,
  });
  saveGenerationRecord(userId, {
    id: wholeShotTaskId, ownerId: userId, type: 'video', status: 'completed', provider: 'duomi', providerTaskId: 'drama-whole-shot-provider-task',
    assetId: wholeShotAssetId, dramaProjectId, dramaShotId: wholeShotId, archivePending: false, creditStatus: 'charged', creditCost: 0,
    createdAt, updatedAt: createdAt,
  });
  saveDramaProjectRecord(userId, {
    id: dramaProjectId, ownerId: userId, title: '删除同步测试项目', mode: 'professional', step: 'video', maxStep: 'video', status: 'active',
    input: '', synopsis: '', script: '', scenes: [], resources: [],
    settings: { shotCount: 2, totalDuration: 40, shotDuration: 20, aspectRatio: '9:16' },
    shots: [
      { id: dramaShotId, title: '删除同步测试镜头', script: '测试', prompt: '测试', sceneId: '', resourceIds: [], referenceAssetIds: [],
        generation: { type: 'TEXT', modelId: '', firstFrameAssetId: '', lastFrameAssetId: '', referenceAssetIds: [], quality: '720p', count: 1 },
        lifecycle: { status: 'generated', revision: 1, staleReasons: [] }, videoVersions: [dramaTaskId], selectedVideoTaskId: dramaTaskId, tailFrameAssetId: '' },
      { id: wholeShotId, title: '整镜删除测试', script: '测试整镜删除', prompt: '测试', sceneId: '', resourceIds: [], referenceAssetIds: [],
        generation: { type: 'TEXT', modelId: '', firstFrameAssetId: '', lastFrameAssetId: '', referenceAssetIds: [], quality: '720p', count: 1 },
        lifecycle: { status: 'generated', revision: 1, staleReasons: [] }, videoVersions: [wholeShotTaskId], selectedVideoTaskId: wholeShotTaskId, tailFrameAssetId: '' },
    ],
    createdAt, updatedAt: createdAt,
  });
  closeDatabase({ checkpoint: false });

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: { ...process.env, NODE_ENV: 'development', GUGU_TEST_ALLOW_BROWSER_WORKSPACE:'1', DATA_DIR: dataDir, PORT: String(port), OAI_API_BASE: `${upstreamBase}/v1`, OAIAPI_GEMINI_KEY: 'test-oai-key', DESKTOP_DIRECT_DELIVERY_GRACE_SECONDS: '3600' },
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

  const missingScope = await fetch(`${base}/api/generations`, {
    headers: { ...headers, 'X-GuGu-Desktop':'1', 'X-GuGu-Device-Id':'device-a-123456' },
  });
  assert.equal(missingScope.status, 400, '桌面请求缺少工作区标识时应被拒绝');
  const scopeAHeaders = {
    ...headers,
    'X-GuGu-Desktop':'1',
    'X-GuGu-Device-Id':'device-a-123456',
    'X-GuGu-Workspace-Id':'workspace-a-123456',
  };
  const claimA = await fetch(`${base}/api/workspaces/claim-legacy`, {
    method:'POST', headers:{ ...scopeAHeaders, 'Content-Type':'application/json' },
    body:JSON.stringify({ assetIds:[assetId] }),
  });
  assert.equal(claimA.status, 200);
  const scopedTasksA = await fetch(`${base}/api/generations`, { headers:scopeAHeaders });
  assert.deepEqual((await scopedTasksA.json()).map(task => task.id), [taskId]);
  const scopedFilesA = await fetch(`${base}/api/files`, { headers:scopeAHeaders });
  assert.deepEqual((await scopedFilesA.json()).map(file => file.id), [assetId]);
  const scopeBHeaders = {
    ...headers,
    'X-GuGu-Desktop':'1',
    'X-GuGu-Device-Id':'device-b-123456',
    'X-GuGu-Workspace-Id':'workspace-b-123456',
  };
  const claimB = await fetch(`${base}/api/workspaces/claim-legacy`, {
    method:'POST', headers:{ ...scopeBHeaders, 'Content-Type':'application/json' },
    body:JSON.stringify({ assetIds:[authenticatedAssetId] }),
  });
  assert.equal(claimB.status, 200);
  const scopedTasksB = await fetch(`${base}/api/generations`, { headers:scopeBHeaders });
  assert.deepEqual((await scopedTasksB.json()).map(task => task.id), [authenticatedTaskId]);

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
  assert.ok(firstSyncData.deliveries.some(file => file.id === assetId), '尚未归档的普通上游结果应立即投递');
  assert.ok(firstSyncData.deliveries.some(file => file.id === authenticatedAssetId), '尚未归档的鉴权上游结果应立即投递');
  assert.ok(firstSyncData.deliveries.some(file => file.id === remoteBackedAssetId));
  assert.ok(firstSyncData.nextCursor);

  const targetedSync = await fetch(`${base}/api/files/sync?deviceId=device-targeted-123456&assetIds=${assetId}&limit=20`, { headers });
  assert.equal(targetedSync.status, 200);
  assert.ok((await targetedSync.json()).deliveries.some(file => file.id === assetId), '定向补拉也应返回尚未归档的上游结果');

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
  assert.equal(secondSyncData.deliveries.some(file => file.id === assetId), false, '本地确认后不应继续投递直收结果');
  assert.equal(secondSyncData.deliveries.some(file => file.id === remoteBackedAssetId), true);

  const acknowledgedRemote = await fetch(`${base}/api/files/${remoteBackedAssetId}/local-ready`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: upstreamPayload.length, sha256: digest, mimeType: 'video/mp4', deviceId: 'device-a-123456' }),
  });
  assert.equal(acknowledgedRemote.status, 200);
  const thirdSync = await fetch(`${base}/api/files/sync?deviceId=device-a-123456&cursor=${encodeURIComponent(secondSyncData.nextCursor)}&limit=20`, { headers });
  assert.equal(thirdSync.status, 200);
  const thirdSyncData = await thirdSync.json();
  assert.equal(thirdSyncData.deliveries.some(file => file.id === remoteBackedAssetId), false, '同一设备确认后不应重复投递');

  const deletedDramaVersion = await fetch(`${base}/api/drama/projects/${dramaProjectId}/shots/${dramaShotId}/videos/${dramaTaskId}`, {
    method: 'DELETE', headers,
  });
  assert.equal(deletedDramaVersion.status, 200);
  const deletedDramaData = await deletedDramaVersion.json();
  assert.deepEqual(deletedDramaData.project.shots[0].videoVersions, []);
  assert.equal(deletedDramaData.project.shots[0].selectedVideoTaskId, '');
  const dramaAssetAfterDelete = await fetch(`${base}/api/files/${dramaAssetId}`, { headers });
  assert.equal(dramaAssetAfterDelete.status, 404);
  const dramaTaskAfterDelete = await fetch(`${base}/api/generations?ids=${dramaTaskId}`, { headers });
  assert.deepEqual(await dramaTaskAfterDelete.json(), []);

  const deletedWholeShot = await fetch(`${base}/api/drama/projects/${dramaProjectId}/shots/${wholeShotId}`, {
    method: 'DELETE', headers,
  });
  assert.equal(deletedWholeShot.status, 200);
  const deletedWholeShotData = await deletedWholeShot.json();
  assert.deepEqual(deletedWholeShotData.project.shots.map(shot => shot.id), [dramaShotId]);
  assert.deepEqual(deletedWholeShotData.deletedTaskIds, [wholeShotTaskId]);
  assert.deepEqual(deletedWholeShotData.deletedAssetIds, [wholeShotAssetId]);
  const wholeShotAssetAfterDelete = await fetch(`${base}/api/files/${wholeShotAssetId}`, { headers });
  assert.equal(wholeShotAssetAfterDelete.status, 404);
  const wholeShotTaskAfterDelete = await fetch(`${base}/api/generations?ids=${wholeShotTaskId}`, { headers });
  assert.deepEqual(await wholeShotTaskAfterDelete.json(), []);

  const staleProjectSave = await fetch(`${base}/api/drama/projects/${dramaProjectId}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: deletedWholeShotData.project.revision - 1, title: '不应覆盖的新标题' }),
  });
  assert.equal(staleProjectSave.status, 409);
  const staleProjectSaveData = await staleProjectSave.json();
  assert.equal(staleProjectSaveData.code, 'PROJECT_VERSION_CONFLICT');
  assert.notEqual(staleProjectSaveData.project.title, '不应覆盖的新标题');

  const deletionSync = await fetch(`${base}/api/files/sync?deviceId=device-a-123456&cursor=${encodeURIComponent(thirdSyncData.nextCursor)}&limit=20`, { headers });
  assert.equal(deletionSync.status, 200);
  const deletionSyncData = await deletionSync.json();
  assert.ok(deletionSyncData.changes.some(change => change.action === 'delete' && change.assetId === dramaAssetId));

  // 批量确认：客户端启动对账一次提交一页，单条被拒绝不能让整批失败。
  const authenticatedDigest = createHash('sha256').update(authenticatedPayload).digest('hex');
  const batch = await fetch(`${base}/api/files/local-ready`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'device-b-123456',
      items: [
        { id: authenticatedAssetId, size: authenticatedPayload.length, sha256: authenticatedDigest, mimeType: 'video/mp4' },
        { id: 'missing-asset', size: 1, sha256: authenticatedDigest, mimeType: 'video/mp4' },
        { id: localAssetId, size: localPayload.length, sha256: 'not-a-digest', mimeType: 'video/mp4' },
      ],
    }),
  });
  assert.equal(batch.status, 200);
  const batchData = await batch.json();
  assert.equal(batchData.acknowledged, 1);
  assert.deepEqual(batchData.results.map(result => [result.id, result.ok]), [
    [authenticatedAssetId, true],
    ['missing-asset', false],
    [localAssetId, false],
  ]);
  assert.match(batchData.results[1].error, /文件不存在/);
  assert.match(batchData.results[2].error, /SHA-256/);

  const acknowledgedInBatch = await fetch(`${base}/api/files/${authenticatedAssetId}`, { headers });
  const acknowledgedInBatchAsset = await acknowledgedInBatch.json();
  assert.equal(acknowledgedInBatchAsset.deliveryStatus, 'local_ready');
  assert.equal(acknowledgedInBatchAsset.size, authenticatedPayload.length);
  const batchGenerations = await fetch(`${base}/api/generations`, { headers });
  const batchGeneration = (await batchGenerations.json()).find(item => item.id === authenticatedTaskId);
  assert.equal(batchGeneration.status, 'completed');

  const emptyBatch = await fetch(`${base}/api/files/local-ready`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-b-123456', items: [] }),
  });
  assert.equal(emptyBatch.status, 400);
  const oversizedBatch = await fetch(`${base}/api/files/local-ready`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-b-123456', items: Array.from({ length: 201 }, () => ({ id: localAssetId, size: 1, sha256: authenticatedDigest, mimeType: 'video/mp4' })) }),
  });
  assert.equal(oversizedBatch.status, 400);
});
