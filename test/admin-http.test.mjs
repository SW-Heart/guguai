import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { adjustCredits, chargeGenerationMicro, refundGenerationMicro, configureLedger, reserveLlmCredits, settleLlmCredits } from '../lib/ledger.mjs';
import { llmRatesFromEnv } from '../lib/billing.mjs';
import { appendSystemEvent } from '../lib/audit.mjs';
import { insertUser } from '../lib/store.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitForServer(child, port) {
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(`GuGu AI: ${base}`)) { clearTimeout(timer); resolve(base); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}：${output}`)); });
  });
}

function client(base) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (cookie) requestHeaders.Cookie = cookie;
    const response = await fetch(base + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await response.json(); } catch {}
    return { response, data, cookie };
  };
  return { call, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

test('admin HTTP permissions and core workflows', async t => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'admin-http-'));
  const port = await freePort();
  const adminId = randomUUID();
  const refundedUserId = randomUUID();
  const phoneUserId = randomUUID();
  const adminPassword = 'admin-http-password-123';
  resetForTests();
  openDatabase({ file: path.join(workDir, 'studio.db') });
  const createdAt = new Date().toISOString();
  insertUser({ id: adminId, username: 'http_admin', role: 'admin', status: 'active', passwordHash: await hashPassword(adminPassword), credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  insertUser({ id: refundedUserId, username: 'refunded_user', nickname: '退款用户', role: 'user', status: 'active', passwordHash: 'scrypt:x:y', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  insertUser({ id: phoneUserId, username: '13800138000', phoneNumber: '13800138000', nickname: '手机号用户', role: 'user', status: 'active', passwordHash: 'scrypt:x:y', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  await adjustCredits(refundedUserId, 10_000_000, { actorUserId: adminId, idempotencyKey: 'seed-refund-user-balance', reasonCode: 'promotion' });
  await chargeGenerationMicro(refundedUserId, 'failed-generation-refund', 5_000_000);
  await refundGenerationMicro(refundedUserId, 'failed-generation-refund', 5_000_000);
  const taskId = 'admin-task-filter';
  sql(`INSERT INTO generations(id, user_id, type, status, created_at, updated_at, doc_json)
       VALUES(:id, :userId, 'video', 'failed', :createdAt, :createdAt, :docJson)`)
    .run({ id: taskId, userId: refundedUserId, createdAt, docJson: JSON.stringify({ id: taskId, status: 'failed' }) });
  await chargeGenerationMicro(refundedUserId, taskId, 1_000_000);
  await refundGenerationMicro(refundedUserId, taskId, 1_000_000);
  configureLedger({ llmRates:llmRatesFromEnv({ LLM_CACHE_READ_PRICE_YUAN_PER_MILLION:'0.3', LLM_CACHE_CREATION_PRICE_YUAN_PER_MILLION:'3.75' }), llmProtocol:'openai-compatible', llmModel:'cache-test' });
  await adjustCredits(phoneUserId, 1_000_000, { actorUserId:adminId, idempotencyKey:'seed-cache-user-balance', reasonCode:'promotion' });
  await reserveLlmCredits(phoneUserId, 'http-cached-usage', 1_000_000);
  await settleLlmCredits(phoneUserId, 'http-cached-usage', { model:'cache-test', usage:{ inputTokens:1000, outputTokens:20, cacheReadTokens:600, cacheCreationTokens:300 } });
  sql(`INSERT INTO llm_usage(id, user_id, status, model, input_tokens, output_tokens, charged_micro, created_at, doc_json)
       VALUES('http-legacy-usage', :userId, 'settled', 'cache-test', 100, 20, 4200, :createdAt, '{}')`).run({userId:phoneUserId, createdAt});
  appendSystemEvent({ level: 'error', category: 'generation', userId: refundedUserId, generationId: taskId, message: '任务失败测试日志' });
  const paymentDoc = JSON.stringify({ source: 'admin-http-test' });
  sql(`INSERT INTO alipay_payment_orders(out_trade_no, user_id, status, subject, total_amount_fen, credits_micro, refunded_amount_fen, alipay_trade_no, paid_at, created_at, updated_at, doc_json)
       VALUES('ORDER-PAID-1', :userId, 'PAID', 'GuGu AI 50 积分', 500, 50000000, 0, 'ALI-PAID-1', '2026-08-20T10:00:00.000Z', '2026-08-20T09:59:00.000Z', '2026-08-20T10:00:00.000Z', :docJson),
             ('ORDER-REFUNDED-1', :userId, 'REFUNDED', 'GuGu AI 20 积分', 200, 20000000, 200, 'ALI-REFUNDED-1', '2026-08-21T10:00:00.000Z', '2026-08-21T09:59:00.000Z', '2026-08-21T10:00:00.000Z', :docJson),
             ('ORDER-PENDING-1', :userId, 'PENDING_PAYMENT', 'GuGu AI 10 积分', 100, 10000000, 0, NULL, NULL, '2026-08-22T09:59:00.000Z', '2026-08-22T09:59:00.000Z', :docJson)`)
    .run({ userId: refundedUserId, docJson: paymentDoc });
  closeDatabase({ checkpoint: false });

  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env: { ...process.env, NODE_ENV: 'development', GUGU_TEST_ALLOW_BROWSER_WORKSPACE:'1', DIW_KEY:'test-diw', DATA_DIR: workDir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); rmSync(workDir, { recursive: true, force: true }); });
  const base = await waitForServer(child, port);
  const admin = client(base);
  const unauth = await admin.call('/api/admin/auth/session');
  assert.equal(unauth.response.status, 401);
  const page = await fetch(`${base}/guguadmin`);
  assert.equal(page.status, 200);
  const adminHtml = await page.text();
  assert.match(adminHtml, /管理后台/);
  assert.match(adminHtml, /guguadmin\.js\?v=30/);

  const login = await admin.call('/api/admin/auth/login', { method: 'POST', headers: { Origin: base }, body: { username: 'http_admin', password: adminPassword } });
  assert.equal(login.response.status, 200);
  assert.ok(login.data.csrfToken);
  const csrf = login.data.csrfToken;

  const models = await admin.call('/api/admin/models');
  assert.equal(models.response.status, 200);
  assert.ok(models.data.items.some(item => item.modelId === 'grok'));
  const routes = await admin.call('/api/admin/model-routes');
  assert.equal(routes.response.status, 200);
  assert.ok(routes.data.channels.some(item => item.id === 'diw-main'));
  const deletingRoute = routes.data.items[0];
  const deletePath = `/api/admin/model-routes/${deletingRoute.id}`;
  assert.equal((await admin.call(deletePath, { method: 'DELETE', body: { expectedVersion: deletingRoute.version } })).response.status, 403);
  assert.equal((await admin.call(deletePath, { method: 'DELETE', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { expectedVersion: deletingRoute.version + 1 } })).response.status, 409);
  assert.equal((await admin.call(deletePath, { method: 'DELETE', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { expectedVersion: deletingRoute.version } })).response.status, 200);
  assert.ok(!(await admin.call('/api/admin/model-routes')).data.items.some(item => item.id === deletingRoute.id));

  const overviewAfterRefund = await admin.call('/api/admin/overview');
  assert.equal(overviewAfterRefund.data.credits.spent, 0.01725);
  const paidOrders = await admin.call('/api/admin/payment-orders');
  assert.equal(paidOrders.response.status, 200);
  assert.deepEqual(paidOrders.data.items.map(item => item.orderNo), ['ORDER-REFUNDED-1', 'ORDER-PAID-1']);
  assert.deepEqual(paidOrders.data.summary, { payingUsers: 1, totalAmount: 7, refundedAmount: 2, netAmount: 5 });
  assert.equal(paidOrders.data.items[1].username, 'refunded_user');
  assert.equal(paidOrders.data.items[1].tradeNo, 'ALI-PAID-1');
  const searchedPaidOrders = await admin.call('/api/admin/payment-orders?query=ALI-PAID-1');
  assert.deepEqual(searchedPaidOrders.data.items.map(item => item.orderNo), ['ORDER-PAID-1']);
  const rangedPaidOrders = await admin.call('/api/admin/payment-orders?from=2026-08-21T00%3A00%3A00.000Z');
  assert.deepEqual(rangedPaidOrders.data.items.map(item => item.orderNo), ['ORDER-REFUNDED-1']);
  const refundedUser = await admin.call('/api/admin/users?query=refunded_user');
  assert.equal(refundedUser.data.items[0].totalSpent, 0);
  const phoneUser = await admin.call('/api/admin/users?query=13800138000');
  assert.deepEqual({ nickname: phoneUser.data.items[0].nickname, phoneNumber: phoneUser.data.items[0].phoneNumber }, { nickname: '手机号用户', phoneNumber: '13800138000' });
  const refundedUserDetail = await admin.call(`/api/admin/users/${refundedUserId}`);
  assert.equal(refundedUserDetail.data.user.totalSpent, 0);
  const createdRoute = await admin.call('/api/admin/model-routes', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { logicalModelId: 'seedance-2.0', quality: '720p', credentialId: 'diw-main', upstreamModelId: 'http-test-upstream', durations:[5,7,15], priority: 99, costYuan: 1.1, salePriceYuan: 2.2, adminEnabled: false } });
  assert.equal(createdRoute.response.status, 201);
  assert.equal(createdRoute.data.route.salePriceYuan, 2.2);
  assert.equal(createdRoute.data.route.adminEnabled, false);
  assert.deepEqual(createdRoute.data.route.durations, [5,7,15]);
  const editedRoute = await admin.call('/api/admin/model-routes/' + createdRoute.data.route.id, { method:'PATCH', headers:{ Origin:base, 'X-CSRF-Token':csrf }, body:{ durations:[30], expectedVersion:createdRoute.data.route.version } });
  assert.equal(editedRoute.response.status, 200);
  assert.deepEqual(editedRoute.data.route.durations, [30]);
  assert.equal(editedRoute.data.route.salePriceYuan, 2.2);
  const noCsrf = await admin.call('/api/admin/pricing', { method: 'POST', headers: { Origin: base }, body: { imagePerRequest: '1.5', videoPerSecond: '0.8', expectedVersion: 1 } });
  assert.equal(noCsrf.response.status, 403);
  const pricing = await admin.call('/api/admin/pricing', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { imagePerRequest: '1.5', videoPerSecond: '0.8', modelPrices:{ 'grok:720p':2.75, 'gpt-image-2.5:2k':0.125, 'llm:input':1.2, 'llm:cache-read':0, 'llm:cache-creation':2.5, 'minimax-h3-15s:768p':0.8, 'minimax-h3-15s:480p':0.5 }, expectedVersion: 1 } });
  assert.equal(pricing.response.status, 201);
  assert.equal(pricing.data.pricing.videoPerSecond, 0.8);
  const priceFields = await admin.call('/api/admin/pricing');
  assert.equal(priceFields.data.fields.find(item => item.key === 'gpt-image-2.5:2k').amount, 0.125);
  assert.equal(priceFields.data.fields.find(item => item.key === 'llm:cache-read').amount, 0);
  assert.equal(priceFields.data.fields.find(item => item.key === 'llm:cache-creation').amount, 2.5);
  const usageLogs = await admin.call(`/api/admin/logs/llm?userId=${phoneUserId}&modelId=cache-test`);
  assert.equal(usageLogs.response.status, 200);
  const cacheUsage = usageLogs.data.items.find(item => item.id === 'http-cached-usage');
  assert.equal(cacheUsage.inputTokens, 1000);
  assert.equal(cacheUsage.uncachedInputTokens, 100);
  assert.equal(cacheUsage.cacheReadTokens, 600);
  assert.equal(cacheUsage.cacheCreationTokens, 300);
  assert.equal(cacheUsage.cacheReadRateYuanPerMillion, 0.3);
  assert.equal(cacheUsage.cacheCreationRateYuanPerMillion, 3.75);
  assert.equal(cacheUsage.charged, 0.01725);
  const legacyUsage = usageLogs.data.items.find(item => item.id === 'http-legacy-usage');
  assert.equal(legacyUsage.cacheReadTokens, null);
  assert.equal(legacyUsage.cacheCreationTokens, null);
  assert.equal(legacyUsage.uncachedInputTokens, 100);

  const invite = await admin.call('/api/admin/invite-codes', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { code: 'HTTP-TEST-01', maxUses: 1, signupBonus: '4.5' } });
  assert.equal(invite.response.status, 201);
  const userResponse = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'http_user', password: 'user-password-123', inviteCode: 'ignored' }) });
  const userData = await userResponse.json();
  assert.equal(userResponse.status, 201);
  assert.equal(userData.user.credits, 0);
  const userCookie = userResponse.headers.get('set-cookie').split(';')[0];

  const userClient = client(base); userClient.cookie = userCookie;
  const quote = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId:'grok', generationType:'TEXT', quality:'720p', duration:10, aspectRatio:'16:9' } });
  assert.equal(quote.response.status, 200);
  assert.equal(quote.data.credits, 27.5);
  await t.test('saved MiniMax prices override defaults until a new version updates config, catalog and quotes', async () => {
    const modelId = 'minimax-h3-15s';
    const oldConfig = await userClient.call('/api/config');
    assert.equal(oldConfig.data.modelPrices.find(item => item.modelId === modelId && item.quality === '768p').credits, 0.8);
    const oldQuote = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId, generationType:'TEXT', quality:'768p', duration:5 } });
    assert.equal(oldQuote.response.status, 200);
    assert.equal(oldQuote.data.credits, 4);
    const updated = await admin.call('/api/admin/pricing', {
      method:'POST', headers:{ Origin:base, 'X-CSRF-Token':csrf },
      body:{ imagePerRequest:pricing.data.pricing.imagePerRequest, videoPerSecond:pricing.data.pricing.videoPerSecond,
        expectedVersion:pricing.data.pricing.version, modelPrices:{ [`${modelId}:480p`]:0.5, [`${modelId}:768p`]:0.6 } },
    });
    assert.equal(updated.response.status, 201);
    assert.equal(updated.data.pricing.modelPrices['grok:720p'], 2.75);
    assert.equal(updated.data.pricing.imagePerRequest, 1.5);
    assert.equal(updated.data.pricing.videoPerSecond, 0.8);
    const config = await userClient.call('/api/config');
    const catalog = await userClient.call('/api/public/model-prices');
    assert.equal(config.data.pricing.version, updated.data.pricing.version);
    assert.equal(catalog.data.pricingVersion, updated.data.pricing.version);
    for (const [quality, amount] of [['480p', 0.5], ['768p', 0.6]]) {
      assert.equal(config.data.modelPrices.find(item => item.modelId === modelId && item.quality === quality).credits, amount);
      assert.equal(catalog.data.items.find(item => item.modelId === modelId && item.quality === quality).credits, amount);
      const model = config.data.videoCapabilities.models.find(item => item.id === modelId);
      for (const mode of model.modes) {
        assert.equal(mode.pricingByQuality[quality].amount, amount);
        const result = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId, generationType:mode.generationType, quality, duration:5 } });
        assert.equal(result.response.status, 200);
        assert.equal(result.data.credits, amount * 5);
      }
    }
  });
  const activeRoute = await admin.call('/api/admin/model-routes/' + createdRoute.data.route.id, { method:'PATCH', headers:{ Origin:base, 'X-CSRF-Token':csrf }, body:{ durations:[5,7,30], adminEnabled:true } });
  assert.equal(activeRoute.response.status, 200);
  for (const duration of [5,7,30]) {
    const result = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId:'seedance-2.0', generationType:'TEXT', quality:'720p', duration, aspectRatio:'16:9' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.credits, duration * 22);
    assert.equal(result.data.yuan, Number((duration * 2.2).toFixed(8)));
  }
  const beforeChange = await userClient.call('/api/config');
  const durationsOf = data => data.videoCapabilities.models.find(model => model.id === 'seedance-2.0').modes.find(mode => mode.generationType === 'TEXT').durationsByQuality['720p']['16:9'];
  assert.deepEqual(durationsOf(beforeChange.data), [5,7,30]);
  await admin.call('/api/admin/model-routes/' + createdRoute.data.route.id, { method:'PATCH', headers:{ Origin:base, 'X-CSRF-Token':csrf }, body:{ durations:[5,10,15] } });
  const afterChange = await userClient.call('/api/config');
  assert.equal(afterChange.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(durationsOf(afterChange.data), [5,10,15]);
  const invalidDuration = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId:'seedance-2.0', generationType:'TEXT', quality:'720p', duration:6, aspectRatio:'16:9' } });
  assert.equal(invalidDuration.response.status, 503);
  const qualities1080 = data => data.videoCapabilities.models.find(model => model.id === 'seedance-2.0').modes.find(mode => mode.generationType === 'TEXT').qualityOptions.includes('1080p');
  assert.equal(qualities1080(afterChange.data), false);
  const route1080 = await admin.call('/api/admin/model-routes', { method:'POST', headers:{ Origin:base, 'X-CSRF-Token':csrf }, body:{ logicalModelId:'seedance-2.0-text', quality:'1080p', credentialId:'diw-main', upstreamModelId:'http-test-1080p', durations:[5,10,15], priority:1, costYuan:1, salePriceYuan:2 } });
  assert.equal(route1080.response.status, 201);
  assert.equal(qualities1080((await userClient.call('/api/config')).data), true);
  const quote1080 = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId:'seedance-2.0', generationType:'TEXT', quality:'1080p', duration:10, aspectRatio:'16:9' } });
  assert.equal(quote1080.response.status, 200);
  assert.equal(quote1080.data.credits, 200);
  const disable1080 = await admin.call('/api/admin/model-routes/' + route1080.data.route.id, { method:'PATCH', headers:{ Origin:base, 'X-CSRF-Token':csrf }, body:{ adminEnabled:false, expectedVersion:route1080.data.route.version } });
  assert.equal(disable1080.response.status, 200);
  assert.equal(qualities1080((await userClient.call('/api/config')).data), false);
  const unavailable1080 = await userClient.call('/api/model-quote', { method:'POST', body:{ modelId:'seedance-2.0', generationType:'TEXT', quality:'1080p', duration:10, aspectRatio:'16:9' } });
  assert.equal(unavailable1080.response.status, 503);
  const forbidden = await userClient.call('/api/admin/overview');
  assert.equal(forbidden.response.status, 401);
  const userLoginAsAdmin = await admin.call('/api/admin/auth/login', { method: 'POST', headers: { Origin: base }, body: { username: 'http_user', password: 'user-password-123' } });
  assert.equal(userLoginAsAdmin.response.status, 401);

  const users = await admin.call('/api/admin/users?query=http_user');
  assert.equal(users.data.items.length, 1);
  const target = users.data.items[0];
  assert.equal(target.totalSpent, 0);
  const seedBalance = await admin.call(`/api/admin/users/${target.id}/credit-adjustments`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { amount: '4.5', reasonCode: 'customer_service', note: 'http seed', idempotencyKey: 'http-seed-1' } });
  assert.equal(seedBalance.response.status, 200);
  assert.equal(seedBalance.data.balance, 4.5);
  const adjustment = await admin.call(`/api/admin/users/${target.id}/credit-adjustments`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { amount: '-1.25', reasonCode: 'customer_service', note: 'http test', idempotencyKey: 'http-adjust-1' } });
  assert.equal(adjustment.response.status, 200);
  assert.equal(adjustment.data.balance, 3.25);
  const replay = await admin.call(`/api/admin/users/${target.id}/credit-adjustments`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { amount: '-1.25', reasonCode: 'customer_service', note: 'http test', idempotencyKey: 'http-adjust-1' } });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replay, true);
  const usersAfterAdjustment = await admin.call(`/api/admin/users?query=${encodeURIComponent(target.username)}`);
  assert.equal(usersAfterAdjustment.data.items[0].totalSpent, 1.25);
  const detailAfterAdjustment = await admin.call(`/api/admin/users/${target.id}`);
  assert.equal(detailAfterAdjustment.data.user.totalSpent, 1.25);
  const audit = await admin.call('/api/admin/logs/audit?limit=100');
  assert.equal(audit.data.items.find(item => item.action === 'user.credit_adjustment').actorNickname, 'http_admin');
  const taskGenerations = await admin.call(`/api/admin/logs/generations?taskId=${taskId}`);
  assert.deepEqual(taskGenerations.data.items.map(item => item.id), [taskId]);
  const taskCredits = await admin.call(`/api/admin/logs/credits?taskId=${taskId}`);
  assert.equal(taskCredits.data.items.length, 2);
  assert.ok(taskCredits.data.items.every(item => item.generationId === taskId));
  const taskSystem = await admin.call(`/api/admin/logs/system?taskId=${taskId}`);
  assert.deepEqual(taskSystem.data.items.map(item => item.generationId), [taskId]);

  const disabled = await admin.call(`/api/admin/users/${target.id}/disable`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: {} });
  assert.equal(disabled.response.status, 200);
  const disabledLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'http_user', password: 'user-password-123' }) });
  assert.equal(disabledLogin.status, 401);
  assert.equal(disabledLogin.headers.get('set-cookie'), null);
});
