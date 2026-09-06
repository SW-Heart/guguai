import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { __test } from '../server.mjs';
import { sql } from '../lib/db.mjs';
import {
  claimGenerationJobs,
  enqueueGenerationJob,
  findAsset,
  insertUser,
  saveGenerationRecord,
} from '../lib/store.mjs';
import { createMediaArchiveService } from '../services/media-archive.mjs';

test('generation archive uses its configured runtime dependencies without call-site overrides', async () => {
  const calls = [];
  let storedAsset = null;
  const task = { id:'generation-default-deps', type:'video', sourceRequiresAuth:false };
  const service = createMediaArchiveService({
    assertGenerationJobLease:() => {},
    findAsset:() => storedAsset,
    findGeneration:() => task,
    saveAsset:async () => {},
    saveGenerationAsset:(_userId, asset) => { storedAsset = asset; },
    withMediaTempDir:async (_label, callback) => callback('/tmp'),
    generationAssetExtension:() => '.mp4',
    generationAssetName:() => '生成视频.mp4',
    generationSourceHeaders:() => ({}),
    assetObjectKey:() => 'assets/result.mp4',
    download:async () => { calls.push('download'); return { contentType:'video/mp4', size:12 }; },
    put:async () => { calls.push('put'); },
    remove:async () => { calls.push('remove'); },
    now:() => '2026-09-06T00:00:00.000Z',
  });

  await service.archiveGenerationResult('user-default-deps', task, 'https://example.test/result.mp4');

  assert.deepEqual(calls, ['download', 'put']);
  assert.equal(storedAsset.objectKey, 'assets/result.mp4');
  assert.equal(task.status, 'completed');
});

test('generation archive does not persist an asset after lease loss during upload', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userId = `archive-lease-user-${suffix}`;
  const generationId = `archive-lease-generation-${suffix}`;
  const assetId = `archive-lease-asset-${suffix}`;
  const owner = `archive-worker-${suffix}`;
  insertUser({ id:userId, username:userId, role:'user', status:'active', passwordHash:'scrypt:x:y', credits:0, creditBalanceMicro:0, creditHeldMicro:0, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  saveGenerationRecord(userId, { id:generationId, type:'video', status:'completed', assetId, sourceUrl:'https://example.test/result.mp4', sourceRequiresAuth:false, archivePending:true, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  const job = enqueueGenerationJob({ userId, generationId, kind:'archive', nextRunAt:Date.now() });
  const [lease] = claimGenerationJobs({ owner, now:Date.now(), limit:1, leaseMs:60_000 });
  assert.equal(lease.id, job.id);

  const removedObjects = [];
  const archiveTask = { id:generationId, assetId, type:'video', sourceRequiresAuth:false };
  await assert.rejects(
    __test.archiveGenerationResult(userId, archiveTask, 'https://example.test/result.mp4', {
      leaseGuard:{ id:lease.id, owner, leaseToken:lease.leaseToken },
      download:async (_url, target) => {
        await fs.writeFile(target, 'video-payload');
        return { contentType:'video/mp4', size:13 };
      },
      put:async () => {
        sql('UPDATE generation_jobs SET lease_until = :expired WHERE id = :id').run({ id:lease.id, expired:Date.now() - 1 });
      },
      remove:async key => { removedObjects.push(key); },
    }),
    error => error.code === 'GENERATION_JOB_LEASE_LOST',
  );
  assert.equal(findAsset(userId, assetId), null);
  assert.equal(removedObjects.length, 1);
  assert.match(removedObjects[0], new RegExp(assetId));
});
