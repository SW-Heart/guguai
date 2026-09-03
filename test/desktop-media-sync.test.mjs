import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRemoveImportedLocalAsset,
  cloudAssetFromDesktopSync,
  desktopHydrationRetryDelay,
  desktopMediaPayload,
  isAwaitingDesktopDelivery,
  isRemoteReferenceReady,
  needsReferenceUpload,
  shouldHydrateDesktopAsset,
  shouldRemoveUploadJobLocalAsset,
} from '../public/desktop-media-sync.js';

test('desktop folder reveal payload distinguishes cloud, hydrated, and local-only assets', () => {
  assert.deepEqual(desktopMediaPayload({ id:'cloud-1', name:'历史图片.png', kind:'image', mimeType:'image/png' }), {
    assetId:'cloud-1', localAssetId:'', url:'/api/files/cloud-1/direct', name:'历史图片.png', kind:'image', mimeType:'image/png',
  });
  assert.deepEqual(desktopMediaPayload({ id:'cloud-2', localId:'local-2', directUrl:'/signed-route', name:'已接收.mp4', kind:'video', mimeType:'video/mp4' }), {
    assetId:'cloud-2', localAssetId:'local-2', url:'/signed-route', name:'已接收.mp4', kind:'video', mimeType:'video/mp4',
  });
  assert.deepEqual(desktopMediaPayload({ id:'local-3', localOnly:true, name:'本地素材.webp', kind:'image', mimeType:'image/webp' }), {
    assetId:'', localAssetId:'local-3', url:'', name:'本地素材.webp', kind:'image', mimeType:'image/webp',
  });
});

test('desktop hydration retries transient failures with bounded backoff', () => {
  assert.equal(desktopHydrationRetryDelay(1), 750);
  assert.equal(desktopHydrationRetryDelay(2), 1500);
  assert.equal(desktopHydrationRetryDelay(3), 0);
  assert.equal(desktopHydrationRetryDelay(1, { baseDelay:200, maxFailures:2 }), 200);
  assert.equal(desktopHydrationRetryDelay(2, { baseDelay:200, maxFailures:2 }), 0);
});

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
  assert.equal(shouldHydrateDesktopAsset({ id:'repair', deliveryStatus:'local_ready', remoteStatus:'ready' }, { force:true }), true);
  assert.equal(shouldHydrateDesktopAsset({ id:'already-local', deliveryStatus:'local_ready', remoteStatus:'ready', localStatus:'saved' }, { force:true }), false);
});
