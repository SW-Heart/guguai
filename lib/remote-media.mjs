import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// Downloads media that API callers reference by URL. Every hop is resolved
// and checked before connecting, so a caller cannot make the server reach
// loopback, private networks or cloud metadata endpoints, including through
// redirects or DNS answers that change between lookup and connect.

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address) {
  // IPv4-mapped IPv6 addresses are judged by the IPv4 address they carry.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(address));
  if (mapped) return isPublicAddress(mapped[1]);
  if (/^::ffff:/i.test(String(address))) return false;
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const mediaError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, publicMessage:message });

function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all:true }, (error, addresses) => {
    if (error) return callback(mediaError('素材链接的域名无法解析'));
    const list = Array.isArray(addresses) ? addresses : [{ address:addresses, family:options.family || 4 }];
    const unsafe = list.find(item => !isPublicAddress(item.address));
    if (!list.length || unsafe) return callback(mediaError('素材链接必须是公开可访问的地址'));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function requestOnce(url, { timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      lookup:guardedLookup,
      headers:{ 'User-Agent':'GuGu-AI-API/1.0', Accept:'image/*,video/*,audio/*,*/*;q=0.5' },
      timeout:timeoutMs,
      signal,
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        return resolve({ redirect:new URL(response.headers.location, url) });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(mediaError(`素材链接无法下载（HTTP ${status}）`));
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        return reject(mediaError(`素材超过 ${Math.round(maxBytes / 1024 / 1024)} MB`, 413));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(mediaError(`素材超过 ${Math.round(maxBytes / 1024 / 1024)} MB`, 413));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ buffer:Buffer.concat(chunks), contentType:String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase() }));
      response.on('error', () => reject(mediaError('素材下载中断，请重试')));
    });
    request.on('timeout', () => request.destroy(mediaError('素材下载超时，请确认链接可以访问')));
    request.on('error', error => reject(error.publicMessage ? error : mediaError('素材链接无法访问')));
  });
}

export async function fetchRemoteMedia(value, { maxBytes, timeoutMs = 30_000, maxRedirects = 3, signal } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { throw mediaError('素材链接格式不正确'); }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw mediaError('素材链接需为 http 或 https 地址');
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw mediaError('素材链接必须是公开可访问的地址');
    const result = await requestOnce(url, { timeoutMs, maxBytes, signal });
    if (!result.redirect) return result;
    url = result.redirect;
  }
  throw mediaError('素材链接跳转次数过多');
}

export function decodeDataUrl(value, { maxBytes }) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)?(;[^,]*)?,(.*)$/is.exec(String(value));
  if (!match || !/;base64/i.test(match[2] || '')) throw mediaError('data URL 需使用 base64 编码');
  const base64 = match[3].replace(/\s+/g, '');
  if (base64.length > Math.ceil(maxBytes / 3) * 4 + 4) throw mediaError(`素材超过 ${Math.round(maxBytes / 1024 / 1024)} MB`, 413);
  return { buffer:Buffer.from(base64, 'base64'), contentType:String(match[1] || '').toLowerCase() };
}

// Media type is decided from the bytes, never from the caller's claim.
export function sniffMediaType(buffer) {
  const head = buffer.subarray(0, 16);
  const ascii = (start, end) => head.subarray(start, end).toString('latin1');
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (['M4A ', 'M4B '].includes(brand)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  return '';
}

export function mediaKind(mimeType) {
  return String(mimeType).split('/')[0];
}
