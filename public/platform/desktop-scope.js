export function createDesktopScope({ getWindow, getSyncInfo, getMediaKind = item => item?.kind } = {}) {
  const readWindow = getWindow || (() => globalThis.window);
  const readSyncInfo = getSyncInfo || (() => ({}));

  function headers() {
    const currentWindow = readWindow();
    const info = readSyncInfo() || {};
    if (!currentWindow?.guguDesktop || !info.deviceId || !info.workspaceId) return {};
    return {
      'X-GuGu-Desktop': '1',
      'X-GuGu-Device-Id': info.deviceId,
      'X-GuGu-Workspace-Id': info.workspaceId,
    };
  }
  function localAsset(item) {
    const cloudAssetId = String(item?.cloudAssetId || '');
    const id = cloudAssetId || String(item?.id || '');
    if (!id || !item?.url) return null;
    const kind = item.kind || getMediaKind(item);
    if (!kind) return null;
    return { ...item, id, localId: item.id, cloudAssetId, kind, url: item.url, remoteUrl: item.remoteUrl || (cloudAssetId ? `/api/files/${encodeURIComponent(cloudAssetId)}/content` : ''), localStatus: 'saved', localOnly: !cloudAssetId, updatedAt: item.updatedAt || item.createdAt };
  }
  return { headers, localAsset };
}
