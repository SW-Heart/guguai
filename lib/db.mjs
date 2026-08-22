import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 4;
export const MIGRATION_DONE_KEY = 'legacy_json_migration';

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
  ['minimax-h3', 'video', 1, 1, 20],
  ['seedance-2.0', 'video', 1, 1, 30],
  ['seedance-2.0-fast', 'video', 1, 1, 40],
  ['oai', 'video', 1, 1, 50],
  ['veo-31', 'video', 1, 1, 60],
  ['grok-15', 'video', 1, 1, 70],
  ['veo', 'video', 1, 0, 80],
];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
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
  oss_key    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  doc_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_user_time ON assets(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_assets_user_kind ON assets(user_id, kind, created_at DESC, id);

CREATE TABLE IF NOT EXISTS upload_intents (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id          TEXT NOT NULL UNIQUE,
  temporary_oss_key TEXT NOT NULL UNIQUE,
  final_oss_key     TEXT NOT NULL UNIQUE,
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
`;

let db = null;
let txDepth = 0;
let savepointSeq = 0;

function hasColumn(handle, table, column) {
  return handle.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function addColumnIfMissing(handle, table, column, definition) {
  if (!hasColumn(handle, table, column)) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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

function migrateV1ToV2(handle) {
  addColumnIfMissing(handle, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(handle, 'users', 'admin_note', 'TEXT');
  addColumnIfMissing(handle, 'users', 'disabled_at', 'TEXT');
  addColumnIfMissing(handle, 'users', 'disabled_by', 'TEXT');
  addColumnIfMissing(handle, 'users', 'updated_at', 'TEXT');
  addColumnIfMissing(handle, 'sessions', 'scope', "TEXT NOT NULL DEFAULT 'user'");
  addColumnIfMissing(handle, 'sessions', 'csrf_token_hash', 'TEXT');
  addColumnIfMissing(handle, 'credit_entries', 'actor_user_id', 'TEXT');
  addColumnIfMissing(handle, 'credit_entries', 'reason_code', 'TEXT');
  addColumnIfMissing(handle, 'credit_entries', 'note', 'TEXT');
  addColumnIfMissing(handle, 'credit_entries', 'external_ref', 'TEXT');
  addColumnIfMissing(handle, 'generations', 'credit_cost_micro', 'INTEGER');
  addColumnIfMissing(handle, 'generations', 'pricing_version', 'INTEGER');
  addColumnIfMissing(handle, 'generations', 'pricing_snapshot_json', 'TEXT');
  addColumnIfMissing(handle, 'generations', 'model_id', 'TEXT');
  addColumnIfMissing(handle, 'generations', 'provider', 'TEXT');
  handle.exec(`UPDATE users SET status = COALESCE(status, 'active'), updated_at = COALESCE(updated_at, created_at)`);

  const legacyInvites = handle.prepare('SELECT code, user_id AS userId, username, used_at AS usedAt FROM invite_uses').all();
  const createdAt = new Date().toISOString();
  const addInvite = handle.prepare(`
    INSERT INTO invite_codes(code, enabled, max_uses, used_count, signup_bonus_micro, created_at, updated_at, note)
    VALUES(:code, 1, 1, 0, 50000000, :createdAt, :createdAt, '由旧版邀请码迁移')
    ON CONFLICT(code) DO NOTHING
  `);
  const addUse = handle.prepare(`
    INSERT INTO invite_code_uses(id, code, user_id, username_snapshot, bonus_micro, used_at)
    VALUES(:id, :code, :userId, :username, 50000000, :usedAt)
    ON CONFLICT(code, user_id) DO NOTHING
  `);
  for (const row of legacyInvites) {
    addInvite.run({ code: row.code, createdAt: row.usedAt || createdAt });
    if (row.userId) addUse.run({ id: `legacy-${row.code}`, code: row.code, userId: row.userId, username: row.username || '', usedAt: row.usedAt || createdAt });
  }
  handle.exec(`
    UPDATE invite_codes
    SET used_count = MAX(
          (SELECT COUNT(*) FROM invite_code_uses u WHERE u.code = invite_codes.code),
          (SELECT COUNT(*) FROM invite_uses legacy WHERE legacy.code = invite_codes.code)
        ),
        enabled = CASE WHEN MAX(
          (SELECT COUNT(*) FROM invite_code_uses u WHERE u.code = invite_codes.code),
          (SELECT COUNT(*) FROM invite_uses legacy WHERE legacy.code = invite_codes.code)
        ) >= max_uses THEN 0 ELSE enabled END
  `);
  handle.prepare(`UPDATE generations SET model_id = json_extract(doc_json, '$.videoModelId'), provider = json_extract(doc_json, '$.provider') WHERE model_id IS NULL`).run();
  handle.prepare(`UPDATE generations SET credit_cost_micro = CAST(ROUND(credit_cost * 1000000) AS INTEGER) WHERE credit_cost_micro IS NULL`).run();
}

function migrateV2ToV3(handle) {
  // upload_intents and its indexes are created by SCHEMA_SQL above. Keeping a
  // named migration makes the version transition explicit and leaves a safe
  // hook for future data backfills without rewriting existing rows.
  handle.exec('SELECT 1');
}

function migrateV3ToV4(handle) {
  const exists = handle.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='upload_intents'`).get().count > 0;
  if (!exists) return;
  handle.exec(`
    DROP INDEX IF EXISTS idx_upload_intents_user_status;
    DROP INDEX IF EXISTS idx_upload_intents_expiry;
    DROP INDEX IF EXISTS idx_upload_intents_recovery;
    ALTER TABLE upload_intents RENAME TO upload_intents_v3;
    CREATE TABLE upload_intents (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id          TEXT NOT NULL UNIQUE,
      temporary_oss_key TEXT NOT NULL UNIQUE,
      final_oss_key     TEXT NOT NULL UNIQUE,
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
    INSERT INTO upload_intents(
      id, user_id, asset_id, temporary_oss_key, final_oss_key, name, kind, mime_type,
      expected_size, actual_size, client_width, client_height, object_etag, status,
      expires_at, claimed_at, created_at, updated_at, completed_at, error_code, doc_json
    )
    SELECT id, user_id, asset_id, temporary_oss_key, final_oss_key, name, kind, mime_type,
      expected_size, actual_size, client_width, client_height, object_etag, status,
      expires_at, claimed_at, created_at, updated_at, completed_at, error_code, doc_json
    FROM upload_intents_v3;
    DROP TABLE upload_intents_v3;
    CREATE INDEX idx_upload_intents_user_status ON upload_intents(user_id, status, created_at DESC);
    CREATE INDEX idx_upload_intents_expiry ON upload_intents(status, expires_at);
    CREATE INDEX idx_upload_intents_recovery ON upload_intents(status, claimed_at) WHERE status = 'verifying';
  `);
}

/** Opens the single SQLite connection, applies pragmas and upgrades the schema. */
function existingSchemaVersion(handle) {
  const hasMeta = handle.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_meta'`).get().count > 0;
  if (!hasMeta) return 0;
  const row = handle.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
  return row ? Number(row.value) : 0;
}

function backupBeforeSchemaUpgrade(handle, target) {
  if (target === ':memory:') return null;
  const current = existingSchemaVersion(handle);
  if (!Number.isInteger(current) || current <= 0 || current >= SCHEMA_VERSION) return null;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-');
  const backup = `${target}.pre-schema-${current}-to-${SCHEMA_VERSION}-${stamp}`;
  handle.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  chmodSync(backup, 0o600);
  const probe = new DatabaseSync(backup, { readOnly: true });
  try {
    const integrity = probe.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`升级前数据库备份校验失败: ${integrity}`);
  } catch (error) {
    probe.close();
    unlinkSync(backup);
    throw error;
  }
  probe.close();
  console.log(`[db] schema ${current} -> ${SCHEMA_VERSION} 升级前备份=${backup}`);
  return backup;
}

export function openDatabase({ env = process.env, file = null, verbose = false } = {}) {
  if (db) return db;
  const target = file ?? resolveDbFile(env);
  if (target !== ':memory:') mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (target !== ':memory:' && journalMode !== 'wal') throw new Error(`无法启用 WAL 模式，当前为 ${journalMode}`);
  if (!foreignKeys) throw new Error('无法启用外键约束');
  backupBeforeSchemaUpgrade(db, target);
  applySchema(db);
  if (verbose) {
    console.log(`[db] file=${target}`);
    console.log(`[db] schemaVersion=${readSchemaVersion()} journal_mode=${journalMode}`);
  }
  return db;
}

function applySchema(handle) {
  const hasMeta = handle.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='schema_meta'`).get().c > 0;
  let current = 0;
  if (hasMeta) {
    const row = handle.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
    current = row ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) throw new Error(`数据库 schema 版本 ${current} 高于当前代码支持的版本 ${SCHEMA_VERSION}，请升级代码后再启动`);
  }

  handle.exec('BEGIN');
  try {
    handle.exec(SCHEMA_SQL);
    if (current < 2 && hasMeta) migrateV1ToV2(handle);
    if (current < 3 && hasMeta) migrateV2ToV3(handle);
    if (current < 4 && hasMeta) migrateV3ToV4(handle);
    handle.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope, expires_at);
      CREATE INDEX IF NOT EXISTS idx_credits_actor_time ON credit_entries(actor_user_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_gen_model_time ON generations(model_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_gen_status_time ON generations(status, created_at DESC, id);
    `);
    seedDefaults(handle);
    handle.prepare(`
      INSERT INTO schema_meta(key, value) VALUES('schema_version', :v)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ v: String(SCHEMA_VERSION) });
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

export function migrationCompleted() {
  return Boolean(readMeta(MIGRATION_DONE_KEY));
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
