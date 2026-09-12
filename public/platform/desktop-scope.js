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
    if (!id || (!item?.url && item?.localStatus !== 'missing')) return null;
    const kind = item.kind || getMediaKind(item);
    if (!kind) return null;
    // Desktop downloads historically mark remoteStatus as ready even when only
    // the local copy exists. Local library metadata cannot prove cloud readiness.
    return { ...item, id, localId: item.id, cloudAssetId, kind, url: item.url, remoteUrl: item.remoteUrl || (cloudAssetId ? `/api/files/${encodeURIComponent(cloudAssetId)}/content` : ''), ...(cloudAssetId ? { remoteStatus:'pending' } : {}), localStatus: item.localStatus === 'missing' ? 'missing' : 'saved', localOnly: !cloudAssetId, updatedAt: item.updatedAt || item.createdAt };
  }
  return { headers, localAsset };
}
