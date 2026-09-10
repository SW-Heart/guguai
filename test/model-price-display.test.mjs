import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase } from '../lib/db.mjs';
import { ensureDefaultModelRoutes } from '../lib/model-routes.mjs';

process.env.DIW_KEY = 'test-diw-key';
process.env.WJ_TJWD_KEY = 'test-wj-key';
process.env.WJ_SD_PY_900_KEY = 'test-wj-py-key';
process.env.CNTCN_KEY = 'test-cntcn-key';
const { __test } = await import('../server.mjs');
openDatabase({ file: ':memory:' });
ensureDefaultModelRoutes();
after(() => closeDatabase({ checkpoint:false }));

const app = await (await import('node:fs/promises')).readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('video price catalog formats per-second credits to one decimal place', () => {
  const start = app.indexOf('function priceCreditsText(');
  const end = app.indexOf('\nfunction modelPriceCard(', start);
  const formatter = new Function('creditText', 'priceUnitLabel', `${app.slice(start, end)}\nreturn priceCreditsText;`)(() => 'fallback', unit => unit);
  assert.equal(formatter(1.3333, 'second'), '1.3 积分 / second');
  assert.equal(formatter(18, 'request'), 'fallback 积分 / request');
});

test('Seedance price catalog displays normalized per-second amounts', () => {
  const catalog = __test.publicPlatformPrices({ imagePerRequest: 1, videoPerSecond: 1, version: 1 }, {
    models: [
      { id: 'minimax-h3-15s', label: 'GuGu 2.0', modes: [{ generationType: 'TEXT', qualityOptions: ['768p'], pricing: { amount: 1, unit: 'second' } }] },
      { id: 'grok', label: 'GuGu 1.5', modes: [{ generationType: 'TEXT', qualityOptions: ['720p'], pricing: { amount: 1.5, unit: 'second' } }] },
      { id: 'seedance-2.0', label: 'Seedance 2.0' },
      { id: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast' },
      { id: 'seedance-2.5', label: 'Seedance 2.5' },
    ],
  });
  const seedance20 = catalog.find(item => item.modelId === 'seedance-2.0' && item.quality === '480p');
  const seedance20Fast = catalog.find(item => item.modelId === 'seedance-2.0-fast' && item.quality === '720p');
  const seedance25 = catalog.find(item => item.modelId === 'seedance-2.5' && item.quality === '480p');
  assert.equal(seedance20.unit, 'second');
  assert.equal(seedance20.duration, 15);
  assert.equal(seedance20.yuan, seedance20.totalYuan / 15);
  assert.equal(seedance25.unit, 'second');
  assert.equal(seedance25.duration, 30);
  assert.equal(seedance25.yuan, seedance25.totalYuan / 30);
  assert.equal(seedance20Fast.duration, 15);
  assert.equal(seedance20Fast.totalYuan, 1.8);
  assert.equal(seedance20Fast.totalCredits, 18);
  assert.ok(Math.abs(seedance20Fast.yuan - 0.12) < 1e-9);
  assert.deepEqual(catalog.slice(0, 4).map(item => item.label), ['GuGu 2.0', 'GuGu 1.5', 'Seedance 2.0', 'Seedance 2.0']);
  assert.ok(catalog.some(item => item.label === 'Seedance 2.0 Fast'));
  assert.equal(Object.hasOwn(seedance20Fast, 'selectedRouteId'), false);
  assert.equal(Object.hasOwn(seedance20Fast, 'selectedRouteName'), false);
  assert.match(seedance20Fast.priceVersion, /^v1-[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(catalog), /sd20-|upstream|credential|WJ|DIW/);
});

test('GPT Image 2.5 price catalog exposes 1K, 2K and 4K request prices', () => {
  const catalog = __test.publicPlatformPrices({ imagePerRequest:1, videoPerSecond:1, version:1 }, { models:[] });
  const prices = catalog.filter(item => item.modelId === 'gpt-image-2.5').map(item => [item.quality, item.credits]);
  assert.deepEqual(prices, [['1K', 1], ['2K', 2], ['4K', 4]]);
});

test('Midjourney price catalog charges four credits per composite request', () => {
  const catalog = __test.publicPlatformPrices({ imagePerRequest:1, videoPerSecond:1, version:1 }, { models:[] });
  const price = catalog.find(item => item.modelId === 'midjourney');
  assert.equal(price.quality, '标准');
  assert.equal(price.credits, 4);
  assert.equal(price.yuan, 0.4);
  assert.equal(price.unit, 'request');
});
