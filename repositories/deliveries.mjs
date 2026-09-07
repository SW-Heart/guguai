export function createDeliveryRepository({ sql, scopeWhere, findAsset, defaultPageLimit = 100, maxPageLimit = 200 } = {}) {
  for (const [name, dependency] of Object.entries({ sql, scopeWhere, findAsset })) {
    if (typeof dependency !== 'function') throw new TypeError(`交付仓储缺少 ${name} 依赖`);
  }

  function listPendingAssetDeliveries(userId, deviceId, { workspaceId = '', limit = defaultPageLimit, before = null } = {}) {
    const bounded = Math.max(1, Math.min(maxPageLimit, Number(limit) || defaultPageLimit));
    const scoped = scopeWhere({ deviceId, workspaceId }, 'a.doc_json');
    const rows = sql(`
      SELECT a.doc_json AS docJson
      FROM assets a
      LEFT JOIN asset_deliveries d
        ON d.user_id = a.user_id AND d.device_id = :deviceId AND d.asset_id = a.id
      WHERE a.user_id = :userId
        ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}
        AND COALESCE(json_extract(a.doc_json, '$.sourceGenerationId'), '') <> ''
        AND (
          COALESCE(a.object_key, '') <> ''
          OR (
            COALESCE(json_extract(a.doc_json, '$.sourceUrl'), '') <> ''
            AND COALESCE(json_extract(a.doc_json, '$.deliveryStatus'), '') <> 'local_ready'
          )
        )
        AND (
          json_extract(a.doc_json, '$.deliveryStatus') IN ('awaiting_local', 'remote_backed_up', 'local_ready')
          OR (json_extract(a.doc_json, '$.deliveryStatus') IS NULL AND json_extract(a.doc_json, '$.remoteStatus') = 'ready')
        )
        AND COALESCE(d.status, '') <> 'ready'
        ${before ? 'AND (a.created_at < :beforeTime OR (a.created_at = :beforeTime AND a.id > :beforeId))' : ''}
      ORDER BY a.created_at DESC, a.id ASC
      LIMIT :limit`).all({ userId, deviceId, ...scoped.params, limit: bounded, ...(before ? { beforeTime:before.t, beforeId:before.i } : {}) });
    return rows.map(row => JSON.parse(row.docJson));
  }

  function markAssetDeliveryPending(userId, deviceId, assetId) {
    const timestamp = new Date().toISOString();
    sql(`
      INSERT INTO asset_deliveries(user_id, device_id, asset_id, status, attempts, created_at, updated_at)
      VALUES(:userId, :deviceId, :assetId, 'pending', 1, :createdAt, :updatedAt)
      ON CONFLICT(user_id, device_id, asset_id) DO UPDATE SET
        status = CASE WHEN asset_deliveries.status = 'ready' THEN 'ready' ELSE 'pending' END,
        attempts = CASE WHEN asset_deliveries.status = 'ready' THEN asset_deliveries.attempts ELSE asset_deliveries.attempts + 1 END,
        updated_at = excluded.updated_at`).run({ userId, deviceId, assetId, createdAt: timestamp, updatedAt: timestamp });
  }

  function markAssetDeliveryReady(userId, deviceId, assetId) {
    if (!findAsset(userId, assetId)) return false;
    const timestamp = new Date().toISOString();
    sql(`
      INSERT INTO asset_deliveries(user_id, device_id, asset_id, status, attempts, created_at, updated_at)
      VALUES(:userId, :deviceId, :assetId, 'ready', 1, :createdAt, :updatedAt)
      ON CONFLICT(user_id, device_id, asset_id) DO UPDATE SET
        status = 'ready', updated_at = excluded.updated_at`).run({ userId, deviceId, assetId, createdAt: timestamp, updatedAt: timestamp });
    return true;
  }

  return { listPendingAssetDeliveries, markAssetDeliveryPending, markAssetDeliveryReady };
}
