import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function fetchOrders() {');
const end = source.indexOf('  /* ---------- 提示词检查 ---------- */', start);
const labelsStart = source.indexOf('  const statusLabels =');
const labelsEnd = source.indexOf('  const pill =', labelsStart);
assert.ok(start >= 0 && end > start && labelsStart >= 0 && labelsEnd > labelsStart);

test('paid order table shows both payment methods and readable refund states', async () => {
  const table = { innerHTML: '' };
  const items = [
    { orderNo: 'WX-1', provider: 'wechat', tradeNo: 'WX-TRANSACTION', status: 'REFUNDING' },
    { orderNo: 'ALI-1', provider: 'alipay', tradeNo: 'ALI-TRANSACTION', status: 'PAID' },
  ].map(item => ({ ...item, username: '用户', userId: 'user-1', amount: 1, credits: 10, paidAt: '2026-10-09T00:00:00.000Z' }));
  await runInNewContext(`${source.slice(labelsStart, labelsEnd)}\n${source.slice(start, end)}\nfetchOrders();`, {
    URLSearchParams,
    $: () => table,
    state: { filters: { orders: {} } },
    nextRequest: () => 1,
    currentCursor: () => '',
    markLoading() {},
    isStale: () => false,
    api: async () => ({ items, total: 2, summary: {} }),
    esc: String,
    money: String,
    yuan: String,
    date: String,
    idText: String,
    pageControls: () => '',
    doneLoading() {},
    bindPageControls() {},
    errorMarkup: message => { assert.fail(message); },
  });
  assert.match(table.innerHTML, /<th>支付方式<\/th><th>交易号<\/th>/);
  assert.match(table.innerHTML, /<td>微信支付<\/td>/);
  assert.match(table.innerHTML, /<td>支付宝<\/td>/);
  assert.match(table.innerHTML, /WX-TRANSACTION/);
  assert.match(table.innerHTML, /ALI-TRANSACTION/);
  assert.match(table.innerHTML, /退款中/);
  assert.doesNotMatch(table.innerHTML, /支付宝交易号|REFUNDING/);
});
