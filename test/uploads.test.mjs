import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeDatabase, openDatabase } from '../lib/db.mjs';
import {
  claimUploadIntent,
  completeUploadIntentWithAsset,
  countActiveUploadIntents,
  createUploadIntent,
  expireUploadIntent,
  expireUploadIntents,
  findAssetBySha256,
  findUploadIntent,
  insertUser,
  saveAssetRecord,
} from '../lib/store.mjs';

openDatabase({ file: ':memory:' });
after(() => closeDatabase({ checkpoint: false }));

function makeUser(prefix) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  insertUser({
    id,
    username: `${prefix}_${id.slice(0, 8)}`,
    passwordHash: 'test',
    role: 'user',
    status: 'active',
    creditBalanceMicro: 0,
    creditHeldMicro: 0,
    createdAt,
    updatedAt: createdAt,
  });
  return { id, createdAt };
}

async function isolatedDbModule() {
  const url = new URL('../lib/db.mjs', import.meta.url);
  url.searchParams.set('baseline-test', randomUUID());
  return import(url.href);
}

test('empty database creates the R2-only schema v1 baseline', async () => {
  const dbModule = await isolatedDbModule();
  const handle = dbModule.openDatabase({ file: ':memory:' });
  try {
    assert.equal(dbModule.readSchemaVersion(), 1);
    assert.equal(dbModule.readMeta('schema_baseline'), 'r2-only-v1');
    const tables = handle.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`).all();
    assert.ok(tables.some(row => row.name === 'assets'));
    assert.ok(tables.some(row => row.name === 'upload_intents'));

    const columns = tables.flatMap(({ name }) => handle.prepare(`PRAGMA table_info(${name})`).all());
    assert.deepEqual(columns.filter(column => column.name.toLowerCase().includes('oss')), []);
    assert.ok(handle.prepare('PRAGMA table_info(assets)').all().some(column => column.name === 'object_key'));
    const uploadColumns = handle.prepare('PRAGMA table_info(upload_intents)').all().map(column => column.name);
    assert.ok(uploadColumns.includes('temporary_object_key'));
    assert.ok(uploadColumns.includes('final_object_key'));
    assert.equal(handle.prepare('SELECT COUNT(*) AS count FROM pricing_versions').get().count, 1);
    assert.ok(handle.prepare('SELECT COUNT(*) AS count FROM model_controls').get().count > 0);
  } finally {
    dbModule.closeDatabase({ checkpoint: false });
  }
});

test('a complete R2-only schema v1 database can be reopened', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'baseline-reopen-'));
  const file = path.join(dir, 'studio.db');
  try {
    const creator = await isolatedDbModule();
    creator.openDatabase({ file });
    creator.closeDatabase();

    const reopener = await isolatedDbModule();
    const handle = reopener.openDatabase({ file });
    try {
      assert.equal(reopener.readSchemaVersion(), 1);
      assert.equal(reopener.readMeta('schema_baseline'), 'r2-only-v1');
      assert.ok(handle.prepare('PRAGMA table_info(assets)').all().some(column => column.name === 'object_key'));
    } finally {
      reopener.closeDatabase();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('historical schema v1 is rejected without modifying its file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'historical-v1-'));
  const file = path.join(dir, 'studio.db');
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES('schema_version', '1');
      CREATE TABLE assets (id TEXT PRIMARY KEY, oss_key TEXT);
      INSERT INTO assets(id, oss_key) VALUES('legacy-asset', 'legacy/key.png');
    `);
    legacy.close();

    const bytesBefore = readFileSync(file);
    const filesBefore = readdirSync(dir).sort();
    const dbModule = await isolatedDbModule();
    assert.throws(
      () => dbModule.openDatabase({ file }),
      /schema_version=1 不是 R2-only 全新基线.*不支持迁移.*空 DATA_DIR/,
    );
    assert.throws(() => dbModule.database(), /数据库尚未打开/);
    assert.deepEqual(readFileSync(file), bytesBefore);
    assert.deepEqual(readdirSync(dir).sort(), filesBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy schema is rejected without modifying its file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-schema-'));
  const file = path.join(dir, 'studio.db');
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES('schema_version', '12');
      CREATE TABLE legacy_payload (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO legacy_payload(value) VALUES('keep-me');
    `);
    legacy.close();

    const bytesBefore = readFileSync(file);
    const filesBefore = readdirSync(dir).sort();
    const dbModule = await isolatedDbModule();
    assert.throws(
      () => dbModule.openDatabase({ file }),
      /旧 schema_version=12.*不支持迁移.*空 DATA_DIR/,
    );
    assert.throws(() => dbModule.database(), /数据库尚未打开/);
    assert.deepEqual(readFileSync(file), bytesBefore);
    assert.deepEqual(readdirSync(dir).sort(), filesBefore);

    const probe = new DatabaseSync(file, { readOnly: true });
    assert.equal(probe.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, '12');
    assert.equal(probe.prepare('SELECT value FROM legacy_payload').get().value, 'keep-me');
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upload intent claim and completion are idempotent', () => {
  const { id: userId, createdAt } = makeUser('upload');
  const intent = {
    id: randomUUID(),
    userId,
    assetId: randomUUID(),
    temporaryObjectKey: `model-studio/pending/${userId}/upload.jpg`,
    finalObjectKey: `model-studio/assets/${userId}/asset.jpg`,
    name: 'upload.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    expectedSize: 10,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
  };
  createUploadIntent(intent);
  assert.equal(countActiveUploadIntents(userId), 1);
  assert.equal(findUploadIntent(userId, intent.id).temporaryObjectKey, intent.temporaryObjectKey);
  assert.equal(findUploadIntent(userId, intent.id).finalObjectKey, intent.finalObjectKey);
  assert.equal(claimUploadIntent(userId, intent.id, new Date().toISOString()), true);
  assert.equal(claimUploadIntent(userId, intent.id, new Date().toISOString()), false);

  const asset = {
    id: intent.assetId,
    ownerId: userId,
    name: intent.name,
    kind: intent.kind,
    mimeType: intent.mimeType,
    size: 10,
    storageName: `${intent.assetId}.jpg`,
    objectKey: intent.finalObjectKey,
    createdAt,
    updatedAt: createdAt,
  };
  const first = completeUploadIntentWithAsset(userId, intent.id, {
    actualSize: 10,
    objectEtag: 'etag-1',
    asset,
    nowIso: new Date().toISOString(),
  });
  assert.equal(first.asset.id, intent.assetId);
  const second = completeUploadIntentWithAsset(userId, intent.id, {
    actualSize: 10,
    objectEtag: 'etag-1',
    asset,
    nowIso: new Date().toISOString(),
  });
  assert.equal(second.asset.id, intent.assetId);
  assert.equal(findUploadIntent(userId, intent.id).status, 'completed');
  assert.equal(countActiveUploadIntents(userId), 0);
});

test('expired upload intents return object keys without a storage provider', () => {
  const { id: userId, createdAt } = makeUser('expired');
  const intent = {
    id: randomUUID(),
    userId,
    assetId: randomUUID(),
    temporaryObjectKey: `model-studio/pending/${userId}/expired.png`,
    finalObjectKey: `model-studio/assets/${userId}/expired.png`,
    name: 'expired.png',
    kind: 'image',
    mimeType: 'image/png',
    expectedSize: 12,
    status: 'pending',
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
  };
  createUploadIntent(intent);
  const expired = expireUploadIntents(new Date().toISOString());
  assert.deepEqual(expired, [{
    id: intent.id,
    userId,
    temporaryObjectKey: intent.temporaryObjectKey,
    finalObjectKey: intent.finalObjectKey,
  }]);
  assert.equal(findUploadIntent(userId, intent.id).status, 'expired');
  assert.equal('storageProvider' in expired[0], false);
});

test('targeted expiration cannot expire another user intent', () => {
  const first = makeUser('expired_target');
  const second = makeUser('expired_other');
  const nowIso = new Date().toISOString();
  const makeIntent = ({ userId, createdAt, suffix }) => ({
    id: randomUUID(),
    userId,
    assetId: randomUUID(),
    temporaryObjectKey: `model-studio/pending/${userId}/${suffix}.png`,
    finalObjectKey: `model-studio/assets/${userId}/${suffix}.png`,
    name: `${suffix}.png`,
    kind: 'image',
    mimeType: 'image/png',
    expectedSize: 12,
    status: 'pending',
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
  });
  const target = makeIntent({ userId: first.id, createdAt: first.createdAt, suffix: 'target' });
  const other = makeIntent({ userId: second.id, createdAt: second.createdAt, suffix: 'other' });
  createUploadIntent(target);
  createUploadIntent(other);

  assert.equal(expireUploadIntent(second.id, target.id, nowIso), null);
  assert.equal(findUploadIntent(first.id, target.id).status, 'pending');
  const expired = expireUploadIntent(first.id, target.id, nowIso);
  assert.equal(expired.temporaryObjectKey, target.temporaryObjectKey);
  assert.equal(findUploadIntent(first.id, target.id).status, 'expired');
  assert.equal(findUploadIntent(second.id, other.id).status, 'pending');
});

test('same-user content hash lookup reuses an existing asset without crossing users', () => {
  const { id: userId, createdAt } = makeUser('hash');
  const { id: otherUserId } = makeUser('hash');
  const sha256 = 'a'.repeat(64);
  const asset = {
    id: randomUUID(),
    ownerId: userId,
    name: 'same.png',
    kind: 'image',
    mimeType: 'image/png',
    size: 42,
    sha256,
    storageName: 'same.png',
    objectKey: 'model-studio/assets/same.png',
    createdAt,
    updatedAt: createdAt,
  };
  saveAssetRecord(userId, asset);
  assert.equal(findAssetBySha256(userId, sha256, 42).id, asset.id);
  assert.equal(findAssetBySha256(userId, sha256, 42, { requireRemote: true }).id, asset.id);
  assert.equal(findAssetBySha256(otherUserId, sha256, 42), null);
  assert.equal(findAssetBySha256(userId, sha256, 43), null);
});

test('remote hash reuse ignores desktop-only records without an object key', () => {
  const { id: userId, createdAt } = makeUser('local');
  const asset = {
    id: randomUUID(),
    ownerId: userId,
    name: 'generated.png',
    kind: 'image',
    mimeType: 'image/png',
    size: 42,
    sha256: 'b'.repeat(64),
    storageName: 'generated.png',
    remoteStatus: 'local_only',
    createdAt,
    updatedAt: createdAt,
  };
  saveAssetRecord(userId, asset);
  assert.equal(findAssetBySha256(userId, asset.sha256, asset.size)?.id, asset.id);
  assert.equal(findAssetBySha256(userId, asset.sha256, asset.size, { requireRemote: true }), null);
});
