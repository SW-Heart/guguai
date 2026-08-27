export function macDmgUpdateFile(updateInfo, feedUrl) {
  const feed = new URL(`${String(feedUrl || '').trim().replace(/\/$/, '')}/`);
  if (feed.protocol !== 'https:' || feed.username || feed.password) throw new Error('macOS 手动更新地址必须是 HTTPS');
  for (const file of updateInfo?.files || []) {
    const artifact = new URL(String(file?.url || ''), feed);
    if (artifact.protocol !== 'https:' || artifact.origin !== feed.origin || !artifact.pathname.toLowerCase().endsWith('.dmg')) continue;
    const fileName = decodeURIComponent(artifact.pathname.split('/').pop() || 'GuGu-AI-update.dmg');
    return { ...file, downloadUrl: artifact.toString(), fileName };
  }
  throw new Error('更新清单中缺少同源 HTTPS DMG 安装包');
}

export function macDmgInstallerLauncher(filePath, processId = process.pid) {
  const installerPath = String(filePath || '').trim();
  const pid = Number(processId);
  if (!installerPath.startsWith('/') || !installerPath.toLowerCase().endsWith('.dmg')) throw new Error('macOS 更新安装包路径无效');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('macOS 客户端进程 ID 无效');
  return {
    command: '/bin/sh',
    args: [
      '-c',
      'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$2"',
      'gugu-update-installer',
      String(pid),
      installerPath,
    ],
  };
}
