import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { resolveDataDir, openDatabase, sql } from '../lib/db.mjs';

const args = new Set(process.argv.slice(2));
const valueOf = flag => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
};
const userFilter = String(valueOf('--user') || '').trim();
const limit = Math.max(1, Number(valueOf('--limit') || 100000));
const deleting = args.has('--delete');
const dataDir = resolveDataDir();
const usersDir = path.join(dataDir, 'users');
const safeId = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const r2Endpoint = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
const r2Bucket = String(process.env.R2_BUCKET || '').trim();

if (!r2AccessKeyId || !r2SecretAccessKey || !r2Endpoint || !r2Bucket) {
  throw new Error('R2 配置不完整，缺少 R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_ENDPOINT/R2_BUCKET');
}
const r2 = new S3Client({
  region: String(process.env.R2_REGION || 'auto').trim() || 'auto',
  endpoint: r2Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
});

if (deleting) console.log('模式：DELETE（只删除逐条通过 R2 校验的本地文件）');
else console.log('模式：DRY-RUN（不会删除任何文件；使用 --delete 才会执行删除）');

openDatabase({ file: null });
const rows = sql(`
  SELECT id, user_id AS userId, object_key AS objectKey, doc_json AS docJson
  FROM assets
  WHERE (:userId = '' OR user_id = :userId)
  ORDER BY created_at ASC, id ASC
  LIMIT :limit`).all({ userId: userFilter, limit });

const summary = { assets: 0, localFiles: 0, localBytes: 0, verified: 0, deletable: 0, deleted: 0, r2Errors: 0, mismatched: 0, skipped: 0 };
for (const row of rows) {
  summary.assets += 1;
  let asset;
  try { asset = JSON.parse(row.docJson); } catch { summary.skipped += 1; continue; }
  if (!asset.storageName || !row.objectKey) { summary.skipped += 1; continue; }
  const userPart = safeId(row.userId);
  const storageName = path.basename(String(asset.storageName));
  const localDir = path.join(usersDir, userPart, 'files');
  const localFile = path.join(localDir, storageName);
  if (!localFile.startsWith(`${localDir}${path.sep}`)) { summary.skipped += 1; continue; }
  const localStat = await fs.stat(localFile).catch(() => null);
  if (!localStat?.isFile()) continue;
  summary.localFiles += 1;
  summary.localBytes += localStat.size;
  try {
    const result = await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: row.objectKey }));
    const remoteSize = Number(result?.ContentLength || 0);
    if (!remoteSize || remoteSize !== Number(asset.size)) {
      summary.mismatched += 1;
      console.log(`[mismatch] user=${row.userId} asset=${row.id} local=${localStat.size} remote=${remoteSize} expected=${asset.size}`);
      continue;
    }
    summary.verified += 1;
    if (localStat.size !== remoteSize) {
      summary.mismatched += 1;
      console.log(`[mismatch] user=${row.userId} asset=${row.id} local=${localStat.size} remote=${remoteSize}`);
      continue;
    }
    summary.deletable += 1;
    if (deleting) {
      await fs.unlink(localFile);
      summary.deleted += 1;
      console.log(`[deleted] ${localFile}`);
    } else {
      console.log(`[safe] ${localFile}`);
    }
  } catch (error) {
    summary.r2Errors += 1;
    console.log(`[r2-error] user=${row.userId} asset=${row.id} key=${row.objectKey} error=${error.code || error.message}`);
  }
}

console.log(JSON.stringify({ ...summary, localMiB: Number((summary.localBytes / 1024 / 1024).toFixed(2)), user: userFilter || null, limit, deleting }, null, 2));
