// 客户端诊断日志包的对象存储。
//
// 日志包与用户素材完全不同：它不进素材库、不计费、只供后台排查，因此单独
// 放在一个前缀下，并用独立的 S3 客户端，避免和媒体上传链路互相牵连。
// 元数据落在 system_events（category='client_log'）里，管理后台按 objectKey 取包。
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const endpoint = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
const bucket = String(process.env.R2_BUCKET || '').trim();
const region = String(process.env.R2_REGION || 'auto').trim() || 'auto';
const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const configured = Boolean(accessKeyId && secretAccessKey && endpoint && bucket);
const client = configured ? new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
}) : null;
const mediaPrefix = String(process.env.MEDIA_OBJECT_PREFIX || 'model-studio').replace(/^\/+|\/+$/g, '');
const prefix = String(process.env.SUPPORT_LOG_OBJECT_PREFIX || [mediaPrefix, 'support-logs'].filter(Boolean).join('/')).replace(/^\/+|\/+$/g, '');
const safeId = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');

export const SUPPORT_LOG_MIME = 'application/gzip';
export const supportLogStorageReady = configured;
export const supportLogMaxBytes = Math.max(64 * 1024, Number(process.env.SUPPORT_LOG_MAX_BYTES || 16 * 1024 * 1024));

export function supportLogObjectKey(userId) {
  const day = new Date().toISOString().slice(0, 10);
  return [prefix, safeId(userId) || 'unknown', `${day}-${randomUUID()}.log.gz`].filter(Boolean).join('/');
}

/** 只允许下载确实位于日志前缀下的对象，避免 details 被污染后变成任意读。 */
export function isSupportLogKey(key) {
  const value = String(key || '');
  return Boolean(prefix) && value.startsWith(`${prefix}/`) && !value.includes('..');
}

function storageUnavailable() {
  return Object.assign(new Error('诊断日志存储服务尚未配置'), { statusCode: 503 });
}

export async function putSupportLogObject(key, body) {
  if (!client) throw storageUnavailable();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: SUPPORT_LOG_MIME,
  }));
  return key;
}

export async function signedSupportLogUrl(key, { expires = 300, fileName = '' } = {}) {
  if (!client) throw storageUnavailable();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseCacheControl: 'private, no-store',
    ...(fileName ? { ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"` } : {}),
  }), { expiresIn: expires });
}
