import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase, closeDatabase, sql, resetForTests } from '../lib/db.mjs';
import {
  configureCursors, listGenerations, listAssets, listDramaProjects, latestDramaProject,
  saveGenerationRecord, saveAssetRecord, saveDramaProjectRecord,
  parseLimit, decodeCursor, encodeCursor, InvalidCursorError,
  findGeneration, listPendingGenerations, listAssetChanges, listPendingAssetDeliveries, markAssetDeliveryPending, markAssetDeliveryReady, deleteAsset, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT,
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
    const pending = listPendingGenerations();
    assert.deepEqual(pending.map(p => p.task.status).sort(), ['completed', 'queued', 'running']);
    assert.ok(pending.some(p => p.task.id === 's-awaiting-backup'));
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
