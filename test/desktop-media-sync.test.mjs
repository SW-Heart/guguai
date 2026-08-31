import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRemoveImportedLocalAsset,
  cloudAssetFromDesktopSync,
  isRemoteReferenceReady,
  shouldRemoveUploadJobLocalAsset,
} from '../public/desktop-media-sync.js';

test('desktop sync accepts both current and legacy successful return shapes', () => {
  const current = { cloudAsset: { id: 'cloud-current', name: 'current.png' } };
  const legacy = { id: 'local-1', cloudAssetId: 'cloud-legacy', name: 'legacy.png', relativePath: 'library/legacy.png' };

  assert.equal(cloudAssetFromDesktopSync(current), current.cloudAsset);
  assert.deepEqual(cloudAssetFromDesktopSync(legacy), {
    ...legacy,
    id: 'cloud-legacy',
    url: '',
  });
  assert.equal(cloudAssetFromDesktopSync({ id: 'local-only' }), null);
});

test('desktop import cleanup never removes a deduplicated existing local asset', () => {
  assert.equal(canRemoveImportedLocalAsset({ id: 'new-local', reused: false }), true);
  assert.equal(canRemoveImportedLocalAsset({ id: 'existing-local', reused: true }), false);
  assert.equal(shouldRemoveUploadJobLocalAsset({ localAssetId: 'new-local', removeLocalOnDiscard: true, assetId: '' }), true);
  assert.equal(shouldRemoveUploadJobLocalAsset({ localAssetId: 'existing-local', removeLocalOnDiscard: false, assetId: '' }), false);
  assert.equal(shouldRemoveUploadJobLocalAsset({ localAssetId: 'new-local', removeLocalOnDiscard: true, assetId: 'cloud-1' }), false);
});

test('desktop references require remote content instead of only a cloud id', () => {
  assert.equal(isRemoteReferenceReady({ id:'ready', remoteStatus:'ready' }), true);
  assert.equal(isRemoteReferenceReady({ id:'legacy' }), true);
  assert.equal(isRemoteReferenceReady({ id:'local', remoteStatus:'local_only', localId:'desktop-1' }), false);
  assert.equal(isRemoteReferenceReady({ id:'generated', remoteStatus:'local_only', referenceSourceAvailable:true }), true);
  assert.equal(isRemoteReferenceReady({ id:'desktop-only', localOnly:true }), false);
});
