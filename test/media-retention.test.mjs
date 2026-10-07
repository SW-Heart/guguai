import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cloudCopyExpiresAt, createMediaRetentionService } from '../services/media-retention.mjs';
import { __test } from '../server.mjs';

const day = 24 * 3600_000;
const at = Date.parse('2026-10-20T00:00:00Z');
const iso = offsetDays => new Date(at + offsetDays * day).toISOString();

test('cloud copies count down from local save, upload, or a long fallback for undelivered output', () => {
  assert.equal(cloudCopyExpiresAt({ objectKey:'k', localReadyAt:iso(-1), createdAt:iso(-20) }), at + 5 * day);
  assert.equal(cloudCopyExpiresAt({ objectKey:'k', source:'upload', objectUploadedAt:iso(-2) }), at + 4 * day);
  assert.equal(cloudCopyExpiresAt({ objectKey:'k', source:'generation', objectUploadedAt:iso(-2) }), at + 28 * day);
  assert.equal(cloudCopyExpiresAt({ objectKey:'k', source:'agent-edited-video', createdAt:iso(-31) }), at - day);
  assert.equal(cloudCopyExpiresAt({ localReadyAt:iso(-10) }), null);
});

function harness(rows, { active = [] } = {}) {
  const saved = [];
  const deletedObjects = [];
  const removedFiles = [];
  const service = createMediaRetentionService({
    listAssetsWithObjects:({ afterId, limit }) => rows.filter(row => row.id > afterId && row.asset.objectKey).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit),
    saveAsset:async (userId, asset) => { saved.push({ userId, asset }); const row = rows.find(item => item.id === asset.id); row.asset = asset; },
    deleteObject:async key => deletedObjects.push(key),
    removeServerCopy:async (_userId, asset) => removedFiles.push(asset.storageName),
    activeReferenceAssetIds:() => active,
    now:() => at,
    pageSize:2,
    logger:{ error() {} },
  });
  return { service, saved, deletedObjects, removedFiles };
}

const row = (id, asset) => ({ userId:'u1', id, asset:{ id, storageName:`${id}.mp4`, size:10, kind:'video', ...asset } });

test('expired copies are deleted and the record becomes local-only or expired', async () => {
  const rows = [
    row('a1', { objectKey:'model-studio/u1/a1.mp4', localReadyAt:iso(-7) }),
    row('a2', { objectKey:'model-studio/u1/a2.mp4', localReadyAt:iso(-1) }),
    row('a3', { objectKey:'model-studio/u1/a3.mp4', source:'generation', objectUploadedAt:iso(-31) }),
    row('a4', { objectKey:'model-studio/assets/u1/a4.png', source:'upload', objectUploadedAt:iso(-7) }),
  ];
  const { service, deletedObjects, removedFiles } = harness(rows);
  const result = await service.sweepExpiredAssets();
  assert.equal(result.expired, 3);
  assert.deepEqual(deletedObjects, ['model-studio/u1/a1.mp4', 'model-studio/u1/a3.mp4', 'model-studio/assets/u1/a4.png']);
  assert.deepEqual(removedFiles, ['a1.mp4', 'a3.mp4', 'a4.mp4']);
  assert.equal(rows[0].asset.objectKey, undefined);
  assert.equal(rows[0].asset.remoteStatus, 'local_only');
  assert.equal(rows[0].asset.remoteExpiredAt, new Date(at).toISOString());
  assert.equal(rows[2].asset.remoteStatus, 'expired');
  assert.equal(rows[3].asset.remoteStatus, 'local_only');
  assert.equal(rows[1].asset.objectKey, 'model-studio/u1/a2.mp4');
});

test('dry runs change nothing, active tasks protect their files, and a cutoff clears old data', async () => {
  const rows = [
    row('b1', { objectKey:'oline/u1/b1.mp4', localReadyAt:iso(-1), createdAt:iso(-40) }),
    row('b2', { objectKey:'model-studio/u1/b2.mp4', localReadyAt:iso(-8) }),
    row('b3', { objectKey:'model-studio/u1/b3.mp4', localReadyAt:iso(-1), objectUploadedAt:iso(-1) }),
  ];
  const dry = harness(rows, { active:['b2'] });
  const preview = await dry.service.sweepExpiredAssets({ dryRun:true, before:at - 6 * day });
  assert.deepEqual(preview.items.map(item => item.assetId), ['b1']);
  assert.equal(preview.skippedInUse, 1);
  assert.equal(dry.deletedObjects.length, 0);
  assert.equal(dry.saved.length, 0);
  assert.equal(rows[0].asset.objectKey, 'oline/u1/b1.mp4');
});

test('reference sweep deletes only objects older than a day', async () => {
  const deleted = [];
  const service = createMediaRetentionService({
    listAssetsWithObjects:() => [], saveAsset:async () => {}, deleteObject:async () => {}, removeServerCopy:async () => {}, activeReferenceAssetIds:() => [],
    listReferenceObjects:async function* () {
      yield { key:'old.png', lastModified:new Date(at - 25 * 3600_000) };
      yield { key:'fresh.png', lastModified:new Date(at - 2 * 3600_000) };
    },
    deleteReferenceObject:async key => deleted.push(key),
    now:() => at,
  });
  assert.deepEqual(await service.sweepReferenceObjects(), { deleted:1 });
  assert.deepEqual(deleted, ['old.png']);
});

test('expired copies are exposed to clients and never re-archived', () => {
  const publicAsset = __test.publicAsset({ id:'x', name:'n', kind:'video', remoteStatus:'local_only', remoteExpiredAt:'2026-10-20T00:00:00.000Z', storageName:'x.mp4' });
  assert.equal(publicAsset.remoteStatus, 'local_only');
  assert.equal(publicAsset.remoteExpiredAt, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(__test.requestGenerationArchive('u', { id:'x', remoteExpiredAt:'2026-10-20T00:00:00.000Z', sourceUrl:'https://example.com/x.mp4' }), { error:'这个文件已过云端保存期限' });
});

test('missing cloud copies explain where the file lives instead of a bare 404', () => {
  const route = readFileSync(new URL('../server/routes/files.mjs', import.meta.url), 'utf8');
  assert.match(route, /这个文件只保存在本地电脑上，请在保存过它的电脑上查看/);
  assert.equal((route.match(/sendMissingContent\(res, asset\);/g) || []).length, 2);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function cloudCopyGone\(file\)/);
  assert.match(app, /文件保存在其他电脑上/);
});
