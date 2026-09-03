import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteMedia } from '../desktop/media-download.mjs';

test('desktop media downloads authenticate only same-origin hops and follow signed-storage redirects', async () => {
  const expectedResponse = { ok: true, status: 200 };
  const sessionCalls = [];
  const sameOriginCalls = [];
  const sameOriginFetch = (url, options) => {
    sameOriginCalls.push({ url, options });
    return Promise.resolve({
      status: 302,
      headers: { get: name => name.toLowerCase() === 'location' ? 'https://storage.example.com/signed.mp4' : null },
    });
  };
  const electronSession = {
    fetch(url, options) {
      sessionCalls.push({ url, options });
      return Promise.resolve(expectedResponse);
    },
  };

  const response = await fetchRemoteMedia(
    electronSession,
    'https://studio.example.com/api/files/asset-1/direct',
    { sameOriginHeaders:{ Cookie:'studio_session=secret' }, sameOriginFetch },
  );

  assert.equal(response, expectedResponse);
  assert.deepEqual(sameOriginCalls, [
    {
      url: 'https://studio.example.com/api/files/asset-1/direct',
      options: {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        headers: { 'X-GuGu-Desktop':'1', Cookie:'studio_session=secret' },
      },
    },
  ]);
  assert.deepEqual(sessionCalls, [
    {
      url: 'https://storage.example.com/signed.mp4',
      options: {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        headers: {},
      },
    },
  ]);
});
