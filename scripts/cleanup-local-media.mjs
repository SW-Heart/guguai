import { promises as fs } from 'node:fs';
import path from 'node:path';
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
const ossConfigured = Boolean(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET && process.env.ALIYUN_OSS_ENDPOINT && process.env.ALIYUN_OSS_BUCKET);
const oss = ossConfigured ? new OSS({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, endpoint: process.env.ALIYUN_OSS_ENDPOINT, bucket: process.env.ALIYUN_OSS_BUCKET, secure: true }) : null;

if (deleting) console.log('模式：DELETE（只删除逐条通过 OSS 校验的本地文件）');
else console.log('模式：DRY-RUN（不会删除任何文件；使用 --delete 才会执行删除）');
if (!oss) throw new Error('OSS 配置不完整，无法安全校验本地文件；请先配置 ALIYUN_ACCESS_KEY_ID/SECRET/ENDPOINT/BUCKET');

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
  try {
    const result = await oss.getObjectMeta(asset.ossKey);
    const remoteSize = Number(result?.res?.headers?.['content-length'] || 0);
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
    console.log(`[missing-oss] user=${row.userId} asset=${asset.id} key=${asset.ossKey} error=${error.code || error.message}`);
  }
}

console.log(JSON.stringify({ ...summary, localMiB: Number((summary.localBytes / 1024 / 1024).toFixed(2)), user: userFilter || null, limit, deleting }, null, 2));
