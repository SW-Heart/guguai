const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export async function fetchRemoteMedia(electronSession, url, { sameOriginHeaders = {}, maxRedirects = 5 } = {}) {
  const source = new URL(url);
  let target = source;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const sameOrigin = target.origin === source.origin;
    const response = await electronSession.fetch(target.toString(), {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
      headers: sameOrigin ? { 'X-GuGu-Desktop': '1', ...sameOriginHeaders } : {},
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
