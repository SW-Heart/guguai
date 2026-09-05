import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopScope } from '../public/platform/desktop-scope.js';

test('desktop scope only emits workspace headers for a ready desktop session', () => {
  let desktop = true;
  const info = { deviceId: 'device-1', workspaceId: 'workspace-1' };
  const scope = createDesktopScope({ getWindow: () => ({ guguDesktop: desktop ? {} : null }), getSyncInfo: () => info });
  assert.deepEqual(scope.headers(), { 'X-GuGu-Desktop': '1', 'X-GuGu-Device-Id': 'device-1', 'X-GuGu-Workspace-Id': 'workspace-1' });
  desktop = false;
  assert.deepEqual(scope.headers(), {});
});

test('desktop scope normalizes local cloud and local-only records consistently', () => {
  const scope = createDesktopScope({ getMediaKind: () => 'image' });
  assert.deepEqual(scope.localAsset({ id: 'local-1', url: 'gugu-media://local-1', name: '本地' }), {
    id: 'local-1', url: 'gugu-media://local-1', name: '本地', localId: 'local-1', cloudAssetId: '', kind: 'image', remoteUrl: '', localStatus: 'saved', localOnly: true, updatedAt: undefined,
  });
});
