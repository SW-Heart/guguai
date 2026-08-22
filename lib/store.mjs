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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql, tx } from './db.mjs';

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 200;

const parseDoc = row => (row ? JSON.parse(row.doc_json) : null);
const parseUserRow = row => {
  if (!row) return null;
  const user = JSON.parse(row.doc_json);
  user.id = row.id;
  user.username = row.username;
  user.role = row.role || user.role || 'user';
  user.status = row.status || user.status || 'active';
  user.creditBalanceMicro = row.credit_balance_micro;
  user.creditHeldMicro = row.credit_held_micro;
  user.credits = row.credit_balance_micro / 1_000_000;
  user.adminNote = row.admin_note || user.adminNote || '';
  user.disabledAt = row.disabled_at || user.disabledAt || null;
  user.disabledBy = row.disabled_by || user.disabledBy || null;
  user.updatedAt = row.updated_at || user.updatedAt || user.createdAt;
  return user;
};
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
  return parseUserRow(sql('SELECT * FROM users WHERE id = :userId').get({ userId }));
}

export function findUserByUsername(username) {
  return parseUserRow(sql('SELECT * FROM users WHERE username = :username')
    .get({ username: String(username).toLowerCase() }));
}

export function usernameTaken(username) {
  return sql('SELECT 1 AS hit FROM users WHERE username = :username')
    .get({ username: String(username).toLowerCase() }) !== undefined;
}

export function insertUser(user) {
  sql(`
    INSERT INTO users(id, username, password_hash, role, status, invite_code, admin_note,
                      disabled_at, disabled_by, updated_at, credit_balance_micro, credit_held_micro, created_at, doc_json)
    VALUES(:id, :username, :passwordHash, :role, :status, :inviteCode, :adminNote,
           :disabledAt, :disabledBy, :updatedAt, :balanceMicro, :heldMicro, :createdAt, :docJson)`).run({
    id: user.id,
    username: String(user.username).toLowerCase(),
    passwordHash: user.passwordHash,
    role: user.role ?? 'user',
    status: user.status ?? 'active',
    inviteCode: user.inviteCode ?? null,
    adminNote: user.adminNote ?? null,
    disabledAt: user.disabledAt ?? null,
    disabledBy: user.disabledBy ?? null,
    updatedAt: user.updatedAt ?? user.createdAt,
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

export function burnInviteCode(code, { userId, username, usedAt }) {
  const changes = sql(`
    INSERT INTO invite_uses(code, user_id, username, used_at)
    VALUES(:code, :userId, :username, :usedAt)
    ON CONFLICT(code) DO NOTHING`).run({ code, userId, username, usedAt }).changes;
  return changes > 0;
}

function consumeConfiguredInvite(code, { userId, username, usedAt }) {
  const invite = sql('SELECT * FROM invite_codes WHERE code = :code').get({ code });
  if (!invite) return { error: '邀请码无效', status: 400 };
  const nowIso = usedAt || new Date().toISOString();
  if (!invite.enabled) return { error: '邀请码已停用', status: 409 };
  if (invite.expires_at && invite.expires_at <= nowIso) return { error: '邀请码已过期', status: 409 };
  const updated = sql(`
    UPDATE invite_codes
    SET used_count = used_count + 1, updated_at = :updatedAt
    WHERE code = :code AND enabled = 1 AND used_count < max_uses
      AND (expires_at IS NULL OR expires_at > :nowIso)
  `).run({ code, updatedAt: nowIso, nowIso }).changes;
  if (updated !== 1) return { error: '邀请码已达到使用上限', status: 409 };
  const bonusMicro = Number(invite.signup_bonus_micro) || 0;
  return { invite, bonusMicro, usedAt: nowIso };
}

/** Registers a user and consumes a configurable invite code in one transaction. */
export function registerUser({ user, inviteCode, signupBonus = null, grantBonus }) {
  return tx(() => {
    if (usernameTaken(user.username)) return { status: 409, error: '账号已存在' };
    let consumed;
    if (inviteCode) {
      consumed = consumeConfiguredInvite(inviteCode, {
        userId: user.id, username: user.username, usedAt: user.createdAt,
      });
      if (consumed.error) return consumed;
      user.inviteCode = inviteCode;
    }
    insertUser(user);
    if (consumed) {
      sql(`INSERT INTO invite_code_uses(id, code, user_id, username_snapshot, bonus_micro, used_at)
           VALUES(:id, :code, :userId, :username, :bonusMicro, :usedAt)`).run({ id: randomUUID(), code: inviteCode, userId: user.id, username: user.username, bonusMicro: consumed.bonusMicro, usedAt: consumed.usedAt });
    }
    const bonus = consumed ? consumed.bonusMicro / 1_000_000 : Number(signupBonus || 0);
    const wallet = bonus > 0 ? grantBonus(user.id, bonus) : null;
    return { user: findUserById(user.id), wallet, invite: consumed?.invite || null };
  });
}

// ---------------------------------------------------------------- sessions

export function createSessionRecord({ tokenHash, userId, scope = 'user', csrfTokenHash = null, expiresAt, createdAt }) {
  sql(`
    INSERT INTO sessions(token_hash, user_id, scope, csrf_token_hash, expires_at, created_at)
    VALUES(:tokenHash, :userId, :scope, :csrfTokenHash, :expiresAt, :createdAt)`)
    .run({ tokenHash, userId, scope, csrfTokenHash, expiresAt, createdAt });
}

/** Resolves a session to its user using promoted columns for permissions and wallet state. */
export function userForSession(tokenHash, nowIso) {
  const row = sql(`
    SELECT s.expires_at AS expiresAt, s.scope, s.csrf_token_hash AS csrfTokenHash,
           u.*
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = :tokenHash`).get({ tokenHash });
  if (!row || !row.doc_json || row.expiresAt <= nowIso || row.status === 'disabled') {
    if (row) deleteSession(tokenHash);
    return null;
  }
  return { ...parseUserRow(row), sessionScope: row.scope, csrfTokenHash: row.csrfTokenHash };
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
    INSERT INTO generations(id, user_id, type, status, credit_cost, credit_cost_micro, credit_status,
                            pricing_version, pricing_snapshot_json, model_id, provider,
                            asset_id, provider_task_id, created_at, updated_at, doc_json)
    VALUES(:id, :userId, :type, :status, :creditCost, :creditCostMicro, :creditStatus,
           :pricingVersion, :pricingSnapshotJson, :modelId, :provider,
           :assetId, :providerTaskId, :createdAt, :updatedAt, :docJson)
    ON CONFLICT(id) DO UPDATE SET
      status                = excluded.status,
      credit_cost           = excluded.credit_cost,
      credit_cost_micro     = excluded.credit_cost_micro,
      credit_status         = excluded.credit_status,
      pricing_version       = excluded.pricing_version,
      pricing_snapshot_json = excluded.pricing_snapshot_json,
      model_id              = excluded.model_id,
      provider              = excluded.provider,
      asset_id              = excluded.asset_id,
      provider_task_id      = excluded.provider_task_id,
      updated_at            = excluded.updated_at,
      doc_json              = excluded.doc_json`).run({
    id: task.id,
    userId,
    type: task.type ?? 'image',
    status: task.status ?? 'queued',
    creditCost: Number.isFinite(Number(task.creditCost)) ? Number(task.creditCost) : 0,
    creditCostMicro: Number.isSafeInteger(task.creditCostMicro) ? task.creditCostMicro : null,
    creditStatus: task.creditStatus ?? null,
    pricingVersion: task.pricingVersion ?? task.pricingSnapshot?.version ?? null,
    pricingSnapshotJson: task.pricingSnapshot ? JSON.stringify(task.pricingSnapshot) : null,
    modelId: task.videoModelId || task.modelId || null,
    provider: task.provider || null,
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

/** Finds a user's existing binary by its client-computed content hash. */
export function findAssetBySha256(userId, sha256, size) {
  return parseDoc(sql(`
    SELECT doc_json FROM assets
    WHERE user_id = :userId
      AND json_extract(doc_json, '$.sha256') = :sha256
      AND json_extract(doc_json, '$.size') = :size
    ORDER BY created_at DESC, id ASC LIMIT 1`).get({ userId, sha256, size }));
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

// ---------------------------------------------------------------- upload intents

function parseUploadIntentRow(row) {
  if (!row) return null;
  const value = JSON.parse(row.doc_json);
  return {
    ...value,
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    temporaryOssKey: row.temporary_oss_key,
    finalOssKey: row.final_oss_key,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    expectedSize: row.expected_size,
    actualSize: row.actual_size,
    clientWidth: row.client_width,
    clientHeight: row.client_height,
    objectEtag: row.object_etag,
    status: row.status,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
  };
}

function uploadIntentRow(userId, id) {
  return sql(`
    SELECT * FROM upload_intents
    WHERE user_id = :userId AND id = :id`).get({ userId, id });
}

export function createUploadIntent(intent) {
  sql(`
    INSERT INTO upload_intents(
      id, user_id, asset_id, temporary_oss_key, final_oss_key,
      name, kind, mime_type, expected_size, actual_size,
      client_width, client_height, object_etag, status, expires_at,
      claimed_at, created_at, updated_at, completed_at, error_code, doc_json
    ) VALUES(
      :id, :userId, :assetId, :temporaryOssKey, :finalOssKey,
      :name, :kind, :mimeType, :expectedSize, :actualSize,
      :clientWidth, :clientHeight, :objectEtag, :status, :expiresAt,
      :claimedAt, :createdAt, :updatedAt, :completedAt, :errorCode, :docJson
    )`).run({
    id: intent.id,
    userId: intent.userId,
    assetId: intent.assetId,
    temporaryOssKey: intent.temporaryOssKey,
    finalOssKey: intent.finalOssKey,
    name: intent.name,
    kind: intent.kind,
    mimeType: intent.mimeType,
    expectedSize: intent.expectedSize,
    actualSize: intent.actualSize ?? null,
    clientWidth: intent.clientWidth ?? null,
    clientHeight: intent.clientHeight ?? null,
    objectEtag: intent.objectEtag ?? null,
    status: intent.status ?? 'pending',
    expiresAt: intent.expiresAt,
    claimedAt: intent.claimedAt ?? null,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt ?? intent.createdAt,
    completedAt: intent.completedAt ?? null,
    errorCode: intent.errorCode ?? null,
    docJson: JSON.stringify(intent),
  });
  return intent;
}

export function findUploadIntent(userId, id) {
  return parseUploadIntentRow(uploadIntentRow(userId, id));
}

export function countActiveUploadIntents(userId) {
  return sql(`
    SELECT COUNT(*) AS count FROM upload_intents
    WHERE user_id = :userId AND status IN ('pending', 'verifying')`).get({ userId }).count;
}

/** Atomically claims a pending intent so concurrent complete calls do not copy twice. */
export function claimUploadIntent(userId, id, nowIso) {
  const changed = sql(`
    UPDATE upload_intents
    SET status = 'verifying', claimed_at = :now, updated_at = :now,
        doc_json = json_set(doc_json, '$.status', 'verifying', '$.claimedAt', :now, '$.updatedAt', :now)
    WHERE user_id = :userId AND id = :id AND status = 'pending'
      AND expires_at > :now`).run({ userId, id, now: nowIso }).changes;
  return changed === 1;
}

function updateUploadIntentDocument(intent, patch) {
  return { ...intent, ...patch };
}

export function markUploadIntentFailed(userId, id, { errorCode, actualSize = null, objectEtag = null, nowIso }) {
  const current = findUploadIntent(userId, id);
  if (!current) return null;
  const updated = updateUploadIntentDocument(current, {
    status: 'failed', actualSize, objectEtag, errorCode,
    updatedAt: nowIso, claimedAt: current.claimedAt || null,
  });
  sql(`
    UPDATE upload_intents
    SET status = :status, actual_size = :actualSize, object_etag = :objectEtag,
        updated_at = :updatedAt, error_code = :errorCode, doc_json = :docJson
    WHERE user_id = :userId AND id = :id`).run({
    userId, id, status: updated.status, actualSize, objectEtag,
    updatedAt: nowIso, errorCode, docJson: JSON.stringify(updated),
  });
  return updated;
}

export function completeUploadIntentWithAsset(userId, id, { actualSize, objectEtag, asset, nowIso }) {
  return tx(() => {
    const current = findUploadIntent(userId, id);
    if (!current) return null;
    if (current.status === 'completed') return { intent: current, asset: findAsset(userId, current.assetId) };
    if (current.status !== 'verifying') return null;
    const completed = updateUploadIntentDocument(current, {
      status: 'completed', actualSize, objectEtag, completedAt: nowIso, updatedAt: nowIso,
    });
    saveAssetRecord(userId, asset);
    sql(`
      UPDATE upload_intents
      SET status = 'completed', actual_size = :actualSize, object_etag = :objectEtag,
          completed_at = :completedAt, updated_at = :updatedAt, doc_json = :docJson
      WHERE user_id = :userId AND id = :id AND status = 'verifying'`).run({
      userId, id, actualSize, objectEtag, completedAt: nowIso,
      updatedAt: nowIso, docJson: JSON.stringify(completed),
    });
    return { intent: completed, asset };
  });
}

export function expireUploadIntents(nowIso, limit = 100) {
  const rows = sql(`
    SELECT id, user_id AS userId, temporary_oss_key AS temporaryOssKey,
           final_oss_key AS finalOssKey
    FROM upload_intents
    WHERE status = 'pending' AND expires_at <= :now
    ORDER BY expires_at ASC LIMIT :limit`).all({ now: nowIso, limit });
  for (const row of rows) {
    sql(`
      UPDATE upload_intents
      SET status = 'expired', updated_at = :now,
          error_code = 'UPLOAD_EXPIRED',
          doc_json = json_set(doc_json, '$.status', 'expired', '$.updatedAt', :now, '$.errorCode', 'UPLOAD_EXPIRED')
      WHERE id = :id AND status = 'pending'`).run({ id: row.id, now: nowIso });
  }
  return rows;
}

export function listRecoverableUploadIntents(nowIso, staleBeforeIso, limit = 50) {
  return sql(`
    SELECT * FROM upload_intents
    WHERE status = 'verifying' AND claimed_at <= :staleBefore
    ORDER BY claimed_at ASC LIMIT :limit`).all({ staleBefore: staleBeforeIso, limit }).map(parseUploadIntentRow);
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
