import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, closeDatabase } from '../lib/db.mjs';
import { isImageModelAvailable, updateModelControl } from '../lib/model-controls.mjs';
import { modelPriceFields } from '../lib/pricing.mjs';
import { buildApiModelCatalog, normalizeImageRequest } from '../lib/api-catalog.mjs';
import { SEEDREAM_DIMENSIONS, SEEDREAM_DIMENSIONS_BY_QUALITY, SEEDREAM_QUALITIES, seedreamSize } from '../lib/seedream.mjs';
import { canvasGenerationPayload, canvasGenerationOptions } from '../public/features/drama/canvas-generation.js';

process.env.TUZI_DEFAULT_API_KEY = 'test-tuzi';
const { __test } = await import('../server.mjs');
openDatabase({ file:':memory:' });
after(() => closeDatabase({ checkpoint:false }));
const config = { imageModels:[{ id:'seedream-5.0', label:'Seedream 5.0' }] };

test('Seedream catalog, canvas and API agree on parameters and two-credit pricing', async () => {
  assert.equal(isImageModelAvailable('seedream-5.0', { TUZI_DEFAULT_API_KEY:'test' }), true);
  assert.equal(isImageModelAvailable('seedream-5.0', { DUOMI_API_KEY:'test' }), false);
  const fields = modelPriceFields({ imagePerRequest:1 }).filter(row => row.modelId === 'seedream-5.0');
  assert.deepEqual(fields.map(row => [row.quality, row.amount]), [['2K',2], ['3K',2], ['4K',2]]);
  const prices = __test.publicPlatformPrices({ imagePerRequest:1, version:1 }, { models:[] });
  assert.deepEqual(prices.filter(row => row.modelId === 'seedream-5.0').map(row => [row.quality, row.credits]), [['2K',2], ['3K',2], ['4K',2]]);
  const [model] = buildApiModelCatalog({ imageModels:config.imageModels, videoModels:[], prices, imageAspectRatios:Object.keys(SEEDREAM_DIMENSIONS) });
  assert.deepEqual(model.parameters.find(param => param.name === 'quality').values, ['2k','3k','4k']);
  for (const quality of SEEDREAM_QUALITIES) for (const aspect of Object.keys(SEEDREAM_DIMENSIONS)) {
    const draft = { type:'image', modelId:'seedream-5.0', prompt:'小兔子', aspect, quality, quantity:3, attachments:[] };
    assert.deepEqual(canvasGenerationOptions(draft, config).qualities, ['2k','3k','4k']);
    const payload = canvasGenerationPayload(draft, config);
    assert.equal(payload.quality, quality);
    const dimensions = SEEDREAM_DIMENSIONS_BY_QUALITY[quality][aspect];
    assert.equal(seedreamSize(payload.size, quality), dimensions);
    const normalized = normalizeImageRequest(model, { prompt:'小兔子', size:aspect, quality:quality.toUpperCase(), n:3 });
    assert.equal(normalized.input.quality, quality);
    assert.equal(normalizeImageRequest(model, { prompt:'小兔子', size:dimensions }).input.quality, quality);
    const quote = await __test.generationRoute.submit({ user:{ id:'seedream-quote-user' }, scope:{}, input:payload, previewOnly:true });
    assert.equal(quote.status, 200, JSON.stringify(quote));
    assert.equal(quote.data.credits, 6);
    assert.equal(quote.data.costMicro, 6_000_000);
    const pixelQuote = await __test.generationRoute.submit({ user:{ id:'seedream-quote-user' }, scope:{}, input:{ ...payload, size:dimensions, quality:undefined }, previewOnly:true });
    assert.equal(pixelQuote.status, 200);
    assert.equal(pixelQuote.data.quality, quality);
  }
  assert.equal(normalizeImageRequest(model, { prompt:'test' }).input.quality, '2k');
  assert.throws(() => normalizeImageRequest(model, { prompt:'test', quality:'1k' }), /2K、3K、4K/);
  assert.throws(() => normalizeImageRequest(model, { prompt:'test', size:'invalid' }), /尺寸/);
  assert.throws(() => normalizeImageRequest(model, { prompt:'test', size:'4096x4096', quality:'2k' }), /不匹配/);
  const invalid = await __test.generationRoute.submit({ user:{ id:'quote-user' }, scope:{}, input:{ type:'image', modelId:'seedream-5.0', prompt:'test', quality:'1k' }, previewOnly:true });
  assert.equal(invalid.status, 400);
  updateModelControl('seedream-5.0', { userVisible:false });
  assert.equal(isImageModelAvailable('seedream-5.0', process.env), false);
});

test('Seedream frontend changes reach every versioned importer', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { posix } = await import('node:path');
  const expected = new Map(Object.entries({
    'app.js':639, 'components/model-logo.js':11, 'marketing.js':30, 'drama-studio.js':323,
    'features/agent/workspace.js':190, 'features/agent/model-preference-picker.js':23,
    'features/drama/director-workspace.js':214, 'features/drama/canvas-generation.js':24,
    'features/drama/canvas-generation-references.js':16, 'features/drama/canvas-ops.js':11,
    'features/drama/storyboard-drafts.js':15,
  }));
  const found = new Set();
  const observedVersions = new Map();
  async function scan(dir = '') {
    for (const item of await readdir(new URL(`../public/${dir}`, import.meta.url), { withFileTypes:true })) {
      const file = posix.join(dir, item.name);
      if (item.isDirectory()) { if (item.name !== 'vendor') await scan(`${file}/`); continue; }
      if (!/\.(js|html)$/.test(item.name)) continue;
      const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/((?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.js)\?v=(\d+)/g)) {
        const target = posix.normalize(match[1].startsWith('/') ? match[1].slice(1) : posix.join(posix.dirname(file), match[1]));
        if (!expected.has(target)) continue;
        const version = Number(match[2]);
        assert.ok(version >= expected.get(target), `${file}: stale ${match[1]}`);
        if (observedVersions.has(target)) assert.equal(version, observedVersions.get(target), `${file}: inconsistent ${match[1]}`);
        observedVersions.set(target, version);
        found.add(target);
      }
    }
  }
  await scan();
  assert.equal(found.size, expected.size);
});
