import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
const SCHEMA_BASELINE = 'r2-only-v1';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveDataDir(env = process.env) {
  return env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(projectDir, 'data');
}

export function resolveDbFile(env = process.env) {
  return path.join(resolveDataDir(env), 'studio.db');
}

const DEFAULT_INVITE_CODES = [];

const DEFAULT_MODEL_CONTROLS = [
  ['gpt-image-2', 'image', 1, 1, 0],
  ['grok', 'video', 1, 1, 10],
  ['minimax-h3-15s', 'video', 1, 1, 20],
  ['seedance-2.0', 'video', 1, 1, 30],
  ['seedance-2.5', 'video', 1, 1, 40],
  ['seedance-2.0-fast', 'video', 1, 1, 50],
  ['minimax-h3', 'video', 1, 1, 60],
  ['oai', 'video', 1, 1, 70],
  ['veo-31', 'video', 1, 1, 80],
  ['veo', 'video', 1, 0, 90],
];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  phone_number         TEXT,
  nickname             TEXT,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'user',
  status               TEXT NOT NULL DEFAULT 'active',
  invite_code          TEXT,
  admin_note           TEXT,
  disabled_at          TEXT,
  disabled_by          TEXT,
  updated_at           TEXT,
  credit_balance_micro INTEGER NOT NULL DEFAULT 0,
  credit_held_micro    INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  doc_json             TEXT NOT NULL,
  CHECK (credit_balance_micro >= 0),
  CHECK (credit_held_micro >= 0),
  CHECK (credit_held_micro <= credit_balance_micro)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'user',
  csrf_token_hash TEXT,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invite_uses (
  code     TEXT PRIMARY KEY,
  user_id  TEXT,
  username TEXT,
  used_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code               TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 1,
  max_uses           INTEGER NOT NULL,
  used_count         INTEGER NOT NULL DEFAULT 0,
  expires_at         TEXT,
  signup_bonus_micro INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL,
  updated_by         TEXT,
  updated_at         TEXT NOT NULL,
  CHECK (enabled IN (0, 1)),
  CHECK (max_uses > 0),
  CHECK (used_count >= 0),
  CHECK (used_count <= max_uses),
  CHECK (signup_bonus_micro >= 0)
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_enabled_time ON invite_codes(enabled, created_at DESC, code);

CREATE TABLE IF NOT EXISTS invite_code_uses (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL REFERENCES invite_codes(code),
  user_id           TEXT NOT NULL REFERENCES users(id),
  username_snapshot TEXT NOT NULL,
  bonus_micro       INTEGER NOT NULL DEFAULT 0,
  used_at           TEXT NOT NULL,
  UNIQUE (code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_invite_code_uses_code_time ON invite_code_uses(code, used_at DESC, id);

CREATE TABLE IF NOT EXISTS credit_entries (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id       TEXT,
  idempotency_key     TEXT NOT NULL,
  type                TEXT NOT NULL,
  reason_code         TEXT,
  note                TEXT,
  external_ref        TEXT,
  amount_micro        INTEGER NOT NULL,
  balance_after_micro INTEGER NOT NULL,
  generation_id       TEXT,
  request_id          TEXT,
  created_at          TEXT NOT NULL,
  doc_json            TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_credits_user_time ON credit_entries(user_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS billing_holds (
  id             TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  status         TEXT NOT NULL,
  reserved_micro INTEGER NOT NULL,
  charged_micro  INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  doc_json       TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK (reserved_micro >= 0)
);
CREATE INDEX IF NOT EXISTS idx_holds_user_status ON billing_holds(user_id, status);

CREATE TABLE IF NOT EXISTS llm_usage (
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  charged_micro INTEGER,
  created_at    TEXT NOT NULL,
  doc_json      TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_llm_user_time ON llm_usage(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_llm_model_time ON llm_usage(model, created_at DESC, id);

CREATE TABLE IF NOT EXISTS generations (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,
  status             TEXT NOT NULL,
  credit_cost        INTEGER NOT NULL DEFAULT 0,
  credit_cost_micro  INTEGER,
  credit_status      TEXT,
  pricing_version    INTEGER,
  pricing_snapshot_json TEXT,
  model_id           TEXT,
  provider           TEXT,
  asset_id           TEXT,
  provider_task_id   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  doc_json           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_user_time ON generations(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_gen_user_type ON generations(user_id, type, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_gen_pending ON generations(status)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  object_key    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  doc_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_user_time ON assets(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_assets_user_kind ON assets(user_id, kind, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_assets_user_name ON assets(user_id, name);
CREATE INDEX IF NOT EXISTS idx_assets_user_delivery
  ON assets(user_id, json_extract(doc_json, '$.deliveryStatus'), created_at DESC, id);

-- Append-only metadata changes let desktop clients advance from a signed
-- cursor instead of rescanning the entire asset table. The full asset
-- document is kept in the change row so updates remain self-contained.
CREATE TABLE IF NOT EXISTS asset_changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc_json   TEXT NOT NULL,
  CHECK (action IN ('upsert', 'delete'))
);
CREATE INDEX IF NOT EXISTS idx_asset_changes_user_seq ON asset_changes(user_id, seq);

-- Delivery is per device. A user can sign in on a new computer without
-- forcing every other computer to download the same generated media again.
CREATE TABLE IF NOT EXISTS asset_deliveries (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, asset_id),
  CHECK (status IN ('pending', 'ready', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_asset_deliveries_device_status
  ON asset_deliveries(user_id, device_id, status, updated_at DESC, asset_id);

CREATE TABLE IF NOT EXISTS upload_intents (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id          TEXT NOT NULL UNIQUE,
  temporary_object_key TEXT NOT NULL UNIQUE,
  final_object_key     TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  expected_size     INTEGER NOT NULL,
  actual_size       INTEGER,
  client_width      INTEGER,
  client_height     INTEGER,
  object_etag       TEXT,
  status            TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  claimed_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  error_code        TEXT,
  doc_json          TEXT NOT NULL,
  CHECK (kind IN ('image', 'video', 'audio')),
  CHECK (status IN ('pending', 'verifying', 'completed', 'expired', 'failed')),
  CHECK (expected_size > 0)
);
CREATE INDEX IF NOT EXISTS idx_upload_intents_user_status
  ON upload_intents(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_intents_expiry
  ON upload_intents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_intents_recovery
  ON upload_intents(status, claimed_at)
  WHERE status = 'verifying';

CREATE TABLE IF NOT EXISTS drama_projects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  step       TEXT,
  status     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  doc_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drama_user_time ON drama_projects(user_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS pricing_versions (
  version                 INTEGER PRIMARY KEY AUTOINCREMENT,
  image_per_request_micro INTEGER NOT NULL,
  video_per_second_micro  INTEGER NOT NULL,
  created_by              TEXT,
  created_at              TEXT NOT NULL,
  note                    TEXT,
  CHECK (image_per_request_micro >= 0),
  CHECK (video_per_second_micro >= 0)
);

CREATE TABLE IF NOT EXISTS model_controls (
  model_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  user_visible INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT,
  updated_at   TEXT NOT NULL,
  CHECK (kind IN ('image', 'video', 'llm')),
  CHECK (user_visible IN (0, 1)),
  CHECK (enabled IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_model_controls_kind_order ON model_controls(kind, user_visible, sort_order, model_id);

CREATE TABLE IF NOT EXISTS model_routes (
  id                    TEXT PRIMARY KEY,
  logical_model_id      TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  provider              TEXT NOT NULL,
  adapter_type          TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  credential_id         TEXT NOT NULL,
  upstream_model_id     TEXT NOT NULL,
  quality               TEXT NOT NULL,
  duration_seconds      INTEGER NOT NULL,
  priority              INTEGER NOT NULL,
  cost_fen              INTEGER NOT NULL,
  sale_price_fen        INTEGER,
  admin_enabled         INTEGER NOT NULL DEFAULT 1,
  catalog_status        TEXT NOT NULL DEFAULT 'unknown',
  catalog_message       TEXT,
  catalog_details_json  TEXT,
  catalog_checked_at    TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  updated_by            TEXT,
  updated_at            TEXT NOT NULL,
  CHECK (quality IN ('480p', '720p')),
  CHECK (duration_seconds > 0),
  CHECK (priority > 0),
  CHECK (cost_fen >= 0),
  CHECK (admin_enabled IN (0, 1)),
  CHECK (catalog_status IN ('unknown', 'available', 'missing', 'probe_error', 'credential_error'))
);
CREATE INDEX IF NOT EXISTS idx_model_routes_selection ON model_routes(logical_model_id, quality, admin_enabled, priority, id);

-- A provider can have many credentials with different model permissions. Keep
-- the credential metadata in SQLite while the secret itself is encrypted by
-- model-routes.mjs (legacy env keys remain a read-only fallback).
CREATE TABLE IF NOT EXISTS model_route_credentials (
  id                    TEXT PRIMARY KEY,
  channel_name          TEXT NOT NULL,
  label                 TEXT NOT NULL,
  provider              TEXT NOT NULL,
  adapter_type          TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  env_key               TEXT,
  api_key_ciphertext    TEXT,
  api_key_hint          TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,
  version               INTEGER NOT NULL DEFAULT 1,
  updated_by            TEXT,
  updated_at            TEXT NOT NULL,
  CHECK (enabled IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_model_route_credentials_channel ON model_route_credentials(channel_name, enabled, id);

CREATE TABLE IF NOT EXISTS model_route_policies (
  logical_model_id TEXT NOT NULL,
  quality          TEXT NOT NULL,
  forced_route_id  TEXT REFERENCES model_routes(id),
  version          INTEGER NOT NULL DEFAULT 1,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY(logical_model_id, quality),
  CHECK (quality IN ('480p', '720p'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  request_id    TEXT,
  status        TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  metadata_json TEXT,
  ip_hash       TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_events(actor_user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_audit_target_time ON audit_events(target_type, target_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS system_events (
  id             TEXT PRIMARY KEY,
  level          TEXT NOT NULL,
  category       TEXT NOT NULL,
  request_id     TEXT,
  user_id        TEXT,
  model_id       TEXT,
  generation_id  TEXT,
  message        TEXT NOT NULL,
  details_json   TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_events_time ON system_events(created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_system_events_user_model ON system_events(user_id, model_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS announcements (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT,
  created_by   TEXT REFERENCES users(id),
  updated_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  doc_json     TEXT NOT NULL,
  CHECK (status IN ('draft', 'published', 'archived')),
  CHECK (length(title) > 0),
  CHECK (length(content) > 0)
);
CREATE INDEX IF NOT EXISTS idx_announcements_public_time ON announcements(status, published_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_announcements_updated_time ON announcements(updated_at DESC, id);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_user_time ON announcement_reads(user_id, read_at DESC, announcement_id);

CREATE TABLE IF NOT EXISTS alipay_payment_orders (
  out_trade_no       TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  subject            TEXT NOT NULL,
  total_amount_fen   INTEGER NOT NULL,
  credits_micro      INTEGER NOT NULL,
  refunded_amount_fen INTEGER NOT NULL DEFAULT 0,
  alipay_trade_no    TEXT,
  paid_at            TEXT,
  closed_at          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  doc_json           TEXT NOT NULL,
  CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'CLOSED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'UNKNOWN')),
  CHECK (total_amount_fen > 0),
  CHECK (credits_micro > 0),
  CHECK (refunded_amount_fen >= 0),
  CHECK (refunded_amount_fen <= total_amount_fen)
);
CREATE INDEX IF NOT EXISTS idx_alipay_orders_user_time ON alipay_payment_orders(user_id, created_at DESC, out_trade_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alipay_orders_trade_no ON alipay_payment_orders(alipay_trade_no) WHERE alipay_trade_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS alipay_refunds (
  out_request_no TEXT PRIMARY KEY,
  out_trade_no   TEXT NOT NULL REFERENCES alipay_payment_orders(out_trade_no) ON DELETE CASCADE,
  amount_fen     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  reason         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  doc_json       TEXT NOT NULL,
  CHECK (amount_fen > 0),
  CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN'))
);
CREATE INDEX IF NOT EXISTS idx_alipay_refunds_order_time ON alipay_refunds(out_trade_no, created_at DESC, out_request_no);

CREATE TABLE IF NOT EXISTS alipay_notify_events (
  notify_id      TEXT PRIMARY KEY,
  out_trade_no   TEXT NOT NULL REFERENCES alipay_payment_orders(out_trade_no) ON DELETE CASCADE,
  trade_no       TEXT,
  trade_status   TEXT,
  event_kind     TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  params_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alipay_notify_order_time ON alipay_notify_events(out_trade_no, received_at DESC, notify_id);
`;

let db = null;
let txDepth = 0;
let savepointSeq = 0;

function seedDefaults(handle) {
  const createdAt = new Date().toISOString();
  handle.prepare(`
    INSERT INTO pricing_versions(version, image_per_request_micro, video_per_second_micro, created_at, note)
    SELECT 1, 1000000, 1000000, :createdAt, '初始平台价格'
    WHERE NOT EXISTS (SELECT 1 FROM pricing_versions)
  `).run({ createdAt });

  const invite = handle.prepare(`
    INSERT INTO invite_codes(code, enabled, max_uses, used_count, signup_bonus_micro, created_at, updated_at, note)
    VALUES(:code, 1, 1, 0, 50000000, :createdAt, :createdAt, '历史默认邀请码')
    ON CONFLICT(code) DO NOTHING
  `);
  for (const code of DEFAULT_INVITE_CODES) invite.run({ code, createdAt });

  const model = handle.prepare(`
    INSERT INTO model_controls(model_id, kind, user_visible, enabled, sort_order, version, updated_at)
    VALUES(:modelId, :kind, :userVisible, :enabled, :sortOrder, 1, :updatedAt)
    ON CONFLICT(model_id) DO NOTHING
  `);
  for (const [modelId, kind, userVisible, enabled, sortOrder] of DEFAULT_MODEL_CONTROLS) {
    model.run({ modelId, kind, userVisible, enabled, sortOrder, updatedAt: createdAt });
  }

  // Apply changed defaults to untouched rows while preserving explicit admin changes.
  const updateDefault = handle.prepare(`
    UPDATE model_controls
    SET user_visible = :userVisible, enabled = :enabled, sort_order = :sortOrder, updated_at = :updatedAt
    WHERE model_id = :modelId AND updated_by IS NULL AND version = 1
  `);
  for (const [modelId, , userVisible, enabled, sortOrder] of DEFAULT_MODEL_CONTROLS) {
    updateDefault.run({ modelId, userVisible, enabled, sortOrder, updatedAt: createdAt });
  }
}

function hasColumn(handle, table, column) {
  return handle.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

/** Inspects an existing file read-only and returns the required open path. */
function inspectSupportedDatabase(target) {
  if (target === ':memory:' || !existsSync(target) || statSync(target).size === 0) return 'empty';

  let probe;
  try {
    probe = new DatabaseSync(target, { readOnly: true });
    const existing = probe.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY name LIMIT 1`).get();
    if (!existing) return 'empty';

    const hasMeta = probe.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_meta'`).get();
    if (!hasMeta) {
      throw new Error('数据库包含已有非空 schema，但没有 schema_version；本版本不支持迁移，请使用空 DATA_DIR 启动');
    }
    const row = probe.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get();
    if (row?.value === '12') {
      if (!hasColumn(probe, 'assets', 'oss_key') || !hasColumn(probe, 'upload_intents', 'temporary_oss_key')) {
        throw new Error('数据库声明为旧 schema_version=12，但表结构不完整，已拒绝迁移');
      }
      const invalidDocuments = probe.prepare(`
        SELECT (SELECT COUNT(*) FROM assets WHERE NOT json_valid(doc_json))
             + (SELECT COUNT(*) FROM upload_intents WHERE NOT json_valid(doc_json)) AS count`).get().count;
      if (invalidDocuments) throw new Error(`旧 schema_version=12 包含 ${invalidDocuments} 条无效 JSON，已拒绝迁移`);
      const ossAssets = probe.prepare(`
        SELECT COUNT(*) AS count FROM assets
        WHERE COALESCE(oss_key, '') <> ''
          AND LOWER(COALESCE(json_extract(doc_json, '$.storageProvider'), 'oss')) <> 'r2'`).get().count;
      if (ossAssets) {
        throw new Error(`旧 schema_version=12 仍有 ${ossAssets} 个素材位于 OSS；请先将对象复制到 R2 并把素材 storageProvider 标记为 r2，再启动迁移`);
      }
      return 'legacy-v12';
    }
    if (!row || row.value !== String(SCHEMA_VERSION)) {
      const version = row?.value ?? '缺失';
      throw new Error(`数据库包含不支持的旧 schema_version=${version}；本版本仅支持从 v12 迁移`);
    }
    const baseline = probe.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_baseline'`).get();
    if (baseline?.value !== SCHEMA_BASELINE) {
      throw new Error(`数据库 schema_version=${SCHEMA_VERSION} 不是 R2-only 全新基线；已拒绝启动`);
    }
    return 'current';
  } catch (error) {
    if (String(error?.message || '').startsWith('数据库') || String(error?.message || '').startsWith('旧 schema')) throw error;
    throw new Error(`无法验证现有数据库，已拒绝启动：${error.message}`, { cause: error });
  } finally {
    probe?.close();
  }
}

function backupBeforeLegacyMigration(handle, target) {
  // Keep a self-contained snapshot before the first schema write. A plain copy
  // of studio.db is unsafe while WAL has committed pages in sidecar files.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const backup = `${target}.pre-schema-12-to-r2-v1-${stamp}`;
  handle.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  chmodSync(backup, 0o600);
  const probe = new DatabaseSync(backup, { readOnly: true });
  try {
    const integrity = probe.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`迁移前数据库备份校验失败: ${integrity}`);
  } catch (error) {
    probe.close();
    unlinkSync(backup);
    throw error;
  }
  probe.close();
  console.log(`[db] schema 12 -> ${SCHEMA_BASELINE} 迁移前备份=${backup}`);
  return backup;
}

function migrateLegacyV12(handle) {
  // v12 used OSS-specific names, but the binary object itself is unchanged:
  // after the preflight has proved every remote asset is already in R2, only
  // the metadata names and JSON shape need to move to the R2-only baseline.
  handle.exec(`
    ALTER TABLE assets RENAME COLUMN oss_key TO object_key;
    ALTER TABLE upload_intents RENAME COLUMN temporary_oss_key TO temporary_object_key;
    ALTER TABLE upload_intents RENAME COLUMN final_oss_key TO final_object_key;
  `);

  const updateAsset = handle.prepare('UPDATE assets SET doc_json = :docJson WHERE id = :id');
  for (const row of handle.prepare('SELECT id, object_key, doc_json FROM assets').all()) {
    // Rewrite the persisted document as well as the SQL column; store.mjs
    // intentionally reads doc_json to preserve fields unknown to the schema.
    const asset = JSON.parse(row.doc_json);
    if (row.object_key) asset.objectKey = row.object_key;
    else delete asset.objectKey;
    if (Object.hasOwn(asset, 'ossUploadedAt')) asset.objectUploadedAt = asset.ossUploadedAt;
    delete asset.ossKey;
    delete asset.ossUploadedAt;
    delete asset.storageProvider;
    updateAsset.run({ id: row.id, docJson: JSON.stringify(asset) });
  }

  const updateIntent = handle.prepare('UPDATE upload_intents SET doc_json = :docJson WHERE id = :id');
  for (const row of handle.prepare(`
    SELECT id, temporary_object_key, final_object_key, doc_json FROM upload_intents`).all()) {
    // Pending intents are metadata only; their keys remain stable so the
    // existing cleanup/recovery paths can continue after the rename.
    const intent = JSON.parse(row.doc_json);
    intent.temporaryObjectKey = row.temporary_object_key;
    intent.finalObjectKey = row.final_object_key;
    delete intent.temporaryOssKey;
    delete intent.finalOssKey;
    delete intent.storageProvider;
    updateIntent.run({ id: row.id, docJson: JSON.stringify(intent) });
  }
}

/** Opens the single SQLite connection and applies the schema v1 baseline. */
export function openDatabase({ env = process.env, file = null, verbose = false } = {}) {
  if (db) return db;
  const target = file ?? resolveDbFile(env);
  const databaseKind = inspectSupportedDatabase(target);
  if (target !== ':memory:') mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  const handle = new DatabaseSync(target);
  try {
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA foreign_keys = ON');
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA synchronous = NORMAL');
    const journalMode = handle.prepare('PRAGMA journal_mode').get().journal_mode;
    const foreignKeys = handle.prepare('PRAGMA foreign_keys').get().foreign_keys;
    if (target !== ':memory:' && journalMode !== 'wal') throw new Error(`无法启用 WAL 模式，当前为 ${journalMode}`);
    if (!foreignKeys) throw new Error('无法启用外键约束');
    if (databaseKind === 'legacy-v12') backupBeforeLegacyMigration(handle, target);
    applyBaselineSchema(handle, { migrateV12: databaseKind === 'legacy-v12' });
    db = handle;
    if (verbose) {
      console.log(`[db] file=${target}`);
      console.log(`[db] schemaVersion=${SCHEMA_VERSION} journal_mode=${journalMode}`);
    }
    return db;
  } catch (error) {
    statementCache.clear();
    try { handle.close(); } catch { /* best effort */ }
    db = null;
    txDepth = 0;
    throw error;
  }
}

function applyBaselineSchema(handle, { migrateV12 = false } = {}) {
  handle.exec('BEGIN');
  try {
    if (migrateV12) migrateLegacyV12(handle);
    handle.exec(SCHEMA_SQL);
    handle.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope, expires_at);
      CREATE INDEX IF NOT EXISTS idx_credits_actor_time ON credit_entries(actor_user_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_gen_model_time ON generations(model_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_gen_status_time ON generations(status, created_at DESC, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone_number) WHERE phone_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_unique ON users(nickname) WHERE nickname IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS trg_users_login_name_insert
      BEFORE INSERT ON users
      WHEN EXISTS (
        SELECT 1 FROM users AS existing
        WHERE existing.username COLLATE NOCASE = NEW.username COLLATE NOCASE
           OR (NEW.nickname IS NOT NULL AND existing.nickname COLLATE NOCASE = NEW.username COLLATE NOCASE)
           OR (NEW.nickname IS NOT NULL AND existing.username COLLATE NOCASE = NEW.nickname COLLATE NOCASE)
           OR (NEW.nickname IS NOT NULL AND existing.nickname COLLATE NOCASE = NEW.nickname COLLATE NOCASE)
      )
      BEGIN
        SELECT RAISE(ABORT, '登录名已被占用');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_users_login_name_update
      BEFORE UPDATE OF username, nickname ON users
      WHEN EXISTS (
        SELECT 1 FROM users AS existing
        WHERE existing.id <> NEW.id
          AND (
            existing.username COLLATE NOCASE = NEW.username COLLATE NOCASE
            OR (NEW.nickname IS NOT NULL AND existing.nickname COLLATE NOCASE = NEW.username COLLATE NOCASE)
            OR (NEW.nickname IS NOT NULL AND existing.username COLLATE NOCASE = NEW.nickname COLLATE NOCASE)
            OR (NEW.nickname IS NOT NULL AND existing.nickname COLLATE NOCASE = NEW.nickname COLLATE NOCASE)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, '登录名已被占用');
      END;
    `);
    seedDefaults(handle);
    handle.prepare(`
      INSERT INTO schema_meta(key, value) VALUES('schema_version', :v)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ v: String(SCHEMA_VERSION) });
    handle.prepare(`
      INSERT INTO schema_meta(key, value) VALUES('schema_baseline', :baseline)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ baseline: SCHEMA_BASELINE });
    if (migrateV12) handle.prepare(`
      INSERT INTO schema_meta(key, value) VALUES('schema_migrated_from', 'legacy-v12')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    handle.prepare(`
      INSERT INTO schema_meta(key, value) VALUES('schema_applied_at', :t)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ t: new Date().toISOString() });
    handle.exec('COMMIT');
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

export function database() {
  if (!db) throw new Error('数据库尚未打开，请先调用 openDatabase()');
  return db;
}

const statementCache = new Map();
export function sql(text) {
  let statement = statementCache.get(text);
  if (!statement) {
    statement = database().prepare(text);
    statementCache.set(text, statement);
  }
  return statement;
}

export function tx(fn) {
  const handle = database();
  if (txDepth === 0) {
    handle.exec('BEGIN IMMEDIATE');
    txDepth++;
    try {
      const result = fn();
      handle.exec('COMMIT');
      return result;
    } catch (error) {
      handle.exec('ROLLBACK');
      throw error;
    } finally {
      txDepth--;
    }
  }
  const name = `sp_${++savepointSeq}`;
  handle.exec(`SAVEPOINT ${name}`);
  txDepth++;
  try {
    const result = fn();
    handle.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    handle.exec(`ROLLBACK TO ${name}`);
    handle.exec(`RELEASE ${name}`);
    throw error;
  } finally {
    txDepth--;
  }
}

export function readSchemaVersion() {
  const row = sql(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
  return row ? Number(row.value) : 0;
}

export function readMeta(key) {
  const row = sql('SELECT value FROM schema_meta WHERE key = :key').get({ key });
  return row ? row.value : null;
}

export function writeMeta(key, value) {
  sql(`INSERT INTO schema_meta(key, value) VALUES(:key, :value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run({ key, value: String(value) });
}

export function closeDatabase({ checkpoint = true } = {}) {
  if (!db) return;
  try { if (checkpoint) db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  statementCache.clear();
  db.close();
  db = null;
  txDepth = 0;
}

export function resetForTests() {
  statementCache.clear();
  if (db) db.close();
  db = null;
  txDepth = 0;
}
