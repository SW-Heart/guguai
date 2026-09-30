export const MODEL_EXPERIENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_experience (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  doc_json TEXT NOT NULL,
  PRIMARY KEY (user_id, generation_id)
);
CREATE INDEX IF NOT EXISTS idx_model_experience_scope
  ON model_experience(user_id, device_id, workspace_id, updated_at DESC);
`;

export function createModelExperienceRepository({ sql }) {
  const scopeParams = (userId, generationId, scope) => ({
    userId, generationId, deviceId: scope.deviceId || '', workspaceId: scope.workspaceId || '',
  });
  function read(userId, generationId, scope) {
    const row = sql(`SELECT doc_json FROM model_experience
      WHERE user_id = :userId AND generation_id = :generationId
        AND device_id = :deviceId AND workspace_id = :workspaceId`).get(scopeParams(userId, generationId, scope));
    return row ? JSON.parse(row.doc_json) : null;
  }
  function save(userId, generationId, scope, details, expectedRevision, invocationId) {
    const previous = read(userId, generationId, scope);
    if (previous?.lastInvocation === invocationId) return previous;
    if ((previous?.revision || 0) !== expectedRevision) throw new Error('这份作品观察已更新，请读取最新版本再修改');
    const record = {
      generationId, revision: expectedRevision + 1, ...details,
      updatedAt: new Date().toISOString(), lastInvocation: invocationId,
    };
    const params = { ...scopeParams(userId, generationId, scope), expectedRevision, revision: record.revision, updatedAt: record.updatedAt, docJson: JSON.stringify(record) };
    const result = sql(`INSERT INTO model_experience(user_id, generation_id, device_id, workspace_id, revision, updated_at, doc_json)
      VALUES(:userId, :generationId, :deviceId, :workspaceId, :revision, :updatedAt, :docJson)
      ON CONFLICT(user_id, generation_id) DO UPDATE SET
        revision = excluded.revision, updated_at = excluded.updated_at, doc_json = excluded.doc_json
      WHERE model_experience.device_id = :deviceId
        AND model_experience.workspace_id = :workspaceId
        AND model_experience.revision = :expectedRevision`).run(params);
    if (!result.changes) throw new Error('这份作品观察已更新，请读取最新版本再修改');
    return record;
  }
  return { read, save };
}
