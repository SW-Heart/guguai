export function createSystemRouteHandler({ sendJson, sendText, isDraining, checkReady, queueStats, metricsText }) {
  return async function handleSystemRoute(req, res, url) {
    if (url.pathname === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status:'ok', uptimeSeconds:Math.round(process.uptime()) });
      return true;
    }
    if (url.pathname === '/readyz' && req.method === 'GET') {
      if (isDraining()) {
        sendJson(res, 503, { status:'draining' });
        return true;
      }
      try {
        checkReady();
        sendJson(res, 200, { status:'ready', queue:queueStats() });
      } catch {
        sendJson(res, 503, { status:'not_ready' });
      }
      return true;
    }
    if (url.pathname === '/metrics' && req.method === 'GET') {
      sendText(res, 200, metricsText(), 'text/plain; version=0.0.4; charset=utf-8');
      return true;
    }
    return false;
  };
}
