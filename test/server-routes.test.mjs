import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountRouteHandler } from '../server/routes/account.mjs';
import { createAuthRouteHandler } from '../server/routes/auth.mjs';
import { createGenerationRouteHandler } from '../server/routes/generations.mjs';
import { createSystemRouteHandler } from '../server/routes/system.mjs';

function response() {
  return {
    status:0,
    value:null,
    writeHead(status) { this.status = status; },
    end(value) { this.value = value; },
  };
}

function accountRoute(overrides = {}) {
  return createAccountRouteHandler({
    bodyForm:async () => ({}),
    bodyJson:async () => ({}),
    sendJson:(res, status, value) => { res.status = status; res.value = value; },
    sendText:(res, status, value) => { res.status = status; res.value = value; },
    requireUser:() => ({ id:'user-a' }),
    currentUser:() => null,
    port:3000,
    publicReturnUrl:() => 'https://example.test/return',
    publicNotifyUrl:() => 'https://example.test/notify',
    handleAlipayNotification:async () => {},
    paymentReturnPage:() => '<html></html>',
    queryPaymentOrder:async () => ({ order:{ outTradeNo:'order-a' } }),
    paymentOrderForUser:() => ({ outTradeNo:'order-a' }),
    createPaymentOrder:async () => ({ order:{ outTradeNo:'order-a' } }),
    closePaymentOrder:async () => ({ ok:true }),
    refundPaymentOrder:async () => ({ ok:true }),
    queryPaymentRefund:async () => ({ refund:{ outRequestNo:'refund-a' } }),
    configState:() => ({ models:[] }),
    walletOf:() => ({ balance:10 }),
    currentPricing:() => ({ imagePerRequest:1, videoPerSecond:2, version:3 }),
    recentCreditEntries:() => [],
    publicCreditEntry:value => value,
    creditPricing:{ signupBonus:50 },
    llmRates:{ inputYuanPerMillion:1, outputYuanPerMillion:2, yuanPerCredit:0.1 },
    listNotifications:() => ({ items:[], unread:0 }),
    markNotificationRead:() => {},
    markAllNotificationsRead:() => {},
    ...overrides,
  });
}

test('account routes preserve public payment callbacks and authenticated response shapes', async () => {
  const route = accountRoute();
  const notifyResponse = response();
  assert.equal(await route({ method:'POST', headers:{} }, notifyResponse, new URL('http://localhost/api/payments/alipay/notify'), { publicOnly:true }), true);
  assert.equal(notifyResponse.status, 200);
  assert.equal(notifyResponse.value, 'success');

  const configResponse = response();
  assert.equal(await route({ method:'GET', headers:{} }, configResponse, new URL('http://localhost/api/config')), true);
  assert.deepEqual(configResponse.value, { models:[] });
});

test('auth me keeps its explicit unauthenticated error shape', async () => {
  const route = createAuthRouteHandler({
    currentUser:() => null,
    sendJson:(res, status, value) => { res.status = status; res.value = value; },
  });
  const res = response();
  assert.equal(await route({ method:'GET', headers:{} }, res, new URL('http://localhost/api/auth/me')), true);
  assert.equal(res.status, 401);
  assert.deepEqual(res.value, { error:'未登录' });
});

test('generation routes keep paged bare-array responses in the route module', async () => {
  const route = createGenerationRouteHandler({
    requireUser:() => ({ id:'user-a' }),
    requireDesktopWorkspaceScope:() => ({ deviceId:'device-a', workspaceId:'workspace-a' }),
    findGeneration:(_userId, id) => ({ id, status:'queued' }),
    listGenerations:() => ({ items:[{ id:'generation-a', status:'queued' }], total:1, nextCursor:'next' }),
    setPageHeaders:(res, page) => { res.total = page.total; res.nextCursor = page.nextCursor; },
    parseLimit:value => Number(value),
    safeId:value => String(value),
    publicGeneration:value => ({ id:value.id, status:value.status }),
    sendJson:(res, status, value) => { res.status = status; res.value = value; },
  });
  const res = response();
  assert.equal(await route({ method:'GET' }, res, new URL('http://localhost/api/generations?view=works&limit=20')), true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.value, [{ id:'generation-a', status:'queued' }]);
  assert.equal(res.total, 1);
  assert.equal(res.nextCursor, 'next');
});

test('generation routes soft-delete user records while preserving the audit row', async () => {
  const task = { id:'generation-a', status:'failed', assetId:'' };
  const calls = [];
  const route = createGenerationRouteHandler({
    requireUser:() => ({ id:'user-a' }),
    requireDesktopWorkspaceScope:() => ({ deviceId:'device-a', workspaceId:'workspace-a' }),
    safeId:value => String(value),
    findGeneration:() => task,
    activeGenerations:new Map(),
    hideGenerationForUser:async (userId, value) => {
      calls.push({ userId, value });
      value.userDeleted = true;
      return { deletedAssetId:null, generationLogPreserved:true, userRecordDeleted:true };
    },
    sendJson:(res, status, value) => { res.status = status; res.value = value; },
  });
  const res = response();
  assert.equal(await route({ method:'DELETE' }, res, new URL('http://localhost/api/generations/generation-a')), true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.value, { ok:true, deletedAssetId:null, generationLogPreserved:true, userRecordDeleted:true });
  assert.deepEqual(calls, [{ userId:'user-a', value:task }]);
});

test('system routes expose readiness and drain state without touching application routes', async () => {
  const calls = [];
  const route = createSystemRouteHandler({
    sendJson:(res, status, value) => { calls.push(['json', status, value]); },
    sendText:(res, status, value) => { calls.push(['text', status, value]); },
    isDraining:() => false,
    checkReady:() => ({ ready:1 }),
    queueStats:() => ({ pending:2 }),
    metricsText:() => 'gugu_pending 2\n',
  });
  const res = response();
  assert.equal(await route({ method:'GET' }, res, new URL('http://localhost/healthz')), true);
  assert.equal(await route({ method:'GET' }, res, new URL('http://localhost/readyz')), true);
  assert.equal(await route({ method:'GET' }, res, new URL('http://localhost/metrics')), true);
  assert.deepEqual(calls, [
    ['json', 200, { status:'ok', uptimeSeconds:Math.round(process.uptime()) }],
    ['json', 200, { status:'ready', queue:{ pending:2 } }],
    ['text', 200, 'gugu_pending 2\n'],
  ]);
});
