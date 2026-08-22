import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { __test } from '../server.mjs';
import { claimUploadIntent, completeUploadIntentWithAsset, countActiveUploadIntents, createUploadIntent, findAssetBySha256, findUploadIntent, insertUser, saveAssetRecord } from '../lib/store.mjs';

test('direct upload keys are scoped and policy fixes the object key', () => {
  const pending = __test.pendingUploadKey('user/unsafe', 'upload-1', 'image/jpeg', 'photo.jpg');
  const final = __test.finalUploadKey('user/unsafe', 'asset-1', 'image/jpeg', 'photo.jpg');
  assert.equal(pending, 'model-studio/pending/userunsafe/upload-1.jpg');
  assert.equal(final, 'model-studio/assets/userunsafe/asset-1.jpg');
  const policy = __test.buildUploadPostPolicy({ key: pending, mimeType: 'image/jpeg', sizeLimit: 8 * 1024 * 1024, expiresAt: '2026-08-21T00:10:00.000Z' });
  assert.ok(policy.conditions.some(item => Array.isArray(item) && item[1] === '$key' && item[2] === pending));
  assert.ok(policy.conditions.some(item => Array.isArray(item) && item[0] === 'content-length-range' && item[2] === 8 * 1024 * 1024));
});

test('supported media magic bytes are recognized', () => {
  assert.equal(__test.magicMatches('image/png', Buffer.from('89504e470d0a1a0a', 'hex')), true);
  assert.equal(__test.magicMatches('image/jpeg', Buffer.from('ffd8ffe000', 'hex')), true);
  assert.equal(__test.magicMatches('image/webp', Buffer.from('524946460000000057454250', 'hex')), true);
  assert.equal(__test.magicMatches('video/mp4', Buffer.from('000000186674797069736f6d', 'hex')), true);
  assert.equal(__test.magicMatches('video/webm', Buffer.from('1a45dfa300', 'hex')), true);
  assert.equal(__test.magicMatches('image/png', Buffer.from('not-png')), false);
});

test('upload MIME variants are normalized before type validation', () => {
  assert.equal(__test.normalizeUploadMime('image/jpg', 'cover.jpg'), 'image/jpeg');
  assert.equal(__test.normalizeUploadMime('', 'cover.jpeg'), 'image/jpeg');
  assert.equal(__test.normalizeUploadMime('audio/x-m4a', 'voice.m4a'), 'audio/mp4');
  assert.equal(__test.normalizeUploadMime('', 'voice.mp3'), 'audio/mpeg');
});

test('OSS upload verification combines accurate size metadata with HeadObject Content-Type', () => {
  const metadata = __test.combinedOssObjectMetadata(
    { status: 200, res: { headers: { 'content-length': '116862', etag: '"etag-meta"' } } },
    { status: 200, res: { headers: { 'content-type': 'image/png', 'content-length': '0', etag: '"etag-head"' } } },
  );
  assert.deepEqual(metadata, {
    size: 116862,
    mimeType: 'image/png',
    etag: 'etag-meta',
    status: 200,
  });
});

test('upload intent claim and completion are idempotent', () => {
  const userId = randomUUID();
  const createdAt = new Date().toISOString();
  insertUser({ id: userId, username: `upload_${userId.slice(0, 8)}`, passwordHash: 'test', role: 'user', status: 'active', creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  const intent = {
    id: randomUUID(), userId, assetId: randomUUID(),
    temporaryOssKey: `model-studio/pending/${userId}/upload.jpg`,
    finalOssKey: `model-studio/assets/${userId}/asset.jpg`,
    name: 'upload.jpg', kind: 'image', mimeType: 'image/jpeg', expectedSize: 10,
    status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt, updatedAt: createdAt,
  };
  createUploadIntent(intent);
  assert.equal(countActiveUploadIntents(userId), 1);
  assert.equal(claimUploadIntent(userId, intent.id, new Date().toISOString()), true);
  assert.equal(claimUploadIntent(userId, intent.id, new Date().toISOString()), false);
  const asset = { id: intent.assetId, ownerId: userId, name: intent.name, kind: intent.kind, mimeType: intent.mimeType, size: 10, storageName: `${intent.assetId}.jpg`, ossKey: intent.finalOssKey, createdAt, updatedAt: createdAt };
  const first = completeUploadIntentWithAsset(userId, intent.id, { actualSize: 10, objectEtag: 'etag-1', asset, nowIso: new Date().toISOString() });
  assert.equal(first.asset.id, intent.assetId);
  const second = completeUploadIntentWithAsset(userId, intent.id, { actualSize: 10, objectEtag: 'etag-1', asset, nowIso: new Date().toISOString() });
  assert.equal(second.asset.id, intent.assetId);
  assert.equal(findUploadIntent(userId, intent.id).status, 'completed');
  assert.equal(countActiveUploadIntents(userId), 0);
});

test('same-user content hash lookup reuses an existing asset without crossing users', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const createdAt = new Date().toISOString();
  insertUser({ id: userId, username: `hash_${userId.slice(0, 8)}`, passwordHash: 'test', role: 'user', status: 'active', creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  insertUser({ id: otherUserId, username: `hash_${otherUserId.slice(0, 8)}`, passwordHash: 'test', role: 'user', status: 'active', creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  const sha256 = 'a'.repeat(64);
  const asset = { id: randomUUID(), ownerId: userId, name: 'same.png', kind: 'image', mimeType: 'image/png', size: 42, sha256, storageName: 'same.png', createdAt, updatedAt: createdAt };
  saveAssetRecord(userId, asset);
  assert.equal(findAssetBySha256(userId, sha256, 42).id, asset.id);
  assert.equal(findAssetBySha256(otherUserId, sha256, 42), null);
  assert.equal(findAssetBySha256(userId, sha256, 43), null);
});
