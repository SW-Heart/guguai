import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const frontendRoutePaths = new Set(['/login', '/image', '/video', '/drama', '/files']);
const marketingRouteFiles = new Map([
  ['/features', 'features.html'],
  ['/features/', 'features.html'],
  ['/pricing', 'pricing.html'],
  ['/pricing/', 'pricing.html'],
]);

export function isDesktopRequest(req) { return String(req.headers['x-gugu-desktop'] || '') === '1'; }

export function staticCacheControl(ext, { versioned = false, production = process.env.NODE_ENV === 'production' } = {}) {
  if (['.js', '.css'].includes(ext)) return production && versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  return ['.svg', '.woff', '.woff2'].includes(ext) ? 'public, max-age=604800, immutable' : 'no-cache';
}

export function staticEntryFile(pathname, { desktop = false, appOnly = true } = {}) {
  return marketingRouteFiles.get(pathname)
    || (pathname === '/guguadmin' || pathname === '/guguadmin/'
      ? 'guguadmin.html'
      : (pathname === '/' || pathname === '/index.html' || frontendRoutePaths.has(pathname))
        ? (desktop || !appOnly ? 'index.html' : 'home.html')
        : pathname.slice(1));
}

export async function serveFile(res, file, mimeType, cacheControl = 'private, max-age=3600', validator = null) {
  const stat = await fs.stat(file);
  const headers = { 'Content-Type': mimeType, 'Content-Length': stat.size, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' };
  if (validator) {
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    headers.ETag = etag;
    if (validator.ifNoneMatch === etag) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      return res.end();
    }
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

export async function serveStatic(res, pathname, req = null, { publicDir, appOnly = true, sendJson } = {}) {
  const desktop = Boolean(req && isDesktopRequest(req));
  const relative = staticEntryFile(pathname, { desktop, appOnly });
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) return sendJson(res, 403, { error: '禁止访问' });
  const ext = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
  const revalidate = ['.js', '.css'].includes(ext);
  const versioned = revalidate && Boolean(req?.url && new URL(req.url, 'http://localhost').searchParams.get('v'));
  const cacheControl = staticCacheControl(ext, { versioned });
  if (appOnly && (pathname === '/' || pathname === '/index.html' || frontendRoutePaths.has(pathname))) res.setHeader('Vary', 'X-GuGu-Desktop');
  try { await serveFile(res, file, mime, cacheControl, revalidate && !versioned ? { ifNoneMatch:req?.headers['if-none-match'] || '' } : null); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendJson(res, 404, { error: '静态文件不存在' }); throw error; }
}
