import { validateDownloadedMedia } from './media-integrity.mjs';
export { validateDownloadedMedia } from './media-integrity.mjs';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export async function fetchRemoteMedia(electronSession, url, { sameOriginHeaders = {}, maxRedirects = 5, sameOriginFetch = globalThis.fetch, signal } = {}) {
  const source = new URL(url);
  let target = source;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const sameOrigin = target.origin === source.origin;
    // Electron's Chromium-backed fetch can reject a manual redirect with
    // "Redirect was cancelled" instead of exposing the 3xx response.
    // Resolve only same-origin hops with Node's standards-compliant fetch so
    // authentication headers can never follow a redirect to object storage.
    if (!sameOrigin) {
      return electronSession.fetch(target.toString(), {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        headers: {},
        ...(signal ? { signal } : {}),
      });
    }
    const response = await sameOriginFetch(target.toString(), {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
      headers: { 'X-GuGu-Desktop': '1', ...sameOriginHeaders },
      ...(signal ? { signal } : {}),
    });
    if (!redirectStatuses.has(response.status)) return response;
    const location = response.headers?.get?.('location');
    if (!location) return response;
    if (redirects >= maxRedirects) throw new Error('媒体下载重定向次数过多');
    await response.body?.cancel().catch(() => {});
    target = new URL(location, target);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('媒体下载重定向地址不受信任');
  }
  throw new Error('媒体下载重定向次数过多');
}

// A stalled transfer must release its queue slot. Progress resets the idle
// deadline, so large videos on a slow but working connection can finish.
export function createDownloadDeadline({ timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('下载连接或传输停滞，请重试')), timeoutMs);
    timer.unref?.();
  };
  touch();
  return { signal:controller.signal, touch, close:() => clearTimeout(timer) };
}

export async function downloadMediaToFile(electronSession, url, target, { headers = {}, kind, mimeType, timeoutMs, fetchMedia = fetchRemoteMedia } = {}) {
  const [{ createWriteStream }, fs, { Readable, Transform }, { pipeline }, { createHash }] = await Promise.all([
    import('node:fs'), import('node:fs/promises'), import('node:stream'), import('node:stream/promises'), import('node:crypto'),
  ]);
  const deadline = createDownloadDeadline({ timeoutMs });
  try {
    const response = await fetchMedia(electronSession, url, { sameOriginHeaders:headers, signal:deadline.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`媒体下载失败（${response.status}）`), { status:response.status });
    }
    const contentType = response.headers.get('content-type') || '';
    const hash = createHash('sha256');
    let size = 0;
    let prefix = Buffer.alloc(0);
    const digest = new Transform({ transform(chunk, _encoding, done) {
      deadline.touch();
      size += chunk.length;
      hash.update(chunk);
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), digest, createWriteStream(target, { mode:0o600 }), { signal:deadline.signal });
    const expectedLength = response.headers.get('content-length');
    if (expectedLength && !response.headers.get('content-encoding') && Number(expectedLength) !== size) throw new Error('下载文件不完整，请重试');
    const detectedType = validateDownloadedMedia(prefix, size, { kind, contentType });
    const declaredType = contentType.split(';')[0].trim().toLowerCase();
    return { size, sha256:hash.digest('hex'), mimeType:detectedType || (/^(image|video|audio)\//.test(declaredType) ? declaredType : mimeType || 'application/octet-stream') };
  } catch (error) {
    await fs.unlink(target).catch(() => {});
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally { deadline.close(); }
}
