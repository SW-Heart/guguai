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
