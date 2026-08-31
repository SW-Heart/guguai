export function fetchRemoteMedia(electronSession, url) {
  return electronSession.fetch(url, {
    cache: 'no-store',
    credentials: 'include',
    redirect: 'follow',
    headers: { 'X-GuGu-Desktop': '1' },
  });
}
