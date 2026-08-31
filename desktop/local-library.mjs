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

export function listLocalAssets({ limit = defaultLimit, cursor = null } = {}) {
  const bounded = Math.max(1, Math.min(maxLimit, Number(limit) || defaultLimit));
  const position = decodeCursor(cursor);
  const rows = db().prepare(`
    SELECT doc_json, created_at AS createdAt, id
    FROM assets
    ${position ? 'WHERE (created_at < :cursorCreatedAt OR (created_at = :cursorCreatedAt AND id > :cursorId))' : ''}
    ORDER BY created_at DESC, id ASC
    LIMIT :limit`).all({ ...(position ? { cursorCreatedAt: position.createdAt, cursorId: position.id } : {}), limit: bounded + 1 });
  const hasMore = rows.length > bounded;
  const page = hasMore ? rows.slice(0, bounded) : rows;
  const items = page.map(rowToAsset).filter(Boolean);
  return { items, nextCursor: hasMore && items.length ? encodeCursor(items.at(-1)) : '' };
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

export function countLocalAssets() {
  return Number(db().prepare('SELECT COUNT(*) AS count FROM assets').get().count);
}

export { upsert as upsertLocalAsset };
