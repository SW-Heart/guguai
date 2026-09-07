import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectLocalMedia } from '../desktop/local-media-state.mjs';
import { openLocalLibrary, closeLocalLibrary, upsertLocalAsset, getLocalAsset, listLocalAssets } from '../desktop/local-library.mjs';
import { createDesktopScope } from '../public/platform/desktop-scope.js';
import { mergeDesktopAssetRecord, shouldHydrateDesktopAsset } from '../public/desktop-media-sync.js';

test('external deletion survives library reopen and remote upserts without downloading again', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'gugu-missing-'));
  try {
    await mkdir(path.join(workspace, 'library'));
    const asset = { id:'local-a', cloudAssetId:'cloud-a', relativePath:'library/a.png', kind:'image', localStatus:'saved' };
    await writeFile(path.join(workspace, asset.relativePath), 'image');
    openLocalLibrary(workspace);
    upsertLocalAsset(asset);
    const saved = await inspectLocalMedia(asset, workspace);
    assert.equal(saved.localStatus, 'saved');
    await unlink(path.join(workspace, asset.relativePath));
    const missing = await inspectLocalMedia(saved, workspace);
    upsertLocalAsset(missing);
    closeLocalLibrary();
    openLocalLibrary(workspace);
    assert.equal(getLocalAsset(asset.id).localStatus, 'missing');
    assert.equal(listLocalAssets().total, 0);
    const scope = createDesktopScope();
    const local = scope.localAsset(getLocalAsset(asset.id));
    assert.equal(local.id, 'cloud-a');
    const cloud = { id:'cloud-a', url:'https://example.com/a.png', localStatus:'remote', deliveryStatus:'awaiting_local', remoteStatus:'pending' };
    for (const merged of [mergeDesktopAssetRecord(saved, missing), mergeDesktopAssetRecord(local, cloud)]) {
      assert.equal(merged.localStatus, 'missing');
      assert.equal(merged.url, '');
      assert.equal(shouldHydrateDesktopAsset(merged, { force:true }), false);
    }
    assert.equal(shouldHydrateDesktopAsset(cloud), true);
  } finally {
    closeLocalLibrary();
    await rm(workspace, { recursive:true, force:true });
  }
});

test('permission errors and unavailable storage never become missing markers', async () => {
  const asset = { id:'a', relativePath:'library/a.png', localStatus:'saved' };
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    await assert.rejects(inspectLocalMedia(asset, '/workspace', { statFile:async () => { throw Object.assign(new Error(code), { code }); } }), { code });
  }
  await assert.rejects(inspectLocalMedia(asset, '/workspace', { statFile:async () => { throw Object.assign(new Error('disconnected'), { code:'ENOENT' }); } }), { code:'ENOENT' });
  assert.equal(asset.localStatus, 'saved');
});
