import { API_LOG_RETENTION_DAYS } from '../../repositories/api-platform.mjs';

// Endpoints behind the API console pages. They use the normal account
// session; API keys themselves never authenticate here.

const credits = micro => Number((Number(micro || 0) / 1_000_000).toFixed(6));

function startOfToday() {
  const date = new Date();
  // Day boundaries follow China Standard Time, where all customers are.
  const shanghai = new Date(date.getTime() + 8 * 3600_000);
  shanghai.setUTCHours(0, 0, 0, 0);
  return new Date(shanghai.getTime() - 8 * 3600_000).toISOString();
}

export function createApiConsoleRoute({
  repo,
  apiCatalog,
  requireUser,
  bodyJson,
  sendJson,
  walletOf,
  taskStatus,
  now = () => new Date().toISOString(),
} = {}) {
  function keyView(key) {
    return {
      id:key.id,
      name:key.name,
      hint:key.hint,
      status:key.status,
      creditLimit:key.creditLimitMicro === null ? null : credits(key.creditLimitMicro),
      usedCredits:credits(repo.keyUsageMicro(key.id)),
      expiresAt:key.expiresAt,
      expired:Boolean(key.expiresAt && Date.parse(key.expiresAt) <= Date.now()),
      lastUsedAt:key.lastUsedAt,
      createdAt:key.createdAt,
    };
  }

  function parseKeyInput(input, { partial = false } = {}) {
    const patch = {};
    if (!partial || Object.hasOwn(input, 'name')) {
      const name = String(input.name ?? '').replace(/[\r\n\u0000-\u001f]/g, '').trim();
      if (!name || Array.from(name).length > 40) throw Object.assign(new Error('密钥名称需为 1–40 个字符'), { statusCode:400 });
      patch.name = name;
    }
    if (!partial || Object.hasOwn(input, 'creditLimit')) {
      const value = input.creditLimit;
      if (value === null || value === undefined || value === '') patch.creditLimitMicro = null;
      else {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) throw Object.assign(new Error('额度上限需为 0 或正数'), { statusCode:400 });
        patch.creditLimitMicro = Math.round(amount * 1_000_000);
      }
    }
    if (!partial || Object.hasOwn(input, 'expiresAt')) {
      const value = input.expiresAt;
      if (value === null || value === undefined || value === '') patch.expiresAt = null;
      else {
        const parsed = Date.parse(String(value));
        if (!Number.isFinite(parsed)) throw Object.assign(new Error('过期时间格式不正确'), { statusCode:400 });
        if (parsed <= Date.now()) throw Object.assign(new Error('过期时间需晚于当前时间'), { statusCode:400 });
        patch.expiresAt = new Date(parsed).toISOString();
      }
    }
    if (partial && Object.hasOwn(input, 'status')) {
      if (!['active', 'disabled'].includes(input.status)) throw Object.assign(new Error('密钥状态不正确'), { statusCode:400 });
      patch.status = input.status;
    }
    return patch;
  }

  function apiBaseUrl(req) {
    const configured = String(process.env.API_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    return `${proto}://${req.headers.host}`;
  }

  return async function handleApiConsole(req, res, url) {
    if (url.pathname === '/api/public/api-models' && req.method === 'GET') {
      sendJson(res, 200, { generatedAt:now(), baseUrl:`${apiBaseUrl(req)}/v1`, yuanPerCredit:0.1, models:apiCatalog() });
      return true;
    }
    if (!url.pathname.startsWith('/api/console/')) return false;
    const user = requireUser(req, res);
    if (!user) return true;

    if (url.pathname === '/api/console/overview' && req.method === 'GET') {
      const wallet = walletOf(user.id);
      const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      const today = repo.usageSince(user.id, startOfToday());
      const month = repo.usageSince(user.id, since30);
      const keys = repo.listKeys(user.id);
      sendJson(res, 200, {
        baseUrl:`${apiBaseUrl(req)}/v1`,
        balance:wallet.balance,
        available:wallet.available ?? wallet.balance,
        keys:{ total:keys.length, active:keys.filter(key => key.status === 'active').length },
        today:{ requests:today.requests, errors:today.errors, credits:credits(today.costMicro) },
        last30Days:{ requests:month.requests, errors:month.errors, credits:credits(month.costMicro) },
      });
      return true;
    }

    if (url.pathname === '/api/console/keys' && req.method === 'GET') {
      sendJson(res, 200, { keys:repo.listKeys(user.id).map(keyView) });
      return true;
    }
    if (url.pathname === '/api/console/keys' && req.method === 'POST') {
      const patch = parseKeyInput(await bodyJson(req, 10_000));
      const created = repo.createKey(user.id, patch);
      sendJson(res, 201, { key:keyView(created.key), secret:created.secret });
      return true;
    }
    const keyMatch = url.pathname.match(/^\/api\/console\/keys\/(key_[a-f0-9]{8,64})$/);
    if (keyMatch && req.method === 'PATCH') {
      const patch = parseKeyInput(await bodyJson(req, 10_000), { partial:true });
      const updated = repo.updateKey(user.id, keyMatch[1], patch);
      sendJson(res, updated ? 200 : 404, updated ? { key:keyView(updated) } : { error:'密钥不存在' });
      return true;
    }
    if (keyMatch && req.method === 'DELETE') {
      const deleted = repo.deleteKey(user.id, keyMatch[1]);
      sendJson(res, deleted ? 200 : 404, deleted ? { ok:true } : { error:'密钥不存在' });
      return true;
    }

    if (url.pathname === '/api/console/logs' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
      const outcome = ['success', 'error'].includes(url.searchParams.get('outcome')) ? url.searchParams.get('outcome') : '';
      const dateParam = name => {
        const value = url.searchParams.get(name) || '';
        if (!value) return '';
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
      };
      const keys = new Map(repo.listKeys(user.id).map(key => [key.id, key]));
      const page = repo.listLogs(user.id, {
        keyId:String(url.searchParams.get('key') || '').slice(0, 80),
        modelId:String(url.searchParams.get('model') || '').slice(0, 80),
        outcome, from:dateParam('from'), to:dateParam('to'), limit,
        before:String(url.searchParams.get('before') || '').slice(0, 80) || null,
      });
      sendJson(res, 200, {
        retentionDays:API_LOG_RETENTION_DAYS,
        hasMore:page.hasMore,
        nextCursor:page.hasMore ? page.logs.at(-1)?.id || null : null,
        logs:page.logs.map(log => ({
          id:log.id,
          requestId:log.requestId,
          keyId:log.keyId,
          keyName:keys.get(log.keyId)?.name || (log.keyId ? '已删除的密钥' : ''),
          method:log.method,
          path:log.path,
          model:log.modelId,
          taskId:log.taskId,
          taskStatus:log.taskId && log.statusCode < 400 ? taskStatus(user.id, log.taskId) : null,
          statusCode:log.statusCode,
          errorCode:log.errorCode,
          errorMessage:log.errorMessage,
          credits:credits(log.costMicro),
          latencyMs:log.latencyMs,
          createdAt:log.createdAt,
        })),
      });
      return true;
    }
    sendJson(res, 404, { error:'接口不存在' });
    return true;
  };
}
