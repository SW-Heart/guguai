import { open } from 'node:fs/promises';

const maxImageBytes = 20 * 1024 * 1024;
const unavailable = '这张图片暂时无法读取，请稍后重试；若仍失败，请重新添加图片。';

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  throw new Error('这张图片的格式无法读取，请使用 PNG、JPEG、WebP 或 GIF 图片。');
}

export function createAgentImageReader({ r2Configured, signedAssetUrl, ensureLocalAsset, withMediaTempDir }) {
  return async (asset, userId) => {
    if (asset.objectKey && r2Configured) return signedAssetUrl(asset.objectKey, 900);
    // Desktop delivery can finish without a cloud archive. Resolve the original
    // through the same authenticated source recovery used by media references.
    return withMediaTempDir(`agent-image-${asset.id}`, async directory => {
      let file;
      try { file = await ensureLocalAsset(userId, asset, directory); }
      catch (cause) { throw new Error(unavailable, { cause }); }
      const handle = await open(file, 'r');
      try {
        const { size } = await handle.stat();
        if (!size || size > maxImageBytes) throw new Error('这张图片为空或超过 20 MB，请重新添加较小的图片。');
        const bytes = await handle.readFile();
        if (bytes.length > maxImageBytes) throw new Error('这张图片超过 20 MB，请重新添加较小的图片。');
        return `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`;
      } finally { await handle.close(); }
    });
  };
}
