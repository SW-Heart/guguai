import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPriceNotice, priceCatalogSignature } from '../public/state/model-price-notice.js';

const price = (modelId, quality, credits) => ({ modelId, quality, credits, yuan:credits / 10, unit:'request', available:true, enabled:true });

test('price notice appears only after a previously seen price changes and clears when viewed', () => {
  const values = new Map();
  const storage = { getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value) };
  let account = 'one';
  let changed = false;
  const notice = createModelPriceNotice({ storage, accountKey:() => account, onChange:value => { changed = value; } });
  const first = [price('image', '1K', 1), price('video', '720p', 2)];
  notice.update(first);
  assert.equal(changed, false);
  notice.update([...first].reverse().map(item => ({ ...item, priceVersion:'new-version', label:'New name' })));
  assert.equal(changed, false);
  notice.update([price('image', '1K', 1.5), first[1]]);
  assert.equal(changed, true);
  notice.markViewed([price('image', '1K', 1.5), first[1]]);
  assert.equal(changed, false);
  notice.update([price('image', '1K', 1.5), first[1]]);
  assert.equal(changed, false);
  account = 'two';
  notice.update(first);
  assert.equal(changed, false);
  account = 'one';
  notice.update(first);
  assert.equal(changed, true);
});

test('price notice ignores missing catalogs and unavailable prices', () => {
  assert.equal(priceCatalogSignature(undefined), null);
  assert.equal(priceCatalogSignature([price('image', '1K', 1)]), priceCatalogSignature([price('image', '1K', 1), { ...price('video', '720p', 2), available:false }]));
});
