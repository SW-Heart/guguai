import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase, closeDatabase, sql, resetForTests } from '../lib/db.mjs';
import {
  configureCursors, listGenerations, listAssets, listDramaProjects, latestDramaProject, deleteDramaProject,
  claimGenerationJobs, completeGenerationJob, createGenerationRequest, enqueueGenerationJob, findGenerationRequest, generationQueueStats, saveGenerationRecord, saveAssetRecord, saveDramaProjectRecord,
  parseLimit, decodeCursor, encodeCursor, InvalidCursorError,
  findGeneration, findCloudAssets, claimLegacyWorkspace, listPendingGenerations, listAssetChanges, listPendingAssetDeliveries, markAssetDeliveryPending, markAssetDeliveryReady, generationJobLeaseActive, renewGenerationJobLease, rescheduleGenerationJob, deleteAsset, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT,
} from '../lib/store.mjs';

let workDir;

function freshDb() {
  resetForTests();
  workDir = mkdtempSync(path.join(tmpdir(), 'store-'));
  openDatabase({ file: path.join(workDir, 'studio.db') });
  configureCursors('test-cursor-secret');
}

function cleanupDb() {
  closeDatabase({ checkpoint: false });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
}

function makeUser(username = 'u1') {
  const id = randomUUID();
  sql(`INSERT INTO users(id, username, password_hash, role, credit_balance_micro,
                         credit_held_micro, created_at, doc_json)
       VALUES(:id, :username, 'scrypt:x:y', 'user', 0, 0, :createdAt, :docJson)`)
    .run({ id, username, createdAt: new Date().toISOString(), docJson: JSON.stringify({ id }) });
  return id;
}

/** Drains every page and returns the concatenated items. */
function drain(fetch, limit) {
  const out = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = fetch({ limit, cursor });
    assert.ok(page.items.length <= limit, '单页不得超过 limit');
    out.push(...page.items);
    cursor = page.nextCursor;
    assert.ok(++guard < 1000, '翻页未终止');
  } while (cursor);
  return out;
}

test('store pagination', async t => {
  t.beforeEach(freshDb);
  t.afterEach(cleanupDb);

  await t.test('paged reads equal a single full read, with no gaps or repeats', () => {
    const userId = makeUser();
    // Deliberately include timestamp ties to exercise the id tiebreak.
    const stamps = Array.from({ length: 57 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 3))).toISOString());
    for (const [i, createdAt] of stamps.entries()) {
      saveGenerationRecord(userId, {
        id: `gen-${String(i).padStart(3, '0')}`, type: i % 2 ? 'video' : 'image',
        status: 'completed', creditCost: 1, createdAt, updatedAt: createdAt,
      });
    }

    const full = listGenerations(userId, { limit: MAX_PAGE_LIMIT });
    assert.equal(full.total, 57);
    assert.equal(full.items.length, 57);
    assert.equal(full.nextCursor, null);

    for (const limit of [1, 2, 5, 7, 20, 56, 57, 58]) {
      const paged = drain(opts => listGenerations(userId, opts), limit);
      assert.deepEqual(
        paged.map(item => item.id), full.items.map(item => item.id),
        `limit=${limit} 的翻页拼接结果应与全量一致`,
      );
      assert.equal(new Set(paged.map(i => i.id)).size, 57, `limit=${limit} 不得重复`);
    }
  });

  await t.test('sort is created_at DESC then id ASC', () => {
    const userId = makeUser();
    const createdAt = '2026-01-01T00:00:00.000Z';
    for (const id of ['c', 'a', 'b']) {
      saveGenerationRecord(userId, { id, type: 'image', status: 'completed', createdAt, updatedAt: createdAt });
    }
    const page = listGenerations(userId, { limit: 10 });
    assert.deepEqual(page.items.map(i => i.id), ['a', 'b', 'c'], '同一时间戳内按 id 升序');
  });

  await t.test('filters are applied in the database and reflected in total', () => {
    const userId = makeUser();
    for (let i = 0; i < 30; i++) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      saveGenerationRecord(userId, {
        id: `g-${i}`, type: i % 3 === 0 ? 'video' : 'image',
        status: 'completed', createdAt, updatedAt: createdAt,
      });
    }
    const videos = listGenerations(userId, { type: 'video', limit: MAX_PAGE_LIMIT });
    assert.equal(videos.total, 10);
    assert.ok(videos.items.every(item => item.type === 'video'));

    const pagedVideos = drain(opts => listGenerations(userId, { type: 'video', ...opts }), 3);
    assert.deepEqual(pagedVideos.map(i => i.id), videos.items.map(i => i.id));
  });

  await t.test('client views exclude user-deleted audit rows and works excludes non-work records', () => {
    const userId = makeUser();
    saveGenerationRecord(userId, { id:'works-completed', type:'image', status:'completed', assetId:'asset-1', createdAt:'2026-01-03', updatedAt:'2026-01-03' });
    saveGenerationRecord(userId, { id:'works-running', type:'image', status:'running', createdAt:'2026-01-02', updatedAt:'2026-01-02' });
    saveGenerationRecord(userId, { id:'history-failed', type:'image', status:'failed', createdAt:'2026-01-04', updatedAt:'2026-01-04' });
    saveGenerationRecord(userId, { id:'assetless-completed', type:'image', status:'completed', createdAt:'2026-01-01', updatedAt:'2026-01-01' });
    saveGenerationRecord(userId, { id:'user-deleted', type:'image', status:'failed', userDeleted:true, userDeletedAt:'2026-01-05', createdAt:'2026-01-05', updatedAt:'2026-01-05' });

    const works = listGenerations(userId, { view:'works', limit:20 });
    const history = listGenerations(userId, { view:'history', limit:20 });
    assert.deepEqual(works.items.map(item => item.id), ['works-completed', 'works-running']);
    assert.equal(works.total, 2);
    assert.deepEqual(history.items.map(item => item.id), ['history-failed', 'works-completed', 'works-running', 'assetless-completed']);
    assert.equal(history.total, 4);
    assert.equal(findGeneration(userId, 'user-deleted').userDeleted, true);
  });

  await t.test('users cannot see each other rows', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const createdAt = '2026-01-01T00:00:00.000Z';
    saveGenerationRecord(a, { id: 'a-1', type: 'image', status: 'completed', createdAt, updatedAt: createdAt });
    saveGenerationRecord(b, { id: 'b-1', type: 'image', status: 'completed', createdAt, updatedAt: createdAt });

    assert.equal(listGenerations(a, { limit: 10 }).total, 1);
    assert.equal(listGenerations(a, { limit: 10 }).items[0].id, 'a-1');
    assert.equal(findGeneration(a, 'b-1'), null, '跨用户读取应为空');
  });

  await t.test('desktop workspace scope isolates records and claims only local legacy assets', () => {
    const userId = makeUser();
    const scopeA = { deviceId: 'device-a-123456', workspaceId: 'workspace-a-123456' };
    const scopeB = { deviceId: 'device-b-123456', workspaceId: 'workspace-b-123456' };
    const originA = { originDeviceId:scopeA.deviceId, originWorkspaceId:scopeA.workspaceId };
    const originB = { originDeviceId:scopeB.deviceId, originWorkspaceId:scopeB.workspaceId };
    const createdAt = '2026-01-01T00:00:00.000Z';
    saveGenerationRecord(userId, { id:'gen-a', type:'image', status:'completed', assetId:'asset-a', ...originA, createdAt, updatedAt:createdAt });
    saveGenerationRecord(userId, { id:'gen-b', type:'image', status:'completed', assetId:'asset-b', ...originB, createdAt, updatedAt:createdAt });
    saveAssetRecord(userId, { id:'asset-a', kind:'image', name:'A.png', sourceGenerationId:'gen-a', objectKey:'a.png', deliveryStatus:'remote_backed_up', remoteStatus:'ready', ...originA, createdAt, updatedAt:createdAt });
    saveAssetRecord(userId, { id:'asset-b', kind:'image', name:'B.png', sourceGenerationId:'gen-b', objectKey:'b.png', deliveryStatus:'remote_backed_up', remoteStatus:'ready', ...originB, createdAt, updatedAt:createdAt });
    saveDramaProjectRecord(userId, { id:'project-a', title:'A', step:'script', status:'draft', ...originA, resources:[{ versions:['gen-a'] }], createdAt, updatedAt:createdAt });
    saveDramaProjectRecord(userId, { id:'project-b', title:'B', step:'script', status:'draft', ...originB, resources:[{ versions:['gen-b'] }], createdAt, updatedAt:createdAt });

    assert.deepEqual(listGenerations(userId, scopeA).items.map(item => item.id), ['gen-a']);
    assert.deepEqual(listGenerations(userId, scopeB).items.map(item => item.id), ['gen-b']);
    assert.equal(findGeneration(userId, 'gen-b', scopeA), null);
    assert.deepEqual(listAssets(userId, scopeA).items.map(item => item.id), ['asset-a']);
    assert.equal(findCloudAssets(userId, ['asset-b'], scopeA).length, 0);
    assert.deepEqual(listDramaProjects(userId, scopeA).items.map(item => item.id), ['project-a']);
    assert.equal(latestDramaProject(userId, scopeB).id, 'project-b');
    assert.equal(deleteDramaProject(userId, 'project-b', scopeA), false, '不能删除其他工作区的项目');
    assert.equal(deleteDramaProject(userId, 'project-a', scopeA), true);
    assert.deepEqual(listDramaProjects(userId, scopeA).items, []);
    assert.equal(findGeneration(userId, 'gen-a', scopeA).id, 'gen-a', '删除项目不能删除生成任务');
    assert.equal(listAssets(userId, scopeA).items[0].id, 'asset-a', '删除项目不能删除生成视频素材');
    assert.deepEqual(listPendingAssetDeliveries(userId, 'device-a-123456', { workspaceId:scopeA.workspaceId }).map(item => item.id), ['asset-a']);

    saveGenerationRecord(userId, { id:'legacy-generation', type:'image', status:'completed', assetId:'legacy-asset', createdAt, updatedAt:createdAt });
    saveAssetRecord(userId, { id:'legacy-asset', kind:'image', name:'legacy.png', sourceGenerationId:'legacy-generation', objectKey:'legacy.png', createdAt, updatedAt:createdAt });
    saveDramaProjectRecord(userId, { id:'legacy-project', title:'Legacy', step:'script', status:'draft', resources:[{ versions:['legacy-generation'] }], createdAt, updatedAt:createdAt });
    const claimed = claimLegacyWorkspace(userId, { ...scopeA, assetIds:['legacy-asset'] });
    assert.deepEqual(claimed, { generations:1, assets:1, projects:1 });
    assert.equal(findGeneration(userId, 'legacy-generation', scopeA).originWorkspaceId, scopeA.workspaceId);
    assert.equal(findGeneration(userId, 'legacy-generation', scopeB), null);
    assert.equal(listAssets(userId, scopeA).items.some(item => item.id === 'legacy-asset'), true);
    assert.equal(claimLegacyWorkspace(userId, { ...scopeA, assetIds:['legacy-asset'] }).generations, 0, '归属迁移应可重复调用且不重复更新');
  });

  await t.test('a cursor from another scope or a tampered cursor is rejected', () => {
    const good = encodeCursor('gen', { t: '2026-01-01T00:00:00.000Z', i: 'x' });
    assert.deepEqual(decodeCursor('gen', good), { t: '2026-01-01T00:00:00.000Z', i: 'x', s: 'gen' });
    assert.throws(() => decodeCursor('asset', good), InvalidCursorError, '跨集合游标应被拒绝');
    assert.throws(() => decodeCursor('gen', `${good}x`), InvalidCursorError, '篡改签名应被拒绝');
    assert.throws(() => decodeCursor('gen', 'garbage'), InvalidCursorError);
    assert.throws(() => decodeCursor('gen', 'a'.repeat(600)), InvalidCursorError);
    assert.equal(decodeCursor('gen', null), null);
    assert.equal(decodeCursor('gen', ''), null);
  });

  await t.test('a cursor pointing at a deleted row still advances', () => {
    const userId = makeUser();
    for (let i = 0; i < 6; i++) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      saveGenerationRecord(userId, { id: `g-${i}`, type: 'image', status: 'completed', createdAt, updatedAt: createdAt });
    }
    const first = listGenerations(userId, { limit: 2 });
    assert.deepEqual(first.items.map(i => i.id), ['g-5', 'g-4']);

    sql('DELETE FROM generations WHERE id = :id').run({ id: 'g-4' });
    const second = listGenerations(userId, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(i => i.id), ['g-3', 'g-2'], '游标记录被删也应继续推进');
  });

  await t.test('limit validation', () => {
    assert.equal(parseLimit(undefined), DEFAULT_PAGE_LIMIT);
    assert.equal(parseLimit(''), DEFAULT_PAGE_LIMIT);
    assert.equal(parseLimit('50'), 50);
    assert.equal(parseLimit('200'), 200);
    for (const bad of ['0', '201', '-1', 'abc', '1.5', ' 5', '1e3']) {
      assert.throws(() => parseLimit(bad), /limit 必须是/, `limit=${bad} 应被拒绝`);
    }
  });

  await t.test('assets paginate by created_at and filter by kind', () => {
    const userId = makeUser();
    for (let i = 0; i < 25; i++) {
      const createdAt = new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString();
      saveAssetRecord(userId, {
        id: `a-${i}`, kind: i % 2 ? 'video' : 'image', name: `n${i}`,
        createdAt, updatedAt: createdAt,
      });
    }
    const images = listAssets(userId, { kind: 'image', limit: MAX_PAGE_LIMIT });
    assert.equal(images.total, 13);
    const paged = drain(opts => listAssets(userId, { kind: 'image', ...opts }), 4);
    assert.deepEqual(paged.map(i => i.id), images.items.map(i => i.id));
  });

  await t.test('asset search is server-side and remains keyset-paginatable', () => {
    const userId = makeUser();
    for (let i = 0; i < 9; i += 1) {
      const name = i % 2 ? `other-${i}` : `brand-${i}`;
      const createdAt = new Date(Date.UTC(2026, 0, 4, 0, i)).toISOString();
      saveAssetRecord(userId, { id: `search-${i}`, kind: 'image', name, createdAt, updatedAt: createdAt });
    }
    const first = listAssets(userId, { search: 'brand', limit: 2 });
    assert.equal(first.total, 5);
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const paged = drain(opts => listAssets(userId, { search: 'brand', ...opts }), 2);
    assert.deepEqual(paged.map(item => item.id), ['search-8', 'search-6', 'search-4', 'search-2', 'search-0']);
    assert.equal(listAssets(userId, { search: 'brand', limit: 2, includeTotal: false }).total, null);
  });

  await t.test('asset sync starts at a checkpoint and tracks device delivery independently', () => {
    const userId = makeUser();
    const deviceA = 'device-a-123456';
    const deviceB = 'device-b-123456';
    const createdAt = '2026-01-01T00:00:00.000Z';
    for (let i = 0; i < 8; i += 1) {
      saveAssetRecord(userId, {
        id: `delivery-${i}`, kind: 'video', name: `v${i}`, objectKey: `assets/${i}.mp4`,
        sourceGenerationId: `generation-${i}`, deliveryStatus: 'remote_backed_up',
        createdAt, updatedAt: createdAt,
      });
    }
    const first = listAssetChanges(userId, { limit: 3 });
    assert.deepEqual(first.items, [], '新设备不应回放全部历史变更');
    assert.ok(first.nextCursor);
    assert.equal(listPendingAssetDeliveries(userId, deviceA, { limit: 3 }).length, 3);
    assert.equal(listPendingAssetDeliveries(userId, deviceB, { limit: 3 }).length, 3);

    const firstDelivery = listPendingAssetDeliveries(userId, deviceA, { limit: 1 })[0];
    markAssetDeliveryPending(userId, deviceA, firstDelivery.id);
    markAssetDeliveryReady(userId, deviceA, firstDelivery.id);
    assert.equal(listPendingAssetDeliveries(userId, deviceA, { limit: 20 }).some(item => item.id === firstDelivery.id), false);
    assert.equal(listPendingAssetDeliveries(userId, deviceB, { limit: 20 }).some(item => item.id === firstDelivery.id), true);

    const directAsset = {
      id: 'delivery-direct', kind: 'video', name: 'direct.mp4', sourceGenerationId: 'generation-direct',
      sourceUrl: 'https://upstream.example/direct.mp4', deliveryStatus: 'awaiting_local', remoteStatus: 'pending',
      createdAt, updatedAt: createdAt,
    };
    const receivedDirectAsset = { ...directAsset, id:'delivery-direct-ready', deliveryStatus:'local_ready' };
    saveAssetRecord(userId, directAsset);
    saveAssetRecord(userId, receivedDirectAsset);
    assert.equal(listPendingAssetDeliveries(userId, deviceA, { limit:20 }).some(item => item.id === directAsset.id), true, '只有 sourceUrl 的生成结果也应立即投递');
    assert.deepEqual(findCloudAssets(userId, [directAsset.id]).map(item => item.id), [directAsset.id], '定向补拉应允许尚未归档的上游结果');
    assert.equal(listPendingAssetDeliveries(userId, deviceA, { limit:20 }).some(item => item.id === receivedDirectAsset.id), false, '已本地确认且未归档的结果不应重复投递');
    assert.deepEqual(findCloudAssets(userId, [receivedDirectAsset.id]), []);

    const nextAsset = { id: 'delivery-new', kind: 'image', name: 'new', objectKey: 'assets/new.png', sourceGenerationId: 'generation-new', deliveryStatus: 'remote_backed_up', createdAt, updatedAt: createdAt };
    saveAssetRecord(userId, nextAsset);
    const delta = listAssetChanges(userId, { cursor: first.nextCursor, limit: 20 });
    assert.ok(delta.items.some(change => change.assetId === nextAsset.id && change.action === 'upsert'));
    assert.equal(deleteAsset(userId, nextAsset.id), true);
    const tombstone = listAssetChanges(userId, { cursor: delta.nextCursor, limit: 20 }).items.find(change => change.assetId === nextAsset.id && change.action === 'delete');
    assert.ok(tombstone, '删除应产生增量 tombstone');
  });

  await t.test('drama projects sort by updated_at and latest reads one row', () => {
    const userId = makeUser();
    for (let i = 0; i < 8; i++) {
      saveDramaProjectRecord(userId, {
        id: `p-${i}`, title: `t${i}`, step: 'script', status: 'draft',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 3, 0, i)).toISOString(),
      });
    }
    const all = listDramaProjects(userId, { limit: MAX_PAGE_LIMIT });
    assert.deepEqual(all.items.map(i => i.id), ['p-7', 'p-6', 'p-5', 'p-4', 'p-3', 'p-2', 'p-1', 'p-0']);
    assert.equal(latestDramaProject(userId).id, 'p-7');

    const paged = drain(opts => listDramaProjects(userId, opts), 3);
    assert.deepEqual(paged.map(i => i.id), all.items.map(i => i.id));

    // Touching an older project must move it to the front.
    const older = all.items.at(-1);
    saveDramaProjectRecord(userId, { ...older, updatedAt: '2026-06-01T00:00:00.000Z' });
    assert.equal(latestDramaProject(userId).id, 'p-0');
  });

  await t.test('latest project is null for a user with none', () => {
    assert.equal(latestDramaProject(makeUser()), null);
  });

  await t.test('records round-trip unchanged including unknown fields', () => {
    const userId = makeUser();
    const task = {
      id: 'rt-1', ownerId: userId, type: 'video', status: 'completed',
      prompt: '中文提示词 with "quotes" and \\backslash',
      referenceAssetIds: ['x', 'y'], size: null, quality: '720p',
      aspectRatio: '16:9', duration: 10, creditCost: 10, creditStatus: 'charged',
      providerTaskId: 'p1', assetId: 'a1', error: '', nested: { deep: { arr: [1, 2, { k: 'v' }] } },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: null, futureField: 'kept',
    };
    saveGenerationRecord(userId, task);
    assert.deepEqual(findGeneration(userId, 'rt-1'), task, '记录应逐字段往返一致');
  });

  await t.test('pending generations query includes results waiting for local delivery or backup', () => {
    const userId = makeUser();
    const statuses = ['queued', 'running', 'completed', 'failed'];
    for (const [i, status] of statuses.entries()) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      saveGenerationRecord(userId, { id: `s-${status}`, type: 'image', status, createdAt, updatedAt: createdAt });
    }
    saveGenerationRecord(userId, {
      id: 's-awaiting-backup', type: 'image', status: 'completed', sourceUrl: 'https://upstream.example/result.png',
      archivePending: true, createdAt: '2026-01-01T00:05:00.000Z', updatedAt: '2026-01-01T00:05:00.000Z',
    });
    saveGenerationRecord(userId, {
      id: 's-awaiting-references', type: 'image', status: 'queued', awaitingReferences: true,
      createdAt: '2026-01-01T00:06:00.000Z', updatedAt: '2026-01-01T00:06:00.000Z',
    });
    saveGenerationRecord(userId, {
      id: 's-refund-pending', type: 'image', status: 'failed', creditStatus: 'refund_failed',
      createdAt: '2026-01-01T00:07:00.000Z', updatedAt: '2026-01-01T00:07:00.000Z',
    });
    const pending = listPendingGenerations();
    assert.deepEqual(pending.map(p => p.task.status).sort(), ['completed', 'failed', 'queued', 'queued', 'running']);
    assert.ok(pending.some(p => p.task.id === 's-awaiting-backup'));
    assert.ok(pending.some(p => p.task.id === 's-awaiting-references'));
    assert.ok(pending.some(p => p.task.id === 's-refund-pending'));
    assert.ok(pending.every(p => p.userId === userId));
  });

  await t.test('updating a generation does not duplicate the row', () => {
    const userId = makeUser();
    const createdAt = '2026-01-01T00:00:00.000Z';
    saveGenerationRecord(userId, { id: 'u-1', type: 'image', status: 'queued', createdAt, updatedAt: createdAt });
    saveGenerationRecord(userId, { id: 'u-1', type: 'image', status: 'running', createdAt, updatedAt: '2026-01-01T00:00:05.000Z' });
    saveGenerationRecord(userId, { id: 'u-1', type: 'image', status: 'completed', assetId: 'a9', createdAt, updatedAt: '2026-01-01T00:00:09.000Z' });

    const page = listGenerations(userId, { limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].status, 'completed');
    assert.equal(page.items[0].assetId, 'a9');
    assert.equal(listPendingGenerations().length, 0);
  });
});

test('drama project conditional save rejects a stale revision without overwriting', () => {
  freshDb();
  try {
    const userId = makeUser('cas-user');
    const createdAt = '2026-09-05T00:00:00.000Z';
    const project = {
      id: 'cas-project', userId, title: '初始', step: 'script', status: 'draft', revision: 1,
      createdAt, updatedAt: createdAt, originDeviceId: 'device-a', originWorkspaceId: 'workspace-a',
    };
    saveDramaProjectRecord(userId, project, { insertOnly: true });

    const firstUpdate = { ...project, title: '第一次保存', revision: 2, updatedAt: '2026-09-05T00:01:00.000Z' };
    assert.equal(saveDramaProjectRecord(userId, firstUpdate, { expectedRevision: 1 }).saved, true);

    const staleUpdate = { ...project, title: '过期保存', revision: 2, updatedAt: '2026-09-05T00:02:00.000Z' };
    assert.equal(saveDramaProjectRecord(userId, staleUpdate, { expectedRevision: 1 }).saved, false);
    const persisted = sql('SELECT title, revision FROM drama_projects WHERE id = :id').get({ id: project.id });
    assert.equal(persisted.title, '第一次保存');
    assert.equal(persisted.revision, 2);
  } finally {
    cleanupDb();
  }
});

test('concurrent project saves allow exactly one writer for a revision', async () => {
  freshDb();
  try {
    const userId = makeUser('cas-concurrent-user');
    const project = {
      id: 'cas-concurrent-project', userId, title: '初始', step: 'script', status: 'draft', revision: 1,
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
      originDeviceId: 'device-a', originWorkspaceId: 'workspace-a',
    };
    saveDramaProjectRecord(userId, project, { insertOnly: true });
    const [first, second] = await Promise.all([
      Promise.resolve(saveDramaProjectRecord(userId, { ...project, title:'并发一', revision:2 }, { expectedRevision:1 })),
      Promise.resolve(saveDramaProjectRecord(userId, { ...project, title:'并发二', revision:2 }, { expectedRevision:1 })),
    ]);
    assert.equal([first.saved, second.saved].filter(Boolean).length, 1);
    const persisted = sql('SELECT title, revision FROM drama_projects WHERE id = :id').get({ id: project.id });
    assert.equal(persisted.revision, 2);
    assert.ok(['并发一', '并发二'].includes(persisted.title));
  } finally {
    cleanupDb();
  }
});

test('generation jobs enforce lease ownership and can be rescheduled', () => {
  freshDb();
  try {
    const userId = makeUser('job-user');
    saveGenerationRecord(userId, { id:'job-generation', type:'image', status:'queued', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    const job = enqueueGenerationJob({ userId, generationId:'job-generation', nextRunAt:100 });
    const [claimed] = claimGenerationJobs({ owner:'worker-a', now:100, limit:1, leaseMs:1000 });
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.leaseToken, 1);
    assert.equal(renewGenerationJobLease({ id:job.id, owner:'worker-a', leaseToken:1, leaseUntil:2_000, now:100 }), true);
    assert.equal(generationJobLeaseActive({ id:job.id, owner:'worker-a', leaseToken:1, now:1_999 }), true);
    assert.equal(generationJobLeaseActive({ id:job.id, owner:'worker-a', leaseToken:1, now:2_000 }), false);
    assert.equal(completeGenerationJob({ id:job.id, owner:'worker-b', leaseToken:1 }), false);
    assert.equal(rescheduleGenerationJob({ id:job.id, owner:'worker-a', leaseToken:1, nextRunAt:3_000, errorCode:'TEMPORARY', errorMessage:'retry later', now:1_999 }), true);
    assert.deepEqual(generationQueueStats(2_000), {
      pendingJobs: 1, leasedJobs: 0, expiredLeases: 0, manualReviewJobs: 0,
      pendingGenerations: 1, refundPendingGenerations: 0,
    });

    const [reclaimed] = claimGenerationJobs({ owner:'worker-b', now:3_000, limit:1, leaseMs:1000 });
    assert.equal(reclaimed.id, job.id);
    assert.equal(reclaimed.leaseToken, 2);
    assert.equal(completeGenerationJob({ id:job.id, owner:'worker-b', leaseToken:2, now:3_999 }), true);
  } finally {
    cleanupDb();
  }
});

test('expired generation leases cannot renew, complete, or merge into another job', () => {
  freshDb();
  try {
    const userId = makeUser('expired-job-user');
    saveGenerationRecord(userId, { id:'expired-generation', type:'image', status:'running', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    const generationJob = enqueueGenerationJob({ userId, generationId:'expired-generation', kind:'generation', nextRunAt:100 });
    const pollJob = enqueueGenerationJob({ userId, generationId:'expired-generation', kind:'poll', nextRunAt:9_000 });
    const [lease] = claimGenerationJobs({ owner:'expired-worker', now:100, limit:1, leaseMs:1_000 });
    assert.equal(lease.id, generationJob.id);
    assert.equal(generationJobLeaseActive({ id:lease.id, owner:'expired-worker', leaseToken:lease.leaseToken, now:1_100 }), false);
    assert.equal(renewGenerationJobLease({ id:lease.id, owner:'expired-worker', leaseToken:lease.leaseToken, leaseUntil:5_000, now:1_100 }), false);
    assert.equal(completeGenerationJob({ id:lease.id, owner:'expired-worker', leaseToken:lease.leaseToken, now:1_100 }), false);
    assert.equal(rescheduleGenerationJob({ id:lease.id, owner:'expired-worker', leaseToken:lease.leaseToken, kind:'poll', nextRunAt:1, now:1_100 }), false);
    const persisted = sql('SELECT state, lease_owner, lease_token, lease_until FROM generation_jobs WHERE id = :id').get({ id:lease.id });
    assert.deepEqual({ ...persisted }, { state:'leased', lease_owner:'expired-worker', lease_token:1, lease_until:1_100 });
    assert.equal(sql('SELECT next_run_at FROM generation_jobs WHERE id = :id').get({ id:pollJob.id }).next_run_at, 9_000);
  } finally {
    cleanupDb();
  }
});

test('generation job rescheduling validates its lease before merging jobs and preserves recovery timing', () => {
  freshDb();
  try {
    const userId = makeUser('job-safety-user');
    saveGenerationRecord(userId, { id:'refund-generation', type:'image', status:'failed', creditStatus:'refund_failed', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    const refundJob = enqueueGenerationJob({ userId, generationId:'refund-generation', kind:'refund_reconcile', nextRunAt:100 });
    const [refundLease] = claimGenerationJobs({ owner:'refund-worker', now:100, limit:1, leaseMs:10_000 });
    assert.equal(rescheduleGenerationJob({ id:refundJob.id, owner:'refund-worker', leaseToken:refundLease.leaseToken, nextRunAt:5_000, now:100 }), true);
    assert.equal(sql('SELECT kind FROM generation_jobs WHERE id = :id').get({ id:refundJob.id }).kind, 'refund_reconcile');
    assert.equal(sql('SELECT state FROM generation_jobs WHERE id = :id').get({ id:refundJob.id }).state, 'pending');

    saveGenerationRecord(userId, { id:'conflict-generation', type:'image', status:'running', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    const generationJob = enqueueGenerationJob({ userId, generationId:'conflict-generation', kind:'generation', nextRunAt:200 });
    const pollJob = enqueueGenerationJob({ userId, generationId:'conflict-generation', kind:'poll', nextRunAt:900_000 });
    const [generationLease] = claimGenerationJobs({ owner:'generation-worker', now:200, limit:1, leaseMs:10_000 });
    assert.equal(generationLease.id, generationJob.id);
    assert.equal(rescheduleGenerationJob({ id:generationJob.id, owner:'stale-worker', leaseToken:generationLease.leaseToken, kind:'poll', nextRunAt:1 }), false);
    assert.equal(sql('SELECT next_run_at FROM generation_jobs WHERE id = :id').get({ id:pollJob.id }).next_run_at, 900_000);
    assert.equal(completeGenerationJob({ id:generationJob.id, owner:'generation-worker', leaseToken:generationLease.leaseToken, now:200 }), true);

    saveGenerationRecord(userId, { id:'timed-generation', type:'image', status:'queued', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    const scheduled = enqueueGenerationJob({ userId, generationId:'timed-generation', kind:'generation', nextRunAt:900_000 });
    const preserved = enqueueGenerationJob({ userId, generationId:'timed-generation', kind:'generation', nextRunAt:1, preserveScheduledTime:true });
    assert.equal(preserved.id, scheduled.id);
    assert.equal(preserved.nextRunAt, 900_000);

    saveGenerationRecord(userId, { id:'batch-generation', type:'image', status:'queued', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    enqueueGenerationJob({ userId, generationId:'batch-generation', kind:'generation', nextRunAt:300 });
    enqueueGenerationJob({ userId, generationId:'batch-generation', kind:'poll', nextRunAt:300 });
    saveGenerationRecord(userId, { id:'batch-other-generation', type:'image', status:'queued', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    enqueueGenerationJob({ userId, generationId:'batch-other-generation', kind:'generation', nextRunAt:300 });
    const batch = claimGenerationJobs({ owner:'batch-worker', now:300, limit:3 });
    assert.equal(batch.filter(job => job.generationId === 'batch-generation').length, 1);
    assert.equal(batch.length, 2);

    saveGenerationRecord(userId, { id:'serial-generation', type:'image', status:'queued', createdAt:'2026-09-05T00:00:00.000Z', updatedAt:'2026-09-05T00:00:00.000Z' });
    enqueueGenerationJob({ userId, generationId:'serial-generation', kind:'generation', nextRunAt:400 });
    enqueueGenerationJob({ userId, generationId:'serial-generation', kind:'poll', nextRunAt:400 });
    const [serialLease] = claimGenerationJobs({ owner:'serial-worker-a', now:400, limit:1 });
    assert.equal(serialLease.generationId, 'serial-generation');
    assert.deepEqual(claimGenerationJobs({ owner:'serial-worker-b', now:400, limit:1 }), []);
    assert.equal(completeGenerationJob({ id:serialLease.id, owner:'serial-worker-a', leaseToken:serialLease.leaseToken, now:400 }), true);
  } finally {
    cleanupDb();
  }
});

test('generation request idempotency records preserve the request hash and task list', () => {
  freshDb();
  try {
    const userId = makeUser('idempotency-user');
    const request = createGenerationRequest({
      userId,
      idempotencyKey: 'request-key-1234',
      requestHash: 'hash-a',
      generationIds: ['generation-a', 'generation-b', 'generation-b'],
    });
    assert.deepEqual(request.generationIds, ['generation-a', 'generation-b']);
    assert.deepEqual(findGenerationRequest(userId, 'request-key-1234'), request);
    assert.deepEqual(createGenerationRequest({
      userId,
      idempotencyKey: 'request-key-1234',
      requestHash: 'hash-a',
      generationIds: ['generation-a', 'generation-b'],
    }), request);
    assert.throws(() => createGenerationRequest({
      userId,
      idempotencyKey: 'request-key-1234',
      requestHash: 'hash-b',
      generationIds: ['generation-a', 'generation-b'],
    }), error => error.code === 'IDEMPOTENCY_KEY_REUSED' && error.statusCode === 409);
    assert.equal(findGenerationRequest(userId, 'missing-key'), null);
  } finally {
    cleanupDb();
  }
});

test('generation claim respects capacity even with many distinct due tasks', () => {
  freshDb();
  try {
    const userId = makeUser('claim-capacity');
    for (let i = 0; i < 8; i++) {
      const generationId = `capacity-${i}`;
      saveGenerationRecord(userId, { id:generationId, type:'video', status:'queued', createdAt:'2026-09-06T00:00:00Z', updatedAt:'2026-09-06T00:00:00Z' });
      enqueueGenerationJob({ userId, generationId, nextRunAt:100 });
    }
    assert.equal(claimGenerationJobs({ owner:'worker', now:100, limit:1 }).length, 1);
    assert.equal(claimGenerationJobs({ owner:'worker', now:100, limit:2 }).length, 2);
  } finally { cleanupDb(); }
});

test('corrupt recovery documents do not discard valid work', () => {
  freshDb();
  try {
    const userId = makeUser('recovery-corruption');
    for (const id of ['bad-json', 'null-doc', 'good-doc']) saveGenerationRecord(userId, { id, type:'video', status:'queued', createdAt:'2026-09-06T00:00:00Z', updatedAt:'2026-09-06T00:00:00Z' });
    sql("UPDATE generations SET doc_json = '{broken' WHERE id = 'bad-json'").run();
    sql("UPDATE generations SET doc_json = 'null' WHERE id = 'null-doc'").run();
    assert.deepEqual(listPendingGenerations().map(row => row.task.id), ['good-doc']);
  } finally { cleanupDb(); }
});

test('pending delivery keysets reach older assets even when recent downloads fail', () => {
  freshDb();
  try {
    const userId = makeUser('delivery-pages');
    for (let i = 0; i < 5; i++) saveAssetRecord(userId, { id:`delivery-${i}`, kind:'video', sourceGenerationId:`g-${i}`, sourceUrl:'https://example.test/video', deliveryStatus:'awaiting_local', remoteStatus:'pending', createdAt:'2026-09-06T00:00:00Z', updatedAt:'2026-09-06T00:00:00Z' });
    const first = listPendingAssetDeliveries(userId, 'device', { limit:2 });
    const last = first.at(-1);
    const second = listPendingAssetDeliveries(userId, 'device', { limit:2, before:{ t:last.createdAt, i:last.id } });
    assert.deepEqual([...first,...second].map(asset => asset.id), ['delivery-0','delivery-1','delivery-2','delivery-3']);
  } finally { cleanupDb(); }
});
