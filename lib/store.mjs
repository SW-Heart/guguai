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
export {
  claimGenerationJobs,
  completeGenerationJob,
  createGenerationRequest,
  enqueueGenerationJob,
  findGenerationRequest,
  generationJobLeaseActive,
  generationQueueStats,
  renewGenerationJobLease,
  rescheduleGenerationJob,
} from '../repositories/generation-jobs.mjs';
import { createDramaProjectRepository } from '../repositories/drama-projects.mjs';
import { createGenerationRepository } from '../repositories/generations.mjs';
import { createAssetRepository } from '../repositories/assets.mjs';
import { createUploadRepository } from '../repositories/uploads.mjs';
import { createAccountRepository } from '../repositories/accounts.mjs';
import { createDeliveryRepository } from '../repositories/deliveries.mjs';

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
  user.phoneNumber = row.phone_number || user.phoneNumber || null;
  user.nickname = row.nickname || user.nickname || null;
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
const accountRepository = createAccountRepository({ sql, tx, parseUserRow });
export const {
  findUserById, findUserByUsername, findUserByLogin, findUserByPhoneNumber, loginNameTaken, usernameTaken,
  insertUser, createSmsUser, updateUserProfile, inviteUsed, burnInviteCode, registerUser,
  createSessionRecord, userForSession, deleteSession, purgeExpiredSessions,
} = accountRepository;

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
function keysetPage({ table, timeColumn, userId, filters = {}, extraWhere = [], extraParams = {}, limit, cursor, scope, includeTotal = true }) {
  const where = ['user_id = :userId'];
  const params = { userId, ...extraParams, limit: limit + 1 };

  where.push(...extraWhere);

  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    where.push(`${column} = :f_${column}`);
    params[`f_${column}`] = value;
  }

  let total = null;
  if (includeTotal) {
    const countSql = `SELECT COUNT(*) AS total FROM ${table} WHERE ${where.join(' AND ')}`;
    const countParams = { ...params };
    delete countParams.limit;
    total = sql(countSql).get(countParams).total;
  }

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

const dramaProjectRepository = createDramaProjectRepository({ sql, keysetPage, scopeWhere, parseDoc });
export const { saveDramaProjectRecord, findDramaProject, deleteDramaProject, listDramaProjects, latestDramaProject } = dramaProjectRepository;
const generationRepository = createGenerationRepository({ sql, keysetPage, scopeWhere, parseDoc, defaultPageLimit: DEFAULT_PAGE_LIMIT });
export const { saveGenerationRecord, findGeneration, listGenerations, listPendingGenerations } = generationRepository;

function scopeWhere(scope = {}, expression = 'doc_json') {
  const deviceId = String(scope?.deviceId || '').trim();
  const workspaceId = String(scope?.workspaceId || '').trim();
  if (!deviceId || !workspaceId) return { where: [], params: {} };
  return {
    where: [
      `json_extract(${expression}, '$.originDeviceId') = :originDeviceId`,
      `json_extract(${expression}, '$.originWorkspaceId') = :originWorkspaceId`,
    ],
    params: { originDeviceId: deviceId, originWorkspaceId: workspaceId },
  };
}

const assetRepository = createAssetRepository({
  sql, tx, keysetPage, scopeWhere, decodeCursor, encodeCursor, parseDoc, parseDocs,
  defaultPageLimit: DEFAULT_PAGE_LIMIT, maxPageLimit: MAX_PAGE_LIMIT,
});
export const {
  saveAssetRecord, findAsset, findAssetBySha256, deleteAsset, listAssets, listAssetChanges,
  findAssets, findCloudAssets,
} = assetRepository;
const deliveryRepository = createDeliveryRepository({ sql, scopeWhere, findAsset, defaultPageLimit: DEFAULT_PAGE_LIMIT, maxPageLimit: MAX_PAGE_LIMIT });
export const { listPendingAssetDeliveries, markAssetDeliveryPending, markAssetDeliveryReady } = deliveryRepository;

const uploadRepository = createUploadRepository({ sql, tx, findAsset, saveAssetRecord });
export const {
  createUploadIntent, findUploadIntent, countActiveUploadIntents, claimUploadIntent,
  markUploadIntentFailed, completeUploadIntentWithAsset, expireUploadIntent,
  expireUploadIntents, listRecoverableUploadIntents,
} = uploadRepository;

function containsAnyId(value, ids) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return ids.has(value);
  if (Array.isArray(value)) return value.some(item => containsAnyId(item, ids));
  if (typeof value === 'object') return Object.values(value).some(item => containsAnyId(item, ids));
  return false;
}

/**
 * Assigns legacy records to the current local workspace without moving any
 * file. Older clients did not persist an origin device/workspace, so the only
 * safe claim signal is an asset ID that is already present in this workspace.
 * Records with no matching local asset remain hidden from scoped desktop reads.
 */
export function claimLegacyWorkspace(userId, { deviceId = '', workspaceId = '', assetIds = [] } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  const ids = new Set((Array.isArray(assetIds) ? assetIds : [])
    .map(value => String(value || '').trim())
    .filter(value => value && value.length <= 200)
    .slice(0, 5000));
  if (!normalizedDeviceId || !normalizedWorkspaceId || !ids.size) {
    return { generations: 0, assets: 0, projects: 0 };
  }

  const result = { generations: 0, assets: 0, projects: 0 };
  const updatedAt = new Date().toISOString();
  const placeholders = [...ids].map((_, index) => `:assetId${index}`).join(', ');
  const idParams = Object.fromEntries([...ids].map((value, index) => [`assetId${index}`, value]));
  const legacyPredicate = `(json_extract(doc_json, '$.originDeviceId') IS NULL OR json_extract(doc_json, '$.originDeviceId') = '' OR json_extract(doc_json, '$.originWorkspaceId') IS NULL OR json_extract(doc_json, '$.originWorkspaceId') = '')`;

  tx(() => {
    const claimedGenerationIds = new Set();
    const generations = sql(`
      SELECT id, doc_json
      FROM generations
      WHERE user_id = :userId AND (asset_id IN (${placeholders}) OR json_extract(doc_json, '$.assetId') IN (${placeholders})) AND ${legacyPredicate}`)
      .all({ userId, ...idParams });
    for (const row of generations) {
      let doc;
      try { doc = JSON.parse(row.doc_json); } catch { continue; }
      doc.originDeviceId = normalizedDeviceId;
      doc.originWorkspaceId = normalizedWorkspaceId;
      doc.updatedAt ||= updatedAt;
      sql(`UPDATE generations SET updated_at = :updatedAt, doc_json = :docJson
           WHERE user_id = :userId AND id = :id AND ${legacyPredicate}`)
        .run({ userId, id: row.id, updatedAt, docJson: JSON.stringify(doc) });
      claimedGenerationIds.add(String(row.id));
      result.generations += 1;
    }

    const assets = sql(`
      SELECT id, doc_json
      FROM assets
      WHERE user_id = :userId AND ${legacyPredicate}`)
      .all({ userId });
    const claimedIds = new Set([...ids, ...claimedGenerationIds]);
    for (const row of assets) {
      let doc;
      try { doc = JSON.parse(row.doc_json); } catch { continue; }
      if (!ids.has(String(row.id)) && !containsAnyId(doc, claimedIds)) continue;
      doc.originDeviceId = normalizedDeviceId;
      doc.originWorkspaceId = normalizedWorkspaceId;
      doc.updatedAt ||= updatedAt;
      sql(`UPDATE assets SET updated_at = :updatedAt, doc_json = :docJson
           WHERE user_id = :userId AND id = :id AND ${legacyPredicate}`)
        .run({ userId, id: row.id, updatedAt, docJson: JSON.stringify(doc) });
      result.assets += 1;
    }

    const projects = sql(`
      SELECT id, revision, doc_json
      FROM drama_projects
      WHERE user_id = :userId AND ${legacyPredicate}`)
      .all({ userId });
    for (const row of projects) {
      let doc;
      try { doc = JSON.parse(row.doc_json); } catch { continue; }
      if (!containsAnyId(doc, claimedIds)) continue;
      doc.originDeviceId = normalizedDeviceId;
      doc.originWorkspaceId = normalizedWorkspaceId;
      doc.updatedAt ||= updatedAt;
      const revision = Math.max(1, Number(doc.revision) || Number(row.revision) || 1) + 1;
      doc.revision = revision;
      sql(`UPDATE drama_projects SET revision = :revision, updated_at = :updatedAt, doc_json = :docJson
           WHERE user_id = :userId AND id = :id AND ${legacyPredicate}`)
        .run({ userId, id: row.id, revision, updatedAt, docJson: JSON.stringify(doc) });
      result.projects += 1;
    }
  });
  return result;
}
