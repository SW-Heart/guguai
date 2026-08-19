import { randomUUID } from 'node:crypto';
import { sql, tx } from './db.mjs';
import { clientIp, createLoginAttemptLimiter, hashToken, randomToken, verifyPassword } from './auth.mjs';
import { appendAuditEvent, appendSystemEvent } from './audit.mjs';
import { adjustCredits, walletOf } from './ledger.mjs';
import { creditsToMicro, microToCredits } from './billing.mjs';
import { createPricingVersion, currentPricing, pricingHistory, parsePrice } from './pricing.mjs';
import { listModelControls, modelControl, updateModelControl } from './model-controls.mjs';
import { decodeCursor, encodeCursor, parseLimit } from './store.mjs';

const ADMIN_SESSION_MAX_AGE = 4 * 60 * 60;
const adminLoginLimiter = createLoginAttemptLimiter({ maxAttempts: 5, windowMs: 15 * 60_000 });
const now = () => new Date().toISOString();
const json = value => value === undefined || value === null ? null : JSON.stringify(value);
const parseCookies = (header = '') => Object.fromEntries(header.split(';').map(part => part.trim().split('='))
  .filter(item => item[0]).map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]));
const publicAdmin = user => ({ id: user.id, username: user.username, role: user.role, status: user.status, createdAt: user.createdAt });

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(value));
}

async function bodyJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式不正确'), { statusCode: 400 }); }
}

function requestId(req) {
  const value = String(req.headers['x-request-id'] || '').trim();
  return value && value.length <= 100 ? value : randomUUID();
}

function requestAudit(req, id) {
  return { requestId: id, ip: clientIp(req), userAgent: req.headers['user-agent'] || null };
}

function adminSession(req) {
  const token = parseCookies(req.headers.cookie).gugu_admin_session;
  if (!token) return null;
  const row = sql(`
    SELECT s.token_hash AS tokenHash, s.csrf_token_hash AS csrfTokenHash, s.expires_at AS expiresAt,
           u.id, u.username, u.role, u.status, u.created_at AS createdAt, u.doc_json
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = :tokenHash AND s.scope = 'admin'
  `).get({ tokenHash: hashToken(token) });
  if (!row || row.expiresAt <= now() || row.status !== 'active' || row.role !== 'admin') {
    if (row) sql('DELETE FROM sessions WHERE token_hash = :tokenHash').run({ tokenHash: row.tokenHash });
    return null;
  }
  return { token, tokenHash: row.tokenHash, csrfTokenHash: row.csrfTokenHash, user: { id: row.id, username: row.username, role: row.role, status: row.status, createdAt: row.createdAt } };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function requireAdmin(req, res, { write = false } = {}) {
  const session = adminSession(req);
  if (!session) { sendJson(res, 401, { error: '请先登录管理员账号' }); return null; }
  if (write) {
    if (!originAllowed(req)) { sendJson(res, 403, { error: '请求来源不允许' }); return null; }
    const csrf = String(req.headers['x-csrf-token'] || '');
    if (!csrf || csrf.length > 256 || hashToken(csrf) !== session.csrfTokenHash) { sendJson(res, 403, { error: '管理员操作凭证无效' }); return null; }
  }
  return session;
}

function setAdminCookie(res, token) {
  res.setHeader('Set-Cookie', `gugu_admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', 'gugu_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function rowDoc(row, field = 'doc_json') {
  if (!row) return null;
  try { return JSON.parse(row[field]); } catch { return null; }
}

function pageQuery({ scope, table, where = [], params = {}, timeColumn = 'created_at', idColumn = 'id', limit, cursor, select = '*' }) {
  const conditions = [...where];
  const queryParams = { ...params, limit: limit + 1 };
  const total = sql(`SELECT COUNT(*) AS total FROM ${table} WHERE ${conditions.length ? conditions.join(' AND ') : '1=1'}`).get(params).total;
  const position = decodeCursor(scope, cursor);
  if (position) {
    conditions.push(`(${timeColumn} < :cursorTime OR (${timeColumn} = :cursorTime AND ${idColumn} > :cursorId))`);
    queryParams.cursorTime = position.t;
    queryParams.cursorId = position.i;
  }
  const rows = sql(`SELECT ${select}, ${timeColumn} AS __sort_time, ${idColumn} AS __sort_id FROM ${table} WHERE ${conditions.length ? conditions.join(' AND ') : '1=1'} ORDER BY ${timeColumn} DESC, ${idColumn} ASC LIMIT :limit`).all(queryParams);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { rows: items, total, nextCursor: hasMore && last ? encodeCursor(scope, { t: last.__sort_time, i: last.__sort_id }) : null };
}

function userRow(row) {
  return {
    id: row.id, username: row.username, role: row.role, status: row.status,
    credits: microToCredits(row.credit_balance_micro), held: microToCredits(row.credit_held_micro),
    available: microToCredits(Math.max(0, row.credit_balance_micro - row.credit_held_micro)),
    createdAt: row.created_at, updatedAt: row.updated_at, disabledAt: row.disabled_at,
    adminNote: row.admin_note || '',
  };
}

function listUsers(url) {
  const where = [];
  const params = {};
  const query = String(url.searchParams.get('query') || '').trim();
  const status = String(url.searchParams.get('status') || '').trim();
  const role = String(url.searchParams.get('role') || '').trim();
  if (query) { where.push('(username LIKE :query OR id = :exactId)'); params.query = `%${query}%`; params.exactId = query; }
  if (['active', 'disabled'].includes(status)) { where.push('status = :status'); params.status = status; }
  if (['user', 'admin'].includes(role)) { where.push('role = :role'); params.role = role; }
  const page = pageQuery({ scope: 'admin-users', table: 'users', where, params, limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'id, username, role, status, credit_balance_micro, credit_held_micro, created_at, updated_at, disabled_at, admin_note' });
  return { items: page.rows.map(userRow), total: page.total, nextCursor: page.nextCursor };
}

function userDetail(id) {
  const row = sql('SELECT * FROM users WHERE id = :id').get({ id });
  if (!row) return null;
  const result = userRow(row);
  result.inviteCode = row.invite_code;
  result.generations = sql('SELECT COUNT(*) AS count FROM generations WHERE user_id = :id').get({ id }).count;
  result.creditEntries = sql('SELECT COUNT(*) AS count FROM credit_entries WHERE user_id = :id').get({ id }).count;
  result.llmUsage = sql('SELECT COUNT(*) AS count FROM llm_usage WHERE user_id = :id').get({ id }).count;
  result.recentCredits = sql('SELECT doc_json FROM credit_entries WHERE user_id = :id ORDER BY created_at DESC, id ASC LIMIT 20').all({ id }).map(row => rowDoc(row));
  result.recentGenerations = sql('SELECT id, type, status, credit_cost_micro, model_id, created_at, updated_at FROM generations WHERE user_id = :id ORDER BY created_at DESC, id ASC LIMIT 20').all({ id }).map(row => ({ id: row.id, type: row.type, status: row.status, creditCost: row.credit_cost_micro === null ? null : microToCredits(row.credit_cost_micro), modelId: row.model_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  return result;
}

function parseSignedCredits(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(text) || /^-?0(?:\.0{1,6})?$/.test(text)) throw Object.assign(new Error('调账金额必须是非零数字，最多 6 位小数'), { statusCode: 400 });
  const negative = text.startsWith('-');
  const micro = parsePrice(negative ? text.slice(1) : text, '调账金额');
  return negative ? -micro : micro;
}

function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error('邀请码有效期格式无效'), { statusCode: 400 });
  return date.toISOString();
}

function listModels() {
  return listModelControls().map(item => ({ ...item, providerConfigured: item.kind === 'image' ? Boolean(process.env.DUOMI_API_KEY) : true }));
}

function listInvites(url) {
  const conditions = [];
  const params = {};
  const enabled = url.searchParams.get('enabled');
  const query = String(url.searchParams.get('query') || '').trim().toUpperCase();
  if (enabled === '0' || enabled === '1') { conditions.push('enabled = :enabled'); params.enabled = Number(enabled); }
  if (query) { conditions.push('code LIKE :query'); params.query = `%${query}%`; }
  const page = pageQuery({ scope: 'admin-invites', table: 'invite_codes', where: conditions, params, timeColumn: 'created_at', idColumn: 'code', limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'code, enabled, max_uses, used_count, expires_at, signup_bonus_micro, note, created_by, created_at, updated_at' });
  return { items: page.rows.map(row => ({ code: row.code, enabled: Boolean(row.enabled), maxUses: row.max_uses, usedCount: row.used_count, remaining: Math.max(0, row.max_uses - row.used_count), expiresAt: row.expires_at, signupBonus: microToCredits(row.signup_bonus_micro), note: row.note || '', createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, status: !row.enabled ? 'disabled' : row.expires_at && row.expires_at <= now() ? 'expired' : row.used_count >= row.max_uses ? 'exhausted' : 'active' })), total: page.total, nextCursor: page.nextCursor };
}

function addTimeRange(url, where, params) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from) { where.push('created_at >= :from'); params.from = from; }
  if (to) { where.push('created_at < :to'); params.to = to; }
}

function listGenerations(url) {
  const where = [];
  const params = {};
  const userId = url.searchParams.get('userId');
  const modelId = url.searchParams.get('modelId');
  const status = url.searchParams.get('status');
  const type = url.searchParams.get('type');
  addTimeRange(url, where, params);
  if (userId) { where.push('user_id = :userId'); params.userId = userId; }
  if (modelId) { where.push('model_id = :modelId'); params.modelId = modelId; }
  if (status) { where.push('status = :status'); params.status = status; }
  if (type) { where.push('type = :type'); params.type = type; }
  const page = pageQuery({ scope: 'admin-generations', table: 'generations', where, params, limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'id, user_id, type, status, credit_cost_micro, credit_status, pricing_version, model_id, provider, asset_id, created_at, updated_at, doc_json' });
  return { items: page.rows.map(row => ({ id: row.id, userId: row.user_id, type: row.type, status: row.status, creditCost: row.credit_cost_micro === null ? Number(row.credit_cost || 0) : microToCredits(row.credit_cost_micro), creditStatus: row.credit_status, pricingVersion: row.pricing_version, modelId: row.model_id, provider: row.provider, assetId: row.asset_id, createdAt: row.created_at, updatedAt: row.updated_at, details: rowDoc(row) })), total: page.total, nextCursor: page.nextCursor };
}

function listCredits(url) {
  const where = [];
  const params = {};
  if (url.searchParams.get('userId')) { where.push('user_id = :userId'); params.userId = url.searchParams.get('userId'); }
  if (url.searchParams.get('type')) { where.push('type = :type'); params.type = url.searchParams.get('type'); }
  if (url.searchParams.get('modelId')) { where.push('(generation_id IN (SELECT id FROM generations WHERE model_id = :modelId) OR request_id IN (SELECT id FROM llm_usage WHERE model = :modelId))'); params.modelId = url.searchParams.get('modelId'); }
  addTimeRange(url, where, params);
  const page = pageQuery({ scope: 'admin-credits', table: 'credit_entries', where, params, limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'id, user_id, actor_user_id, type, reason_code, note, amount_micro, balance_after_micro, generation_id, request_id, created_at, doc_json' });
  return { items: page.rows.map(row => ({ id: row.id, userId: row.user_id, actorUserId: row.actor_user_id, type: row.type, reasonCode: row.reason_code, note: row.note, amount: microToCredits(Math.abs(row.amount_micro)) * (row.amount_micro < 0 ? -1 : 1), balanceAfter: microToCredits(row.balance_after_micro), generationId: row.generation_id, requestId: row.request_id, createdAt: row.created_at, details: rowDoc(row) })), total: page.total, nextCursor: page.nextCursor };
}

function listLlmUsage(url) {
  const where = [];
  const params = {};
  if (url.searchParams.get('userId')) { where.push('user_id = :userId'); params.userId = url.searchParams.get('userId'); }
  if (url.searchParams.get('modelId')) { where.push('model = :modelId'); params.modelId = url.searchParams.get('modelId'); }
  addTimeRange(url, where, params);
  const page = pageQuery({ scope: 'admin-llm', table: 'llm_usage', where, params, limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'id, user_id, status, model, input_tokens, output_tokens, charged_micro, created_at, doc_json' });
  return { items: page.rows.map(row => ({ id: row.id, userId: row.user_id, status: row.status, modelId: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, charged: row.charged_micro === null ? null : microToCredits(row.charged_micro), createdAt: row.created_at, details: rowDoc(row) })), total: page.total, nextCursor: page.nextCursor };
}

function listAudit(url) {
  const where = [];
  const params = {};
  if (url.searchParams.get('userId')) { where.push('(actor_user_id = :userId OR target_id = :userId)'); params.userId = url.searchParams.get('userId'); }
  if (url.searchParams.get('action')) { where.push('action = :action'); params.action = url.searchParams.get('action'); }
  addTimeRange(url, where, params);
  const page = pageQuery({ scope: 'admin-audit', table: 'audit_events', where, params, limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'id, actor_user_id, action, target_type, target_id, request_id, status, before_json, after_json, metadata_json, created_at' });
  return { items: page.rows.map(row => ({ id: row.id, actorUserId: row.actor_user_id, action: row.action, targetType: row.target_type, targetId: row.target_id, requestId: row.request_id, status: row.status, before: rowDoc({ doc_json: row.before_json }), after: rowDoc({ doc_json: row.after_json }), metadata: rowDoc({ doc_json: row.metadata_json }), createdAt: row.created_at })), total: page.total, nextCursor: page.nextCursor };
}

function listSystem(url) {
  const where = [];
  const params = {};
  if (url.searchParams.get('userId')) { where.push('user_id = :userId'); params.userId = url.searchParams.get('userId'); }
  if (url.searchParams.get('modelId')) { where.push('model_id = :modelId'); params.modelId = url.searchParams.get('modelId'); }
  if (url.searchParams.get('level')) { where.push('level = :level'); params.level = url.searchParams.get('level'); }
  addTimeRange(url, where, params);
  const page = pageQuery({ scope: 'admin-system', table: 'system_events', where, params, limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor'), select: 'id, level, category, request_id, user_id, model_id, generation_id, message, details_json, created_at' });
  return { items: page.rows.map(row => ({ id: row.id, level: row.level, category: row.category, requestId: row.request_id, userId: row.user_id, modelId: row.model_id, generationId: row.generation_id, message: row.message, details: rowDoc({ doc_json: row.details_json }), createdAt: row.created_at })), total: page.total, nextCursor: page.nextCursor };
}

function overview(url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const range = from && to ? 'created_at >= :from AND created_at < :to' : '1=1';
  const rangeParams = from && to ? { from, to } : {};
  const users = sql(`SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'disabled') AS disabled FROM users`).get();
  const wallet = sql('SELECT COALESCE(SUM(credit_balance_micro),0) AS balance, COALESCE(SUM(credit_held_micro),0) AS held FROM users').get();
  const generations = sql(`SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, SUM(status IN ('queued','running')) AS pending FROM generations WHERE ${range}`).get(rangeParams);
  const spent = sql(`SELECT COALESCE(SUM(-amount_micro),0) AS spent FROM credit_entries WHERE amount_micro < 0 AND created_at >= COALESCE(:from, '0000') AND created_at < COALESCE(:to, '9999')`).get({ from: from || null, to: to || null });
  return {
    users: { total: users.total, active: users.active || 0, disabled: users.disabled || 0 },
    credits: { balance: microToCredits(wallet.balance), held: microToCredits(wallet.held), spent: microToCredits(spent.spent) },
    generations: { total: generations.total, completed: generations.completed || 0, failed: generations.failed || 0, pending: generations.pending || 0 },
    exceptions: {
      reconcile: sql("SELECT COUNT(*) AS count FROM billing_holds WHERE status = 'billing_reconcile_required'").get().count,
      refundFailed: sql("SELECT COUNT(*) AS count FROM generations WHERE credit_status = 'refund_failed'").get().count,
      systemErrors: sql("SELECT COUNT(*) AS count FROM system_events WHERE level IN ('error','critical')").get().count,
    },
  };
}

async function login(req, res, id) {
  const input = await bodyJson(req);
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  if (adminLoginLimiter.isBlocked(req, username)) {
    appendAuditEvent({ action: 'admin.login', targetType: 'session', status: 'rate_limited', metadata: { username }, ...requestAudit(req, id) });
    return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
  }
  const row = sql('SELECT id, username, role, status, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE username = :username').get({ username });
  const valid = row ? await verifyPassword(password, row.passwordHash) : false;
  if (!valid || row.role !== 'admin' || row.status !== 'active') {
    adminLoginLimiter.recordFailure(req, username);
    appendAuditEvent({ action: 'admin.login', targetType: 'session', status: 'failed', metadata: { username }, ...requestAudit(req, id) });
    return sendJson(res, 401, { error: '管理员账号或密码不正确' });
  }
  adminLoginLimiter.reset(req, username);
  const token = randomToken();
  const csrf = randomToken();
  const createdAt = now();
  sql(`INSERT INTO sessions(token_hash, user_id, scope, csrf_token_hash, expires_at, created_at)
       VALUES(:tokenHash, :userId, 'admin', :csrfHash, :expiresAt, :createdAt)`).run({
    tokenHash: hashToken(token), userId: row.id, csrfHash: hashToken(csrf),
    expiresAt: new Date(Date.now() + ADMIN_SESSION_MAX_AGE * 1000).toISOString(), createdAt,
  });
  appendAuditEvent({ actorUserId: row.id, action: 'admin.login', targetType: 'session', status: 'succeeded', ...requestAudit(req, id) });
  setAdminCookie(res, token);
  return sendJson(res, 200, { admin: { id: row.id, username: row.username, role: row.role, status: row.status, createdAt: row.createdAt }, csrfToken: csrf });
}

async function handleAuthorized(req, res, url, session, id) {
  const write = ['POST', 'PATCH', 'DELETE'].includes(req.method);
  if (url.pathname === '/api/admin/auth/session' && req.method === 'GET') return sendJson(res, 200, { admin: session.user });
  if (url.pathname === '/api/admin/auth/logout' && req.method === 'POST') {
    sql('DELETE FROM sessions WHERE token_hash = :tokenHash').run({ tokenHash: session.tokenHash });
    clearAdminCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/overview' && req.method === 'GET') return sendJson(res, 200, overview(url));
  if (url.pathname === '/api/admin/users' && req.method === 'GET') return sendJson(res, 200, listUsers(url));

  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
  if (userMatch && req.method === 'PATCH') {
    const input = await bodyJson(req);
    const beforeRow = sql('SELECT * FROM users WHERE id = :id').get({ id: userMatch[1] });
    if (!beforeRow) return sendJson(res, 404, { error: '用户不存在' });
    const note = String(input.adminNote ?? '').slice(0, 2000);
    sql('UPDATE users SET admin_note = :note, updated_at = :updatedAt WHERE id = :id').run({ id: userMatch[1], note, updatedAt: now() });
    const after = userDetail(userMatch[1]);
    appendAuditEvent({ actorUserId: session.user.id, action: 'user.update_note', targetType: 'user', targetId: userMatch[1], before: { adminNote: beforeRow.admin_note || '' }, after: { adminNote: note }, ...requestAudit(req, id) });
    return sendJson(res, 200, { user: after });
  }
  if (userMatch && req.method === 'GET') {
    const detail = userDetail(userMatch[1]);
    return detail ? sendJson(res, 200, { user: detail }) : sendJson(res, 404, { error: '用户不存在' });
  }
  const disableMatch = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)\/(disable|enable|revoke-sessions)$/);
  if (disableMatch && req.method === 'POST') {
    const userId = disableMatch[1];
    const action = disableMatch[2];
    return tx(() => {
      const beforeRow = sql('SELECT * FROM users WHERE id = :userId').get({ userId });
      if (!beforeRow) return sendJson(res, 404, { error: '用户不存在' });
      if (action === 'revoke-sessions') {
        const count = sql('DELETE FROM sessions WHERE user_id = :userId').run({ userId }).changes;
        appendAuditEvent({ actorUserId: session.user.id, action: 'user.revoke_sessions', targetType: 'user', targetId: userId, before: { sessionCount: count }, after: { sessionCount: 0 }, ...requestAudit(req, id) });
        return sendJson(res, 200, { ok: true, revoked: count });
      }
      if (beforeRow.role === 'admin' && action === 'disable') {
        const activeAdmins = sql("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count;
        if (activeAdmins <= 1) return sendJson(res, 409, { error: '不能禁用最后一个管理员' });
      }
      const status = action === 'disable' ? 'disabled' : 'active';
      const updatedAt = now();
      sql(`UPDATE users SET status = :status, disabled_at = :disabledAt, disabled_by = :disabledBy, updated_at = :updatedAt WHERE id = :userId`).run({ userId, status, disabledAt: status === 'disabled' ? updatedAt : null, disabledBy: status === 'disabled' ? session.user.id : null, updatedAt });
      if (status === 'disabled') sql('DELETE FROM sessions WHERE user_id = :userId').run({ userId });
      const after = userDetail(userId);
      appendAuditEvent({ actorUserId: session.user.id, action: `user.${action}`, targetType: 'user', targetId: userId, before: userRow(beforeRow), after, ...requestAudit(req, id) });
      return sendJson(res, 200, { user: after });
    });
  }

  const adjustMatch = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)\/credit-adjustments$/);
  if (adjustMatch && req.method === 'POST') {
    const input = await bodyJson(req);
    const amountMicro = parseSignedCredits(input.amount);
    const result = await adjustCredits(adjustMatch[1], amountMicro, {
      actorUserId: session.user.id,
      idempotencyKey: String(input.idempotencyKey || randomUUID()),
      reasonCode: String(input.reasonCode || 'other').slice(0, 60),
      note: input.note,
      onAudit: ({ before, after, entry }) => appendAuditEvent({ actorUserId: session.user.id, action: 'user.credit_adjustment', targetType: 'user', targetId: adjustMatch[1], before, after: { ...after, entryId: entry.id }, ...requestAudit(req, id) }),
    });
    return sendJson(res, 200, { ...result, amount: microToCredits(Math.abs(amountMicro)) * (amountMicro < 0 ? -1 : 1) });
  }

  if (url.pathname === '/api/admin/models' && req.method === 'GET') return sendJson(res, 200, { items: listModels() });
  const modelMatch = url.pathname.match(/^\/api\/admin\/models\/([\w-]+)$/);
  if (modelMatch && req.method === 'PATCH') {
    const input = await bodyJson(req);
    const model = updateModelControl(modelMatch[1], input, { actorUserId: session.user.id, expectedVersion: input.expectedVersion, audit: requestAudit(req, id) });
    return sendJson(res, 200, { model });
  }

  if (url.pathname === '/api/admin/pricing' && req.method === 'GET') return sendJson(res, 200, { current: currentPricing(), history: pricingHistory() });
  if (url.pathname === '/api/admin/pricing' && req.method === 'POST') {
    const input = await bodyJson(req);
    const pricing = createPricingVersion({ imagePerRequest: input.imagePerRequest, videoPerSecond: input.videoPerSecond, actorUserId: session.user.id, expectedVersion: input.expectedVersion, note: input.note, audit: requestAudit(req, id) });
    return sendJson(res, 201, { pricing });
  }

  if (url.pathname === '/api/admin/invite-codes' && req.method === 'GET') return sendJson(res, 200, listInvites(url));
  if (url.pathname === '/api/admin/invite-codes' && req.method === 'POST') {
    const input = await bodyJson(req);
    const code = String(input.code || `GUGU-${randomToken().slice(0, 4).toUpperCase()}-${randomToken().slice(0, 4).toUpperCase()}`).trim().toUpperCase();
    if (!/^[A-Z0-9-]{8,40}$/.test(code)) return sendJson(res, 400, { error: '邀请码只能包含大写字母、数字和短横线，长度 8–40' });
    const maxUses = Number(input.maxUses);
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) return sendJson(res, 400, { error: '最大使用次数无效' });
    const bonusMicro = parsePrice(input.signupBonus ?? '50', '注册送积分');
    const createdAt = now();
    try {
      tx(() => {
        sql(`INSERT INTO invite_codes(code, enabled, max_uses, used_count, expires_at, signup_bonus_micro, note, created_by, created_at, updated_at)
             VALUES(:code, 1, :maxUses, 0, :expiresAt, :bonusMicro, :note, :createdBy, :createdAt, :createdAt)`).run({ code, maxUses, expiresAt: parseExpiry(input.expiresAt), bonusMicro, note: String(input.note || '').slice(0, 500), createdBy: session.user.id, createdAt });
        appendAuditEvent({ actorUserId: session.user.id, action: 'invite.create', targetType: 'invite_code', targetId: code, after: { code, maxUses, signupBonus: microToCredits(bonusMicro) }, ...requestAudit(req, id) });
      });
    } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendJson(res, 409, { error: '邀请码已存在' }); throw error; }
    return sendJson(res, 201, { invite: listInvites(new URL(`http://local/api/admin/invite-codes?query=${encodeURIComponent(code)}&limit=1`)).items[0] });
  }
  const inviteMatch = url.pathname.match(/^\/api\/admin\/invite-codes\/([A-Z0-9-]+)(\/uses)?$/i);
  if (inviteMatch && !inviteMatch[2] && req.method === 'GET') {
    const row = sql('SELECT * FROM invite_codes WHERE code = :code').get({ code: inviteMatch[1].toUpperCase() });
    return row ? sendJson(res, 200, { invite: { code: row.code, enabled: Boolean(row.enabled), maxUses: row.max_uses, usedCount: row.used_count, remaining: row.max_uses - row.used_count, expiresAt: row.expires_at, signupBonus: microToCredits(row.signup_bonus_micro), note: row.note || '' } }) : sendJson(res, 404, { error: '邀请码不存在' });
  }
  if (inviteMatch && req.method === 'PATCH') {
    const code = inviteMatch[1].toUpperCase();
    const input = await bodyJson(req);
    const row = sql('SELECT * FROM invite_codes WHERE code = :code').get({ code });
    if (!row) return sendJson(res, 404, { error: '邀请码不存在' });
    const enabled = input.enabled === undefined ? row.enabled : (input.enabled ? 1 : 0);
    const expiresAt = input.expiresAt === undefined ? row.expires_at : parseExpiry(input.expiresAt);
    const maxUses = input.maxUses === undefined ? row.max_uses : Number(input.maxUses);
    if (!Number.isSafeInteger(maxUses) || maxUses < row.used_count || maxUses < 1) return sendJson(res, 400, { error: '最大使用次数不能小于已使用次数' });
    const before = { code: row.code, enabled: Boolean(row.enabled), maxUses: row.max_uses, usedCount: row.used_count, expiresAt: row.expires_at, signupBonus: microToCredits(row.signup_bonus_micro), note: row.note || '' };
    const updatedAt = now();
    const bonusMicro = input.signupBonus === undefined ? row.signup_bonus_micro : parsePrice(input.signupBonus, '注册送积分');
    sql(`UPDATE invite_codes SET enabled = :enabled, max_uses = :maxUses, expires_at = :expiresAt, signup_bonus_micro = :bonusMicro, note = :note, updated_by = :updatedBy, updated_at = :updatedAt WHERE code = :code`).run({ code, enabled, maxUses, expiresAt, bonusMicro, note: input.note === undefined ? row.note : String(input.note).slice(0, 500), updatedBy: session.user.id, updatedAt });
    const after = sql('SELECT * FROM invite_codes WHERE code = :code').get({ code });
    appendAuditEvent({ actorUserId: session.user.id, action: 'invite.update', targetType: 'invite_code', targetId: code, before, after: { enabled: Boolean(after.enabled), maxUses: after.max_uses, usedCount: after.used_count, expiresAt: after.expires_at, signupBonus: microToCredits(after.signup_bonus_micro), note: after.note || '' }, ...requestAudit(req, id) });
    return sendJson(res, 200, { ok: true });
  }
  if (inviteMatch && url.pathname.endsWith('/uses') && req.method === 'GET') {
    const code = inviteMatch[1].toUpperCase();
    const rows = sql('SELECT id, code, user_id AS userId, username_snapshot AS username, bonus_micro AS bonusMicro, used_at AS usedAt FROM invite_code_uses WHERE code = :code ORDER BY used_at DESC, id ASC').all({ code });
    return sendJson(res, 200, { items: rows.map(row => ({ ...row, bonus: microToCredits(row.bonusMicro) })) });
  }

  if (url.pathname === '/api/admin/logs/generations' && req.method === 'GET') return sendJson(res, 200, listGenerations(url));
  if (url.pathname === '/api/admin/logs/credits' && req.method === 'GET') return sendJson(res, 200, listCredits(url));
  if (url.pathname === '/api/admin/logs/llm' && req.method === 'GET') return sendJson(res, 200, listLlmUsage(url));
  if (url.pathname === '/api/admin/logs/audit' && req.method === 'GET') return sendJson(res, 200, listAudit(url));
  if (url.pathname === '/api/admin/logs/system' && req.method === 'GET') return sendJson(res, 200, listSystem(url));
  if (url.pathname === '/api/admin/billing/reconcile' && req.method === 'GET') {
    const rows = sql(`SELECT h.*, u.username FROM billing_holds h JOIN users u ON u.id = h.user_id WHERE h.status = 'billing_reconcile_required' ORDER BY h.updated_at DESC`).all();
    return sendJson(res, 200, { items: rows.map(row => ({ id: row.id, userId: row.user_id, username: row.username, status: row.status, details: rowDoc(row), updatedAt: row.updated_at })) });
  }
  return false;
}

export async function handleAdminRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/api/admin/')) return false;
  const id = requestId(req);
  try {
    if (url.pathname === '/api/admin/auth/login' && req.method === 'POST') return await login(req, res, id);
    const session = requireAdmin(req, res, { write: ['POST', 'PATCH', 'DELETE'].includes(req.method) });
    if (!session) return true;
    const handled = await handleAuthorized(req, res, url, session, id);
    if (!handled && !res.headersSent) sendJson(res, 404, { error: '后台接口不存在' });
    return true;
  } catch (error) {
    if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message });
    try { appendSystemEvent({ level: 'error', category: 'admin_api', requestId: id, message: error.message || '后台接口失败' }); } catch {}
    if (res.headersSent) return res.end();
    return sendJson(res, 500, { error: '后台服务错误' });
  }
}

export const __test = { parseSignedCredits, parseCookies, originAllowed, publicAdmin };
