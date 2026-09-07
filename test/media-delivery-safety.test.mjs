import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { __test } from '../server.mjs';
import { insertUser, saveAssetRecord, saveGenerationRecord, findAsset, findGeneration, enqueueGenerationJob, claimGenerationJobs } from '../lib/store.mjs';
import { createFilesRouteHandler } from '../server/routes/files.mjs';

function fixture() {
  const userId = randomUUID();
  const timestamp = new Date().toISOString();
  insertUser({ id:userId, username:userId, passwordHash:'x', role:'user', status:'active', credits:0, creditBalanceMicro:0, creditHeldMicro:0, createdAt:timestamp, updatedAt:timestamp });
  const task = { id:randomUUID(), type:'video', status:'completed', archivePending:true, creditStatus:'charged', createdAt:timestamp, updatedAt:timestamp };
  const asset = { id:randomUUID(), kind:'video', sourceGenerationId:task.id, deliveryStatus:'awaiting_local', size:0, createdAt:timestamp, updatedAt:timestamp };
  task.assetId = asset.id;
  saveGenerationRecord(userId, task);
  saveAssetRecord(userId, asset);
  return { userId, task, asset };
}

test('local-ready reads the asset after the body and preserves a concurrent archive', async () => {
  const { userId, asset } = fixture();
  let response;
  const handler = createFilesRouteHandler({
    requireUser:() => ({ id:userId }), requireDesktopWorkspaceScope:() => ({}), normalizeDeviceId:() => '', findAsset,
    bodyJson:async () => {
      saveAssetRecord(userId, { ...asset, size:20, objectKey:'backup/video.mp4', mimeType:'video/mp4', sha256:'a'.repeat(64) });
      return { size:20, sha256:'a'.repeat(64), mimeType:'video/webm' };
    },
    applyLocalReadyAcknowledgement:__test.applyLocalReadyAcknowledgement,
    publicAsset:value => value,
    sendJson:(_res, status, body) => { response = { status, body }; },
  });
  await handler({ method:'POST' }, {}, new URL(`https://example.test/api/files/${asset.id}/local-ready`));
  assert.equal(response.status, 200);
  assert.equal(findAsset(userId, asset.id).objectKey, 'backup/video.mp4');
  assert.equal(findAsset(userId, asset.id).mimeType, 'video/mp4');
  assert.equal(findAsset(userId, asset.id).deliveryStatus, 'local_ready');
});

test('invalid archive source stops delivery retries without failing or refunding generation', async () => {
  for (const sourceUrl of [undefined, '', '   ', 5, 'bad url', 'file:///tmp/video']) {
    const { userId, task } = fixture();
    task.sourceUrl = sourceUrl;
    saveGenerationRecord(userId, task);
    await __test.archiveGenerationWithRetry(userId, task);
    const saved = findGeneration(userId, task.id);
    assert.equal(saved.archivePending, false);
    assert.equal(saved.archiveErrorCode, 'INVALID_SOURCE_URL');
    assert.equal(saved.status, 'completed');
    assert.equal(saved.creditStatus, 'charged');
  }
});

test('authenticated upstream stream failure is handled without escaping the request', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1,2])); },
    pull(controller) { controller.error(new Error('upstream stream interrupted')); },
  })));
  const res = new Writable({ write(_chunk, _encoding, done) { done(); } });
  res.writeHead = () => { res.headersSent = true; };
  assert.equal(await __test.servePendingGenerationSource(res, { id:'stream', sourceUrl:'https://example.test/video', sourceRequiresAuth:true }), true);
  assert.equal(res.destroyed, true);
});

test('backup requests reuse the durable archive job and never undo a local receipt', async () => {
  const { userId, task, asset } = fixture();
  task.sourceUrl = asset.sourceUrl = 'https://example.test/video';
  saveGenerationRecord(userId, task);
  saveAssetRecord(userId, asset);
  const job = enqueueGenerationJob({ userId, generationId:task.id, kind:'archive', nextRunAt:Date.now() });
  // An existing worker owns this task; the request must not create parallel work.
  const [lease] = claimGenerationJobs({ owner:'test-archive-worker', limit:1, leaseMs:60_000 });
  assert.equal(lease.id, job.id);
  assert.equal(__test.requestGenerationArchive(userId, findAsset(userId, asset.id)).status, 'pending');
  assert.equal(enqueueGenerationJob({ userId, generationId:task.id, kind:'archive' }).id, job.id);
  await __test.applyLocalReadyAcknowledgement(userId, findAsset(userId, asset.id), { size:20, sha256:'a'.repeat(64), mimeType:'video/mp4' });
  assert.equal(__test.requestGenerationArchive(userId, findAsset(userId, asset.id)).status, 'local_ready');
  assert.equal(findGeneration(userId, task.id).archivePending, false);
});

test('mismatched receipts cannot overwrite archived metadata or finish delivery', async () => {
  const { userId, task, asset } = fixture();
  saveAssetRecord(userId, { ...asset, objectKey:'backup/video.mp4', size:20, sha256:'a'.repeat(64) });
  const outcome = await __test.applyLocalReadyAcknowledgement(userId, findAsset(userId, asset.id), { size:20, sha256:'b'.repeat(64), mimeType:'video/mp4' });
  assert.equal(outcome.status, 409);
  assert.equal(findGeneration(userId, task.id).archivePending, true);
  assert.equal(findAsset(userId, asset.id).sha256, 'a'.repeat(64));
});
