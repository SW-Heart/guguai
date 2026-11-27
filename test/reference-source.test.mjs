import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { __test } = await import('../server.mjs');

// A generation that is only on the user's device keeps the provider's result
// link, which expires. It must never be used as a reference source.
const deliveredGeneration = {
  id: 'generation-ag-expired-link', ownerId: 'user-reference-source', kind: 'image',
  name: '生成图片.png', mimeType: 'image/png', size: 1024,
  storageName: 'generation-ag-expired-link.png',
  sourceUrl: 'https://upstream.example/expired-result.png',
  sourceGenerationId: 'ag-expired-link', remoteStatus: 'local_only', localReadyAt: '2026-11-27T02:40:00.000Z',
};

test('a provider result link is not a readable reference source', async () => {
  assert.equal(await __test.referenceAssetHasReadableSource('user-reference-source', deliveredGeneration), false);
});

test('preparing a reference never downloads the provider result link', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'gugu-reference-source-'));
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, ...rest) => { requested.push(String(url)); return originalFetch(url, ...rest); };
  try {
    await assert.rejects(
      __test.ensureLocalAsset('user-reference-source', deliveredGeneration, targetDir),
      error => error.code === 'REFERENCE_NOT_READY' && error.statusCode === 409 && /重新上传/.test(error.message),
    );
    assert.deepEqual(requested.filter(url => url.includes('upstream.example')), []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(targetDir, { recursive: true, force: true });
  }
});
