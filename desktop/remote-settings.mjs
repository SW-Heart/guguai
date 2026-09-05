export function normalizeControlledUrl(value, { production = false, allowedOrigin = '', allowEmpty = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('地址不能为空');
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('地址必须是完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('地址必须是完整的 http:// 或 https:// 地址');
  }
  if (production && parsed.protocol !== 'https:') throw new Error('生产环境只允许 HTTPS 地址');
  if (allowedOrigin && parsed.origin !== allowedOrigin) throw new Error('地址不在受控来源范围内');
  return parsed.toString().replace(/\/$/, '');
}
