import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteMedia } from '../desktop/media-download.mjs';

test('desktop media downloads let Electron follow signed-storage redirects', async () => {
  const expectedResponse = { ok: true };
  const calls = [];
  const electronSession = {
    fetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve(expectedResponse);
    },
  };

  const response = await fetchRemoteMedia(electronSession, 'https://studio.example.com/api/files/asset-1/direct');

  assert.equal(response, expectedResponse);
  assert.deepEqual(calls, [{
    url: 'https://studio.example.com/api/files/asset-1/direct',
    options: {
      credentials: 'include',
      redirect: 'follow',
    },
  }]);
});
