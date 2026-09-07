import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const databaseName = 'library.db';
const legacyIndexName = 'library-index.json';
const defaultLimit = 200;
const maxLimit = 200;
let database = null;

function db() {
  if (!database) throw new Error('本地素材库尚未初始化');
  return database;
}

function nullable(value) {
  const text = String(value || '').trim();
  return text || null;
}

function rowToAsset(row) {
  if (!row) return null;
  try { return JSON.parse(row.doc_json); } catch { return null; }
}

function assetParams(asset) {
  const createdAt = String(asset.createdAt || new Date().toISOString());
  const updatedAt = String(asset.updatedAt || createdAt);
  const normalized = {
    ...asset,
    id: String(asset.id || ''),
    cloudAssetId: String(asset.cloudAssetId || ''),
    name: String(asset.name || asset.id || '未命名文件'),
    relativePath: String(asset.relativePath || ''),
    mimeType: String(asset.mimeType || 'application/octet-stream'),
    kind: String(asset.kind || 'image'),
    size: Number.isSafeInteger(Number(asset.size)) ? Number(asset.size) : 0,
    sha256: String(asset.sha256 || ''),
    createdAt,
    updatedAt,
    localStatus: String(asset.localStatus || 'saved'),
    remoteStatus: String(asset.remoteStatus || 'pending'),
  };
  return {
    id: normalized.id,
    cloudAssetId: nullable(asset.cloudAssetId),
    name: normalized.name,
    relativePath: normalized.relativePath,
    mimeType: normalized.mimeType,
    kind: normalized.kind,
    size: normalized.size,
    sha256: nullable(asset.sha256),
    createdAt,
    updatedAt,
    localStatus: normalized.localStatus,
    remoteStatus: normalized.remoteStatus,
    docJson: JSON.stringify(normalized),
  };
}

function upsert(asset) {
  const params = assetParams(asset);
  if (!params.id || !params.relativePath) throw new Error('本地素材记录不完整');
  db().prepare(`
    INSERT INTO assets(id, cloud_asset_id, name, relative_path, mime_type, kind, size, sha256,
                       created_at, updated_at, local_status, remote_status, doc_json)
    VALUES(:id, :cloudAssetId, :name, :relativePath, :mimeType, :kind, :size, :sha256,
           :createdAt, :updatedAt, :localStatus, :remoteStatus, :docJson)
    ON CONFLICT(id) DO UPDATE SET
      cloud_asset_id = excluded.cloud_asset_id,
      name = excluded.name,
      relative_path = excluded.relative_path,
      mime_type = excluded.mime_type,
      kind = excluded.kind,
      size = excluded.size,
      sha256 = excluded.sha256,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      local_status = excluded.local_status,
      remote_status = excluded.remote_status,
      doc_json = excluded.doc_json`).run(params);
  return asset;
}

function migrateLegacyIndex(workspace) {
  const legacyFile = path.join(workspace, '.gugu', legacyIndexName);
  if (!existsSync(legacyFile)) return 0;
  let legacy;
  try { legacy = JSON.parse(readFileSync(legacyFile, 'utf8')); } catch { return 0; }
  if (!Array.isArray(legacy?.assets) || !legacy.assets.length) return 0;
  const insert = db().prepare(`
    INSERT OR IGNORE INTO assets(id, cloud_asset_id, name, relative_path, mime_type, kind, size, sha256,
                                 created_at, updated_at, local_status, remote_status, doc_json)
    VALUES(:id, :cloudAssetId, :name, :relativePath, :mimeType, :kind, :size, :sha256,
           :createdAt, :updatedAt, :localStatus, :remoteStatus, :docJson)`);
  let migrated = 0;
  db().exec('BEGIN');
  try {
    for (const asset of legacy.assets) {
      try {
        const params = assetParams(asset);
        if (!params.id || !params.relativePath) continue;
        migrated += insert.run(params).changes > 0 ? 1 : 0;
      } catch { /* skip malformed legacy rows */ }
    }
    db().exec('COMMIT');
  } catch (error) {
    db().exec('ROLLBACK');
    throw error;
  }
  return migrated;
}

export function openLocalLibrary(workspace) {
  closeLocalLibrary();
  const root = path.resolve(workspace);
  const metadataDir = path.join(root, '.gugu');
  mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(metadataDir, databaseName));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      cloud_asset_id TEXT UNIQUE,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_status TEXT NOT NULL,
      remote_status TEXT NOT NULL,
      doc_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_tasks (
      asset_id TEXT PRIMARY KEY,
      local_asset_id TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      mime_type TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      CHECK (status IN ('pending', 'retrying'))
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_tasks_due ON delivery_tasks(status, next_attempt_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_local_assets_time ON assets(created_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_local_assets_kind_time ON assets(kind, created_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_local_assets_sha_size ON assets(sha256, size);
  `);
  const count = database.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
  const migrated = Number(count) === 0 ? migrateLegacyIndex(root) : 0;
  return { migrated };
}

export function closeLocalLibrary() {
  if (!database) return;
  try { database.close(); } catch {}
  database = null;
}

export function getLocalAsset(id) {
  return rowToAsset(db().prepare('SELECT doc_json FROM assets WHERE id = :id').get({ id: String(id || '') }));
}

export function findLocalAssetByCloudId(cloudAssetId) {
  return rowToAsset(db().prepare('SELECT doc_json FROM assets WHERE cloud_asset_id = :cloudAssetId').get({ cloudAssetId: String(cloudAssetId || '') }));
}

export function findLocalAssetByRelativePath(relativePath) {
  return rowToAsset(db().prepare('SELECT doc_json FROM assets WHERE relative_path = :relativePath').get({ relativePath: String(relativePath || '') }));
}

// relative_path 和 cloud_asset_id 都是唯一列。只有未绑定云端 ID 的本地导入记录
// 才能被云端素材认领；已绑定其他云端 ID 的记录必须保留原归属。即使两个
// 任务产出的字节完全相同，渲染层仍需要两个 cloud_asset_id 都能找到本地记录。
export function claimLocalAssetByPath({ relativePath, cloudAssetId = '', sha256 = '', size = 0, previousId = '' } = {}) {
  const owner = findLocalAssetByRelativePath(relativePath);
  if (!owner || !owner.id || owner.id === String(previousId || '')) return null;
  const adoptable = !owner.cloudAssetId;
  if (!adoptable) return null;
  const claimed = {
    ...owner,
    cloudAssetId: String(cloudAssetId || ''),
    sha256: String(sha256 || owner.sha256 || ''),
    size: Number.isSafeInteger(Number(size)) ? Number(size) : owner.size,
    updatedAt: new Date().toISOString(),
    localStatus: 'saved',
    remoteStatus: 'ready',
  };
  db().exec('BEGIN');
  try {
    if (previousId) deleteLocalAsset(String(previousId));
    upsert(claimed);
    db().exec('COMMIT');
  } catch (error) {
    db().exec('ROLLBACK');
    throw error;
  }
  return claimed;
}

export function findLocalAssetByDigest(sha256, size) {
  return rowToAsset(db().prepare('SELECT doc_json FROM assets WHERE sha256 = :sha256 AND size = :size LIMIT 1').get({ sha256: String(sha256 || ''), size: Number(size) }));
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return value && typeof value.createdAt === 'string' && typeof value.id === 'string' ? value : null;
  } catch { return null; }
}

function encodeCursor(asset) {
  return Buffer.from(JSON.stringify({ createdAt: asset.createdAt, id: asset.id }), 'utf8').toString('base64url');
}

export function listLocalAssets({ limit = defaultLimit, cursor = null, kind = '', search = '', remoteStatus = '' } = {}) {
  const bounded = Math.max(1, Math.min(maxLimit, Number(limit) || defaultLimit));
  const position = decodeCursor(cursor);
  const normalizedKind = ['image', 'video', 'audio'].includes(kind) ? kind : '';
  const normalizedSearch = String(search || '').trim();
  const normalizedRemoteStatus = String(remoteStatus || '').trim();
  const where = [];
  const params = { limit: bounded + 1 };
  if (normalizedKind) {
    where.push('kind = :kind');
    params.kind = normalizedKind;
  }
  if (normalizedSearch) {
    where.push('name LIKE :search');
    params.search = `%${normalizedSearch}%`;
  }
  if (normalizedRemoteStatus) {
    where.push('remote_status = :remoteStatus');
    params.remoteStatus = normalizedRemoteStatus;
  }
  const countWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalParams = { ...params };
  delete totalParams.limit;
  const total = Number(db().prepare(`SELECT COALESCE(SUM(CASE WHEN local_status != 'missing' THEN 1 ELSE 0 END), 0) AS count FROM assets ${countWhere}`).get(totalParams).count);
  const rows = db().prepare(`
    SELECT doc_json, created_at AS createdAt, id
    FROM assets
    ${where.length || position ? `WHERE ${[
      ...where,
      ...(position ? ['(created_at < :cursorCreatedAt OR (created_at = :cursorCreatedAt AND id > :cursorId))'] : []),
    ].join(' AND ')}` : ''}
    ORDER BY created_at DESC, id ASC
    LIMIT :limit`).all({ ...params, ...(position ? { cursorCreatedAt: position.createdAt, cursorId: position.id } : {}) });
  const hasMore = rows.length > bounded;
  const page = hasMore ? rows.slice(0, bounded) : rows;
  const items = page.map(rowToAsset).filter(Boolean);
  return { items, total, nextCursor: hasMore && items.length ? encodeCursor(items.at(-1)) : '' };
}

export function listLocalAssetsByCloudIds(ids) {
  const values = [...new Set((Array.isArray(ids) ? ids : []).map(value => String(value || '')).filter(Boolean))].slice(0, 500);
  if (!values.length) return [];
  const placeholders = values.map((_, index) => `:id${index}`).join(',');
  return db().prepare(`SELECT doc_json FROM assets WHERE cloud_asset_id IN (${placeholders})`).all(Object.fromEntries(values.map((value, index) => [`id${index}`, value]))).map(rowToAsset).filter(Boolean);
}

export function deleteLocalAsset(id) {
  return db().prepare('DELETE FROM assets WHERE id = :id').run({ id: String(id || '') }).changes > 0;
}

export function upsertLocalDeliveryTask({ assetId, localAssetId, size = 0, sha256 = '', mimeType = '', attempts = 0, nextAttemptAt = 0 } = {}) {
  const normalizedAssetId = String(assetId || '').trim();
  const normalizedLocalAssetId = String(localAssetId || '').trim();
  if (!normalizedAssetId || !normalizedLocalAssetId) throw new Error('本地确认任务标识不完整');
  const value = {
    assetId: normalizedAssetId,
    localAssetId: normalizedLocalAssetId,
    size: Math.max(0, Number(size) || 0),
    sha256: String(sha256 || ''),
    mimeType: String(mimeType || ''),
    attempts: Math.max(0, Math.floor(Number(attempts) || 0)),
    nextAttemptAt: Math.max(0, Math.floor(Number(nextAttemptAt) || 0)),
    updatedAt: new Date().toISOString(),
  };
  db().prepare(`
    INSERT INTO delivery_tasks(asset_id, local_asset_id, size, sha256, mime_type, attempts, next_attempt_at, status, updated_at, doc_json)
    VALUES(:assetId, :localAssetId, :size, :sha256, :mimeType, :attempts, :nextAttemptAt, 'pending', :updatedAt, :docJson)
    ON CONFLICT(asset_id) DO UPDATE SET
      local_asset_id = excluded.local_asset_id,
      size = excluded.size,
      sha256 = excluded.sha256,
      mime_type = excluded.mime_type,
      attempts = excluded.attempts,
      next_attempt_at = excluded.next_attempt_at,
      status = 'pending',
      updated_at = excluded.updated_at,
      doc_json = excluded.doc_json`).run({ ...value, docJson: JSON.stringify(value) });
  return value;
}

export function listLocalDeliveryTasks({ now = Date.now(), limit = 100, dueOnly = false } = {}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const dueClause = dueOnly ? 'AND next_attempt_at <= :now' : '';
  const params = { limit: bounded };
  if (dueOnly) params.now = Math.max(0, Number(now) || 0);
  return db().prepare(`
    SELECT doc_json FROM delivery_tasks
    WHERE status IN ('pending', 'retrying') ${dueClause}
    ORDER BY next_attempt_at ASC, updated_at ASC, asset_id ASC
    LIMIT :limit`).all(params).map(row => {
    try { return JSON.parse(row.doc_json); } catch { return null; }
  }).filter(Boolean);
}

export function completeLocalDeliveryTask(assetId) {
  return db().prepare('DELETE FROM delivery_tasks WHERE asset_id = :assetId').run({ assetId: String(assetId || '') }).changes > 0;
}

export function removeLocalDeliveryTask(assetId) {
  return completeLocalDeliveryTask(assetId);
}

export function countLocalAssets() {
  return Number(db().prepare('SELECT COUNT(*) AS count FROM assets').get().count);
}

export { upsert as upsertLocalAsset };
