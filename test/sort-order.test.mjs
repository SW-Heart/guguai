import test from 'node:test';
import assert from 'node:assert/strict';

import { planSortOrderShift } from '../lib/sort-order.mjs';

// Applies a plan to the full list (target included) and returns ids in order.
function apply(list, targetId, to, from) {
  const siblings = list.filter(item => item.id !== targetId);
  const changes = planSortOrderShift(siblings, { from, to, max: 1000 });
  const next = new Map(list.map(item => [item.id, item.order]));
  for (const change of changes) next.set(change.id, change.to);
  next.set(targetId, to);
  return { changes, orders: Object.fromEntries(next) };
}

const oneToSix = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({ id, order: index + 1 }));

test('moving #5 to #1 pushes 1–4 down and leaves 6 alone', () => {
  const { orders } = apply(oneToSix, 'e', 1, 5);
  assert.deepEqual(orders, { a: 2, b: 3, c: 4, d: 5, e: 1, f: 6 });
});

test('inserting a new item at #1 pushes every occupied slot down', () => {
  const { orders } = apply([...oneToSix, { id: 'new', order: 1 }], 'new', 1, null);
  assert.deepEqual(orders, { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7, new: 1 });
});

test('moving #2 to #5 closes its old slot so it lands exactly on 5', () => {
  const { orders } = apply(oneToSix, 'b', 5, 2);
  assert.deepEqual(orders, { a: 1, b: 5, c: 2, d: 3, e: 4, f: 6 });
});

test('pushes stop at the first gap and leave untouched history alone', () => {
  const list = [{ id: 'a', order: 10 }, { id: 'b', order: 11 }, { id: 'c', order: 20 }, { id: 'd', order: 30 }];
  const { changes } = apply([...list, { id: 'new', order: 10 }], 'new', 10, null);
  assert.deepEqual(changes, [{ id: 'a', from: 10, to: 11 }, { id: 'b', from: 11, to: 12 }]);
  assert.deepEqual(apply(list, 'd', 25, 30).changes, []);
});

test('duplicates in the pushed chain are separated', () => {
  const list = [{ id: 'x', order: 5 }, { id: 'y', order: 5 }, { id: 'z', order: 6 }];
  assert.deepEqual(planSortOrderShift(list, { from: null, to: 5, max: 100 }), [
    { id: 'x', from: 5, to: 6 }, { id: 'y', from: 5, to: 7 }, { id: 'z', from: 6, to: 8 },
  ]);
});

test('result is always unique for every move inside a compact list', () => {
  for (const target of oneToSix) for (let to = 1; to <= 6; to++) {
    const { orders } = apply(oneToSix, target.id, to, target.order);
    assert.equal(new Set(Object.values(orders)).size, 6, `${target.id} -> ${to}`);
  }
});

test('refuses shifts beyond the allowed maximum', () => {
  assert.throws(() => planSortOrderShift([{ id: 'a', order: 10 }], { from: null, to: 10, max: 10 }), { statusCode: 400 });
});
