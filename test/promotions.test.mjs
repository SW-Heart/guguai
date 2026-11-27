import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase, sql } from '../lib/db.mjs';
import { creditAlipayPurchase, purchaseBonusMicro, walletOf } from '../lib/ledger.mjs';
import { __test as alipayTest } from '../lib/alipay-payments.mjs';
import { createWechatOrder, handleWechatNotification, refundWechatOrder, wechatOrderForUser, xunhuHash } from '../lib/wechat-payments.mjs';
import { __test as clock, activePromotion, bonusMicroFor, orderPromotion, publicPromotion, settlementBonusMicro, PROMOTION_SETTLE_GRACE_MS } from '../lib/promotions.mjs';

// Black Friday runs for the whole of 27 Nov 2026 in Beijing time (UTC+8).
const START = Date.parse('2026-11-26T16:00:00Z');
const END = Date.parse('2026-11-27T16:00:00Z');
const env = { XUNHUPAY_APP_ID: 'wx-channel', XUNHUPAY_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://example.com' };
const signed = data => ({ ...data, hash: xunhuHash(data, env.XUNHUPAY_SECRET) });
const response = data => ({ ok: true, json: async () => data });

function setup(t) {
  openDatabase({ file: ':memory:' });
  t.after(() => { clock.setClock(null); closeDatabase({ checkpoint: false }); });
  sql(`INSERT INTO users(id,username,password_hash,created_at,credit_balance_micro,credit_held_micro,doc_json)
    VALUES('promo-user','promo-user','hash','2026-01-01',0,0,'{}')`).run();
}
const setNow = value => clock.setClock(() => value);
async function createWechat(amount = '10') {
  return createWechatOrder({ userId: 'promo-user', amount, env, fetchImpl: async () => response(signed({ errcode: 0, openid: 'provider-order', url_qrcode: 'https://api.xunhupay.com/qr.png' })) });
}
const paid = (order, status = 'OD') => signed({ appid: env.XUNHUPAY_APP_ID, trade_order_id: order.outTradeNo, total_fee: order.totalAmount, transaction_id: 'transaction-1', open_order_id: 'provider-order', status });

test('the bonus window is the whole Beijing day and the preview starts the day before', () => {
  assert.equal(activePromotion(START - 1), null);
  assert.equal(activePromotion(START)?.id, 'black-friday-2026');
  assert.equal(activePromotion(END - 1)?.id, 'black-friday-2026');
  assert.equal(activePromotion(END), null);
  assert.equal(publicPromotion(START - 1).phase, 'upcoming');
  assert.equal(publicPromotion(START).phase, 'active');
  assert.equal(publicPromotion(START).bonusRate, 0.1);
  assert.equal(publicPromotion(START).endsAt, '2026-11-27T16:00:00.000Z');
  assert.equal(publicPromotion(END), null);
  assert.equal(publicPromotion(Date.parse('2026-11-25T15:59:59Z')), null);
});

test('bonus is 10% of the paid credits and honours a short settlement grace', () => {
  assert.equal(bonusMicroFor(10_000_000, activePromotion(START)), 1_000_000);
  assert.equal(bonusMicroFor(15_000_000, null), 0);
  assert.deepEqual(orderPromotion(100_000_000, START - 1), { promotionId: null, bonusMicro: 0 });
  assert.deepEqual(orderPromotion(100_000_000, START), { promotionId: 'black-friday-2026', bonusMicro: 10_000_000 });
  assert.equal(settlementBonusMicro('black-friday-2026', 10_000_000, END + PROMOTION_SETTLE_GRACE_MS - 1), 10_000_000);
  assert.equal(settlementBonusMicro('black-friday-2026', 10_000_000, END + PROMOTION_SETTLE_GRACE_MS), 0);
  assert.equal(settlementBonusMicro('unknown', 10_000_000, START), 0);
  assert.equal(settlementBonusMicro(null, 10_000_000, START), 0);
});

test('an order created in the window is credited once with its bonus and refunded in full', async t => {
  setup(t);
  setNow(START + 1000);
  const { order } = await createWechat('10');
  assert.equal(order.bonusCredits, 10);
  // Paying just after midnight still honours the order placed before it.
  setNow(END + 60_000);
  await Promise.all([handleWechatNotification(paid(order), env), handleWechatNotification(paid(order), env)]);
  assert.equal(walletOf('promo-user').balanceMicro, 110_000_000);
  assert.equal(sql("SELECT count(*) AS n FROM credit_entries WHERE type='promotion_bonus'").get().n, 1);
  assert.equal(purchaseBonusMicro('promo-user', order.outTradeNo, 'wechat'), 10_000_000);
  assert.equal(wechatOrderForUser('promo-user', order.outTradeNo).bonusGrantedCredits, 10);
  await refundWechatOrder('promo-user', order.outTradeNo, {}, env, async () => response(signed({ errcode: 0, trade_order_id: order.outTradeNo, refund_fee: '10.00', refund_status: 'CD' })));
  assert.equal(walletOf('promo-user').balanceMicro, 0);
  assert.equal(walletOf('promo-user').heldMicro, 0);
});

test('a refund is refused when the bonus has already been spent', async t => {
  setup(t);
  setNow(START);
  const { order } = await createWechat('1');
  await handleWechatNotification(paid(order), env);
  sql("UPDATE users SET credit_balance_micro = 10_500_000 WHERE id = 'promo-user'").run();
  await assert.rejects(refundWechatOrder('promo-user', order.outTradeNo, {}, env, async () => { throw new Error('must not call provider'); }), /可用积分不足/);
});

test('orders placed before the window, or paid after the grace, get no bonus', async t => {
  setup(t);
  setNow(START - 1000);
  const early = (await createWechat('1')).order;
  setNow(START + 1000);
  await handleWechatNotification(paid(early), env);
  const late = (await createWechat('1')).order;
  setNow(END + PROMOTION_SETTLE_GRACE_MS + 1);
  await handleWechatNotification(signed({ appid: env.XUNHUPAY_APP_ID, trade_order_id: late.outTradeNo, total_fee: late.totalAmount, transaction_id: 'transaction-2', open_order_id: 'provider-order', status: 'OD' }), env);
  assert.equal(walletOf('promo-user').balanceMicro, 20_000_000);
  assert.equal(sql("SELECT count(*) AS n FROM credit_entries WHERE type='promotion_bonus'").get().n, 0);
});

test('Alipay partial refunds take back the bonus in proportion', async t => {
  setup(t);
  const createdAt = '2026-11-27T01:00:00Z';
  sql(`INSERT INTO alipay_payment_orders(out_trade_no,user_id,status,subject,total_amount_fen,credits_micro,promotion_id,bonus_micro,created_at,updated_at,doc_json)
    VALUES('ALI-1','promo-user','PAID','GuGu AI 100 积分',1000,100000000,'black-friday-2026',10000000,:createdAt,:createdAt,'{}')`).run({ createdAt });
  await creditAlipayPurchase('promo-user', 'ALI-1', 100_000_000, { bonusMicro: 10_000_000 });
  const row = sql("SELECT * FROM alipay_payment_orders WHERE out_trade_no = 'ALI-1'").get();
  assert.equal(alipayTest.refundCreditsMicro(row, 500), 55_000_000);
  assert.equal(alipayTest.rowToOrder(row).bonusGrantedCredits, 10);
});

test('promotion assets are versioned from every entry that loads them', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=648'));
  assert.ok(html.includes('/styles/promotion.css?v=1'));
  assert.ok(html.includes('id="creditPromotionBanner"'));
  assert.ok(app.includes("./features/promotions/recharge-promotion.js?v=1"));
  assert.ok(app.includes("./features/credits/presentation.js?v=8"));
});
