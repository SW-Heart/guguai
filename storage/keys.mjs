import path from 'node:path';
import { randomUUID } from 'node:crypto';

const defaultSafeId = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');

export function createStorageKeyService({
  storagePrefix = '',
  referenceImagePrefix = '',
  safeId = defaultSafeId,
  now = () => Date.now(),
  id = randomUUID,
} = {}) {
  function uploadExtension(mimeType, name = '') {
    const requested = path.extname(String(name)).toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (requested && requested.length <= 10) return requested;
    return ({
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
      'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
      'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
      'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.weba', 'audio/flac': '.flac',
    }[mimeType] || '');
  }
  function assetObjectKey(userId, storageName) {
    const extension = path.extname(storageName).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const base = safeId(path.basename(storageName, path.extname(storageName)));
    return [storagePrefix, safeId(userId), `${base}${extension}`].filter(Boolean).join('/');
  }
  function pendingUploadKey(userId, uploadId, mimeType, name) {
    return [storagePrefix, 'pending', safeId(userId), `${safeId(uploadId)}${uploadExtension(mimeType, name)}`].filter(Boolean).join('/');
  }
  function finalUploadKey(userId, assetId, mimeType, name) {
    return [storagePrefix, 'assets', safeId(userId), `${safeId(assetId)}${uploadExtension(mimeType, name)}`].filter(Boolean).join('/');
  }
  function referenceImageKey(userId, generationId, asset) {
    const extension = uploadExtension(asset?.mimeType, asset?.storageName) || '.bin';
    return [referenceImagePrefix, safeId(userId), safeId(generationId), `${now()}-${id()}${extension}`].filter(Boolean).join('/');
  }
  return { uploadExtension, assetObjectKey, pendingUploadKey, finalUploadKey, referenceImageKey };
}
