import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRemoveImportedLocalAsset,
  cloudAssetFromDesktopSync,
  isAwaitingDesktopDelivery,
  isRemoteReferenceReady,
  needsReferenceUpload,
  shouldHydrateDesktopAsset,
  shouldRemoveUploadJobLocalAsset,
} from '../public/desktop-media-sync.js';

test('desktop sync accepts only the canonical cloudAsset result', () => {
  const current = { cloudAsset: { id: 'cloud-current', name: 'current.png' } };

  assert.equal(cloudAssetFromDesktopSync(current), current.cloudAsset);
  assert.equal(cloudAssetFromDesktopSync({ asset: { id: 'legacy-asset' } }), null);
  assert.equal(cloudAssetFromDesktopSync({ id: 'local-1', cloudAssetId: 'legacy-id' }), null);
  assert.equal(cloudAssetFromDesktopSync({ id: 'local-only' }), null);
});

test('desktop import cleanup never removes a deduplicated existing local asset', () => {
  assert.equal(canRemoveImportedLocalAsset({ id: 'new-local', reused: false }), true);
  assert.equal(canRemoveImportedLocalAsset({ id: 'existing-local', reused: true }), false);
  assert.equal(shouldRemoveUploadJobLocalAsset({ localAssetId: 'new-local', removeLocalOnDiscard: true, assetId: '' }), true);
  assert.equal(shouldRemoveUploadJobLocalAsset({ localAssetId: 'existing-local', removeLocalOnDiscard: false, assetId: '' }), false);
  assert.equal(shouldRemoveUploadJobLocalAsset({ localAssetId: 'new-local', removeLocalOnDiscard: true, assetId: 'cloud-1' }), false);
});

test('desktop references require explicit remote content readiness', () => {
  assert.equal(isRemoteReferenceReady({ id:'ready', remoteStatus:'ready' }), true);
  assert.equal(isRemoteReferenceReady({ id:'unspecified' }), false);
  assert.equal(isRemoteReferenceReady({ id:'local', remoteStatus:'local_only', localId:'desktop-1' }), false);
  assert.equal(isRemoteReferenceReady({ id:'generated', remoteStatus:'local_only', referenceSourceAvailable:true }), true);
  assert.equal(isRemoteReferenceReady({ id:'desktop-only', localOnly:true, remoteStatus:'ready' }), false);
});

test('legacy desktop references are marked for upload before video creation', () => {
  assert.equal(needsReferenceUpload({ id:'local', localOnly:true, remoteStatus:'pending' }), true);
  assert.equal(needsReferenceUpload({ id:'legacy', localId:'desktop-1', remoteStatus:'local_only' }), true);
  assert.equal(needsReferenceUpload({ id:'remote', remoteStatus:'local_only', referenceSourceAvailable:true }), false);
  assert.equal(needsReferenceUpload({ id:'ready', remoteStatus:'ready' }), false);
});

test('desktop auto hydration selects generated results awaiting local delivery or already backed up remotely', () => {
  const awaiting = { id:'new-result', deliveryStatus:'awaiting_local', remoteStatus:'pending' };
  const backedUp = { id:'backed-up', deliveryStatus:'remote_backed_up', remoteStatus:'ready' };
  assert.equal(isAwaitingDesktopDelivery(awaiting), true);
  assert.equal(shouldHydrateDesktopAsset(awaiting), true);
  assert.equal(isAwaitingDesktopDelivery(backedUp), true);
  assert.equal(shouldHydrateDesktopAsset(backedUp), true);
  assert.equal(shouldHydrateDesktopAsset({ ...awaiting, localStatus:'saved' }), false);
  assert.equal(shouldHydrateDesktopAsset({ ...backedUp, localStatus:'saved' }), false);
  assert.equal(shouldHydrateDesktopAsset({ ...awaiting, localOnly:true }), false);
  assert.equal(shouldHydrateDesktopAsset({ deliveryStatus:'awaiting_local', remoteStatus:'pending' }), false);
  assert.equal(shouldHydrateDesktopAsset({ id:'history', remoteStatus:'ready' }), false);
  assert.equal(shouldHydrateDesktopAsset({ id:'uploaded', remoteStatus:'ready' }), false);
  assert.equal(shouldHydrateDesktopAsset({ id:'inconsistent', deliveryStatus:'remote_backed_up', remoteStatus:'pending' }), false);
});
