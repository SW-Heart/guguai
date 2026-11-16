import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { dbBackupObjectPrefix, isDbBackupObjectKey, offsiteBackupConfig, pruneRemoteBackups, uploadBackupSnapshot } from '../lib/db-backup-offsite.mjs';
import { notifyBackupFailure } from '../lib/feishu.mjs';

const r2Env = { R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com/', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'media' };

async function readBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** In-memory bucket that understands the four commands the backup path sends. */
function fakeBucket(initial = {}) {
  const objects = new Map(Object.entries(initial));
  const calls = [];
  const send = async command => {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    if (name === 'PutObjectCommand') { objects.set(input.Key, await readBody(input.Body)); return {}; }
    if (name === 'HeadObjectCommand') return { ContentLength: objects.get(input.Key)?.length };
    if (name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter(key => key.startsWith(input.Prefix)).map(Key => ({ Key })) };
    if (name === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
    throw new Error(`unexpected command ${name}`);
  };
  return { objects, calls, send };
}

test('offsite backup config reuses the media bucket and reports what is missing', () => {
  const config = offsiteBackupConfig(r2Env);
  assert.equal(config.ready, true);
  assert.equal(config.endpoint, 'https://example.r2.cloudflarestorage.com');
  assert.equal(config.bucket, 'media');
  assert.equal(config.prefix, 'model-studio/db-backups');
  assert.equal(config.retention, 30);

  const custom = offsiteBackupConfig({ ...r2Env, DB_BACKUP_R2_BUCKET: 'backups', DB_BACKUP_OBJECT_PREFIX: '/prod/db/', DB_BACKUP_REMOTE_RETENTION: '0' });
  assert.equal(custom.bucket, 'backups');
  assert.equal(custom.prefix, 'prod/db');
  assert.equal(custom.retention, 30, 'an invalid retention must not turn into "keep nothing"');

  const empty = offsiteBackupConfig({});
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.missing, ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
});

test('backup objects are recognisable so media cleanup can skip them', () => {
  assert.equal(dbBackupObjectPrefix({ MEDIA_OBJECT_PREFIX: 'oline' }), 'oline/db-backups');
  assert.equal(isDbBackupObjectKey('model-studio/db-backups/studio.db.bak-20261116T203000Z.gz', {}), true);
  assert.equal(isDbBackupObjectKey('model-studio/users/u1/a.png', {}), false);
  assert.equal(isDbBackupObjectKey('model-studio/db-backups-other/x', {}), false);
});

test('snapshot is gzipped, uploaded, verified and old remote copies are pruned', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'studio.db.bak-20261116T203000Z');
  const content = Buffer.from('sqlite snapshot '.repeat(500));
  await writeFile(file, content);
  const prefix = 'model-studio/db-backups';
  const bucket = fakeBucket({
    [`${prefix}/studio.db.bak-20261114T203000Z.gz`]: Buffer.from('a'),
    [`${prefix}/studio.db.bak-20261115T203000Z.gz`]: Buffer.from('b'),
    [`${prefix}/notes.txt`]: Buffer.from('keep'),
    'model-studio/users/u1/a.png': Buffer.from('keep'),
  });

  const result = await uploadBackupSnapshot({ file, sha256: 'abc', send: bucket.send, bucket: 'media', prefix, retention: 2, tmpDir: dir });

  assert.equal(result.key, `${prefix}/studio.db.bak-20261116T203000Z.gz`);
  assert.deepEqual(gunzipSync(bucket.objects.get(result.key)), content);
  assert.equal(result.size, bucket.objects.get(result.key).length);
  assert.deepEqual({ kept: result.kept, removed: result.removed }, { kept: 2, removed: 1 });
  assert.equal(bucket.objects.has(`${prefix}/studio.db.bak-20261114T203000Z.gz`), false, 'oldest snapshot is pruned');
  assert.equal(bucket.objects.has(`${prefix}/studio.db.bak-20261115T203000Z.gz`), true);
  assert.equal(bucket.objects.has(`${prefix}/notes.txt`), true, 'unrelated keys under the prefix are left alone');
  assert.equal(bucket.objects.has('model-studio/users/u1/a.png'), true);
  const put = bucket.calls.find(call => call.name === 'PutObjectCommand').input;
  assert.equal(put.ContentType, 'application/gzip');
  assert.deepEqual(put.Metadata, { 'snapshot-sha256': 'abc' });
  assert.deepEqual(await readdir(dir), ['studio.db.bak-20261116T203000Z'], 'temporary gzip is removed');
});

test('a size mismatch fails the run and prunes nothing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'studio.db.bak-20261116T203000Z');
  await writeFile(file, 'snapshot');
  const prefix = 'p';
  const bucket = fakeBucket({ [`${prefix}/studio.db.bak-20261101T203000Z.gz`]: Buffer.from('old') });
  const send = async command => command.constructor.name === 'HeadObjectCommand' ? { ContentLength: 1 } : bucket.send(command);

  await assert.rejects(uploadBackupSnapshot({ file, send, bucket: 'media', prefix, retention: 1, tmpDir: dir }), /大小不一致/);
  assert.equal(bucket.objects.has(`${prefix}/studio.db.bak-20261101T203000Z.gz`), true);
  assert.equal(bucket.calls.some(call => call.name === 'DeleteObjectCommand'), false);
  await assert.rejects(uploadBackupSnapshot({ file: path.join(dir, 'studio.db'), send, bucket: 'media', prefix, tmpDir: dir }), /不是数据库备份文件/);
});

test('pruning always keeps at least the newest snapshot', async () => {
  const bucket = fakeBucket({ 'p/studio.db.bak-20261101T000000Z.gz': Buffer.from('a'), 'p/studio.db.bak-20261102T000000Z.gz': Buffer.from('b') });
  assert.deepEqual(await pruneRemoteBackups({ send: bucket.send, bucket: 'media', prefix: 'p', retention: 0 }), { kept: 1, removed: 1 });
  assert.deepEqual([...bucket.objects.keys()], ['p/studio.db.bak-20261102T000000Z.gz']);
});

test('backup failure is reported to the feishu group', async () => {
  let payload;
  const result = await notifyBackupFailure({
    reason: '本地备份已完成，但异地备份失败：timeout',
    at: '2026-11-16T20:30:00.000Z',
    env: { FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook' },
    fetchImpl: async (_url, init) => { payload = JSON.parse(init.body); return new Response(JSON.stringify({ code: 0 }), { status: 200 }); },
  });
  assert.equal(result.sent, true);
  assert.equal(payload.card.header.title.content, '数据库备份失败');
  assert.match(payload.card.elements[0].text.content, /异地备份失败：timeout/);
  assert.match(payload.card.elements[1].text.content, /2026-11-17 04:30:00/);
  assert.deepEqual(await notifyBackupFailure({ reason: 'x', env: {} }), { skipped: true, reason: 'FEISHU_WEBHOOK 未配置或格式无效' });
});
