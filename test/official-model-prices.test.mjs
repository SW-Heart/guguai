import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { officialPriceDiscount } from '../public/state/official-model-prices.js';

const row = (quality, yuan, unit = 'second') => ({ quality, yuan, unit, credits:yuan * 10, label:'Seedance' });
test('discounts compare the selected resolution and map special offers to the same model', () => {
  assert.equal(officialPriceDiscount('seedance-2.0', row('480p', 0.40)).label, '8.7折');
  assert.equal(officialPriceDiscount('seedance-2.5', row('480p', 0.55)).label, '8.3折');
  assert.equal(officialPriceDiscount('seedance-2.5-value', row('720P', 0.18)).label, '1.2折');
  assert.equal(officialPriceDiscount('seedance-2.0-value', row('720p', 0.15)).label, '1.6折');
  assert.equal(officialPriceDiscount('seedance-2.0-fast', row('720p', 0.15)).label, '1.9折');
  assert.equal(officialPriceDiscount('seedance-2.0-mini', row('480p', 0)).label, '0折');
});

test('whole-number discounts omit decimal zero and explain the savings on hover', () => {
  const discount = officialPriceDiscount('seedance-2.0-mini', row('720p', 0.3));
  assert.equal(discount.label, '6折');
  assert.match(discount.detail, /^比官方价格低40%。/);
});

test('user-supplied references support H3 resolutions and per-request image prices', () => {
  assert.equal(officialPriceDiscount('minimax-h3-15s', row('480P', 0.05)).label, '1.6折');
  assert.equal(officialPriceDiscount('minimax-h3-15s', row('768p', 0.06)).label, '1.2折');
  assert.equal(officialPriceDiscount('minimax-h3', row('2K', 0.01)), null);
  const gpt2 = officialPriceDiscount('gpt-image-2', row('标准', 0.1, 'request'));
  assert.equal(gpt2.label, '2.9折');
  assert.match(gpt2.detail, /^比官方价格低71%。/);
  assert.equal(officialPriceDiscount('gpt-image-2.5', row('1K', 0.1, 'request')).label, '3.5折');
  assert.equal(officialPriceDiscount('gpt-image-2.5', row('2K', 0.2, 'request')).label, '6.9折');
  assert.equal(officialPriceDiscount('gpt-image-2.5', row('4K', 0.4, 'request')), null);
  assert.equal(officialPriceDiscount('midjourney', row('标准', 0.4, 'request')), null);
  assert.equal(officialPriceDiscount('midjourney', row('标准', 0.16, 'request')).label, '5折');
  assert.equal(officialPriceDiscount('minimax-h3-15s', row('480p', 0.05, 'request')), null);
});

test('unknown, incomparable, invalid and non-discounted prices have no badge', () => {
  for (const model of ['gpt-image-2.5', 'gpt-image-2', 'midjourney', 'unknown']) {
    assert.equal(officialPriceDiscount(model, row('480p', 0.01)), null);
  }
  for (const item of [row('4K', 0.01), row('480p', 0.1, 'request'), row('480p', 0.46), row('480p', 0.8), row('480p', -1), row('480p', NaN), row('480p', Infinity), row('480p', null), row('480p', 0.459)]) {
    assert.equal(officialPriceDiscount('seedance-2.0', item), null);
  }
});

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
test('cards initialize on the cheapest tier and carry independent discount values for each tier', () => {
  const context = vm.createContext({ officialPriceDiscount, esc:String, creditText:String, modelIcon:() => '' });
  vm.runInContext(app.slice(app.indexOf('const priceUnitLabels ='), app.indexOf('function renderModelPrices(')), context);
  const html = context.modelPriceCard('seedance-2.0', [row('720p', 0.5), row('480p', 0.4)], 'video');
  assert.match(html, /class="price-model-discount"[^>]*>8.7折/);
  assert.match(html, /data-discount="5.1折"/);
  assert.match(html, /title="比官方价格低13%。按官方 16:9、无参考视频/);
  assert.match(html, /<header class="price-model-card-head">.*class="price-model-discount".*<\/header>/);
  assert.match(context.modelPriceCard('midjourney', [row('标准', 0.4, 'request')], 'image'), /class="price-model-discount" hidden/);
});

test('tier clicks update and hide the badge along with the displayed price', () => {
  let onClick;
  const badge = { setAttribute(name, value) { this[name] = value; } };
  const amount = {};
  const card = {
    querySelectorAll:() => [],
    querySelector:selector => ({ '.price-model-discount':badge, '.price-model-amount':amount })[selector],
  };
  const tier = { closest:() => card, classList:{ contains:() => false }, dataset:{ amount:'0.50', discount:'5.1折', discountDetail:'参考价说明' } };
  const context = vm.createContext({ $:() => ({ addEventListener(_, fn) { onClick = fn; } }) });
  vm.runInContext(app.slice(app.indexOf("$('#modelPriceBody')?.addEventListener('click'"), app.indexOf("$('#modelPriceButton').onclick")), context);
  onClick({ target:{ closest:() => tier } });
  assert.equal(badge.textContent, '5.1折');
  assert.equal(badge.title, '参考价说明');
  assert.equal(badge.hidden, false);
  assert.equal(amount.textContent, '0.50');
  tier.dataset.discount = '';
  tier.dataset.discountDetail = '';
  onClick({ target:{ closest:() => tier } });
  assert.equal(badge.hidden, true);
  assert.equal(badge.title, '');
});

test('discount feature refreshes the script and style entry cache keys', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\/app\.js\?v=508/);
  assert.match(html, /\/styles\.css\?v=373/);
  assert.match(app, /official-model-prices\.js\?v=3/);
});
