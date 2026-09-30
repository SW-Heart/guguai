import { createReadStream, promises as fs } from 'node:fs';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const transientCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

export function retryableReferenceUploadError(error) {
  const pending = [error];
  const seen = new Set();
  let transportFailure = false;
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current.name === 'AbortError') return false;
    const status = Number(current.$metadata?.httpStatusCode || current.status || current.statusCode || current.res?.status);
    if (status) return [408, 409, 425, 429].includes(status) || status >= 500;
    if (transientCodes.has(String(current.code || ''))
      || /socket hang up|fetch failed|network error|timed? out|before secure TLS connection/i.test(String(current.message || ''))) {
      transportFailure = true;
    }
    pending.push(current.cause, ...(current.errors || []));
  }
  return transportFailure;
}

export async function uploadReferenceFileWithRetry({
  client, bucket, key, sourceFile, mimeType,
  maxAttempts = 4,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = () => {},
} = {}) {
  if (!client || typeof client.send !== 'function') throw new TypeError('参考图片上传缺少存储客户端');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('参考图片上传重试次数无效');
  const contentLength = (await fs.stat(sourceFile)).size;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A stream consumed by a failed PUT cannot be reused. Reopen the same
    // source for every attempt; writing the same key and bytes is idempotent.
    const body = createReadStream(sourceFile);
    try {
      await client.send(new PutObjectCommand({
        Bucket:bucket, Key:key, Body:body, ContentLength:contentLength, ContentType:mimeType,
      }));
      return attempt;
    } catch (error) {
      body.destroy();
      if (attempt >= maxAttempts || !retryableReferenceUploadError(error)) {
        error.referenceUploadAttempts = attempt;
        throw error;
      }
      await onRetry({ attempt, error });
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
