import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import OSS from 'ali-oss';
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
const provider = String(process.env.MEDIA_STORAGE_PROVIDER || 'oss').trim().toLowerCase();
const storageProviderForAsset = asset => asset?.storageProvider === 'r2' ? 'r2' : 'oss';
const aliOssConfigured = Boolean(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET && process.env.ALIYUN_OSS_ENDPOINT && process.env.ALIYUN_OSS_BUCKET);
const oss = aliOssConfigured ? new OSS({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, endpoint: process.env.ALIYUN_OSS_ENDPOINT, bucket: process.env.ALIYUN_OSS_BUCKET, secure: true }) : null;
const r2Bucket = String(process.env.R2_BUCKET || '').trim();
const r2 = process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && r2Bucket
  ? new S3Client({ region: process.env.R2_REGION || 'auto', endpoint: process.env.R2_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } })
  : null;

if (!['oss', 'r2'].includes(provider)) throw new Error('MEDIA_STORAGE_PROVIDER 必须是 oss 或 r2');
if ((provider === 'oss' && !oss) || (provider === 'r2' && !r2)) throw new Error(`${provider.toUpperCase()} 配置不完整，无法安全校验本地文件`);
if (deleting) console.log(`模式：DELETE（只删除逐条通过 ${provider.toUpperCase()} 校验的本地文件）`);
else console.log('模式：DRY-RUN（不会删除任何文件；使用 --delete 才会执行删除）');

openDatabase({ file: null });
const rows = sql(`
  SELECT user_id AS userId, doc_json AS docJson
  FROM assets
  WHERE (:userId = '' OR user_id = :userId)
  ORDER BY created_at ASC, id ASC
  LIMIT :limit`).all({ userId: userFilter, limit });

const summary = { assets: 0, localFiles: 0, localBytes: 0, verified: 0, deletable: 0, deleted: 0, missingOss: 0, mismatched: 0, skipped: 0 };
for (const row of rows) {
  summary.assets += 1;
  let asset;
  try { asset = JSON.parse(row.docJson); } catch { summary.skipped += 1; continue; }
  if (!asset.storageName || !asset.ossKey) { summary.skipped += 1; continue; }
  const userPart = safeId(row.userId);
  const storageName = path.basename(String(asset.storageName));
  const localDir = path.join(usersDir, userPart, 'files');
  const localFile = path.join(localDir, storageName);
  if (!localFile.startsWith(`${localDir}${path.sep}`)) { summary.skipped += 1; continue; }
  const localStat = await fs.stat(localFile).catch(() => null);
  if (!localStat?.isFile()) continue;
  summary.localFiles += 1;
  summary.localBytes += localStat.size;
  const assetProvider = storageProviderForAsset(asset);
  const assetClientConfigured = assetProvider === 'r2' ? r2 : oss;
  if (!assetClientConfigured) {
    summary.missingOss += 1;
    console.log(`[missing-${assetProvider}] user=${row.userId} asset=${asset.id} key=${asset.ossKey} error=provider-not-configured`);
    continue;
  }
  try {
    const result = assetProvider === 'r2'
      ? await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: asset.ossKey }))
      : await oss.getObjectMeta(asset.ossKey);
    const remoteSize = assetProvider === 'r2' ? Number(result?.ContentLength || 0) : Number(result?.res?.headers?.['content-length'] || 0);
    if (!remoteSize || remoteSize !== Number(asset.size)) { summary.mismatched += 1; console.log(`[mismatch] user=${row.userId} asset=${asset.id} local=${localStat.size} remote=${remoteSize} expected=${asset.size}`); continue; }
    summary.verified += 1;
    if (localStat.size !== remoteSize) { summary.mismatched += 1; console.log(`[mismatch] user=${row.userId} asset=${asset.id} local=${localStat.size} remote=${remoteSize}`); continue; }
    summary.deletable += 1;
    if (deleting) {
      await fs.unlink(localFile);
      summary.deleted += 1;
      console.log(`[deleted] ${localFile}`);
    } else {
      console.log(`[safe] ${localFile}`);
    }
  } catch (error) {
    summary.missingOss += 1;
    console.log(`[missing-${assetProvider}] user=${row.userId} asset=${asset.id} key=${asset.ossKey} error=${error.code || error.message}`);
  }
}

console.log(JSON.stringify({ ...summary, localMiB: Number((summary.localBytes / 1024 / 1024).toFixed(2)), user: userFilter || null, limit, deleting }, null, 2));
