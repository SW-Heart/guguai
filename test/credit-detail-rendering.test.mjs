import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCreditPresentation } from '../public/features/credits/presentation.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture() {
  const state = { creditWallet:{ balance:100 }, creditDetailTab:'spend', creditTransactionsLoaded:true,
    tasks:[{ id:'task', status:'running' }],
    creditTransactions:Array.from({ length:1000 }, (_, i) => ({ id:String(i), amount:-1, generationId:'task', createdAt:`record-${i}` })) };
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      open:true, html:'', writes:0, scrollTop:0,
      classList:{ toggle() {} }, setAttribute() {}, closest() { return this; },
      get innerHTML() { return this.html; },
      set innerHTML(value) { this.html = value; this.writes++; },
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({ state, $, ...createCreditPresentation({ getState:() => state }) });
  vm.runInContext(app.slice(app.indexOf('let creditDetailPage ='), app.indexOf('function selectedWechatAmount()')), context);
  const render = () => context.renderCreditDetail();
  const page = value => { vm.runInContext(`creditDetailPage = ${value}`, context); render(); };
  return { state, $, render, page };
}

test('credit detail bounds rendered rows and preserves every record across pages', () => {
  const { $, render, page } = fixture();
  render();
  const body = $('#creditSpendBody');
  assert.equal((body.innerHTML.match(/<tr>/g) || []).length, 50);
  assert.match(body.innerHTML, /record-0"/);
  assert.match(body.innerHTML, /record-49"/);
  assert.doesNotMatch(body.innerHTML, /record-50"/);
  assert.equal($('#creditDetailPrevious').disabled, true);
  assert.equal($('#creditDetailNext').disabled, false);
  page(20);
  assert.match(body.innerHTML, /record-950"/);
  assert.match(body.innerHTML, /record-999"/);
  assert.equal($('#creditDetailNext').disabled, true);
  page(21);
  assert.match($('#creditDetailPageInfo').textContent, /第 20 \/ 20 页/);
});

test('unchanged and closed credit detail avoids table writes but status changes still render', () => {
  const { $, state, render } = fixture();
  render();
  const body = $('#creditSpendBody');
  body.scrollTop = 120;
  render();
  assert.equal(body.writes, 1);
  assert.equal(body.scrollTop, 120);
  state.tasks[0].status = 'completed';
  render();
  assert.equal(body.writes, 2);
  assert.match(body.innerHTML, /已完成/);
  assert.equal(body.scrollTop, 0);
  $('#creditDetailDialog').open = false;
  state.creditTransactions = [];
  render();
  assert.equal(body.writes, 2);
  $('#creditDetailDialog').open = true;
  render();
  assert.match(body.innerHTML, /暂无积分消耗记录/);
});

test('tab changes release hidden rows and loading hides pagination', () => {
  const { $, state, render, page } = fixture();
  page(20);
  state.creditTransactions.push({ amount:5 });
  state.creditDetailTab = 'earn';
  render();
  assert.equal($('#creditSpendBody').innerHTML, '');
  assert.match($('#creditEarnBody').innerHTML, /\+5/);
  assert.match($('#creditDetailPageInfo').textContent, /第 1 \/ 1 页/);
  assert.equal($('#creditDetailNext').disabled, true);
  state.creditTransactionsLoaded = false;
  render();
  assert.equal($('#creditDetailPagination').hidden, true);
  assert.match($('#creditEarnBody').innerHTML, /正在加载记录/);
});

test('credit detail ships fresh entry versions and avoids full window backdrop blur', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /\/app\.js\?v=585"/);
  assert.match(html, /\/styles\.css\?v=418"/);
  assert.match(css, /\.credit-detail-dialog::backdrop\s*\{[^}]*backdrop-filter: none/);
  for (const id of ['creditDetailPagination', 'creditDetailPrevious', 'creditDetailNext', 'creditDetailPageInfo']) {
    assert.ok(html.includes(`id="${id}"`));
  }
});
