import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { escapeHtml, formatDateTime, formatNumber, priceHighlights, renderPriceCatalog } from '../public/price-catalog.js?v=1';
import { staticEncoding } from './static.mjs';

export const SITE_ORIGIN = 'https://guguai.xyz';
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// The API host serves the same pages and must not be indexed as a copy of the site.
export function robotsTxt(host = '') {
  if (/^api\./i.test(String(host))) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /guguadmin',
    'Disallow: /assistant',
    'Disallow: /login',
    'Disallow: /create',
    'Disallow: /image',
    'Disallow: /video',
    'Disallow: /drama',
    'Disallow: /agent',
    'Disallow: /projects',
    'Disallow: /lab',
    'Disallow: /files',
    'Disallow: /downloads/',
    '',
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

export async function sitemapXml(publicDir) {
  const pages = [['/', 'home.html', '1.0'], ['/features', 'features.html', '0.8'], ['/pricing', 'pricing.html', '0.9'], ['/help', 'help.html', '0.8']];
  const entries = await Promise.all(pages.map(async ([loc, file, priority]) => {
    const stat = await fs.stat(path.join(publicDir, file)).catch(() => null);
    // Prices change daily, so the pricing page is always reported as fresh.
    const lastmod = (loc === '/pricing' || !stat ? new Date() : stat.mtime).toISOString().slice(0, 10);
    return `  <url><loc>${SITE_ORIGIN}${loc === '/' ? '/' : loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${loc === '/pricing' ? 'daily' : 'weekly'}</changefreq><priority>${priority}</priority></url>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

const between = (html, name, content) => html.replace(new RegExp(`(<!--${name}_START-->)[\\s\\S]*?(<!--${name}_END-->)`), (_, start, end) => `${start}${content}${end}`);

export function pricingSummary(payload) {
  const { video, image, hasValueModels } = priceHighlights(payload);
  const parts = [];
  if (Number.isFinite(video)) parts.push(`视频低至 ¥${formatNumber(video)}/秒`);
  if (Number.isFinite(image)) parts.push(`图片低至 ¥${formatNumber(image)}/张`);
  return parts.length ? `${parts.join('，')}${hasValueModels ? '，另有多款特价模型' : ''}。` : '';
}

export function renderPricingPage(template, payload) {
  const cards = renderPriceCatalog(payload);
  if (!cards) return template;
  const highlights = priceHighlights(payload);
  const summary = pricingSummary(payload);
  const modelNames = [...highlights.videoNames.slice(0, 4), ...highlights.imageNames.slice(0, 3)].join('、');
  const description = `${summary}${modelNames ? `${modelNames} 等模型实时价格，` : ''}按量计费，无需订阅，生成失败退回积分。`;
  const prices = highlights.yuanValues.filter(Number.isFinite);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'GuGu AI',
    url: SITE_ORIGIN,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Windows, macOS',
    description,
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'CNY',
      lowPrice: Math.min(...prices).toFixed(2),
      highPrice: Math.max(...prices).toFixed(2),
      offerCount: prices.length,
      url: `${SITE_ORIGIN}/pricing`,
    },
  };
  let html = template.replace(/(<meta (?:name="description"|property="og:description") content=")[^"]*(")/g, (_, start, end) => `${start}${escapeHtml(description)}${end}`);
  html = html.replace('<!--SEO_JSONLD-->', `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`);
  html = html.replace('<!--PRICE_SUMMARY-->', escapeHtml(summary));
  html = between(html, 'PRICE_STATUS', '实时价格已更新');
  html = between(html, 'PRICE_UPDATED', `更新时间：${escapeHtml(formatDateTime(payload.generatedAt, 'Asia/Shanghai'))}`);
  html = between(html, 'PRICE_CATALOG', cards);
  // The browser keeps these cards if its own refresh fails.
  return html.replace('<body data-page="pricing" data-price-page>', '<body data-page="pricing" data-price-page data-loaded="true">');
}

export async function sendText(res, req, body, contentType) {
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
  const encoding = Buffer.byteLength(body) >= 1024 ? staticEncoding(req?.headers?.['accept-encoding']) : '';
  const payload = encoding === 'br'
    ? await brotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    : encoding === 'gzip' ? await gzipAsync(body) : Buffer.from(body);
  res.writeHead(200, { ...headers, ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Content-Length': payload.length });
  res.end(req?.method === 'HEAD' ? undefined : payload);
}

// Serves robots.txt, sitemap.xml and the price page with live prices. Returns false for other paths.
export async function serveSeoRoute(res, req, pathname, { publicDir, priceState }) {
  if (pathname === '/robots.txt') { await sendText(res, req, robotsTxt(req?.headers?.host), 'text/plain; charset=utf-8'); return true; }
  if (pathname === '/sitemap.xml') { await sendText(res, req, await sitemapXml(publicDir), 'application/xml; charset=utf-8'); return true; }
  if (pathname === '/pricing' || pathname === '/pricing/') {
    const template = await fs.readFile(path.join(publicDir, 'pricing.html'), 'utf8');
    let html = template;
    try { html = renderPricingPage(template, priceState()); }
    catch (error) { console.warn('[seo] pricing page rendered without prices', error?.message || error); }
    await sendText(res, req, html, 'text/html; charset=utf-8');
    return true;
  }
  return false;
}
