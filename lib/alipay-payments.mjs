import { createPrivateKey, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlipaySdk } from 'alipay-sdk';
import { creditsToMicro, microToCredits } from './billing.mjs';
import { sql, tx } from './db.mjs';
import { captureAlipayRefundCredits, creditAlipayPurchase, releaseAlipayRefundCredits, reserveAlipayRefundCredits } from './ledger.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandboxConfigPath = path.join(projectRoot, '.alipay-sandbox.json');
const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const PRODUCTION_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const PAID_STATES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);
const YUAN_PER_CREDIT = 0.1;
export const ALIPAY_CREDIT_PACKAGES = Object.freeze([10, 50, 100, 500]);

function paymentError(message, statusCode = 400, publicData = null) {
  return Object.assign(new Error(message), { statusCode, ...(publicData ? { publicData } : {}) });
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw paymentError(`支付宝${label}未配置`, 503);
  return text;
}

function envText(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function configuredEnvCredentials(env) {
  const appId = envText(env, 'ALIPAY_APP_ID', 'AIPAY_APP_ID');
  const privateKey = envText(env, 'ALIPAY_APP_PRIVATE_KEY', 'ALIPAY_PRIVATE_PKCS_KEY', 'AIPAY_PRIVATE_PKCS_KEY', 'ALIPAY_PRIVATE_KEY', 'AIPAY_PRIVATE_KEY');
  const alipayPublicKey = envText(env, 'ALIPAY_ALIPAY_PUBLIC_KEY', 'AIPAY_ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY');
  if (!appId && !privateKey && !alipayPublicKey) return null;
  return { appId, privateKey, alipayPublicKey };
}

function validatePkcs1PrivateKey(value) {
  const privateKey = String(value || '').trim();
  if (!privateKey || /需自行配置|请填写|placeholder|^<?app_private_key>?$/i.test(privateKey)) {
    throw paymentError('支付宝应用私钥未配置：Node.js 请将同一生产应用的 PKCS#1 原始私钥填写到 AIPAY_PRIVATE_PKCS_KEY', 503);
  }
  if (/-----BEGIN|-----END/.test(privateKey) || /\s/.test(privateKey)) {
    throw paymentError('支付宝应用私钥格式错误：AIPAY_PRIVATE_PKCS_KEY 必须是不含 PEM 头尾和换行的 PKCS#1 原始私钥', 503);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(privateKey)) {
    throw paymentError('支付宝应用私钥格式错误：请使用支付宝开放平台密钥工具转换并复制 PKCS#1 原始私钥', 503);
  }
  try {
    createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs1' });
  } catch {
    throw paymentError('支付宝应用私钥无法解析：Node.js 需要 PKCS#1 格式，请使用支付宝开放平台密钥工具转换后重新配置', 503);
  }
  return privateKey;
}

export function loadAlipayConfig(env = process.env) {
  const mode = envText(env, 'ALIPAY_ENV', 'AIPAY_ENV').toLowerCase() === 'production' ? 'production' : 'sandbox';
  const envCredentials = configuredEnvCredentials(env);
  if (envCredentials) {
    const config = {
      mode,
      appId: requiredText(envCredentials.appId, '应用 ID'),
      privateKey: requiredText(envCredentials.privateKey, 'PKCS#1 应用私钥'),
      alipayPublicKey: requiredText(envCredentials.alipayPublicKey, '支付宝公钥'),
      sellerId: envText(env, 'ALIPAY_SELLER_ID', 'AIPAY_SELLER_ID'),
      sellerEmail: envText(env, 'ALIPAY_SELLER_EMAIL', 'AIPAY_SELLER_EMAIL'),
      gateway: envText(env, 'ALIPAY_GATEWAY', 'AIPAY_GATEWAY') || (mode === 'production' ? PRODUCTION_GATEWAY : SANDBOX_GATEWAY),
      configPath: null,
    };
    if (mode === 'production' && !config.sellerId && !config.sellerEmail) throw paymentError('支付宝商家 ID 或商家邮箱至少配置一项', 503);
    return config;
  }

  if (mode === 'production') throw paymentError('支付宝生产应用参数未配置', 503);

  let sandbox;
  try {
    sandbox = JSON.parse(readFileSync(sandboxConfigPath, 'utf8'));
  } catch {
    throw paymentError('支付宝沙箱配置不可用，请重新执行沙箱配置校验', 503);
  }
  const app = sandbox?.appIds?.[0];
  const seller = sandbox?.sandboxAccounts?.partner;
  return {
    mode: 'sandbox',
    appId: requiredText(app?.appId, '沙箱应用 ID'),
    privateKey: requiredText(app?.appPrivatePkcsKey, '沙箱 PKCS#1 应用私钥'),
    alipayPublicKey: requiredText(app?.alipayPublicKey, '沙箱公钥'),
    sellerId: requiredText(app?.pid || seller?.userId, '沙箱商家 ID'),
    sellerEmail: String(seller?.email || '').trim(),
    gateway: SANDBOX_GATEWAY,
    configPath: sandboxConfigPath,
  };
}

export function createAlipayClient(env = process.env) {
  const config = loadAlipayConfig(env);
  config.privateKey = validatePkcs1PrivateKey(config.privateKey);
  return {
    config,
    sdk: new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      alipayPublicKey: config.alipayPublicKey,
      gateway: config.gateway,
      signType: 'RSA2',
      keyType: 'PKCS1',
      camelcase: false,
    }),
  };
}

export function amountTextFromFen(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw paymentError('支付金额无效');
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

export function amountFenFromText(value, label = '金额') {
  const match = String(value ?? '').trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) throw paymentError(`${label}格式不正确`);
  const fen = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(fen) || fen <= 0) throw paymentError(`${label}必须大于 0`);
  return fen;
}

function creditsAndAmount(credits, env = process.env) {
  const numericCredits = Number(credits);
  if (!ALIPAY_CREDIT_PACKAGES.includes(numericCredits)) {
    throw paymentError(`请选择有效的积分商品：${ALIPAY_CREDIT_PACKAGES.join('、')} 积分`);
  }
  const configuredRate = Number(env.ALIPAY_YUAN_PER_CREDIT || env.YUAN_PER_CREDIT || YUAN_PER_CREDIT);
  if (!Number.isFinite(configuredRate) || Math.abs(configuredRate - YUAN_PER_CREDIT) > Number.EPSILON) {
    throw paymentError('积分人民币换算比例必须配置为 0.1 元/积分', 503);
  }
  const totalAmountFen = numericCredits * 10;
  if (!Number.isSafeInteger(totalAmountFen) || totalAmountFen < 1) throw paymentError('充值金额无效');
  return { credits: numericCredits, creditsMicro: creditsToMicro(numericCredits), totalAmountFen };
}

export function publicCreditPackages(env = process.env) {
  creditsAndAmount(ALIPAY_CREDIT_PACKAGES[0], env);
  return {
    yuanPerCredit: YUAN_PER_CREDIT,
    packages: ALIPAY_CREDIT_PACKAGES.map(credits => ({
      credits,
      amount: amountTextFromFen(credits * 10),
      amountFen: credits * 10,
    })),
  };
}

function orderNumber(prefix = 'GUGU') {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `${prefix}${stamp}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    outTradeNo: row.out_trade_no,
    userId: row.user_id,
    status: row.status,
    subject: row.subject,
    totalAmount: amountTextFromFen(row.total_amount_fen),
    totalAmountFen: row.total_amount_fen,
    credits: microToCredits(row.credits_micro),
    creditsMicro: row.credits_micro,
    refundedAmount: amountTextFromFen(row.refunded_amount_fen),
    refundedAmountFen: row.refunded_amount_fen,
    tradeNo: row.alipay_trade_no || null,
    paidAt: row.paid_at || null,
    closedAt: row.closed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findOrder(outTradeNo) {
  return sql('SELECT * FROM alipay_payment_orders WHERE out_trade_no = :outTradeNo').get({ outTradeNo });
}

function findOwnedOrder(userId, outTradeNo) {
  const row = sql('SELECT * FROM alipay_payment_orders WHERE user_id = :userId AND out_trade_no = :outTradeNo')
    .get({ userId, outTradeNo });
  if (!row) throw paymentError('支付订单不存在', 404);
  return row;
}

function writeOrder(row) {
  sql(`
    UPDATE alipay_payment_orders
    SET status = :status,
        refunded_amount_fen = :refundedAmountFen,
        alipay_trade_no = :tradeNo,
        paid_at = :paidAt,
        closed_at = :closedAt,
        updated_at = :updatedAt,
        doc_json = :docJson
    WHERE out_trade_no = :outTradeNo
  `).run({
    outTradeNo: row.out_trade_no,
    status: row.status,
    refundedAmountFen: row.refunded_amount_fen,
    tradeNo: row.alipay_trade_no || null,
    paidAt: row.paid_at || null,
    closedAt: row.closed_at || null,
    updatedAt: row.updated_at,
    docJson: JSON.stringify(rowToOrder(row)),
  });
}

function updateFromProviderState(row, providerState, tradeNo = null) {
  if (PAID_STATES.has(providerState)) row.status = 'PAID';
  else if (providerState === 'TRADE_CLOSED') row.status = row.refunded_amount_fen >= row.total_amount_fen ? 'REFUNDED' : 'CLOSED';
  else if (providerState === 'WAIT_BUYER_PAY') row.status = 'PENDING_PAYMENT';
  else row.status = 'UNKNOWN';
  if (tradeNo) row.alipay_trade_no = tradeNo;
  row.updated_at = new Date().toISOString();
  writeOrder(row);
}

function providerFailure(result, operation) {
  const code = String(result?.sub_code || result?.code || 'UNKNOWN');
  const detail = String(result?.sub_msg || result?.msg || '支付宝未返回明确结果');
  throw paymentError(`${operation}失败：${detail}`, 502, { providerCode: code });
}

function assertProviderOrder(row, result) {
  if (result.out_trade_no && result.out_trade_no !== row.out_trade_no) throw paymentError('支付宝返回的商户订单号不匹配', 502);
  if (result.total_amount && amountFenFromText(result.total_amount, '支付宝订单金额') !== row.total_amount_fen) {
    throw paymentError('支付宝返回的订单金额不匹配', 502);
  }
}

async function settlePaidOrder(row, tradeNo, receivedAt = new Date().toISOString(), onCredited = null) {
  return creditAlipayPurchase(row.user_id, row.out_trade_no, row.credits_micro, {
    onCredited: context => {
      row.status = 'PAID';
      row.alipay_trade_no = tradeNo || row.alipay_trade_no;
      row.paid_at = row.paid_at || receivedAt;
      row.updated_at = receivedAt;
      writeOrder(row);
      onCredited?.(context);
    },
  });
}

export function publicReturnUrl(env = process.env, port = 4317) {
  const configured = envText(env, 'ALIPAY_RETURN_URL', 'AIPAY_RETURN_URL');
  if (configured) return new URL(configured).href;
  const publicBaseUrl = envText(env, 'PUBLIC_BASE_URL');
  if (publicBaseUrl) return new URL('/payments/alipay/return', publicBaseUrl).href;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw paymentError('生产环境必须配置 ALIPAY_RETURN_URL', 503);
  }
  return `http://127.0.0.1:${port}/payments/alipay/return`;
}

export function publicNotifyUrl(env = process.env) {
  const configured = envText(env, 'ALIPAY_NOTIFY_URL', 'AIPAY_NOTIFY_URL');
  if (configured) return new URL(configured).href;
  const publicBaseUrl = envText(env, 'PUBLIC_BASE_URL');
  return publicBaseUrl ? new URL('/api/payments/alipay/notify', publicBaseUrl).href : '';
}

export async function createPaymentOrder({ userId, credits, returnUrl, notifyUrl = '', env = process.env }) {
  const priced = creditsAndAmount(credits, env);
  const { sdk } = createAlipayClient(env);
  const createdAt = new Date().toISOString();
  const outTradeNo = orderNumber();
  const subject = `GuGu AI ${priced.credits} 积分`;
  const row = {
    out_trade_no: outTradeNo,
    user_id: userId,
    status: 'PENDING_PAYMENT',
    subject,
    total_amount_fen: priced.totalAmountFen,
    credits_micro: priced.creditsMicro,
    refunded_amount_fen: 0,
    alipay_trade_no: null,
    paid_at: null,
    closed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  sql(`
    INSERT INTO alipay_payment_orders(out_trade_no, user_id, status, subject, total_amount_fen, credits_micro,
                                      refunded_amount_fen, created_at, updated_at, doc_json)
    VALUES(:outTradeNo, :userId, :status, :subject, :totalAmountFen, :creditsMicro,
           0, :createdAt, :createdAt, :docJson)
  `).run({
    outTradeNo,
    userId,
    status: row.status,
    subject,
    totalAmountFen: row.total_amount_fen,
    creditsMicro: row.credits_micro,
    createdAt,
    docJson: JSON.stringify(rowToOrder(row)),
  });

  const request = {
    returnUrl: String(returnUrl || '').trim(),
    bizContent: {
      out_trade_no: outTradeNo,
      total_amount: amountTextFromFen(row.total_amount_fen),
      subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    },
  };
  if (String(notifyUrl || '').trim()) request.notifyUrl = String(notifyUrl).trim();
  let paymentHtml;
  try {
    paymentHtml = await sdk.pageExec('alipay.trade.page.pay', 'POST', request);
  } catch (error) {
    row.status = 'UNKNOWN';
    row.updated_at = new Date().toISOString();
    writeOrder(row);
    throw error;
  }
  if (!String(paymentHtml || '').includes('<form')) {
    row.status = 'UNKNOWN';
    row.updated_at = new Date().toISOString();
    writeOrder(row);
    throw paymentError('创建支付宝收银台失败：未生成支付表单', 502);
  }
  return { order: rowToOrder(row), paymentHtml: String(paymentHtml), returnUrl };
}

export function paymentOrderForUser(userId, outTradeNo) {
  return rowToOrder(findOwnedOrder(userId, outTradeNo));
}

export async function queryPaymentOrder(userId, outTradeNo, env = process.env) {
  const row = findOwnedOrder(userId, outTradeNo);
  const { sdk } = createAlipayClient(env);
  const result = await sdk.exec('alipay.trade.query', { bizContent: { out_trade_no: row.out_trade_no } });
  if (result.code !== '10000') {
    if (row.status === 'PENDING_PAYMENT' && result.sub_code === 'ACQ.TRADE_NOT_EXIST') {
      return { order: rowToOrder(row), providerStatus: 'TRADE_NOT_EXIST' };
    }
    providerFailure(result, '查询支付订单');
  }
  assertProviderOrder(row, result);
  if (PAID_STATES.has(result.trade_status)) await settlePaidOrder(row, result.trade_no);
  else updateFromProviderState(row, result.trade_status, result.trade_no);
  return { order: rowToOrder(findOrder(row.out_trade_no)), providerStatus: result.trade_status || 'UNKNOWN' };
}

export async function closePaymentOrder(userId, outTradeNo, env = process.env) {
  const queried = await queryPaymentOrder(userId, outTradeNo, env);
  if (queried.order.status === 'PAID') throw paymentError('订单已经支付，不能关闭', 409);
  if (queried.order.status === 'CLOSED') return queried;
  const row = findOwnedOrder(userId, outTradeNo);
  const { sdk } = createAlipayClient(env);
  const result = await sdk.exec('alipay.trade.close', { bizContent: { out_trade_no: row.out_trade_no } });
  if (result.code !== '10000') providerFailure(result, '关闭支付订单');
  row.status = 'CLOSED';
  row.alipay_trade_no = result.trade_no || row.alipay_trade_no;
  row.closed_at = new Date().toISOString();
  row.updated_at = row.closed_at;
  writeOrder(row);
  return { order: rowToOrder(row), providerStatus: 'TRADE_CLOSED' };
}

function insertRefund(row) {
  sql(`
    INSERT INTO alipay_refunds(out_request_no, out_trade_no, amount_fen, status, reason, created_at, updated_at, doc_json)
    VALUES(:outRequestNo, :outTradeNo, :amountFen, :status, :reason, :createdAt, :createdAt, :docJson)
  `).run({
    outRequestNo: row.outRequestNo,
    outTradeNo: row.outTradeNo,
    amountFen: row.amountFen,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt,
    docJson: JSON.stringify(row),
  });
}

function refundCreditsMicro(order, amountFen) {
  const totalFen = BigInt(order.total_amount_fen);
  const creditsMicro = BigInt(order.credits_micro);
  const roundedAt = refundedFen => (creditsMicro * BigInt(refundedFen) + totalFen / 2n) / totalFen;
  const value = Number(roundedAt(order.refunded_amount_fen + amountFen) - roundedAt(order.refunded_amount_fen));
  if (!Number.isSafeInteger(value) || value <= 0) throw paymentError('退款对应积分无效', 409);
  return value;
}

function writeRefund(row) {
  sql(`UPDATE alipay_refunds SET status = :status, updated_at = :updatedAt, doc_json = :docJson WHERE out_request_no = :outRequestNo`)
    .run({ status: row.status, updatedAt: row.updatedAt, docJson: JSON.stringify(row), outRequestNo: row.outRequestNo });
}

export async function refundPaymentOrder(userId, outTradeNo, input = {}, env = process.env) {
  const order = findOwnedOrder(userId, outTradeNo);
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.status)) throw paymentError('只有已支付订单可以退款', 409);
  const remainingFen = order.total_amount_fen - order.refunded_amount_fen;
  const amountFen = input.amount == null || input.amount === '' ? remainingFen : amountFenFromText(input.amount, '退款金额');
  if (amountFen > remainingFen) throw paymentError('退款金额不能超过订单剩余可退金额');
  const createdAt = new Date().toISOString();
  const refund = {
    outRequestNo: orderNumber('GUGUR'),
    outTradeNo: order.out_trade_no,
    amountFen,
    amount: amountTextFromFen(amountFen),
    creditsMicro: refundCreditsMicro(order, amountFen),
    reason: String(input.reason || '用户申请退款').trim().slice(0, 200),
    status: 'PENDING',
    createdAt,
    updatedAt: createdAt,
  };
  await reserveAlipayRefundCredits(userId, refund.outRequestNo, refund.creditsMicro);
  insertRefund(refund);
  const { sdk } = createAlipayClient(env);
  const result = await sdk.exec('alipay.trade.refund', {
    bizContent: {
      out_trade_no: order.out_trade_no,
      refund_amount: refund.amount,
      refund_reason: refund.reason,
      out_request_no: refund.outRequestNo,
    },
  });
  if (result.code !== '10000') {
    refund.status = 'FAILED';
    refund.updatedAt = new Date().toISOString();
    writeRefund(refund);
    await releaseAlipayRefundCredits(userId, refund.outRequestNo);
    providerFailure(result, '退款');
  }
  refund.status = result.fund_change === 'Y' ? 'SUCCESS' : 'UNKNOWN';
  refund.updatedAt = new Date().toISOString();
  writeRefund(refund);
  if (refund.status === 'SUCCESS') {
    await captureAlipayRefundCredits(userId, refund.outRequestNo);
    applyRefundSuccess(order, amountFen);
  }
  return { refund, order: rowToOrder(findOrder(order.out_trade_no)), fundChange: result.fund_change || null };
}

function applyRefundSuccess(order, amountFen) {
  order.refunded_amount_fen = Math.min(order.total_amount_fen, order.refunded_amount_fen + amountFen);
  order.status = order.refunded_amount_fen === order.total_amount_fen ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  order.updated_at = new Date().toISOString();
  writeOrder(order);
}

export async function queryPaymentRefund(userId, outTradeNo, outRequestNo, env = process.env) {
  const order = findOwnedOrder(userId, outTradeNo);
  const row = sql('SELECT doc_json FROM alipay_refunds WHERE out_trade_no = :outTradeNo AND out_request_no = :outRequestNo')
    .get({ outTradeNo, outRequestNo });
  if (!row) throw paymentError('退款记录不存在', 404);
  const refund = JSON.parse(row.doc_json);
  const { sdk } = createAlipayClient(env);
  const result = await sdk.exec('alipay.trade.fastpay.refund.query', {
    bizContent: { out_trade_no: order.out_trade_no, out_request_no: outRequestNo },
  });
  if (result.code !== '10000') providerFailure(result, '查询退款');
  const wasSuccess = refund.status === 'SUCCESS';
  refund.status = result.refund_status === 'REFUND_SUCCESS' ? 'SUCCESS' : 'UNKNOWN';
  refund.updatedAt = new Date().toISOString();
  writeRefund(refund);
  if (!wasSuccess && refund.status === 'SUCCESS') {
    await captureAlipayRefundCredits(userId, refund.outRequestNo);
    applyRefundSuccess(order, refund.amountFen);
  }
  return { refund, order: rowToOrder(findOrder(order.out_trade_no)), providerStatus: result.refund_status || 'UNKNOWN' };
}

function notifyParamsWithoutSignature(params) {
  const { sign, ...safe } = params;
  return safe;
}

function paidNotification(params) {
  return PAID_STATES.has(params.trade_status) && !params.out_biz_no && !params.gmt_refund && !params.refund_fee;
}

function notificationBusinessMatches(order, params, config) {
  const amountMatches = amountFenFromText(params.total_amount, '通知金额') === order.total_amount_fen;
  const sellerMatches = Boolean(
    (config.sellerId && params.seller_id === config.sellerId)
      || (config.sellerEmail && params.seller_email === config.sellerEmail),
  );
  return params.app_id === config.appId
    && params.out_trade_no === order.out_trade_no
    && amountMatches
    && sellerMatches;
}

export async function handleAlipayNotification(params, env = process.env) {
  const { sdk, config } = createAlipayClient(env);
  if (!sdk.checkNotifySignV2(params)) throw paymentError('支付宝通知验签失败', 400);
  const order = findOrder(String(params.out_trade_no || ''));
  if (!order || !notificationBusinessMatches(order, params, config)) throw paymentError('支付宝通知业务字段校验失败', 400);
  const notifyId = requiredText(params.notify_id, '通知 ID');
  const receivedAt = new Date().toISOString();
  const insertEvent = () => sql(`
    INSERT OR IGNORE INTO alipay_notify_events(notify_id, out_trade_no, trade_no, trade_status, event_kind, received_at, params_json)
    VALUES(:notifyId, :outTradeNo, :tradeNo, :tradeStatus, :eventKind, :receivedAt, :paramsJson)
  `).run({
    notifyId,
    outTradeNo: order.out_trade_no,
    tradeNo: params.trade_no || null,
    tradeStatus: params.trade_status || null,
    eventKind: paidNotification(params) ? 'PAYMENT_SUCCESS' : 'NON_PAYMENT',
    receivedAt,
    paramsJson: JSON.stringify(notifyParamsWithoutSignature(params)),
  });

  const existing = sql('SELECT notify_id FROM alipay_notify_events WHERE notify_id = :notifyId').get({ notifyId });
  if (existing) return { replay: true, order: rowToOrder(order) };

  if (paidNotification(params)) {
    await settlePaidOrder(order, params.trade_no, receivedAt, insertEvent);
  } else {
    tx(() => {
      insertEvent();
      updateFromProviderState(order, params.trade_status, params.trade_no);
    });
  }
  return { replay: false, order: rowToOrder(findOrder(order.out_trade_no)) };
}

export function paymentReturnPage({ order = null, error = '' } = {}) {
  const state = order?.status || 'UNKNOWN';
  const title = state === 'PAID' ? '支付已确认' : state === 'PENDING_PAYMENT' ? '正在确认支付结果' : state === 'CLOSED' ? '订单已关闭' : '支付结果待确认';
  const detail = error || (state === 'PAID'
    ? `${order.credits} 积分已到账，可以返回 GuGu AI 继续创作。`
    : '同步回跳不代表支付成功，请返回 GuGu AI 后刷新订单状态。');
  const safe = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const pricingHref = order?.outTradeNo ? `/pricing?order=${encodeURIComponent(order.outTradeNo)}` : '/pricing';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)} · GuGu AI</title><style>html{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6fa;color:#1d2130;font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif}.card{width:min(480px,calc(100% - 40px));box-sizing:border-box;padding:38px;border:1px solid #dfe3ef;border-radius:22px;background:#fff;box-shadow:0 24px 70px rgba(28,35,64,.12)}.mark{width:48px;height:48px;display:grid;place-items:center;border-radius:15px;background:#1677ff;color:#fff;font-size:24px;font-weight:800}h1{margin:22px 0 8px;font-size:26px}p{margin:0;color:#687087}.order{margin-top:20px;padding-top:16px;border-top:1px solid #edf0f6;color:#9299aa;font:12px ui-monospace,SFMono-Regular,monospace}.actions{display:flex;gap:10px;margin-top:26px}.actions a{flex:1;padding:11px 14px;border-radius:10px;text-align:center;text-decoration:none}.primary{background:#1677ff;color:#fff}.secondary{border:1px solid #dfe3ef;color:#343a4d}</style></head><body><main class="card"><div class="mark">支</div><h1>${safe(title)}</h1><p>${safe(detail)}</p>${order ? `<div class="order">订单 ${safe(order.outTradeNo)}</div>` : ''}<div class="actions"><a class="primary" href="/">返回 GuGu AI</a><a class="secondary" href="${safe(pricingHref)}">查看订单</a></div></main></body></html>`;
}

export const __test = { creditsAndAmount, paidNotification, notificationBusinessMatches, rowToOrder, validatePkcs1PrivateKey };
