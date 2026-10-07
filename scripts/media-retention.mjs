// One-off cleanup of media stored before the retention rules existed, plus
// cloud objects no record points to. Dry run by default; pass --execute to delete.
//
//   node --env-file=.env scripts/media-retention.mjs [--before=2026-10-01T00:00:00Z] [--execute]
//
// --before defaults to six days ago: every cloud copy uploaded earlier is
// removed regardless of delivery. Diagnostic logs are never touched.
import { appendFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { openDatabase, resolveDataDir, sql } from '../lib/db.mjs';
import { listAssetsWithObjects, listPendingGenerations, saveAssetRecord } from '../lib/store.mjs';
import { createMediaRetentionService, MEDIA_RETENTION_DEFAULTS } from '../services/media-retention.mjs';

const execute = process.argv.includes('--execute');
const beforeArg = process.argv.find(arg => arg.startsWith('--before='))?.slice('--before='.length);
const before = beforeArg ? Date.parse(beforeArg) : Date.now() - MEDIA_RETENTION_DEFAULTS.localCopyMs;
if (!Number.isFinite(before)) throw new Error('--before 必须是有效时间');
const manifest = process.argv.find(arg => arg.startsWith('--manifest='))?.slice('--manifest='.length) || '';
const record = (bucket, key) => { if (execute && manifest) appendFileSync(manifest, `${bucket}\t${key}\n`); };
const gb = bytes => `${(bytes / 1024 ** 3).toFixed(2)}GB`;

const env = name => String(process.env[name] || '').trim();
const client = prefix => new S3Client({
  region: env(`${prefix}_REGION`) || env('R2_REGION') || 'auto',
  endpoint: (env(`${prefix}_ENDPOINT`) || env('R2_ENDPOINT')).replace(/\/+$/, ''),
  forcePathStyle: true,
  credentials: { accessKeyId: env(`${prefix}_ACCESS_KEY_ID`) || env('R2_ACCESS_KEY_ID'), secretAccessKey: env(`${prefix}_SECRET_ACCESS_KEY`) || env('R2_SECRET_ACCESS_KEY') },
});
const bucket = env('R2_BUCKET');
const referenceBucket = env('R2_REFERENCE_BUCKET');
if (!bucket || !env('R2_ACCESS_KEY_ID')) throw new Error('R2 配置不完整');
const r2 = client('R2');
const r2Reference = referenceBucket ? client('R2_REFERENCE') : null;
const referencePrefix = (env('R2_REFERENCE_IMAGE_PREFIX') || 'model-studio/temporary/reference-images').replace(/^\/+|\/+$/g, '');

async function* listObjects(target, targetBucket, prefix = '') {
  let token;
  do {
    const page = await target.send(new ListObjectsV2Command({ Bucket:targetBucket, Prefix:prefix || undefined, ContinuationToken:token }));
    for (const object of page.Contents || []) yield { key:object.Key, lastModified:object.LastModified, size:Number(object.Size) || 0 };
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

openDatabase({ file:null });
const usersDir = path.join(resolveDataDir(), 'users');
console.log(execute ? '模式：EXECUTE（将删除对象）' : '模式：DRY-RUN（不会删除任何对象；加 --execute 执行）');
console.log(`强制到期：${new Date(before).toISOString()} 之前上传的云端副本`);

const retention = createMediaRetentionService({
  listAssetsWithObjects,
  saveAsset: async (userId, asset) => saveAssetRecord(userId, asset),
  deleteObject: async key => { await r2.send(new DeleteObjectCommand({ Bucket:bucket, Key:key })); record(`r2:${bucket}`, key); },
  removeServerCopy: async (userId, asset) => {
    if (!asset.storageName) return;
    await fs.unlink(path.join(usersDir, String(userId).replace(/[^\w-]/g, ''), 'files', asset.storageName)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  },
  activeReferenceAssetIds: () => listPendingGenerations().flatMap(({ task }) => [...(task.referenceAssetIds || []), task.assetId].filter(Boolean)),
  listReferenceObjects: r2Reference ? () => listObjects(r2Reference, referenceBucket, `${referencePrefix}/`) : undefined,
  deleteReferenceObject: r2Reference ? async key => { await r2Reference.send(new DeleteObjectCommand({ Bucket:referenceBucket, Key:key })); record(`r2:${referenceBucket}`, key); } : undefined,
  logger: console,
});

// 1. Records with a cloud copy: normal countdown plus forced expiry of old data.
const assets = await retention.sweepExpiredAssets({ dryRun:!execute, before });
console.log(`[素材记录] 扫描 ${assets.scanned}，到期 ${assets.expired} 个 ${gb(assets.items.reduce((sum, item) => sum + item.size, 0))}，使用中跳过 ${assets.skippedInUse}，失败 ${assets.failed}`);

// 2. Objects no record points to (older environments, abandoned uploads).
const referenced = new Set(sql(`SELECT object_key AS key FROM assets WHERE COALESCE(object_key, '') <> ''`).all().map(row => row.key));
for (const row of sql(`SELECT temporary_object_key AS temporaryKey, final_object_key AS finalKey FROM upload_intents WHERE status IN ('pending', 'verifying')`).all()) {
  referenced.add(row.temporaryKey);
  referenced.add(row.finalKey);
}
let orphans = 0;
let orphanBytes = 0;
for await (const object of listObjects(r2, bucket)) {
  if (object.key.includes('/support-logs/') || referenced.has(object.key)) continue;
  if (object.lastModified.getTime() > before) continue;
  orphans++;
  orphanBytes += object.size;
  if (execute) { await r2.send(new DeleteObjectCommand({ Bucket:bucket, Key:object.key })); record(`r2:${bucket}`, object.key); }
}
console.log(`[无记录对象] ${orphans} 个 ${gb(orphanBytes)}`);

// 3. Temporary reference images older than a day, including other prefixes
//    left by test environments in the same bucket.
if (r2Reference) {
  let stale = 0;
  const cutoff = Date.now() - MEDIA_RETENTION_DEFAULTS.referenceMs;
  for await (const object of listObjects(r2Reference, referenceBucket)) {
    if (object.lastModified.getTime() > cutoff) continue;
    stale++;
    if (execute) { await r2Reference.send(new DeleteObjectCommand({ Bucket:referenceBucket, Key:object.key })); record(`r2:${referenceBucket}`, object.key); }
  }
  console.log(`[参考图] 超过 24 小时 ${stale} 个`);
}
console.log(execute ? '已完成删除' : 'DRY-RUN 结束，未删除任何对象');
