import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DIW_KEY = 'test-diw-key';
process.env.WJ_TJWD_KEY = 'test-wj-key';
process.env.WJ_SD_PY_900_KEY = 'test-wj-py-key';
process.env.CNTCN_KEY = 'test-cntcn-key';
const { __test } = await import('../server.mjs');

test('Seedance price catalog displays normalized per-second amounts', () => {
  const catalog = __test.publicPlatformPrices({ imagePerRequest: 1, videoPerSecond: 1, version: 1 }, {
    models: [
      { id: 'minimax-h3-15s', label: 'GuGu 2.0', modes: [{ generationType: 'TEXT', qualityOptions: ['768p'], pricing: { amount: 1, unit: 'second' } }] },
      { id: 'grok', label: 'GuGu 1.5', modes: [{ generationType: 'TEXT', qualityOptions: ['720p'], pricing: { amount: 1.5, unit: 'second' } }] },
      { id: 'seedance-2.0', label: 'Seedance 2.0' },
      { id: 'seedance-2.5', label: 'Seedance 2.5' },
    ],
  });
  const seedance20 = catalog.find(item => item.modelId === 'seedance-2.0' && item.quality === '480p');
  const seedance25 = catalog.find(item => item.modelId === 'seedance-2.5' && item.quality === '480p');
  assert.equal(seedance20.unit, 'second');
  assert.equal(seedance20.duration, 15);
  assert.equal(seedance20.yuan, seedance20.totalYuan / 15);
  assert.equal(seedance25.unit, 'second');
  assert.equal(seedance25.duration, 30);
  assert.equal(seedance25.yuan, seedance25.totalYuan / 30);
  assert.deepEqual(catalog.slice(0, 4).map(item => item.label), ['GuGu 2.0', 'GuGu 1.5', 'Seedance 2.0', 'Seedance 2.0']);
});
