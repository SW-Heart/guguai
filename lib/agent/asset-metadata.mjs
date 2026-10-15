import path from 'node:path';

export const assetCategories = ['character', 'location', 'prop', 'audio', 'other'];
export function assetFileName(value, asset) {
  const name = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 150);
  if (!name || /^\.+$/.test(name)) throw new Error('文件名不能为空');
  const extension = path.extname(asset.name || '') || ({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','audio/mpeg':'.mp3','audio/wav':'.wav'}[asset.mimeType] || '');
  return extension && !name.toLowerCase().endsWith(extension.toLowerCase()) ? `${name}${extension}` : name;
}
