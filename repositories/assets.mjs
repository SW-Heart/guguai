export function createAssetRepository({ sql, tx, keysetPage, scopeWhere, decodeCursor, encodeCursor, parseDoc, parseDocs, defaultPageLimit = 100, maxPageLimit = 200 } = {}) {
  for (const [name, dependency] of Object.entries({ sql, tx, keysetPage, scopeWhere, decodeCursor, encodeCursor, parseDoc, parseDocs })) {
    if (typeof dependency !== 'function') throw new TypeError(`素材仓储缺少 ${name} 依赖`);
  }

  function saveAssetRecord(userId, asset) {
    const docJson = JSON.stringify(asset);
    const changedAt = asset.updatedAt || asset.createdAt || new Date().toISOString();
    tx(() => {
      sql(`
        INSERT INTO assets(id, user_id, kind, name, object_key, created_at, updated_at, doc_json)
        VALUES(:id, :userId, :kind, :name, :objectKey, :createdAt, :updatedAt, :docJson)
        ON CONFLICT(id) DO UPDATE SET
          kind       = excluded.kind,
          name       = excluded.name,
          object_key    = excluded.object_key,
          updated_at = excluded.updated_at,
          doc_json   = excluded.doc_json`).run({
        id: asset.id,
        userId,
        kind: asset.kind ?? 'image',
        name: asset.name ?? asset.id,
        objectKey: asset.objectKey ?? null,
        createdAt: asset.createdAt,
        updatedAt: changedAt,
        docJson,
      });
      sql(`INSERT INTO asset_changes(user_id, asset_id, action, created_at, doc_json)
           VALUES(:userId, :assetId, 'upsert', :createdAt, :docJson)`)
        .run({ userId, assetId: asset.id, createdAt: changedAt, docJson });
    });
    return asset;
  }

  function findAsset(userId, id, scope = {}) {
    const scoped = scopeWhere(scope);
    return parseDoc(sql(`SELECT doc_json FROM assets WHERE id = :id AND user_id = :userId ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}`)
      .get({ id, userId, ...scoped.params }));
  }

  function findAssetBySha256(userId, sha256, size, { requireRemote = false, deviceId = '', workspaceId = '' } = {}) {
    const scoped = scopeWhere({ deviceId, workspaceId });
    return parseDoc(sql(`
      SELECT doc_json FROM assets
      WHERE user_id = :userId
        AND json_extract(doc_json, '$.sha256') = :sha256
        AND json_extract(doc_json, '$.size') = :size
        ${requireRemote ? "AND COALESCE(object_key, '') <> ''" : ''}
        ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id ASC LIMIT 1`).get({ userId, sha256, size, ...scoped.params }));
  }

  function deleteAsset(userId, id) {
    const asset = findAsset(userId, id);
    if (!asset) return false;
    const deletedAt = new Date().toISOString();
    tx(() => {
      sql('DELETE FROM assets WHERE id = :id AND user_id = :userId').run({ id, userId });
      sql(`INSERT INTO asset_changes(user_id, asset_id, action, created_at, doc_json)
           VALUES(:userId, :assetId, 'delete', :createdAt, :docJson)`)
        .run({ userId, assetId: id, createdAt: deletedAt, docJson: JSON.stringify(asset) });
    });
    return true;
  }

  function listAssets(userId, { kind = null, search = null, deviceId = '', workspaceId = '', limit = defaultPageLimit, cursor = null, includeTotal = true } = {}) {
    const searchText = String(search || '').trim();
    const scoped = scopeWhere({ deviceId, workspaceId });
    if (!searchText) return keysetPage({
      table: 'assets', timeColumn: 'created_at', scope: 'asset',
      userId, filters: { kind }, extraWhere: scoped.where, extraParams: scoped.params, limit, cursor, includeTotal,
    });
    const baseWhere = ['user_id = :userId', 'name LIKE :search'];
    if (kind) baseWhere.push('kind = :kind');
    baseWhere.push(...scoped.where);
    const where = [...baseWhere];
    const position = decodeCursor('asset-search', cursor);
    const params = { userId, search: `%${searchText}%`, limit: limit + 1 };
    if (kind) params.kind = kind;
    if (position) {
      where.push('(created_at < :cursorTime OR (created_at = :cursorTime AND id > :cursorId))');
      params.cursorTime = position.t;
      params.cursorId = position.i;
    }
    let total = null;
    if (includeTotal) total = sql(`SELECT COUNT(*) AS total FROM assets WHERE ${baseWhere.join(' AND ')}`).get({ userId, ...(kind ? { kind } : {}), ...scoped.params, search: `%${searchText}%` }).total;
    const rows = sql(`
      SELECT id, created_at AS sortTime, doc_json FROM assets
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id ASC
      LIMIT :limit`).all({ ...params, ...scoped.params });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { items: parseDocs(page), total, nextCursor: hasMore && last ? encodeCursor('asset-search', { t: last.sortTime, i: last.id }) : null };
  }

  function changeCursor(seq, assetId = '__checkpoint__') {
    return encodeCursor('asset-change', { t: String(Math.max(0, Number(seq) || 0)), i: String(assetId) });
  }

  function listAssetChanges(userId, { deviceId = '', workspaceId = '', cursor = null, limit = defaultPageLimit } = {}) {
    const latest = Number(sql('SELECT COALESCE(MAX(seq), 0) AS seq FROM asset_changes WHERE user_id = :userId').get({ userId }).seq);
    const position = decodeCursor('asset-change', cursor);
    const afterSeq = position ? Number(position.t) : latest;
    if (!position) return { items: [], nextCursor: changeCursor(latest), hasMore: false };
    const scoped = scopeWhere({ deviceId, workspaceId });
    const rows = sql(`
      SELECT seq, asset_id AS assetId, action, created_at AS createdAt, doc_json AS docJson
      FROM asset_changes
      WHERE user_id = :userId AND seq > :afterSeq
        ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}
      ORDER BY seq ASC
      LIMIT :limit`).all({ userId, afterSeq, ...scoped.params, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(row => ({ seq: row.seq, assetId: row.assetId, action: row.action, createdAt: row.createdAt, asset: JSON.parse(row.docJson) })),
      nextCursor: changeCursor(last?.seq ?? afterSeq, last?.assetId || '__checkpoint__'),
      hasMore,
    };
  }

  function findAssets(userId, ids) {
    const found = new Map();
    for (const id of ids) {
      const asset = findAsset(userId, id);
      if (asset) found.set(id, asset);
    }
    return ids.map(id => found.get(id)).filter(Boolean);
  }

  function findCloudAssets(userId, ids, scope = {}) {
    const scoped = scopeWhere(scope);
    return findAssets(userId, ids).filter(asset => (!scoped.where.length || (
      String(asset.originDeviceId || '') === String(scope.deviceId || '')
      && String(asset.originWorkspaceId || '') === String(scope.workspaceId || '')
    )) && (asset.objectKey || (
      asset.sourceGenerationId
      && asset.sourceUrl
      && asset.deliveryStatus !== 'local_ready'
    )));
  }

  return {
    saveAssetRecord,
    findAsset,
    findAssetBySha256,
    deleteAsset,
    listAssets,
    listAssetChanges,
    findAssets,
    findCloudAssets,
  };
}
