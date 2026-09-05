import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageKeyService } from '../storage/keys.mjs';

test('storage key service preserves scoped object key contracts', () => {
  const service = createStorageKeyService({
    storagePrefix: 'studio',
    referenceImagePrefix: 'temporary/reference',
    now: () => 123,
    id: () => 'fixed-id',
  });
  assert.equal(service.assetObjectKey('user/1', '角色图.PNG'), 'studio/user1/.png');
  assert.equal(service.pendingUploadKey('user/1', 'upload/2', 'image/png', 'source.png'), 'studio/pending/user1/upload2.png');
  assert.equal(service.finalUploadKey('user/1', 'asset/2', 'image/png', 'source.png'), 'studio/assets/user1/asset2.png');
  assert.equal(service.referenceImageKey('user/1', 'generation/2', { mimeType: 'image/png' }), 'temporary/reference/user1/generation2/123-fixed-id.png');
});
