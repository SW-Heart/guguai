import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openDatabase, closeDatabase, sql } from '../lib/db.mjs';
import { walletOf, chargeGenerationMicro } from '../lib/ledger.mjs';
import { createWechatOrder, queryWechatOrder, refundWechatOrder, handleWechatNotification, wechatOrderForUser, loadWechatConfig, xunhuHash, verifyXunhuHash } from '../lib/wechat-payments.mjs';
import { createAccountRouteHandler } from '../server/routes/account.mjs';

const env = { XUNHUPAY_APP_ID: 'wx-channel', XUNHUPAY_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://example.com' };
const signed = data => ({ ...data, hash: xunhuHash(data, env.XUNHUPAY_SECRET) });
const response = data => ({ ok: true, json: async () => data });
function setup(t) {
  openDatabase({ file: ':memory:' });
  t.after(() => closeDatabase({ checkpoint: false }));
  sql(`INSERT INTO users(id,username,password_hash,created_at,credit_balance_micro,credit_held_micro,doc_json)
    VALUES('wx-user','wx-user','hash','2026-01-01',0,0,'{}')`).run();
}
async function create(fetchImpl = async (url, options) => {
  assert.equal(url.pathname, '/payment/do.html');
  const params = JSON.parse(options.body);
  assert.equal(params.version, '1.1');
  assert.equal(params.total_fee, '1.00');
  assert.equal(params.trade_order_id.length, 32);
  assert.ok(verifyXunhuHash(params, env.XUNHUPAY_SECRET));
  assert.equal(params.notify_url, 'https://example.com/api/payments/wechat/notify');
  assert.ok(params.return_url.includes(params.trade_order_id));
  return response(signed({ errcode: 0, openid: 'provider-order', url_qrcode: 'https://api.xunhupay.com/qr.png', url: 'https://api.xunhupay.com/pay/mobile' }));
}) {
  return createWechatOrder({ userId: 'wx-user', credits: 10, env, fetchImpl });
}
function notification(id, status = 'OD', extras = {}) {
  return signed({ appid: env.XUNHUPAY_APP_ID, trade_order_id: id, total_fee: '1.00', transaction_id: 'transaction-1', open_order_id: 'provider-order', status, ...extras });
}
const query = status => async (url, options) => {
  assert.equal(url.pathname, '/payment/query.html');
  const params = Object.fromEntries(new URLSearchParams(options.body));
  assert.ok(params.out_trade_order);
  assert.equal(params.trade_order_id, undefined);
  assert.ok(verifyXunhuHash(params, env.XUNHUPAY_SECRET));
  return response({ errcode: 0, data: { status, open_order_id: 'provider-order' } });
};

test('Xunhu scalar signing follows ASCII, raw values, zero and extension fields', () => {
  const input = { z: '', A: '中文&x=1', a: 0, hash: 'ignored', nil: null, extension: 'new' };
  const expected = createHash('md5').update('A=中文&x=1&a=0&extension=newtest-secret').digest('hex');
  assert.equal(xunhuHash(input, env.XUNHUPAY_SECRET), expected);
  assert.ok(verifyXunhuHash({ ...input, hash: expected }, env.XUNHUPAY_SECRET));
  assert.equal(verifyXunhuHash({ ...input, a: 1, hash: expected }, env.XUNHUPAY_SECRET), false);
  assert.equal(verifyXunhuHash({ ...input, hash: '' }, env.XUNHUPAY_SECRET), false);
  assert.throws(() => xunhuHash({ data: { status: 'OD' } }, 'secret'));
});
test('configuration requires credentials and HTTPS callback, never client credentials', () => {
  assert.equal(loadWechatConfig(env).notifyUrl, 'https://example.com/api/payments/wechat/notify');
  assert.throws(() => loadWechatConfig({}), /暂未开放/);
  assert.throws(() => loadWechatConfig({ ...env, XUNHUPAY_GATEWAY: 'http://example.com' }));
  assert.throws(() => loadWechatConfig({ ...env, PUBLIC_BASE_URL: '' }));
});
test('creation validates package and response signature, persists ownership', async t => {
  setup(t);
  await assert.rejects(createWechatOrder({ userId: 'wx-user', credits: 200, env }), /有效/);
  await assert.rejects(create(async () => response({ errcode: 0, url_qrcode: 'https://example.com/qr' })), /校验/);
  const { order } = await create();
  assert.equal(order.appId, undefined);
  assert.equal(order.userId, undefined);
  assert.equal(order.status, 'PENDING_PAYMENT');
  assert.throws(() => wechatOrderForUser('other-user', order.outTradeNo), /不存在/);
  assert.equal(walletOf('wx-user').balanceMicro, 0);
});
test('notification rejects forged signature, wrong app, amount and provider order', async t => {
  setup(t);
  const { order } = await create();
  for (const extras of [{ appid: 'other' }, { total_fee: '10.00' }, { open_order_id: 'other' }, { transaction_id: '' }]) {
    await assert.rejects(handleWechatNotification(notification(order.outTradeNo, 'OD', extras), env));
  }
  await assert.rejects(handleWechatNotification({ ...notification(order.outTradeNo), hash: '0'.repeat(32) }, env));
  assert.equal(walletOf('wx-user').balanceMicro, 0);
});
test('concurrent notifications and authenticated queries credit once', async t => {
  setup(t);
  const { order } = await create();
  await Promise.all([
    handleWechatNotification(notification(order.outTradeNo), env),
    handleWechatNotification(notification(order.outTradeNo), env),
    queryWechatOrder('wx-user', order.outTradeNo, env, query('OD')),
  ]);
  assert.equal(walletOf('wx-user').balanceMicro, 10_000_000);
  assert.equal(sql("SELECT count(*) AS n FROM credit_entries WHERE type='wechat_purchase'").get().n, 1);
  assert.equal((await queryWechatOrder('wx-user', order.outTradeNo, env, query('WP'))).order.status, 'PAID');
  assert.equal((await queryWechatOrder('wx-user', order.outTradeNo, env, query('CD'))).order.status, 'PAID');
});
test('query CD is cancellation, late signed payment can still settle', async t => {
  setup(t);
  const { order } = await create();
  assert.equal((await queryWechatOrder('wx-user', order.outTradeNo, env, query('CD'))).order.status, 'CLOSED');
  await handleWechatNotification(notification(order.outTradeNo), env);
  assert.equal(walletOf('wx-user').balanceMicro, 10_000_000);
});
test('query cannot settle mismatched provider ID or amount', async t => {
  setup(t);
  const { order } = await create();
  for (const data of [{ status: 'OD', open_order_id: 'wrong' }, { status: 'OD', open_order_id: 'provider-order', total_fee: '2.00' }]) {
    await assert.rejects(queryWechatOrder('wx-user', order.outTradeNo, env, async () => response({ errcode: 0, data })));
  }
  assert.equal(walletOf('wx-user').balanceMicro, 0);
});
test('full refund atomically captures credits once and ignores stale paid events', async t => {
  setup(t);
  const { order } = await create();
  await handleWechatNotification(notification(order.outTradeNo), env);
  await assert.rejects(refundWechatOrder('wx-user', order.outTradeNo, { amount: '0.50' }, env), /整单/);
  let calls = 0;
  const refundFetch = async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/payment/refund.html');
    assert.equal(new URLSearchParams(options.body).get('trade_order_id'), order.outTradeNo);
    return response(signed({ errcode: 0, trade_order_id: order.outTradeNo, refund_fee: '1.00', refund_status: 'CD' }));
  };
  await Promise.all([refundWechatOrder('wx-user', order.outTradeNo, {}, env, refundFetch), refundWechatOrder('wx-user', order.outTradeNo, {}, env, refundFetch)]);
  await handleWechatNotification(notification(order.outTradeNo, 'CD'), env);
  await handleWechatNotification(notification(order.outTradeNo), env);
  assert.equal(calls, 1);
  assert.equal(walletOf('wx-user').balanceMicro, 0);
  assert.equal(walletOf('wx-user').heldMicro, 0);
  assert.equal(wechatOrderForUser('wx-user', order.outTradeNo).status, 'REFUNDED');
});
test('refund timeout retains hold, never repeats remote request, signed callback reconciles', async t => {
  setup(t);
  const { order } = await create();
  await handleWechatNotification(notification(order.outTradeNo), env);
  await assert.rejects(refundWechatOrder('wx-user', order.outTradeNo, {}, env, async () => { throw new Error('timeout'); }));
  assert.equal(walletOf('wx-user').heldMicro, 10_000_000);
  await refundWechatOrder('wx-user', order.outTradeNo, {}, env, () => { throw new Error('must not retry'); });
  await queryWechatOrder('wx-user', order.outTradeNo, env, query('CD'));
  assert.equal(walletOf('wx-user').heldMicro, 10_000_000);
  await handleWechatNotification(notification(order.outTradeNo, 'CD'), env);
  assert.equal(walletOf('wx-user').balanceMicro, 0);
});
test('explicit failed refund releases hold once; RD retains it', async t => {
  setup(t);
  const { order } = await create();
  await handleWechatNotification(notification(order.outTradeNo), env);
  await refundWechatOrder('wx-user', order.outTradeNo, {}, env, async () => response(signed({ errcode: 0, trade_order_id: order.outTradeNo, refund_fee: '1.00', refund_status: 'RD' })));
  assert.equal(walletOf('wx-user').heldMicro, 10_000_000);
  await handleWechatNotification(notification(order.outTradeNo, 'UD'), env);
  await handleWechatNotification(notification(order.outTradeNo, 'UD'), env);
  assert.equal(walletOf('wx-user').heldMicro, 0);
  assert.equal(walletOf('wx-user').balanceMicro, 10_000_000);
});
test('refund before payment callback never credits a refunded order', async t => {
  setup(t);
  const { order } = await create();
  await handleWechatNotification(notification(order.outTradeNo, 'RD'), env);
  await handleWechatNotification(notification(order.outTradeNo), env);
  await handleWechatNotification(notification(order.outTradeNo, 'CD'), env);
  assert.equal(walletOf('wx-user').balanceMicro, 0);
  assert.equal(wechatOrderForUser('wx-user', order.outTradeNo).status, 'REFUNDED');
});
test('wechat order routes require authentication; notify is public and fails closed', async () => {
  let denied = 0;
  const results = [];
  const route = createAccountRouteHandler({ requireUser: () => { denied++; return null; }, bodyForm: async () => ({}), sendText: (...args) => results.push(args) });
  for (const suffix of ['', '/WX123', '/WX123/query', '/WX123/refunds']) {
    assert.equal(await route({ method: suffix === '/WX123' ? 'GET' : 'POST' }, {}, new URL(`https://example.com/api/payments/wechat/orders${suffix}`)), true);
  }
  assert.equal(denied, 4);
  assert.equal(await route({ method: 'POST' }, {}, new URL('https://example.com/api/payments/wechat/notify'), { publicOnly: true }), true);
  assert.equal(results[0][2], 'fail');
});
test('all modified versioned entries have current cache keys', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.ok(Number(read('public/index.html').match(/\/app\.js\?v=(\d+)\b/)?.[1])>=454);
  assert.ok(read('public/app.js').includes('./features/credits/presentation.js?v=5'));
  for (const page of ['index', 'pricing']) assert.ok(read(`public/${page}.html`).includes('/payment.css?v=3'));
  for (const page of ['pricing', 'home', 'features']) assert.ok(read(`public/${page}.html`).includes('/marketing.js?v=16'));
});

test('insufficient balance rejects refund before calling the provider', async t => {
  setup(t);
  const { order } = await create();
  await handleWechatNotification(notification(order.outTradeNo), env);
  await chargeGenerationMicro('wx-user', 'generation-1', 1_000_000);
  let called = false;
  await assert.rejects(refundWechatOrder('wx-user', order.outTradeNo, {}, env, async () => { called = true; }), /不足/);
  assert.equal(called, false);
  assert.equal(walletOf('wx-user').heldMicro, 0);
  assert.equal(wechatOrderForUser('wx-user', order.outTradeNo).status, 'PAID');
  assert.equal(wechatOrderForUser('wx-user', order.outTradeNo).refund, undefined);
});
test('database failure rolls back both wallet and payment state', async t => {
  setup(t);
  const { order } = await create();
  sql("CREATE TRIGGER fail_wechat_update BEFORE UPDATE ON wechat_payment_orders BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
  await assert.rejects(handleWechatNotification(notification(order.outTradeNo), env));
  assert.equal(walletOf('wx-user').balanceMicro, 0);
  assert.equal(wechatOrderForUser('wx-user', order.outTradeNo).status, 'PENDING_PAYMENT');
  sql('DROP TRIGGER fail_wechat_update').run();
  await handleWechatNotification(notification(order.outTradeNo), env);
  assert.equal(walletOf('wx-user').balanceMicro, 10_000_000);
});
test('valid HTTP notification returns exact success and credits only once', async t => {
  setup(t);
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { order } = await create();
  let body;
  const route = createAccountRouteHandler({ bodyForm: async () => notification(order.outTradeNo), sendText: (_res, _status, value) => { body = value; } });
  for (let i = 0; i < 2; i++) {
    await route({ method: 'POST' }, {}, new URL('https://example.com/api/payments/wechat/notify'), { publicOnly: true });
    assert.equal(body, 'success');
  }
  assert.equal(walletOf('wx-user').balanceMicro, 10_000_000);
});

test('custom amounts enforce precision and maximum before contacting payment provider', async t => {
  setup(t);
  for (const amount of ['1.0', '1.00', '1.01', '12.34', 1.5, '9999.99', '0', '0.01', '0.99', '-1', '10000.01', '10001', '0.001', '1.001', '1e3', '', null, {}, true, Infinity, NaN]) {
    let called = false;
    await assert.rejects(createWechatOrder({ userId: 'wx-user', amount, env, fetchImpl: async () => { called = true; } }));
    assert.equal(called, false, String(amount));
  }
  assert.equal(sql('SELECT count(*) AS n FROM wechat_payment_orders').get().n, 0);
});
test('RMB presets and custom amounts produce exact provider fee and server-calculated credits', async t => {
  setup(t);
  for (const amount of ['1', '5', '10', '50', '100', '500', '23', '9999', '10000']) {
    const fen = Math.round(Number(amount) * 100);
    const result = await createWechatOrder({ userId: 'wx-user', amount, credits: 999999999, env, fetchImpl: async (_url, options) => {
      const params = JSON.parse(options.body);
      assert.equal(params.total_fee, (fen / 100).toFixed(2));
      return response(signed({ errcode: 0, openid: `provider-${amount}`, url_qrcode: 'https://api.xunhupay.com/qr.png' }));
    } });
    assert.equal(result.order.totalAmountFen, fen);
    assert.equal(result.order.credits, fen / 10);
    const notice = notification(result.order.outTradeNo, 'OD', { total_fee: (fen / 100).toFixed(2), open_order_id: `provider-${amount}`, transaction_id: `trade-${amount}` });
    const before = walletOf('wx-user').balanceMicro;
    await handleWechatNotification(notice, env);
    await handleWechatNotification(notice, env);
    assert.equal(walletOf('wx-user').balanceMicro - before, fen * 100000);
  }
});
test('amount choices and custom inputs exist in both purchase entrypoints', () => {
  const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  for (const amount of ['1', '5', '10', '50', '100', '500']) {
    assert.ok(read('index.html').includes(`data-wechat-amount="${amount}"`));
    assert.ok(read('pricing.html').includes(`data-buy-wechat-amount="${amount}"`));
  }
  assert.ok(read('app.js').includes("const input = provider === 'wechat' ? { amount }"));
  assert.ok(read('marketing.js').includes("provider === 'wechat' ? { amount } : { credits }"));
});

test('purchase dialogs use the WeChat icon with a fresh stylesheet cache key', () => {
  const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  const html = read('index.html');
  assert.equal((html.match(/src="\/icons\/wechat\.svg\?v=1"/g) || []).length, 2);
  assert.ok(read('icons/wechat.svg').includes('viewBox="0 0 24 24"'));
  assert.ok(Number(html.match(/\/styles\.css\?v=(\d+)\b/)?.[1])>=340);
  assert.ok(!html.includes('/styles.css?v=338'));
});

test('custom input takes precedence, clearing it restores preset, and invalid input never falls back', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const selectionBody = source.match(/function selectedWechatAmount\(\) \{([\s\S]*?)\n\}/)[1];
  const select = new Function('state', selectionBody);
  const validationBody = source.match(/function validWechatAmount\(value\) \{([\s\S]*?)\n\}/)[1];
  const valid = new Function('value', validationBody);
  for (const preset of ['1', '5', '10', '50', '100', '500']) {
    assert.equal(select({ wechatTopupAmount: preset, wechatCustomAmount: '' }), preset);
    assert.equal(select({ wechatTopupAmount: preset, wechatCustomAmount: ' 23 ' }), '23');
    assert.equal(select({ wechatTopupAmount: preset, wechatCustomAmount: ' ' }), preset);
    for (const input of ['0.99', '1.5', '5.00', '10000.01', 'oops']) {
      const amount = select({ wechatTopupAmount: preset, wechatCustomAmount: input });
      assert.equal(amount, input);
      assert.equal(valid(amount), false);
    }
  }
  assert.equal(valid('1'), true);
  assert.equal(valid('10000'), true);
});
