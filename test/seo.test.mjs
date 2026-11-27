import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pricingSummary, renderPricingPage, robotsTxt, sitemapXml } from '../server/seo.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = file => readFileSync(path.join(publicDir, file), 'utf8');

const payload = {
  generatedAt: '2026-11-27T04:00:00.000Z',
  items: [
    { modelId: 'minimax-h3-15s', label: 'Minimax H3', quality: '480p', duration: 4, maxDuration: 15, unit: 'second', available: true, credits: 0.5, yuan: 0.05 },
    { modelId: 'seedance-2.0-value', label: 'Seedance 2.0 特价', quality: '480p', duration: 15, unit: 'request', available: true, credits: 30, yuan: 3 },
    { modelId: 'gpt-image-2.6', label: 'GPT Image 2.6', quality: '1K', duration: null, unit: 'request', available: true, credits: 1, yuan: 0.1 },
    { modelId: 'speech-2.8-hd', kind: 'audio', label: 'MiniMax Speech 2.8 HD', quality: '标准', unit: 'ten_thousand_characters', available: true, credits: 35, yuan: 3.5 },
  ],
  models: [{ id: 'gpt-image-2.6', label: 'GPT Image 2.6', description: '图片模型' }],
};

test('every marketing page names one canonical address, a share card and a single h1', () => {
  for (const [file, loc] of [['home.html', '/'], ['features.html', '/features'], ['pricing.html', '/pricing'], ['help.html', '/help']]) {
    const html = read(file);
    assert.ok(html.includes(`<link rel="canonical" href="https://guguai.xyz${loc}">`), file);
    assert.match(html, /<meta property="og:image" content="https:\/\/guguai\.xyz\/images\/og\/gugu-ai-og\.jpg">/, file);
    assert.match(html, /<meta name="keywords" content="[^"]*Seedance/, file);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, file);
  }
});

test('robots.txt keeps app and admin addresses out of search and hides the API host', () => {
  const robots = robotsTxt('guguai.xyz');
  for (const line of ['Disallow: /api/', 'Disallow: /guguadmin', 'Disallow: /projects', 'Sitemap: https://guguai.xyz/sitemap.xml']) assert.ok(robots.includes(line), line);
  assert.equal(robotsTxt('api.guguai.xyz'), 'User-agent: *\nDisallow: /\n');
});

test('sitemap lists the four public pages', async () => {
  const xml = await sitemapXml(publicDir);
  for (const loc of ['/', '/features', '/pricing', '/help']) assert.ok(xml.includes(`<loc>https://guguai.xyz${loc}</loc>`), loc);
});

test('the pricing page is served with live model names, lowest prices and value models', () => {
  assert.equal(pricingSummary(payload), '视频低至 ¥0.05/秒，图片低至 ¥0.10/张，另有多款特价模型。');
  const html = renderPricingPage(read('pricing.html'), payload);
  assert.ok(html.includes('<h2>Minimax H3</h2>'));
  assert.ok(html.includes('<span class="price-badge">特价</span>'));
  assert.ok(html.includes('/ 万字'), 'speech is priced per 10,000 characters');
  assert.ok(!html.includes('price-loading'));
  assert.ok(html.includes('data-loaded="true"'));
  assert.match(html, /<meta name="description" content="视频低至 ¥0\.05\/秒/);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.deepEqual([jsonLd.offers.lowPrice, jsonLd.offers.highPrice, jsonLd.offers.priceCurrency], ['0.05', '3.50', 'CNY']);
});

test('without prices the pricing template is served unchanged', () => {
  const template = read('pricing.html');
  assert.equal(renderPricingPage(template, { items: [], models: [] }), template);
});
