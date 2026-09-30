import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from './db.mjs';
import { creditsToMicro } from './billing.mjs';
import { amountFenFromText, amountTextFromFen, publicCreditPackages } from './alipay-payments.mjs';
import { creditAlipayPurchase, reserveAlipayRefundCredits, captureAlipayRefundCredits, releaseAlipayRefundCredits } from './ledger.mjs';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const text = value => String(value ?? '').trim();
const nonce = () => randomBytes(16).toString('hex');
const locks = new Map();
async function withOrderLock(id, action) {
  const previous = locks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  locks.set(id, current);
  try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}
function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('微信支付暂不可用，请稍后再试', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('微信支付暂不可用，请稍后再试', 503);
  return url.href;
}
export function loadWechatConfig(env = process.env) {
  const appId = text(env.XUNHUPAY_APP_ID);
  const secret = text(env.XUNHUPAY_SECRET);
  if (!appId || !secret) throw fail('微信支付暂未开放，请选择其他支付方式', 503);
  const gateway = httpsUrl(text(env.XUNHUPAY_GATEWAY) || 'https://api.xunhupay.com');
  const base = text(env.PUBLIC_BASE_URL);
  const notifyUrl = httpsUrl(text(env.XUNHUPAY_NOTIFY_URL) || (base ? new URL('/api/payments/wechat/notify', base).href : ''));
  const returnUrl = httpsUrl(text(env.XUNHUPAY_RETURN_URL) || (base ? new URL('/pricing', base).href : ''));
  if (notifyUrl.length > 128 || returnUrl.length > 128) throw fail('微信支付暂不可用，请稍后再试', 503);
  return { appId, secret, gateway, notifyUrl, returnUrl };
}
export function xunhuHash(params, secret) {
  const entries = Object.keys(params).sort().filter(key => key !== 'hash' && params[key] != null && params[key] !== '');
  if (entries.some(key => !['string', 'number'].includes(typeof params[key]))) throw fail('支付结果无法确认，请稍后刷新', 502);
  return createHash('md5').update(entries.map(key => `${key}=${params[key]}`).join('&') + secret, 'utf8').digest('hex');
}
export function verifyXunhuHash(params, secret) {
  const hash = text(params?.hash);
  return /^[a-f0-9]{32}$/.test(hash) && timingSafeEqual(Buffer.from(hash), Buffer.from(xunhuHash(params, secret)));
}
async function request(config, operation, input, fetchImpl) {
  const params = { appid: config.appId, time: Math.floor(Date.now() / 1000), nonce_str: nonce(), ...input };
  params.hash = xunhuHash(params, config.secret);
  let result;
  try {
    const response = await fetchImpl(new URL(`/payment/${operation}.html`, config.gateway), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': operation === 'do' ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: operation === 'do' ? JSON.stringify(params) : new URLSearchParams(params).toString(),
    });
    if (!response.ok) throw new Error('HTTP failure');
    result = await response.json();
  } catch { throw fail('暂时无法确认微信支付结果，请稍后刷新订单', 502); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('支付结果无法确认，请稍后刷新', 502);
  // The official query SDK uses authenticated HTTPS and returns nested data;
  // its documented scalar hash algorithm cannot sign that object. Do not invent
  // a serialization or treat its outer hash as authenticating nested fields.
  if (operation !== 'query' && !verifyXunhuHash(result, config.secret)) throw fail('支付结果校验失败，请稍后刷新', 502);
  if (String(result.errcode) !== '0') throw fail('微信支付未能完成，请稍后重试或选择其他支付方式', 502);
  return result;
}
function find(id, userId) {
  const row = sql('SELECT * FROM wechat_payment_orders WHERE out_trade_no = :id').get({ id });
  if (!row || (userId && row.user_id !== userId)) throw fail('支付订单不存在', 404);
  return JSON.parse(row.doc_json);
}
function save(order) {
  order.updatedAt = new Date().toISOString();
  sql('UPDATE wechat_payment_orders SET doc_json = :doc WHERE out_trade_no = :id').run({ id: order.outTradeNo, doc: JSON.stringify(order) });
}
function publicOrder(order) {
  const { appId, userId, ...safe } = order;
  return safe;
}
export function wechatOrderForUser(userId, id) { return publicOrder(find(id, userId)); }
function assertIdentity(order, data, config, { notification = false } = {}) {
  if (order.appId !== config.appId || (data.appid != null && text(data.appid) !== order.appId)) throw fail('支付订单校验失败', 400);
  for (const key of ['trade_order_id', 'out_trade_order']) {
    if (data[key] != null && text(data[key]) !== order.outTradeNo) throw fail('支付订单校验失败', 400);
  }
  if (notification && (text(data.appid) !== order.appId || text(data.trade_order_id) !== order.outTradeNo || !text(data.transaction_id))) throw fail('支付订单校验失败', 400);
  if ((notification || data.total_fee != null) && amountFenFromText(data.total_fee) !== order.totalAmountFen) throw fail('支付金额校验失败', 400);
  if (data.open_order_id && order.openOrderId && text(data.open_order_id) !== order.openOrderId) throw fail('支付订单校验失败', 400);
  if (data.transaction_id && order.tradeNo && text(data.transaction_id) !== order.tradeNo) throw fail('支付订单校验失败', 400);
}
async function settle(order, data) {
  if (['REFUNDED', 'REFUNDING'].includes(order.status) || order.refund) return;
  await creditAlipayPurchase(order.userId, order.outTradeNo, creditsToMicro(order.credits), { provider: 'wechat', onCredited: () => {
    order.status = 'PAID';
    order.paidAt ||= new Date().toISOString();
    order.tradeNo ||= text(data.transaction_id) || null;
    order.openOrderId ||= text(data.open_order_id) || null;
    save(order);
  } });
}
async function applyRefund(order, status) {
  if (order.status === 'REFUNDED') return;
  if (!order.refund) {
    if (status === 'UD' && !order.paidAt && order.status === 'REFUNDING') { order.status = 'PENDING_PAYMENT'; save(order); return; }
    if (!['CD', 'RD'].includes(status)) return;
    // A refund made in the provider dashboard still needs a local credit hold.
    if (!order.paidAt) {
      order.status = status === 'CD' ? 'REFUNDED' : 'REFUNDING';
      save(order);
      return;
    }
    order.refund = { outRequestNo: `WXR${nonce().slice(0, 29)}`, status: 'PENDING' };
    await reserveAlipayRefundCredits(order.userId, order.refund.outRequestNo, creditsToMicro(order.credits), { provider: 'wechat', onReserved: () => save(order) });
  }
  if (order.refund.status === 'FAILED') {
    if (status !== 'CD') return;
    // A later authoritative success may follow an earlier failure notification.
    order.refund = { outRequestNo: `WXR${nonce().slice(0, 29)}`, status: 'PENDING' };
    await reserveAlipayRefundCredits(order.userId, order.refund.outRequestNo, creditsToMicro(order.credits), { provider: 'wechat', onReserved: () => save(order) });
  }
  if (status === 'CD') {
    await captureAlipayRefundCredits(order.userId, order.refund.outRequestNo, { provider: 'wechat', onCaptured: () => {
      order.status = 'REFUNDED'; order.refund.status = 'SUCCESS'; order.refundedAmount = order.totalAmount; save(order);
    } });
  } else if (status === 'UD') {
    await releaseAlipayRefundCredits(order.userId, order.refund.outRequestNo, { onReleased: () => {
      order.status = 'PAID'; order.refund.status = 'FAILED'; save(order);
    } });
  } else if (status === 'RD') {
    order.status = 'REFUNDING'; save(order);
  }
}
export function wechatAmountPackage(amount) {
  if (!['string', 'number'].includes(typeof amount)) throw fail('请输入有效的支付金额');
  if (!/^\d{1,5}$/.test(String(amount).trim())) throw fail('请输入 1–10000 元的整数金额');
  const amountFen = amountFenFromText(amount, '支付金额');
  if (amountFen < 100) throw fail('支付金额不能低于 1 元');
  if (amountFen > 1_000_000) throw fail('支付金额不能超过 10000 元');
  return { amountFen, amount: amountTextFromFen(amountFen), credits: amountFen / 10 };
}
export async function createWechatOrder({ userId, amount, credits, env = process.env, fetchImpl = fetch }) {
  // Keep old fixed-package requests working for clients that have not updated.
  const pack = amount !== undefined ? wechatAmountPackage(amount)
    : publicCreditPackages(env).packages.find(item => item.credits === Number(credits));
  if (!pack) throw fail('请选择有效的积分商品');
  const config = loadWechatConfig(env);
  const order = { outTradeNo: `WX${nonce().slice(0, 30)}`, userId, appId: config.appId, provider: 'wechat', status: 'PENDING_PAYMENT', credits: pack.credits, totalAmount: pack.amount, totalAmountFen: pack.amountFen, createdAt: new Date().toISOString(), paidAt: null };
  sql('INSERT INTO wechat_payment_orders(out_trade_no,user_id,app_id,doc_json) VALUES(:id,:userId,:appId,:doc)').run({ id: order.outTradeNo, userId, appId: config.appId, doc: JSON.stringify(order) });
  const returnUrl = new URL(config.returnUrl);
  returnUrl.searchParams.set('order', order.outTradeNo);
  if (returnUrl.href.length > 128) throw fail('微信支付暂不可用，请稍后再试', 503);
  const result = await request(config, 'do', { version: '1.1', trade_order_id: order.outTradeNo, total_fee: pack.amount, title: `GuGu AI ${pack.credits} 积分`, notify_url: config.notifyUrl, return_url: returnUrl.href, plugins: 'guguai' }, fetchImpl);
  const qrCodeUrl = result.url_qrcode ? httpsUrl(result.url_qrcode) : '';
  const paymentUrl = result.url ? httpsUrl(result.url) : '';
  if (!qrCodeUrl && !paymentUrl) throw fail('微信支付暂不可用，请稍后重试', 502);
  await withOrderLock(order.outTradeNo, () => {
    const latest = find(order.outTradeNo, userId);
    latest.openOrderId ||= text(result.open_order_id || result.openid) || null;
    latest.qrCodeUrl = qrCodeUrl; latest.paymentUrl = paymentUrl;
    latest.expiresAt = new Date(Date.now() + 300000).toISOString();
    save(latest);
  });
  return { order: wechatOrderForUser(userId, order.outTradeNo), qrCodeUrl, paymentUrl };
}
export async function queryWechatOrder(userId, id, env = process.env, fetchImpl = fetch) {
  return withOrderLock(id, async () => {
    const order = find(id, userId);
    if (order.status === 'REFUNDED') return { order: publicOrder(order) };
    const config = loadWechatConfig(env);
    if (order.appId !== config.appId) throw fail('支付订单校验失败');
    const result = await request(config, 'query', { out_trade_order: id }, fetchImpl);
    const data = result.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('暂时无法确认支付状态', 502);
    assertIdentity(order, data, config);
    // Bind the HTTPS response to the provider order captured at creation. If
    // creation timed out, only a signed notification may credit this order.
    if (!order.openOrderId || text(data.open_order_id) !== order.openOrderId) throw fail('暂时无法确认支付状态，请稍后刷新', 502);
    if (data.status === 'OD') await settle(order, data);
    // Query CD means CANCELLED, unlike notification/refund CD (REFUNDED).
    else if (data.status === 'CD' && !order.paidAt && !order.refund && order.status === 'PENDING_PAYMENT') { order.status = 'CLOSED'; save(order); }
    return { order: publicOrder(find(id, userId)), providerStatus: text(data.status) };
  });
}
export async function handleWechatNotification(params, env = process.env) {
  const config = loadWechatConfig(env);
  if (!verifyXunhuHash(params, config.secret)) throw fail('支付通知校验失败');
  return withOrderLock(text(params.trade_order_id), async () => {
    const order = find(text(params.trade_order_id));
    assertIdentity(order, params, config, { notification: true });
    if (params.status === 'OD') await settle(order, params);
    else if (['CD', 'RD', 'UD'].includes(params.status)) await applyRefund(order, params.status);
    else throw fail('支付通知状态无法确认');
    return { order: publicOrder(find(order.outTradeNo)) };
  });
}
export async function refundWechatOrder(userId, id, input = {}, env = process.env, fetchImpl = fetch) {
  return withOrderLock(id, async () => {
    const order = find(id, userId);
    const config = loadWechatConfig(env);
    if (order.appId !== config.appId) throw fail('支付订单校验失败');
    if (input.amount != null && input.amount !== '' && amountFenFromText(input.amount) !== order.totalAmountFen) throw fail('微信支付仅支持整单退款');
    if (order.refund || order.status === 'REFUNDED') return { order: publicOrder(order), refund: order.refund || null };
    if (order.status !== 'PAID') throw fail('只有已支付订单可以退款', 409);
    order.refund = { outRequestNo: `WXR${nonce().slice(0, 29)}`, status: 'PENDING' };
    order.status = 'REFUNDING';
    await reserveAlipayRefundCredits(userId, order.refund.outRequestNo, creditsToMicro(order.credits), { provider: 'wechat', onReserved: () => save(order) });
    // Persist before network I/O. Timeouts/invalid responses keep the hold and
    // never cause an automatic second refund; notifications reconcile it.
    const result = await request(config, 'refund', { trade_order_id: id, reason: Array.from(text(input.reason) || '用户申请退款').slice(0, 80).join('') }, fetchImpl);
    assertIdentity(order, result, config);
    if (text(result.trade_order_id) !== id || amountFenFromText(result.refund_fee) !== order.totalAmountFen) throw fail('退款结果校验失败，请稍后刷新', 502);
    await applyRefund(order, result.refund_status);
    return { order: publicOrder(find(id, userId)), refund: find(id, userId).refund };
  });
}
