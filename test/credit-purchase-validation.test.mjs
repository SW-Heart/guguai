import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      textContent:'', disabled:false, attributes:{},
      classList:{ toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key]; },
      focus() { this.focused = true; },
    });
    return nodes.get(selector);
  };
  const presets = ['1', '500'].map(amount => ({
    dataset:{ wechatAmount:amount }, attributes:{},
    classList:{ toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
  }));
  const state = { purchaseProvider:'wechat', wechatCustomAmount:'', wechatTopupAmount:'500', alipayTopupCredits:10, credits:20 };
  let requests = 0;
  const context = vm.createContext({
    state, $, $$:selector => selector === '[data-wechat-amount]' ? presets : [],
    creditText:String, accountScope:{ snapshot:() => ({}) },
    api:() => { requests++; throw new Error('Unexpected payment request'); },
  });
  vm.runInContext(app.slice(app.indexOf('function selectedWechatAmount()'), app.indexOf('function setAlipayStatus(')), context);
  vm.runInContext(app.slice(app.indexOf('async function startAlipayTopup()'), app.indexOf('function setCreditDetailTab(')), context);
  return { $, presets, state, context, requests:() => requests, render:() => context.renderCreditPurchase() };
}

test('invalid custom amounts show actionable inline errors and cannot create orders', async () => {
  const { $, state, context, render, requests } = fixture();
  for (const [amount, message] of [
    ['10001', '金额不能超过 10,000 元'],
    ['60000', '金额不能超过 10,000 元'],
    ['100000', '金额不能超过 10,000 元'],
    ['0', '金额不能低于 1 元'],
    ['-1', '金额不能低于 1 元'],
    ['1.5', '请输入整数金额，不支持小数'],
    ['oops', '请输入 1–10,000 元的整数金额'],
  ]) {
    state.wechatCustomAmount = amount;
    render();
    assert.equal($('#wechatCustomAmountError').textContent, message);
    assert.equal($('#wechatCustomAmount').getAttribute('aria-invalid'), 'true');
    assert.equal($('#alipayTopupButton').disabled, true);
    assert.equal($('#alipayTopupAmount').textContent, '—');
    assert.equal($('#alipayTopupMeta').textContent, '1 元 = 10 积分');
    await context.startAlipayTopup();
    assert.equal($('#wechatCustomAmount').focused, true);
  }
  assert.equal(requests(), 0);
});

test('correcting or clearing custom amounts restores checkout and preserves busy state', () => {
  const { $, presets, state, render } = fixture();
  state.wechatCustomAmount = '60000';
  render();
  for (const amount of ['1', '10000', ' 23 ', '']) {
    state.wechatCustomAmount = amount;
    render();
    assert.equal($('#wechatCustomAmountError').textContent, '');
    assert.equal($('#wechatCustomAmount').getAttribute('aria-invalid'), 'false');
    assert.equal($('#alipayTopupButton').disabled, false);
    assert.equal($('#alipayTopupAmount').textContent, `¥${Number(amount.trim() || '500').toFixed(2)}`);
    assert.equal(presets[1].attributes['aria-checked'], String(!amount.trim()));
    assert.equal(presets[1].tabIndex, 0);
  }
  $('#alipayTopupButton').setAttribute('aria-busy', 'true');
  render();
  assert.equal($('#alipayTopupButton').disabled, true);
  $('#alipayTopupButton').setAttribute('aria-busy', 'false');
  state.wechatCustomAmount = '60000';
  state.purchaseProvider = 'alipay';
  render();
  assert.equal($('#wechatCustomAmountError').textContent, '');
  assert.equal($('#alipayTopupButton').disabled, false);
});

test('purchase validation ships accessible feedback and fresh script and style entries', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /aria-describedby="wechatAmountHint wechatCustomAmountError"/);
  assert.match(html, /id="wechatCustomAmountError"[^>]*aria-live="polite"/);
  assert.match(html, /\/app\.js\?v=636"/);
  assert.match(html, /\/payment\.css\?v=7"/);
  const customInput = html.match(/<input id="wechatCustomAmount"[^>]*>/)[0];
  assert.doesNotMatch(customInput, /maxlength=/);
});
