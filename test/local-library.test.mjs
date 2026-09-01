import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeLocalLibrary,
  countLocalAssets,
  findLocalAssetByCloudId,
  findLocalAssetByDigest,
  listLocalAssets,
  listLocalAssetsByCloudIds,
  openLocalLibrary,
  upsertLocalAsset,
} from '../desktop/local-library.mjs';
import { accountWorkspacePath } from '../desktop/workspace-scope.mjs';

function asset(index, createdAt = new Date(Date.UTC(2026, 0, 1, 0, index % 60, Math.floor(index / 60))).toISOString()) {
  return {
    id: `local-${index}`,
    cloudAssetId: `cloud-${index}`,
    name: `素材-${index}.png`,
    relativePath: `library/file-${index}.png`,
    mimeType: 'image/png',
    kind: 'image',
    size: index + 1,
    sha256: String(index).padStart(64, '0'),
    createdAt,
    updatedAt: createdAt,
    localStatus: 'saved',
    remoteStatus: 'ready',
  };
}

function videoAsset(index, createdAt) {
  return {
    ...asset(index, createdAt),
    name: `视频-${index}.mp4`,
    relativePath: `library/file-${index}.mp4`,
    mimeType: 'video/mp4',
    kind: 'video',
  };
}

test('local library migrates once and paginates without loading the whole index', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-library-'));
  try {
    mkdirSync(path.join(root, '.gugu'), { recursive: true });
    writeFileSync(path.join(root, '.gugu', 'library-index.json'), JSON.stringify({ version: 1, assets: [asset(0), asset(1)] }));
    assert.deepEqual(openLocalLibrary(root), { migrated: 2 });
    assert.equal(countLocalAssets(), 2);
    assert.deepEqual(openLocalLibrary(root), { migrated: 0 });

    for (let index = 2; index < 1002; index += 1) upsertLocalAsset(asset(index));
    assert.equal(countLocalAssets(), 1002);
    assert.equal(findLocalAssetByCloudId('cloud-777').id, 'local-777');
    assert.equal(findLocalAssetByDigest(String(777).padStart(64, '0'), 778).id, 'local-777');
    assert.deepEqual(listLocalAssetsByCloudIds(['cloud-1', 'cloud-999']).map(item => item.id).sort(), ['local-1', 'local-999']);

    const ids = [];
    let cursor = '';
    let guard = 0;
    do {
      const page = listLocalAssets({ limit: 37, cursor });
      assert.ok(page.items.length <= 37);
      ids.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
      assert.ok(++guard < 100);
    } while (cursor);
    assert.equal(ids.length, 1002);
    assert.equal(new Set(ids).size, 1002);

    upsertLocalAsset(videoAsset(2000));
    upsertLocalAsset({ ...videoAsset(2001), name: '特别片段.mp4', remoteStatus: 'local_only' });
    const videos = listLocalAssets({ kind: 'video', limit: 20 });
    assert.equal(videos.total, 2);
    assert.deepEqual(videos.items.map(item => item.id), ['local-2001', 'local-2000']);
    const searched = listLocalAssets({ kind: 'video', search: '特别', limit: 20 });
    assert.equal(searched.total, 1);
    assert.equal(searched.items[0].id, 'local-2001');
    const pending = listLocalAssets({ remoteStatus: 'local_only', limit: 20 });
    assert.equal(pending.total, 1);
    assert.equal(pending.items[0].id, 'local-2001');
  } finally {
    closeLocalLibrary();
    rmSync(root, { recursive: true, force: true });
  }
});

test('account-scoped workspace databases do not expose each other local assets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-library-accounts-'));
  try {
    openLocalLibrary(accountWorkspacePath(root, 'user-a'));
    upsertLocalAsset(asset(1));
    closeLocalLibrary();

    openLocalLibrary(accountWorkspacePath(root, 'user-b'));
    assert.equal(countLocalAssets(), 0);
    assert.equal(findLocalAssetByCloudId('cloud-1'), null);
  } finally {
    closeLocalLibrary();
    rmSync(root, { recursive: true, force: true });
  }
});
