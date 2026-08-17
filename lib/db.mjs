import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const MIGRATION_DONE_KEY = 'legacy_json_migration';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveDataDir(env = process.env) {
  return env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(projectDir, 'data');
}

export function resolveDbFile(env = process.env) {
  return path.join(resolveDataDir(env), 'studio.db');
}

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
  invite_code          TEXT,
  credit_balance_micro INTEGER NOT NULL DEFAULT 0,
  credit_held_micro    INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  doc_json             TEXT NOT NULL,
  CHECK (credit_balance_micro >= 0),
  CHECK (credit_held_micro >= 0),
  CHECK (credit_held_micro <= credit_balance_micro)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invite_uses (
  code     TEXT PRIMARY KEY,
  user_id  TEXT,
  username TEXT,
  used_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_entries (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL,
  type                TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS generations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  status           TEXT NOT NULL,
  credit_cost      INTEGER NOT NULL DEFAULT 0,
  credit_status    TEXT,
  asset_id         TEXT,
  provider_task_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  doc_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_user_time ON generations(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_gen_user_type ON generations(user_id, type, created_at DESC, id);
-- Partial index for startup recovery. A plain index on status is useless here:
-- almost every row is 'completed', so ANALYZE measures no selectivity and the
-- planner falls back to a full table scan. Indexing only the non-terminal rows
-- keeps the index tiny and makes the recovery query O(pending), not O(total).
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
`;

let db = null;
let txDepth = 0;
let savepointSeq = 0;

/**
 * Opens (once per process) the single SQLite connection, applies pragmas and
 * ensures the schema exists. Safe to call repeatedly; returns the same handle.
 */
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

  applySchema(db);

  if (verbose) {
    console.log(`[db] file=${target}`);
    console.log(`[db] schemaVersion=${readSchemaVersion()} journal_mode=${journalMode}`);
  }
  return db;
}

function applySchema(handle) {
  const hasMeta = handle.prepare(
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='schema_meta'`
  ).get().c > 0;

  if (hasMeta) {
    const row = handle.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
    const current = row ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${current} 高于当前代码支持的版本 ${SCHEMA_VERSION}，请升级代码后再启动`
      );
    }
  }

  handle.exec('BEGIN');
  try {
    handle.exec(SCHEMA_SQL);
    handle.prepare(
      `INSERT INTO schema_meta(key, value) VALUES('schema_version', :v)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run({ v: String(SCHEMA_VERSION) });
    handle.prepare(
      `INSERT INTO schema_meta(key, value) VALUES('schema_applied_at', :t)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run({ t: new Date().toISOString() });
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

/** Prepared-statement cache keyed by SQL text. */
const statementCache = new Map();
export function sql(text) {
  let statement = statementCache.get(text);
  if (!statement) {
    statement = database().prepare(text);
    statementCache.set(text, statement);
  }
  return statement;
}

/**
 * Runs `fn` inside a transaction. Nested calls use SAVEPOINTs so an inner
 * failure rolls back only its own work. `fn` must be fully synchronous:
 * node:sqlite is a synchronous API and awaiting inside a transaction would
 * let unrelated work interleave on the same connection.
 */
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
  sql(
    `INSERT INTO schema_meta(key, value) VALUES(:key, :value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run({ key, value: String(value) });
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

/** Test seam: drop the cached handle without touching the file. */
export function resetForTests() {
  statementCache.clear();
  if (db) db.close();
  db = null;
  txDepth = 0;
}
