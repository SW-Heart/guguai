import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { __test as paymentTest, amountFenFromText, amountTextFromFen, loadAlipayConfig, paymentReturnPage, publicCreditPackages, publicNotifyUrl, publicReturnUrl } from '../lib/alipay-payments.mjs';
import { closeDatabase, openDatabase, sql } from '../lib/db.mjs';
import { captureAlipayRefundCredits, creditAlipayPurchase, reserveAlipayRefundCredits, walletOf } from '../lib/ledger.mjs';

test('Alipay amount and production config boundaries', () => {
  assert.equal(amountFenFromText('88.8'), 8880);
  assert.equal(amountTextFromFen(8880), '88.80');
  assert.throws(() => amountFenFromText('1.001'), /格式/);
  const config = loadAlipayConfig({
    ALIPAY_ENV: 'production',
    ALIPAY_APP_ID: 'app-id',
    ALIPAY_APP_PRIVATE_KEY: 'private-key',
    ALIPAY_PUBLIC_KEY: 'public-key',
    ALIPAY_SELLER_ID: 'seller-id',
  });
  assert.equal(config.mode, 'production');
  assert.equal(config.gateway, 'https://openapi.alipay.com/gateway.do');
  assert.throws(() => loadAlipayConfig({ ALIPAY_ENV:'production', ALIPAY_APP_ID:'app', ALIPAY_APP_PRIVATE_KEY:'key', ALIPAY_PUBLIC_KEY:'public' }), /商家/);
  const aliasedSandbox = loadAlipayConfig({
    AIPAY_APP_ID:'sandbox-app',
    AIPAY_PUBLIC_KEY:'application-public-key-must-not-be-used',
    AIPAY_PRIVATE_KEY:'generic-private-key',
    AIPAY_PRIVATE_PKCS_KEY:'pkcs1-private-key',
    AIPAY_ALIPAY_PUBLIC_KEY:'alipay-public-key',
  });
  assert.equal(aliasedSandbox.mode, 'sandbox');
  assert.equal(aliasedSandbox.privateKey, 'pkcs1-private-key');
  assert.equal(aliasedSandbox.alipayPublicKey, 'alipay-public-key');
  assert.equal(aliasedSandbox.gateway, 'https://openapi-sandbox.dl.alipaydev.com/gateway.do');
  assert.equal(publicReturnUrl({ PUBLIC_BASE_URL:'https://guguai.xyz' }), 'https://guguai.xyz/payments/alipay/return');
  assert.equal(publicNotifyUrl({ PUBLIC_BASE_URL:'https://guguai.xyz' }), 'https://guguai.xyz/api/payments/alipay/notify');
  assert.deepEqual(publicCreditPackages({ YUAN_PER_CREDIT:'0.1' }).packages.map(item => [item.credits, item.amount]), [[10, '1.00'], [50, '5.00'], [100, '10.00'], [500, '50.00']]);
  assert.deepEqual(paymentTest.creditsAndAmount(50, { YUAN_PER_CREDIT:'0.1' }), { credits:50, creditsMicro:50_000_000, totalAmountFen:500 });
  assert.throws(() => paymentTest.creditsAndAmount(200, { YUAN_PER_CREDIT:'0.1' }), /有效的积分商品/);
  assert.throws(() => publicCreditPackages({ YUAN_PER_CREDIT:'0.2' }), /必须配置为 0.1/);
});

test('Alipay private key validation rejects placeholders and requires raw PKCS#1', () => {
  assert.throws(() => paymentTest.validatePkcs1PrivateKey('（需自行配置线上非 JAVA 语言私钥）'), /应用私钥未配置/);
  assert.throws(() => paymentTest.validatePkcs1PrivateKey('not-a-private-key'), /格式错误/);

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const rawPkcs1 = privateKey.toString('base64');
  assert.equal(paymentTest.validatePkcs1PrivateKey(rawPkcs1), rawPkcs1);
  assert.throws(
    () => paymentTest.validatePkcs1PrivateKey(`-----BEGIN RSA PRIVATE KEY-----\n${rawPkcs1}\n-----END RSA PRIVATE KEY-----`),
    /不含 PEM 头尾和换行/,
  );
});

test('Alipay crediting and refund holds are idempotent', async t => {
  openDatabase({ file: ':memory:' });
  t.after(() => closeDatabase({ checkpoint: false }));
  const createdAt = new Date().toISOString();
  sql(`
    INSERT INTO users(id, username, password_hash, created_at, credit_balance_micro, credit_held_micro, doc_json)
    VALUES('payment-user', 'payment_user', 'hash', :createdAt, 0, 0, :docJson)
  `).run({ createdAt, docJson: JSON.stringify({ id: 'payment-user', username: 'payment_user', credits: 0 }) });

  const first = await creditAlipayPurchase('payment-user', 'ORDER-1', 100_000_000);
  const replay = await creditAlipayPurchase('payment-user', 'ORDER-1', 100_000_000);
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.equal(walletOf('payment-user').balanceMicro, 100_000_000);

  await reserveAlipayRefundCredits('payment-user', 'REFUND-1', 25_000_000);
  assert.equal(walletOf('payment-user').heldMicro, 25_000_000);
  await captureAlipayRefundCredits('payment-user', 'REFUND-1');
  await captureAlipayRefundCredits('payment-user', 'REFUND-1');
  assert.equal(walletOf('payment-user').balanceMicro, 75_000_000);
  assert.equal(walletOf('payment-user').heldMicro, 0);
  assert.equal(sql("SELECT COUNT(*) AS count FROM credit_entries WHERE type = 'alipay_refund'").get().count, 1);
});

test('payment return page escapes order data and never declares unknown state paid', () => {
  const html = paymentReturnPage({ order: { status: 'UNKNOWN', credits: 100, outTradeNo: '<bad>' } });
  assert.match(html, /支付结果待确认/);
  assert.doesNotMatch(html, /<bad>/);
  assert.match(html, /&lt;bad&gt;/);
  assert.match(paymentReturnPage({ order: { status:'PAID', credits:50, outTradeNo:'ORDER-1' } }), /\/pricing\?order=ORDER-1/);
});
