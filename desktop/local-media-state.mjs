import { stat } from 'node:fs/promises';
import path from 'node:path';

// Only a missing file in an accessible workspace is evidence of removal.
// Permission errors and disconnected storage must not become deletion markers.
export async function inspectLocalMedia(asset, workspace, { statFile = stat } = {}) {
  const target = path.resolve(workspace, asset.relativePath);
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('本地素材路径无效');
  if (asset.localStatus === 'missing') return { ...asset, url:'', previewUrl:'' };
  try {
    const info = await statFile(target);
    if (!info.isFile()) throw new Error('本地素材路径不是文件');
    return { ...asset, localStatus:'saved', url:`gugu-media://asset/${encodeURIComponent(asset.id)}` };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await statFile(workspace);
    await statFile(path.join(workspace, 'library'));
    return { ...asset, localStatus:'missing', url:'', previewUrl:'', updatedAt:new Date().toISOString() };
  }
}
