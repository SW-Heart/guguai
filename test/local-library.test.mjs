import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimLocalAssetByPath,
  closeLocalLibrary,
  countLocalAssets,
  findLocalAssetByCloudId,
  findLocalAssetByDigest,
  getLocalAsset,
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

test('a local path can be adopted only when it is not bound to another cloud asset', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-library-claim-'));
  try {
    openLocalLibrary(root);
    const stored = { ...asset(1), relativePath: 'library/aabbccddeeff0011-同名素材.png' };
    upsertLocalAsset(stored);

    // 直接插入同路径的新记录会撞 relative_path 唯一约束。
    assert.throws(() => upsertLocalAsset({ ...asset(2), relativePath: stored.relativePath }), /UNIQUE constraint failed/);

    // 已绑定其他云端 ID 的记录不能被第二个任务复用，否则第二个任务永远无法按 cloudAssetId 找回。
    const shared = claimLocalAssetByPath({ relativePath: stored.relativePath, cloudAssetId: 'cloud-2', sha256: stored.sha256, size: stored.size });
    assert.equal(shared, null);
    assert.equal(findLocalAssetByCloudId('cloud-1').id, stored.id);
    assert.equal(findLocalAssetByCloudId('cloud-2'), null);
    assert.equal(countLocalAssets(), 1);

    // 未绑定云端 ID 的本地导入文件可以被认领，并顶掉指向失效文件的旧记录。
    const imported = { ...asset(3), cloudAssetId: '', relativePath: 'library/00112233445566aa-本地导入.png', remoteStatus: 'local_only' };
    upsertLocalAsset(imported);
    upsertLocalAsset({ ...asset(4), cloudAssetId: 'cloud-4', relativePath: 'library/missing-file.png' });
    const adopted = claimLocalAssetByPath({ relativePath: imported.relativePath, cloudAssetId: 'cloud-4', sha256: imported.sha256, size: imported.size, previousId: 'local-4' });
    assert.equal(adopted.id, imported.id);
    assert.equal(adopted.cloudAssetId, 'cloud-4');
    assert.equal(adopted.remoteStatus, 'ready');
    assert.equal(findLocalAssetByCloudId('cloud-4').id, imported.id);
    assert.equal(getLocalAsset('local-4'), null);

    // 记录自身占用该路径时不做认领，交回普通 upsert 流程。
    assert.equal(claimLocalAssetByPath({ relativePath: stored.relativePath, cloudAssetId: 'cloud-1', previousId: stored.id }), null);
    assert.equal(claimLocalAssetByPath({ relativePath: 'library/未使用.png', cloudAssetId: 'cloud-9' }), null);
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
