import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createCreditRedemptionController } from '../public/features/credits/redemption.js';
import { createCreditPresentation } from '../public/features/credits/presentation.js';

function fixture(api = async () => ({ credits:12.5, balance:20 })) {
  const nodes = new Map();
  const find = id => {
    if (!nodes.has(id)) nodes.set(id, { value:'', dataset:{}, attributes:{},
      setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; }, focus() { this.focused = true; } });
    return nodes.get(id);
  };
  let current = true;
  const redeemed = [];
  const controller = createCreditRedemptionController({ root:{ querySelector:selector => find(selector.slice(1)) }, api,
    accountScope:{ snapshot:() => ({}), isCurrent:() => current }, onRedeemed:result => redeemed.push(result) });
  controller.reset();
  const submit = () => find('creditRedeemForm').onsubmit({ preventDefault() {} });
  const enter = value => { find('creditRedeemCode').value = value; find('creditRedeemCode').oninput(); };
  return { find, controller, redeemed, submit, enter, expire:() => { current = false; } };
}

test('tabs support keyboard selection and only display the matching panel', () => {
  const { find } = fixture();
  find('creditBuyTab').onkeydown({ key:'ArrowRight', preventDefault() {} });
  assert.equal(find('creditBuyPanel').hidden, true);
  assert.equal(find('creditRedeemPanel').hidden, false);
  assert.equal(find('creditRedeemTab').attributes['aria-selected'], 'true');
  assert.equal(find('creditRedeemTab').focused, true);
});

test('client normalizes codes, updates balance and shows success once', async () => {
  const requests = [];
  let complete;
  const { find, enter, submit, redeemed } = fixture((url, options) => { requests.push({ url, code:JSON.parse(options.body).code }); return new Promise(resolve => { complete = resolve; }); });
  enter(' gugu-test-code ');
  const first = submit();
  await submit();
  assert.equal(find('creditRedeemSubmit').disabled, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].code, 'GUGU-TEST-CODE');
  complete({ credits:12.5, balance:20 });
  await first;
  assert.equal(redeemed.length, 1);
  assert.equal(find('creditRedeemFeedback').dataset.tone, 'success');
  assert.match(find('creditRedeemFeedback').textContent, /12.5/);
  assert.equal(find('creditRedeemCode').value, '');
  assert.equal(find('creditRedeemSubmit').disabled, true);
});

test('invalid codes and API errors produce inline feedback and allow correction', async () => {
  const { find, enter, submit, redeemed } = fixture(async () => { throw new Error('你已使用过此兑换码'); });
  enter('???');
  await submit();
  assert.equal(find('creditRedeemCode').attributes['aria-invalid'], 'true');
  enter('GUGU-TEST-CODE');
  assert.equal(find('creditRedeemFeedback').textContent, '');
  await submit();
  assert.match(find('creditRedeemFeedback').textContent, /已使用/);
  assert.equal(find('creditRedeemSubmit').disabled, false);
  assert.equal(redeemed.length, 0);
});

test('responses for a previous account never update the current wallet', async () => {
  for (const reset of [false, true]) {
    let complete;
    const f = fixture(() => new Promise(resolve => { complete = resolve; }));
    f.enter('GUGU-TEST-CODE');
    const pending = f.submit();
    f.expire();
    if (reset) f.controller.reset();
    complete({ credits:100, balance:100 });
    await pending;
    assert.equal(f.redeemed.length, 0);
    assert.equal(f.find('creditRedeemFeedback').textContent, '');
  }
});

test('reopening during a request keeps submission disabled and applies the successful balance', async () => {
  let complete;
  let requests = 0;
  const f = fixture(() => { requests++; return new Promise(resolve => { complete = resolve; }); });
  f.enter('GUGU-TEST-CODE');
  const pending = f.submit();
  f.controller.reset();
  await f.submit();
  assert.equal(requests, 1);
  assert.equal(f.find('creditRedeemSubmit').disabled, true);
  complete({ credits:100, balance:100 });
  await pending;
  assert.equal(f.redeemed.length, 1);
});

test('redemption entries have a user-facing label and all changed entries have fresh caches', () => {
  assert.equal(createCreditPresentation().creditEarnType({ type:'code_redemption' }), '兑换码兑换');
  const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  assert.match(read('index.html'), /\/app\.js\?v=641"/);
  assert.match(read('index.html'), /\/payment\.css\?v=7"/);
  assert.match(read('guguadmin.html'), /\/guguadmin\.js\?v=79"/);
  assert.match(read('app.js'), /credits\/redemption\.js\?v=1/);
  assert.match(read('app.js'), /credits\/presentation\.js\?v=7/);
  assert.doesNotMatch(read('guguadmin.js'), /邀请码|注册赠送|新用户即可使用它注册/);
});
