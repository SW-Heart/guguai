import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

// Directories (e.g. /images/) are reported as missing files instead of being
// streamed: a read stream on a directory emits EISDIR and would crash the server.
async function statFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw Object.assign(new Error('不是文件'), { code:'ENOENT' });
  return stat;
}

function pipeFile(file, res, range = undefined) {
  createReadStream(file, range).on('error', error => res.destroy(error)).pipe(res);
}

// Browsers (Safari in particular) only play <video> when byte ranges are honoured.
export function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 && size > 0 ? { start:Math.max(0, size - suffix), end:size - 1 } : { unsatisfiable:true };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : { unsatisfiable:true };
}

// /agent, /drama and /lab are older addresses; the app moves them to /create and /projects.
const frontendRoutePaths = new Set(['/assistant', '/login', '/create', '/image', '/video', '/drama', '/agent', '/projects', '/lab', '/files']);
const marketingRouteFiles = new Map([
  ['/help', 'help.html'],
  ['/help/', 'help.html'],
  ['/features', 'features.html'],
  ['/features/', 'features.html'],
  ['/pricing', 'pricing.html'],
  ['/pricing/', 'pricing.html'],
]);
const isProjectRoute = pathname => /^\/projects\/(?:drama\/)?[\w-]+\/?$/.test(pathname);

export function isDesktopRequest(req) { return String(req.headers['x-gugu-desktop'] || '') === '1'; }

export function staticCacheControl(ext, { versioned = false, production = process.env.NODE_ENV === 'production' } = {}) {
  if (['.js', '.css', '.webp', '.mp4'].includes(ext)) return production && versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  return ['.svg', '.woff', '.woff2'].includes(ext) ? 'public, max-age=604800, immutable' : 'no-cache';
}

export function staticEntryFile(pathname, { desktop = false, appOnly = true } = {}) {
  return marketingRouteFiles.get(pathname)
    || (pathname === '/guguadmin' || pathname === '/guguadmin/'
      ? 'guguadmin.html'
      : (pathname === '/' || pathname === '/index.html' || frontendRoutePaths.has(pathname) || isProjectRoute(pathname))
        ? (desktop || !appOnly ? 'index.html' : 'home.html')
        : pathname.slice(1));
}

export async function serveFile(res, file, mimeType, cacheControl = 'private, max-age=3600', validator = null) {
  const stat = await statFile(file);
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
  pipeFile(file, res);
}

const compressibleExtensions = new Set(['.js', '.css', '.html', '.svg', '.json']);
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
// Public text assets are compressed once per file version; the whole set stays a few MB in memory.
const compressedCache = new Map();

export function staticEncoding(acceptEncoding = '') {
  const accepted = String(acceptEncoding);
  if (/\bbr\b/i.test(accepted)) return 'br';
  if (/\bgzip\b/i.test(accepted)) return 'gzip';
  return '';
}

async function compressedStaticBody(file, stat, encoding) {
  const key = `${encoding}:${file}`;
  const version = `${stat.size}:${stat.mtimeMs}`;
  const cached = compressedCache.get(key);
  if (cached?.version === version) return cached.body;
  const pending = fs.readFile(file).then(source => encoding === 'br'
    ? brotli(source, { params:{ [zlibConstants.BROTLI_PARAM_QUALITY]:9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]:source.length } })
    : gzipAsync(source, { level:9 }));
  compressedCache.set(key, { version, body:pending });
  try { return await pending; }
  catch (error) { compressedCache.delete(key); throw error; }
}

export async function servePublicFile(res, file, mimeType, cacheControl, req = null) {
  const stat = await statFile(file);
  const headers = { 'Content-Type': mimeType, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' };
  const ext = path.extname(file);
  const encoding = compressibleExtensions.has(ext) && stat.size >= 1024 ? staticEncoding(req?.headers?.['accept-encoding']) : '';
  if (compressibleExtensions.has(ext)) headers.Vary = res.getHeader?.('Vary') ? `${res.getHeader('Vary')}, Accept-Encoding` : 'Accept-Encoding';
  if (!cacheControl.includes('immutable')) {
    // Validators let no-cache pages and pictures answer 304 instead of resending the whole file.
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ''}"`;
    headers.ETag = etag;
    headers['Last-Modified'] = stat.mtime.toUTCString();
    if (String(req?.headers?.['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  if (encoding) {
    const body = await compressedStaticBody(file, stat, encoding);
    res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
    return res.end(req?.method === 'HEAD' ? undefined : body);
  }
  headers['Accept-Ranges'] = 'bytes';
  const range = req?.headers?.range ? parseByteRange(req.headers.range, stat.size) : null;
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`, 'Content-Length': range.end - range.start + 1 });
    if (req?.method === 'HEAD') return res.end();
    return pipeFile(file, res, range);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req?.method === 'HEAD') return res.end();
  pipeFile(file, res);
}

export async function serveStatic(res, pathname, req = null, { publicDir, appOnly = true, sendJson } = {}) {
  const desktop = Boolean(req && isDesktopRequest(req));
  const relative = staticEntryFile(pathname, { desktop, appOnly });
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) return sendJson(res, 403, { error: '禁止访问' });
  const ext = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4' }[ext] || 'application/octet-stream';
  const versioned = ['.js', '.css', '.webp', '.mp4'].includes(ext) && Boolean(req?.url && new URL(req.url, 'http://localhost').searchParams.get('v'));
  const cacheControl = staticCacheControl(ext, { versioned });
  if (appOnly && (pathname === '/' || pathname === '/index.html' || frontendRoutePaths.has(pathname) || isProjectRoute(pathname))) res.setHeader('Vary', 'X-GuGu-Desktop');
  try { await servePublicFile(res, file, mime, cacheControl, req); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendJson(res, 404, { error: '静态文件不存在' }); throw error; }
}
