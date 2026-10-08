import { createHash, randomBytes } from 'node:crypto';

// Requests made with API keys run in their own workspace scope. Desktop
// clients always list with their own device/workspace pair, so API output
// never appears in the creator workspace.
export const API_DEVICE_ID = 'gugu-api-device';
export const API_WORKSPACE_ID = 'gugu-api-workspace';
export const API_SCOPE = Object.freeze({ desktop:false, deviceId:API_DEVICE_ID, workspaceId:API_WORKSPACE_ID, valid:true });

export const API_KEY_PREFIX = 'sk-gugu-';
export const API_KEY_LIMIT_PER_USER = 50;
export const API_LOG_RETENTION_DAYS = 30;

export const API_PLATFORM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  key_hash           TEXT NOT NULL UNIQUE,
  key_hint           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  credit_limit_micro INTEGER,
  expires_at         TEXT,
  last_used_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  CHECK (status IN ('active', 'disabled')),
  CHECK (credit_limit_micro IS NULL OR credit_limit_micro >= 0)
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_tasks (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  request_id       TEXT NOT NULL,
  idempotency_key  TEXT,
  request_hash     TEXT NOT NULL,
  generation_ids   TEXT NOT NULL,
  params_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  deleted_at       TEXT,
  CHECK (kind IN ('image', 'video'))
);
CREATE INDEX IF NOT EXISTS idx_api_tasks_user_kind ON api_tasks(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_tasks_key ON api_tasks(key_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tasks_idempotency ON api_tasks(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_request_logs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id        TEXT,
  request_id    TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  model_id      TEXT,
  task_id       TEXT,
  status_code   INTEGER NOT NULL,
  error_code    TEXT,
  error_message TEXT,
  cost_micro    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  client_ip     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_logs_user ON api_request_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_key ON api_request_logs(key_id, created_at DESC);
`;

export const hashApiKey = key => createHash('sha256').update(String(key)).digest('hex');

export function generateApiKey() {
  const key = `${API_KEY_PREFIX}${randomBytes(30).toString('base64url')}`;
  return { key, hash:hashApiKey(key), hint:`${key.slice(0, 12)}…${key.slice(-4)}` };
}

const keyFromRow = row => row ? {
  id:row.id,
  userId:row.user_id,
  name:row.name,
  keyHash:row.key_hash,
  hint:row.key_hint,
  status:row.status,
  creditLimitMicro:row.credit_limit_micro ?? null,
  expiresAt:row.expires_at || null,
  lastUsedAt:row.last_used_at || null,
  createdAt:row.created_at,
  updatedAt:row.updated_at,
} : null;

const taskFromRow = row => row ? {
  id:row.id,
  userId:row.user_id,
  keyId:row.key_id,
  kind:row.kind,
  modelId:row.model_id,
  requestId:row.request_id,
  idempotencyKey:row.idempotency_key || null,
  requestHash:row.request_hash,
  generationIds:JSON.parse(row.generation_ids),
  params:JSON.parse(row.params_json),
  createdAt:row.created_at,
} : null;

const logFromRow = row => ({
  id:row.id,
  keyId:row.key_id || null,
  requestId:row.request_id,
  method:row.method,
  path:row.path,
  modelId:row.model_id || null,
  taskId:row.task_id || null,
  statusCode:row.status_code,
  errorCode:row.error_code || null,
  errorMessage:row.error_message || null,
  costMicro:row.cost_micro,
  latencyMs:row.latency_ms,
  createdAt:row.created_at,
});

export function createApiPlatformRepository({ sql, tx, now = () => new Date().toISOString(), id = () => randomBytes(12).toString('hex') }) {
  if (typeof sql !== 'function' || typeof tx !== 'function') throw new TypeError('API 仓储依赖未完整提供');

  function listKeys(userId) {
    return sql('SELECT * FROM api_keys WHERE user_id = :userId AND deleted_at IS NULL ORDER BY created_at DESC').all({ userId }).map(keyFromRow);
  }
  function findKey(userId, keyId) {
    return keyFromRow(sql('SELECT * FROM api_keys WHERE id = :keyId AND user_id = :userId AND deleted_at IS NULL').get({ keyId, userId }));
  }
  function findKeyByHash(hash) {
    return keyFromRow(sql('SELECT * FROM api_keys WHERE key_hash = :hash AND deleted_at IS NULL').get({ hash }));
  }
  function createKey(userId, { name, creditLimitMicro = null, expiresAt = null }) {
    return tx(() => {
      const count = sql('SELECT COUNT(*) AS count FROM api_keys WHERE user_id = :userId AND deleted_at IS NULL').get({ userId }).count;
      if (count >= API_KEY_LIMIT_PER_USER) throw Object.assign(new Error(`最多可创建 ${API_KEY_LIMIT_PER_USER} 个密钥，请先删除不再使用的密钥`), { statusCode:409 });
      const generated = generateApiKey();
      const createdAt = now();
      const keyId = `key_${id()}`;
      sql(`INSERT INTO api_keys(id, user_id, name, key_hash, key_hint, status, credit_limit_micro, expires_at, created_at, updated_at)
        VALUES(:id, :userId, :name, :hash, :hint, 'active', :limit, :expiresAt, :createdAt, :createdAt)`).run({
        id:keyId, userId, name, hash:generated.hash, hint:generated.hint, limit:creditLimitMicro, expiresAt, createdAt,
      });
      return { key:findKey(userId, keyId), secret:generated.key };
    });
  }
  function updateKey(userId, keyId, patch) {
    return tx(() => {
      const current = findKey(userId, keyId);
      if (!current) return null;
      const next = {
        name:patch.name ?? current.name,
        status:patch.status ?? current.status,
        creditLimitMicro:patch.creditLimitMicro !== undefined ? patch.creditLimitMicro : current.creditLimitMicro,
        expiresAt:patch.expiresAt !== undefined ? patch.expiresAt : current.expiresAt,
      };
      sql(`UPDATE api_keys SET name = :name, status = :status, credit_limit_micro = :limit, expires_at = :expiresAt, updated_at = :updatedAt
        WHERE id = :keyId AND user_id = :userId`).run({ name:next.name, status:next.status, limit:next.creditLimitMicro, expiresAt:next.expiresAt, keyId, userId, updatedAt:now() });
      return findKey(userId, keyId);
    });
  }
  function deleteKey(userId, keyId) {
    const result = sql(`UPDATE api_keys SET deleted_at = :at, status = 'disabled', updated_at = :at
      WHERE id = :keyId AND user_id = :userId AND deleted_at IS NULL`).run({ keyId, userId, at:now() });
    return result.changes > 0;
  }
  function touchKey(keyId, at = now()) {
    sql('UPDATE api_keys SET last_used_at = :at WHERE id = :keyId').run({ keyId, at });
  }

  function createTask(task) {
    sql(`INSERT INTO api_tasks(id, user_id, key_id, kind, model_id, request_id, idempotency_key, request_hash, generation_ids, params_json, created_at)
      VALUES(:id, :userId, :keyId, :kind, :modelId, :requestId, :idempotencyKey, :requestHash, :generationIds, :params, :createdAt)`).run({
      id:task.id, userId:task.userId, keyId:task.keyId, kind:task.kind, modelId:task.modelId, requestId:task.requestId,
      idempotencyKey:task.idempotencyKey || null, requestHash:task.requestHash,
      generationIds:JSON.stringify(task.generationIds), params:JSON.stringify(task.params || {}), createdAt:task.createdAt,
    });
    return task;
  }
  function removeTask(userId, taskId) {
    sql('DELETE FROM api_tasks WHERE id = :taskId AND user_id = :userId').run({ taskId, userId });
  }
  function findTask(userId, taskId, kind = null) {
    return taskFromRow(sql(`SELECT * FROM api_tasks WHERE id = :taskId AND user_id = :userId AND deleted_at IS NULL ${kind ? 'AND kind = :kind' : ''}`)
      .get({ taskId, userId, ...(kind ? { kind } : {}) }));
  }
  function findTaskByIdempotencyKey(userId, idempotencyKey) {
    return taskFromRow(sql('SELECT * FROM api_tasks WHERE user_id = :userId AND idempotency_key = :idempotencyKey').get({ userId, idempotencyKey }));
  }
  function markTaskDeleted(userId, taskId) {
    sql('UPDATE api_tasks SET deleted_at = :at WHERE id = :taskId AND user_id = :userId').run({ taskId, userId, at:now() });
  }
  function listTasks(userId, kind, { limit = 20, after = null, order = 'desc' } = {}) {
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const comparator = order === 'asc' ? '>' : '<';
    const anchor = after ? sql('SELECT created_at, id FROM api_tasks WHERE id = :after AND user_id = :userId').get({ after, userId }) : null;
    if (after && !anchor) throw Object.assign(new Error('after 参数对应的任务不存在'), { statusCode:400, param:'after' });
    const rows = sql(`SELECT * FROM api_tasks WHERE user_id = :userId AND kind = :kind AND deleted_at IS NULL
      ${anchor ? `AND (created_at ${comparator} :anchorAt OR (created_at = :anchorAt AND id ${comparator} :anchorId))` : ''}
      ORDER BY created_at ${direction}, id ${direction} LIMIT :limit`).all({
      userId, kind, limit:limit + 1, ...(anchor ? { anchorAt:anchor.created_at, anchorId:anchor.id } : {}),
    });
    return { tasks:rows.slice(0, limit).map(taskFromRow), hasMore:rows.length > limit };
  }
  // Credits currently spent by one key: every charge made through it, minus
  // generations whose charge was refunded after a failure.
  function keyUsageMicro(keyId) {
    return sql(`SELECT COALESCE(SUM(g.credit_cost_micro), 0) AS usedMicro
      FROM api_tasks t, json_each(t.generation_ids) j
      JOIN generations g ON g.id = j.value AND g.user_id = t.user_id
      WHERE t.key_id = :keyId AND COALESCE(g.credit_status, '') != 'refunded'`).get({ keyId }).usedMicro;
  }
  function staleReferenceAssets(before, limit = 200) {
    return sql(`SELECT user_id AS userId, id FROM assets
      WHERE json_extract(doc_json, '$.apiReference') = 1 AND created_at < :before
      ORDER BY created_at LIMIT :limit`).all({ before, limit });
  }

  function insertLog(entry) {
    sql(`INSERT INTO api_request_logs(id, user_id, key_id, request_id, method, path, model_id, task_id, status_code, error_code, error_message, cost_micro, latency_ms, client_ip, created_at)
      VALUES(:id, :userId, :keyId, :requestId, :method, :path, :modelId, :taskId, :statusCode, :errorCode, :errorMessage, :costMicro, :latencyMs, :clientIp, :createdAt)`).run({
      id:`log_${id()}`, userId:entry.userId, keyId:entry.keyId || null, requestId:entry.requestId, method:entry.method,
      path:String(entry.path).slice(0, 200), modelId:entry.modelId || null, taskId:entry.taskId || null, statusCode:entry.statusCode,
      errorCode:entry.errorCode || null, errorMessage:entry.errorMessage ? String(entry.errorMessage).slice(0, 300) : null,
      costMicro:Number.isSafeInteger(entry.costMicro) ? entry.costMicro : 0, latencyMs:Math.max(0, Math.round(entry.latencyMs || 0)),
      clientIp:entry.clientIp || null, createdAt:entry.createdAt || now(),
    });
  }
  function listLogs(userId, { keyId = '', modelId = '', outcome = '', from = '', to = '', limit = 50, before = null } = {}) {
    const where = ['user_id = :userId'];
    const params = { userId, limit:limit + 1 };
    if (keyId) { where.push('key_id = :keyId'); params.keyId = keyId; }
    if (modelId) { where.push('model_id = :modelId'); params.modelId = modelId; }
    if (outcome === 'success') where.push('status_code < 400');
    if (outcome === 'error') where.push('status_code >= 400');
    if (from) { where.push('created_at >= :from'); params.from = from; }
    if (to) { where.push('created_at < :to'); params.to = to; }
    if (before) {
      const anchor = sql('SELECT created_at, id FROM api_request_logs WHERE id = :before AND user_id = :userId').get({ before, userId });
      if (anchor) { where.push('(created_at < :anchorAt OR (created_at = :anchorAt AND id < :anchorId))'); params.anchorAt = anchor.created_at; params.anchorId = anchor.id; }
    }
    const rows = sql(`SELECT * FROM api_request_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT :limit`).all(params);
    return { logs:rows.slice(0, limit).map(logFromRow), hasMore:rows.length > limit };
  }
  function usageSince(userId, since) {
    const row = sql(`SELECT COUNT(*) AS requests, COALESCE(SUM(cost_micro), 0) AS costMicro,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS errors
      FROM api_request_logs WHERE user_id = :userId AND created_at >= :since`).get({ userId, since });
    return { requests:row.requests, errors:row.errors, costMicro:row.costMicro };
  }
  function pruneLogs(before) {
    return sql('DELETE FROM api_request_logs WHERE created_at < :before').run({ before }).changes;
  }

  return Object.freeze({
    listKeys, findKey, findKeyByHash, createKey, updateKey, deleteKey, touchKey,
    createTask, removeTask, findTask, findTaskByIdempotencyKey, markTaskDeleted, listTasks, keyUsageMicro, staleReferenceAssets,
    insertLog, listLogs, usageSince, pruneLogs,
  });
}
