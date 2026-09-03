const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export async function fetchRemoteMedia(electronSession, url, { sameOriginHeaders = {}, maxRedirects = 5, sameOriginFetch = globalThis.fetch } = {}) {
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
      });
    }
    const response = await sameOriginFetch(target.toString(), {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
      headers: { 'X-GuGu-Desktop': '1', ...sameOriginHeaders },
    });
    if (!redirectStatuses.has(response.status)) return response;
    const location = response.headers?.get?.('location');
    if (!location) return response;
    if (redirects >= maxRedirects) throw new Error('媒体下载重定向次数过多');
    target = new URL(location, target);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('媒体下载重定向地址不受信任');
  }
  throw new Error('媒体下载重定向次数过多');
}
