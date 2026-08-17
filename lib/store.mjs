/**
 * Data access for users, sessions, generations, assets and drama projects.
 *
 * Every record keeps its full original object in `doc_json`, with a handful of
 * columns promoted for indexing and filtering. Reads return the parsed document
 * unchanged, which is what keeps the HTTP responses byte-identical to the JSON
 * file era. Writes must go through this module so the promoted columns stay in
 * sync with the document.
 *
 * List queries use keyset pagination. Note that offset pagination would rescan
 * skipped rows on every page, which is the same cost profile as the directory
 * scan being replaced.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, tx } from './db.mjs';

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 200;

const parseDoc = row => (row ? JSON.parse(row.doc_json) : null);
const parseDocs = rows => rows.map(row => JSON.parse(row.doc_json));

// ---------------------------------------------------------------- cursors

/**
 * Cursors are opaque and signed. Without a signature a client could craft a
 * cursor for another user's sort position, and an unsigned cursor is also easy
 * to accidentally malform, which then surfaces as a confusing empty page.
 */
let cursorSecret = null;
export function configureCursors(secret) {
  cursorSecret = String(secret || '');
}

function cursorKey() {
  if (!cursorSecret) throw new Error('游标密钥未配置，请先调用 configureCursors()');
  return cursorSecret;
}

export function encodeCursor(scope, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, s: scope }), 'utf8').toString('base64url');
  const mac = createHmac('sha256', cursorKey()).update(`${scope}.${body}`).digest('base64url').slice(0, 22);
  return `${body}.${mac}`;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor 无效，请使用上一页响应头 X-Next-Cursor 返回的值');
    this.name = 'InvalidCursorError';
    this.statusCode = 400;
  }
}

export function decodeCursor(scope, cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const text = String(cursor);
  if (text.length > 512) throw new InvalidCursorError();
  const dot = text.lastIndexOf('.');
  if (dot <= 0) throw new InvalidCursorError();

  const body = text.slice(0, dot);
  const mac = text.slice(dot + 1);
  const expected = createHmac('sha256', cursorKey()).update(`${scope}.${body}`).digest('base64url').slice(0, 22);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidCursorError();

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new InvalidCursorError(); }
  if (!payload || payload.s !== scope || typeof payload.t !== 'string' || typeof payload.i !== 'string') {
    throw new InvalidCursorError();
  }
  return payload;
}

export function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(String(raw))) {
    throw Object.assign(new Error(`limit 必须是 1 到 ${MAX_PAGE_LIMIT} 之间的整数`), { statusCode: 400 });
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_PAGE_LIMIT) {
    throw Object.assign(new Error(`limit 必须是 1 到 ${MAX_PAGE_LIMIT} 之间的整数`), { statusCode: 400 });
  }
  return value;
}

/**
 * Runs a keyset page over `table` ordered by `timeColumn` DESC, id ASC.
 *
 * The predicate is written out as `time < :t OR (time = :t AND id > :i)` rather
 * than the tuple form `(time, id) < (:t, :i)`, because tuple comparison would
 * order ids DESC within a timestamp tie and contradict the id ASC tiebreak.
 */
function keysetPage({ table, timeColumn, userId, filters = {}, limit, cursor, scope }) {
  const where = ['user_id = :userId'];
  const params = { userId, limit: limit + 1 };

  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    where.push(`${column} = :f_${column}`);
    params[`f_${column}`] = value;
  }

  const countSql = `SELECT COUNT(*) AS total FROM ${table} WHERE ${where.join(' AND ')}`;
  const countParams = { ...params };
  delete countParams.limit;
  const total = sql(countSql).get(countParams).total;

  const position = decodeCursor(scope, cursor);
  if (position) {
    where.push(`(${timeColumn} < :cursorTime OR (${timeColumn} = :cursorTime AND id > :cursorId))`);
    params.cursorTime = position.t;
    params.cursorId = position.i;
  }

  const rows = sql(`
    SELECT id, ${timeColumn} AS sortTime, doc_json FROM ${table}
    WHERE ${where.join(' AND ')}
    ORDER BY ${timeColumn} DESC, id ASC
    LIMIT :limit`).all(params);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(scope, { t: last.sortTime, i: last.id }) : null;

  return { items: parseDocs(page), total, nextCursor };
}

// ---------------------------------------------------------------- users

export function findUserById(userId) {
  return parseDoc(sql('SELECT doc_json FROM users WHERE id = :userId').get({ userId }));
}

export function findUserByUsername(username) {
  return parseDoc(sql('SELECT doc_json FROM users WHERE username = :username')
    .get({ username: String(username).toLowerCase() }));
}

export function usernameTaken(username) {
  return sql('SELECT 1 AS hit FROM users WHERE username = :username')
    .get({ username: String(username).toLowerCase() }) !== undefined;
}

export function insertUser(user) {
  sql(`
    INSERT INTO users(id, username, password_hash, role, invite_code,
                      credit_balance_micro, credit_held_micro, created_at, doc_json)
    VALUES(:id, :username, :passwordHash, :role, :inviteCode,
           :balanceMicro, :heldMicro, :createdAt, :docJson)`).run({
    id: user.id,
    username: String(user.username).toLowerCase(),
    passwordHash: user.passwordHash,
    role: user.role ?? 'user',
    inviteCode: user.inviteCode ?? null,
    balanceMicro: user.creditBalanceMicro ?? 0,
    heldMicro: user.creditHeldMicro ?? 0,
    createdAt: user.createdAt,
    docJson: JSON.stringify(user),
  });
  return user;
}

// ---------------------------------------------------------------- invites

export function inviteUsed(code) {
  return sql('SELECT 1 AS hit FROM invite_uses WHERE code = :code').get({ code }) !== undefined;
}

/**
 * Burns an invite code. The PRIMARY KEY on `code` makes this the arbiter for
 * concurrent registrations using the same code: exactly one INSERT wins.
 * Returns false when the code was already spent.
 */
export function burnInviteCode(code, { userId, username, usedAt }) {
  const changes = sql(`
    INSERT INTO invite_uses(code, user_id, username, used_at)
    VALUES(:code, :userId, :username, :usedAt)
    ON CONFLICT(code) DO NOTHING`).run({ code, userId, username, usedAt }).changes;
  return changes > 0;
}

/** Registers a user and burns the invite code in one transaction. */
export function registerUser({ user, inviteCode, signupBonus, grantBonus }) {
  return tx(() => {
    if (usernameTaken(user.username)) return { status: 409, error: '账号已存在' };
    if (inviteCode && !burnInviteCode(inviteCode, {
      userId: user.id, username: user.username, usedAt: user.createdAt,
    })) {
      return { status: 409, error: '邀请码已被使用' };
    }
    insertUser(user);
    const wallet = signupBonus > 0 ? grantBonus(user.id, signupBonus) : null;
    return { user: findUserById(user.id), wallet };
  });
}

// ---------------------------------------------------------------- sessions

export function createSessionRecord({ tokenHash, userId, expiresAt, createdAt }) {
  sql(`
    INSERT INTO sessions(token_hash, user_id, expires_at, created_at)
    VALUES(:tokenHash, :userId, :expiresAt, :createdAt)`)
    .run({ tokenHash, userId, expiresAt, createdAt });
}

/** Resolves a session to its user, deleting the row when expired or orphaned. */
export function userForSession(tokenHash, nowIso) {
  const row = sql(`
    SELECT s.expires_at AS expiresAt, u.doc_json
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = :tokenHash`).get({ tokenHash });
  if (!row) return null;
  if (!row.doc_json || row.expiresAt <= nowIso) {
    deleteSession(tokenHash);
    return null;
  }
  return JSON.parse(row.doc_json);
}

export function deleteSession(tokenHash) {
  sql('DELETE FROM sessions WHERE token_hash = :tokenHash').run({ tokenHash });
}

export function purgeExpiredSessions(nowIso) {
  return sql('DELETE FROM sessions WHERE expires_at <= :now').run({ now: nowIso }).changes;
}

// ---------------------------------------------------------------- generations

export function saveGenerationRecord(userId, task) {
  sql(`
    INSERT INTO generations(id, user_id, type, status, credit_cost, credit_status,
                            asset_id, provider_task_id, created_at, updated_at, doc_json)
    VALUES(:id, :userId, :type, :status, :creditCost, :creditStatus,
           :assetId, :providerTaskId, :createdAt, :updatedAt, :docJson)
    ON CONFLICT(id) DO UPDATE SET
      status           = excluded.status,
      credit_cost      = excluded.credit_cost,
      credit_status    = excluded.credit_status,
      asset_id         = excluded.asset_id,
      provider_task_id = excluded.provider_task_id,
      updated_at       = excluded.updated_at,
      doc_json         = excluded.doc_json`).run({
    id: task.id,
    userId,
    type: task.type ?? 'image',
    status: task.status ?? 'queued',
    creditCost: Number.isFinite(Number(task.creditCost)) ? Number(task.creditCost) : 0,
    creditStatus: task.creditStatus ?? null,
    assetId: task.assetId || null,
    providerTaskId: task.providerTaskId || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    docJson: JSON.stringify(task),
  });
  return task;
}

export function findGeneration(userId, id) {
  return parseDoc(sql('SELECT doc_json FROM generations WHERE id = :id AND user_id = :userId')
    .get({ id, userId }));
}

export function deleteGeneration(userId, id) {
  return sql('DELETE FROM generations WHERE id = :id AND user_id = :userId')
    .run({ id, userId }).changes > 0;
}

export function listGenerations(userId, { type = null, limit = DEFAULT_PAGE_LIMIT, cursor = null } = {}) {
  return keysetPage({
    table: 'generations', timeColumn: 'created_at', scope: 'gen',
    userId, filters: { type }, limit, cursor,
  });
}

/** Non-terminal tasks only, for startup recovery. Uses idx_gen_status. */
export function listPendingGenerations() {
  return sql(`
    SELECT user_id AS userId, doc_json FROM generations
    WHERE status IN ('queued','running')
    ORDER BY created_at ASC`).all()
    .map(row => ({ userId: row.userId, task: JSON.parse(row.doc_json) }));
}

// ---------------------------------------------------------------- assets

export function saveAssetRecord(userId, asset) {
  sql(`
    INSERT INTO assets(id, user_id, kind, name, oss_key, created_at, updated_at, doc_json)
    VALUES(:id, :userId, :kind, :name, :ossKey, :createdAt, :updatedAt, :docJson)
    ON CONFLICT(id) DO UPDATE SET
      kind       = excluded.kind,
      name       = excluded.name,
      oss_key    = excluded.oss_key,
      updated_at = excluded.updated_at,
      doc_json   = excluded.doc_json`).run({
    id: asset.id,
    userId,
    kind: asset.kind ?? 'image',
    name: asset.name ?? asset.id,
    ossKey: asset.ossKey ?? null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    docJson: JSON.stringify(asset),
  });
  return asset;
}

export function findAsset(userId, id) {
  return parseDoc(sql('SELECT doc_json FROM assets WHERE id = :id AND user_id = :userId')
    .get({ id, userId }));
}

export function deleteAsset(userId, id) {
  return sql('DELETE FROM assets WHERE id = :id AND user_id = :userId')
    .run({ id, userId }).changes > 0;
}

export function listAssets(userId, { kind = null, limit = DEFAULT_PAGE_LIMIT, cursor = null } = {}) {
  return keysetPage({
    table: 'assets', timeColumn: 'created_at', scope: 'asset',
    userId, filters: { kind }, limit, cursor,
  });
}

/** Resolves several asset ids at once, preserving the requested order. */
export function findAssets(userId, ids) {
  const found = new Map();
  for (const id of ids) {
    const asset = findAsset(userId, id);
    if (asset) found.set(id, asset);
  }
  return ids.map(id => found.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------- drama

export function saveDramaProjectRecord(userId, project) {
  sql(`
    INSERT INTO drama_projects(id, user_id, title, step, status, created_at, updated_at, doc_json)
    VALUES(:id, :userId, :title, :step, :status, :createdAt, :updatedAt, :docJson)
    ON CONFLICT(id) DO UPDATE SET
      title      = excluded.title,
      step       = excluded.step,
      status     = excluded.status,
      updated_at = excluded.updated_at,
      doc_json   = excluded.doc_json`).run({
    id: project.id,
    userId,
    title: project.title ?? null,
    step: project.step ?? null,
    status: project.status ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    docJson: JSON.stringify(project),
  });
  return project;
}

export function findDramaProject(userId, id) {
  return parseDoc(sql('SELECT doc_json FROM drama_projects WHERE id = :id AND user_id = :userId')
    .get({ id, userId }));
}

export function deleteDramaProject(userId, id) {
  return sql('DELETE FROM drama_projects WHERE id = :id AND user_id = :userId')
    .run({ id, userId }).changes > 0;
}

export function listDramaProjects(userId, { limit = DEFAULT_PAGE_LIMIT, cursor = null } = {}) {
  return keysetPage({
    table: 'drama_projects', timeColumn: 'updated_at', scope: 'drama',
    userId, limit, cursor,
  });
}

/** Most recently updated project, reading a single row. */
export function latestDramaProject(userId) {
  return parseDoc(sql(`
    SELECT doc_json FROM drama_projects
    WHERE user_id = :userId
    ORDER BY updated_at DESC, id ASC
    LIMIT 1`).get({ userId }));
}
