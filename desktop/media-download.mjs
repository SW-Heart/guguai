export function fetchRemoteMedia(electronSession, url) {
  return electronSession.fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: { 'X-GuGu-Desktop': '1' },
  });
}
