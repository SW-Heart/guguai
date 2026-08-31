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
  } finally {
    closeLocalLibrary();
    rmSync(root, { recursive: true, force: true });
  }
});
