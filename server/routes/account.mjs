export function createAccountRouteHandler({
  bodyForm,
  bodyJson,
  sendJson,
  sendText,
  requireUser,
  currentUser,
  parseCookies,
  port,
  publicReturnUrl,
  publicNotifyUrl,
  handleAlipayNotification,
  paymentReturnPage,
  queryPaymentOrder,
  paymentOrderForUser,
  createPaymentOrder,
  closePaymentOrder,
  refundPaymentOrder,
  queryPaymentRefund,
  configState,
  walletOf,
  currentPricing,
  recentCreditEntries,
  publicCreditEntry,
  creditPricing,
  llmRates,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = {}) {
  return async function handleAccountRoute(req, res, url, { publicOnly = false } = {}) {
    if (url.pathname === '/api/payments/alipay/notify' && req.method === 'POST') {
      try {
        await handleAlipayNotification(await bodyForm(req));
        sendText(res, 200, 'success');
      } catch (error) {
        console.warn('[alipay] notification rejected', { message:error.message });
        sendText(res, 200, 'fail');
      }
      return true;
    }
    if ((url.pathname === '/payments/alipay/return' || url.pathname === '/payments/alipay/return/') && req.method === 'GET') {
      const user = currentUser(req);
      const outTradeNo = String(url.searchParams.get('out_trade_no') || '').trim();
      if (!user || !outTradeNo) {
        sendText(res, 200, paymentReturnPage(), 'text/html; charset=utf-8');
        return true;
      }
      let order = null;
      let error = '';
      try { order = (await queryPaymentOrder(user.id, outTradeNo)).order; }
      catch (queryError) {
        try { order = paymentOrderForUser(user.id, outTradeNo); } catch {}
        error = '支付结果暂时无法确认，请返回 GuGu AI 后刷新。';
      }
      sendText(res, 200, paymentReturnPage({ order, error }), 'text/html; charset=utf-8');
      return true;
    }
    if (publicOnly) return false;
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      sendJson(res, 200, configState());
      return true;
    }
    if (url.pathname === '/api/credits' && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      const wallet = walletOf(user.id);
      const pricing = currentPricing();
      const transactions = recentCreditEntries(user.id, 1000).map(publicCreditEntry);
      sendJson(res, 200, {
        ...wallet,
        pricing: {
          image:pricing.imagePerRequest,
          videoPerSecond:pricing.videoPerSecond,
          signupBonus:creditPricing.signupBonus,
          version:pricing.version,
          llmInputYuanPerMillion:llmRates.inputYuanPerMillion,
          llmOutputYuanPerMillion:llmRates.outputYuanPerMillion,
          yuanPerCredit:llmRates.yuanPerCredit,
        },
        transactions,
      });
      return true;
    }
    if (url.pathname === '/api/payments/alipay/orders' && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return true;
      const input = await bodyJson(req);
      const result = await createPaymentOrder({
        userId:user.id,
        credits:input.credits,
        returnUrl:publicReturnUrl(process.env, port),
        notifyUrl:publicNotifyUrl(process.env),
      });
      sendJson(res, 201, result);
      return true;
    }
    const alipayOrderMatch = url.pathname.match(/^\/api\/payments\/alipay\/orders\/([A-Za-z0-9_-]+)$/);
    if (alipayOrderMatch && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      sendJson(res, 200, { order:paymentOrderForUser(user.id, alipayOrderMatch[1]) });
      return true;
    }
    const alipayOrderActionMatch = url.pathname.match(/^\/api\/payments\/alipay\/orders\/([A-Za-z0-9_-]+)\/(query|close|refunds)$/);
    if (alipayOrderActionMatch && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return true;
      const [, outTradeNo, action] = alipayOrderActionMatch;
      if (action === 'query') { sendJson(res, 200, await queryPaymentOrder(user.id, outTradeNo)); return true; }
      if (action === 'close') { sendJson(res, 200, await closePaymentOrder(user.id, outTradeNo)); return true; }
      sendJson(res, 200, await refundPaymentOrder(user.id, outTradeNo, await bodyJson(req)));
      return true;
    }
    const alipayRefundMatch = url.pathname.match(/^\/api\/payments\/alipay\/orders\/([A-Za-z0-9_-]+)\/refunds\/([A-Za-z0-9_-]+)$/);
    if (alipayRefundMatch && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      sendJson(res, 200, await queryPaymentRefund(user.id, alipayRefundMatch[1], alipayRefundMatch[2]));
      return true;
    }
    if (url.pathname === '/api/notifications' && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return true;
      sendJson(res, 200, listNotifications(user.id, { limit:url.searchParams.get('limit') }));
      return true;
    }
    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([\w-]+)\/read$/);
    if (notificationReadMatch && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return true;
      markNotificationRead(user.id, notificationReadMatch[1]);
      sendJson(res, 200, listNotifications(user.id));
      return true;
    }
    if (url.pathname === '/api/notifications/read-all' && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return true;
      markAllNotificationsRead(user.id);
      sendJson(res, 200, listNotifications(user.id));
      return true;
    }
    return false;
  };
}
