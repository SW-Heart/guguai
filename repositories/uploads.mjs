export function createUploadRepository({ sql, tx, findAsset, saveAssetRecord } = {}) {
  for (const [name, dependency] of Object.entries({ sql, tx, findAsset, saveAssetRecord })) {
    if (typeof dependency !== 'function') throw new TypeError(`上传仓储缺少 ${name} 依赖`);
  }

  function parseUploadIntentRow(row) {
    if (!row) return null;
    const value = JSON.parse(row.doc_json);
    return {
      ...value,
      id: row.id,
      userId: row.user_id,
      assetId: row.asset_id,
      temporaryObjectKey: row.temporary_object_key,
      finalObjectKey: row.final_object_key,
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

  function createUploadIntent(intent) {
    sql(`
      INSERT INTO upload_intents(
        id, user_id, asset_id, temporary_object_key, final_object_key,
        name, kind, mime_type, expected_size, actual_size,
        client_width, client_height, object_etag, status, expires_at,
        claimed_at, created_at, updated_at, completed_at, error_code, doc_json
      ) VALUES(
        :id, :userId, :assetId, :temporaryObjectKey, :finalObjectKey,
        :name, :kind, :mimeType, :expectedSize, :actualSize,
        :clientWidth, :clientHeight, :objectEtag, :status, :expiresAt,
        :claimedAt, :createdAt, :updatedAt, :completedAt, :errorCode, :docJson
      )`).run({
      id: intent.id,
      userId: intent.userId,
      assetId: intent.assetId,
      temporaryObjectKey: intent.temporaryObjectKey,
      finalObjectKey: intent.finalObjectKey,
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

  function findUploadIntent(userId, id) {
    return parseUploadIntentRow(uploadIntentRow(userId, id));
  }

  function countActiveUploadIntents(userId) {
    return sql(`
      SELECT COUNT(*) AS count FROM upload_intents
      WHERE user_id = :userId AND status IN ('pending', 'verifying')`).get({ userId }).count;
  }

  function claimUploadIntent(userId, id, nowIso) {
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

  function markUploadIntentFailed(userId, id, { errorCode, actualSize = null, objectEtag = null, nowIso }) {
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

  function completeUploadIntentWithAsset(userId, id, { actualSize, objectEtag, asset, nowIso }) {
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

  function expireUploadIntent(userId, id, nowIso) {
    const row = sql(`
      SELECT id, user_id AS userId, temporary_object_key AS temporaryObjectKey,
             final_object_key AS finalObjectKey
      FROM upload_intents
      WHERE user_id = :userId AND id = :id AND status = 'pending' AND expires_at <= :now
    `).get({ userId, id, now: nowIso });
    if (!row) return null;
    const changed = sql(`
      UPDATE upload_intents
      SET status = 'expired', updated_at = :now,
          error_code = 'UPLOAD_EXPIRED',
          doc_json = json_set(doc_json, '$.status', 'expired', '$.updatedAt', :now, '$.errorCode', 'UPLOAD_EXPIRED')
      WHERE user_id = :userId AND id = :id AND status = 'pending' AND expires_at <= :now
    `).run({ userId, id, now: nowIso }).changes;
    return changed === 1 ? row : null;
  }

  function expireUploadIntents(nowIso, limit = 100) {
    const rows = sql(`
      SELECT id, user_id AS userId, temporary_object_key AS temporaryObjectKey,
             final_object_key AS finalObjectKey
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
    return rows.map(row => ({ ...row }));
  }

  function listRecoverableUploadIntents(nowIso, staleBeforeIso, limit = 50) {
    return sql(`
      SELECT * FROM upload_intents
      WHERE status = 'verifying' AND claimed_at <= :staleBefore
      ORDER BY claimed_at ASC LIMIT :limit`).all({ staleBefore: staleBeforeIso, limit }).map(parseUploadIntentRow);
  }

  return {
    createUploadIntent,
    findUploadIntent,
    countActiveUploadIntents,
    claimUploadIntent,
    markUploadIntentFailed,
    completeUploadIntentWithAsset,
    expireUploadIntent,
    expireUploadIntents,
    listRecoverableUploadIntents,
  };
}
