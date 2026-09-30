import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDownloadDeadline } from './media-download.mjs';

export async function downloadUpdateToFile(fetchImpl, file, target, { timeoutMs, onProgress = () => {} } = {}) {
  const total = Number(file.size);
  if (!file.sha512 || !Number.isSafeInteger(total) || total <= 0) throw new Error('更新清单缺少完整性校验信息');
  const deadline = createDownloadDeadline({ timeoutMs });
  let response;
  try {
    response = await fetchImpl(file.downloadUrl, { redirect:'follow', credentials:'omit', signal:deadline.signal });
    if (!response.ok || !response.body) throw new Error(`更新安装包下载失败（${response.status}）`);
    deadline.touch();
    const hash = createHash('sha512');
    let transferred = 0;
    let lastPercent = -1;
    const digest = new Transform({ transform(chunk, _encoding, callback) {
      try {
        deadline.touch();
        transferred += chunk.length;
        if (transferred > total) throw new Error('更新安装包大小与清单不一致');
        hash.update(chunk);
        const percent = Math.min(100, Math.floor(transferred / total * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress({ percent, transferred, total });
        }
        callback(null, chunk);
      } catch (error) { callback(error); }
    } });
    await pipeline(Readable.fromWeb(response.body), digest, createWriteStream(target, { mode:0o600 }), { signal:deadline.signal });
    if (transferred !== total || hash.digest('base64') !== file.sha512) throw new Error('更新安装包完整性校验失败');
    return true;
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    await unlink(target).catch(() => {});
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally { deadline.close(); }
}
