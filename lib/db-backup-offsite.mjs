/**
 * Off-site copies of the metadata database snapshot.
 *
 * `npm run db:backup` leaves its snapshots next to the live database, so a
 * lost disk takes both. This module pushes a gzipped copy of a verified
 * snapshot to the private R2 bucket and keeps a bounded history there.
 *
 * Backups live under their own object prefix. Nothing in the media retention
 * path may delete below that prefix: see `isDbBackupObjectKey`.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const DEFAULT_REMOTE_RETENTION = 30;
const SNAPSHOT_NAME = /^studio\.db\.bak-\d{8}T\d{6}Z$/;
const REMOTE_NAME = /^studio\.db\.bak-\d{8}T\d{6}Z\.gz$/;

const trimSlashes = value => String(value || '').trim().replace(/^\/+|\/+$/g, '');

export function dbBackupObjectPrefix(env = process.env) {
  const configured = trimSlashes(env.DB_BACKUP_OBJECT_PREFIX);
  if (configured) return configured;
  return [trimSlashes(env.MEDIA_OBJECT_PREFIX || 'model-studio'), 'db-backups'].filter(Boolean).join('/');
}

/** True for any object below the backup prefix. Media cleanup must skip these. */
export function isDbBackupObjectKey(key, env = process.env) {
  return String(key || '').startsWith(`${dbBackupObjectPrefix(env)}/`);
}

export function offsiteBackupConfig(env = process.env) {
  const value = name => String(env[name] || '').trim();
  const retention = Number(value('DB_BACKUP_REMOTE_RETENTION') || DEFAULT_REMOTE_RETENTION);
  const config = {
    endpoint: value('R2_ENDPOINT').replace(/\/+$/, ''),
    region: value('R2_REGION') || 'auto',
    accessKeyId: value('R2_ACCESS_KEY_ID'),
    secretAccessKey: value('R2_SECRET_ACCESS_KEY'),
    bucket: value('DB_BACKUP_R2_BUCKET') || value('R2_BUCKET'),
    prefix: dbBackupObjectPrefix(env),
    retention: Number.isInteger(retention) && retention >= 1 ? retention : DEFAULT_REMOTE_RETENTION,
  };
  const missing = [
    ['R2_ENDPOINT', config.endpoint], ['R2_ACCESS_KEY_ID', config.accessKeyId],
    ['R2_SECRET_ACCESS_KEY', config.secretAccessKey], ['R2_BUCKET', config.bucket],
  ].filter(([, present]) => !present).map(([name]) => name);
  return { ...config, missing, ready: !missing.length };
}

export function createOffsiteBackupClient(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

async function listRemoteBackups({ send, bucket, prefix }) {
  const names = [];
  let token;
  do {
    const page = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
    for (const object of page.Contents || []) {
      const name = String(object.Key || '').slice(prefix.length + 1);
      if (REMOTE_NAME.test(name)) names.push(name);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  // The UTC stamp in the name sorts chronologically.
  return names.sort().reverse();
}

/** Deletes everything but the newest `retention` snapshots. Unrelated keys are never touched. */
export async function pruneRemoteBackups({ send, bucket, prefix, retention = DEFAULT_REMOTE_RETENTION }) {
  const names = await listRemoteBackups({ send, bucket, prefix });
  const stale = names.slice(Math.max(1, retention));
  for (const name of stale) await send(new DeleteObjectCommand({ Bucket: bucket, Key: `${prefix}/${name}` }));
  return { kept: names.length - stale.length, removed: stale.length };
}

/**
 * Gzips a verified snapshot, uploads it and confirms the stored size.
 * Older remote snapshots are pruned only after the new one is confirmed.
 */
export async function uploadBackupSnapshot({ file, sha256 = '', send, bucket, prefix, retention = DEFAULT_REMOTE_RETENTION, tmpDir = os.tmpdir() }) {
  const name = path.basename(file);
  if (!SNAPSHOT_NAME.test(name)) throw new Error(`不是数据库备份文件：${name}`);
  const key = `${prefix}/${name}.gz`;
  const workDir = await fs.mkdtemp(path.join(tmpDir, 'gugu-db-backup-'));
  const packed = path.join(workDir, `${name}.gz`);
  try {
    await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(packed, { mode: 0o600 }));
    const size = (await fs.stat(packed)).size;
    await send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(packed),
      ContentLength: size,
      ContentType: 'application/gzip',
      Metadata: sha256 ? { 'snapshot-sha256': sha256 } : undefined,
    }));
    const stored = await send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (Number(stored.ContentLength) !== size) {
      throw new Error(`异地备份大小不一致：本地 ${size} 字节，远端 ${Number(stored.ContentLength) || 0} 字节`);
    }
    const pruned = await pruneRemoteBackups({ send, bucket, prefix, retention });
    return { key, size, ...pruned };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
