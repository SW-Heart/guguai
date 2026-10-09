import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, sql } from '../lib/db.mjs';
import { ensureDefaultModelRoutes } from '../lib/model-routes.mjs';
import { publicVideoCapabilities, validateVideoRequest } from '../lib/video-capabilities.mjs';
import { modelPriceFields, pricingSnapshot } from '../lib/pricing.mjs';
import { creditsToMicro } from '../lib/billing.mjs';
import vm from 'node:vm';

process.env.DUOMI_API_KEY = 'test-duomi';
process.env.TUZI_DEFAULT_API_KEY = 'test-tuzi';
process.env.DIW_KEY = 'test-diw-key';
process.env.WJ_TJWD_KEY = 'test-wj-key';
process.env.WJ_SD_PY_900_KEY = 'test-wj-py-key';
process.env.CNTCN_KEY = 'test-cntcn-key';
const { __test } = await import('../server.mjs');
openDatabase({ file: ':memory:' });
ensureDefaultModelRoutes();
sql("UPDATE model_routes SET catalog_status='available'").run();
after(() => closeDatabase({ checkpoint:false }));

const app = await (await import('node:fs/promises')).readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('Minimax H3 catalog, admin defaults and billing snapshots use resolution prices', () => {
  const pricing = { imagePerRequest:1, videoPerSecond:1, version:1 };
  const catalog = __test.publicPlatformPrices(pricing, publicVideoCapabilities());
  const fields = modelPriceFields(pricing);
  for (const [quality, credits, yuan] of [['480p', 0.5, 0.05], ['768p', 0.6, 0.06]]) {
    const item = catalog.find(item => item.modelId === 'minimax-h3-15s' && item.quality === quality);
    assert.equal(item.credits, credits);
    assert.ok(Math.abs(item.yuan - yuan) < 1e-9);
    assert.equal(item.unit, 'second');
    assert.equal(fields.find(item => item.key === `minimax-h3-15s:${quality}`).amount, credits);
    const request = validateVideoRequest({ modelId:'minimax-h3-15s', quality, duration:5 });
    const snapshot = pricingSnapshot({ ...pricing, videoPerSecondMicro:creditsToMicro(request.pricing.amount) }, 'video', request.duration);
    assert.equal(snapshot.totalMicro, quality === '480p' ? 2_500_000 : 3_000_000);
  }
});

test('Minimax H3 fallback estimates follow the selected resolution', () => {
  const context = vm.createContext({ state:{ config:{videoCapabilities:publicVideoCapabilities()} } });
  vm.runInContext(app.slice(app.indexOf('const fallbackVideoModels ='), app.indexOf('const modelIconUrls =')), context);
  vm.runInContext(app.slice(app.indexOf('function videoPricingFor('), app.indexOf('let videoQuoteTimer =')), context);
  for (const generationType of ['TEXT', 'REFERENCE']) {
    const parameters = context.videoModelParameters('minimax-h3-15s', generationType);
    for (const [quality, credits] of [['480p', 0.5], ['768p', 0.6]]) {
      assert.equal(context.videoPricingFor('minimax-h3-15s', parameters, quality).amount * 5, credits * 5);
    }
  }
  assert.equal(context.videoModelPromo('minimax-h3-15s'), '限时特惠 ¥0.05/s 起');
  const parameters = context.videoModelParameters('minimax-h3-15s', 'TEXT');
  context.state.config.modelPrices = [{ modelId:'minimax-h3-15s', quality:'768p', credits:0.8, unit:'second' }];
  assert.equal(context.videoPricingFor('minimax-h3-15s', parameters, '768p').amount * 5, 4);
  context.state.config.modelPrices[0].credits = 0.6;
  assert.equal(context.videoPricingFor('minimax-h3-15s', parameters, '768p').amount * 5, 3);
});

test('Minimax price changes refresh both versioned frontend entries', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const drama = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
  assert.match(html, /src="\/app\.js\?v=504"/);
  assert.match(app, /import\('\.\/drama-studio\.js\?v=239'\)/);
  assert.doesNotMatch(html, /app\.js\?v=462\b/);
  assert.doesNotMatch(app, /drama-studio\.js\?v=205\b/);
  assert.match(drama, /限时特惠 ¥0\.05\/s 起/);
});

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
  assert.ok(Math.abs(seedance20.yuan - seedance20.totalYuan / 15) < 1e-9);
  assert.equal(seedance25.unit, 'second');
  assert.equal(seedance25.duration, 30);
  assert.ok(Math.abs(seedance25.yuan - seedance25.totalYuan / 30) < 1e-9);
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

test('configured image and video prices override defaults including zero', () => {
  const catalog = __test.publicPlatformPrices({ imagePerRequest:1, videoPerSecond:1, version:2, modelPrices:{ 'gpt-image-2.5:2k':0, 'midjourney:标准':2.5, 'grok:720p':3.25 } }, { models:[{ id:'grok', label:'Grok', modes:[{ generationType:'TEXT', qualityOptions:['720p'], pricing:{ amount:1.5, unit:'second' } }] }] });
  assert.equal(catalog.find(item => item.modelId === 'gpt-image-2.5' && item.quality === '2K').credits, 0);
  assert.equal(catalog.find(item => item.modelId === 'midjourney').credits, 2.5);
  assert.equal(catalog.find(item => item.modelId === 'grok').credits, 3.25);
});
