export function createGenerationRepository({ sql, keysetPage, scopeWhere, parseDoc, defaultPageLimit = 100 }) {
  if (typeof sql !== 'function' || typeof keysetPage !== 'function' || typeof scopeWhere !== 'function' || typeof parseDoc !== 'function') {
    throw new TypeError('生成仓储依赖未完整提供');
  }

  function saveGenerationRecord(userId, task) {
    sql(`
      INSERT INTO generations(id, user_id, type, status, credit_cost, credit_cost_micro, credit_status,
                              pricing_version, pricing_snapshot_json, model_id, provider,
                              asset_id, provider_task_id, created_at, updated_at, doc_json)
      VALUES(:id, :userId, :type, :status, :creditCost, :creditCostMicro, :creditStatus,
             :pricingVersion, :pricingSnapshotJson, :modelId, :provider,
             :assetId, :providerTaskId, :createdAt, :updatedAt, :docJson)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, credit_cost = excluded.credit_cost,
        credit_cost_micro = excluded.credit_cost_micro, credit_status = excluded.credit_status,
        pricing_version = excluded.pricing_version, pricing_snapshot_json = excluded.pricing_snapshot_json,
        model_id = excluded.model_id, provider = excluded.provider, asset_id = excluded.asset_id,
        provider_task_id = excluded.provider_task_id, updated_at = excluded.updated_at,
        doc_json = excluded.doc_json`).run({
      id: task.id,
      userId,
      type: task.type ?? 'image',
      status: task.status ?? 'queued',
      creditCost: Number.isFinite(Number(task.creditCost)) ? Number(task.creditCost) : 0,
      creditCostMicro: Number.isSafeInteger(task.creditCostMicro) ? task.creditCostMicro : null,
      creditStatus: task.creditStatus ?? null,
      pricingVersion: task.pricingVersion ?? task.pricingSnapshot?.version ?? null,
      pricingSnapshotJson: task.pricingSnapshot ? JSON.stringify(task.pricingSnapshot) : null,
      modelId: task.videoModelId || task.modelId || null,
      provider: task.provider || null,
      assetId: task.assetId || null,
      providerTaskId: task.providerTaskId || null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      docJson: JSON.stringify(task),
    });
    return task;
  }

  function findGeneration(userId, id, scope = {}) {
    const scoped = scopeWhere(scope);
    return parseDoc(sql(`SELECT doc_json FROM generations WHERE id = :id AND user_id = :userId ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}`)
      .get({ id, userId, ...scoped.params }));
  }

  function deleteGeneration(userId, id) {
    return sql('DELETE FROM generations WHERE id = :id AND user_id = :userId')
      .run({ id, userId }).changes > 0;
  }

  function listGenerations(userId, { type = null, deviceId = '', workspaceId = '', view = 'all', limit = defaultPageLimit, cursor = null, includeTotal = true } = {}) {
    if (!['all', 'works', 'history'].includes(view)) throw Object.assign(new Error('生成记录视图无效'), { statusCode:400 });
    const scoped = scopeWhere({ deviceId, workspaceId });
    const viewWhere = view === 'works'
      ? ["status != 'failed'", "(status != 'completed' OR asset_id IS NOT NULL)"]
      : [];
    return keysetPage({
      table: 'generations', timeColumn: 'created_at', scope: 'gen',
      userId, filters: { type }, extraWhere: [...scoped.where, ...viewWhere], extraParams: scoped.params, limit, cursor, includeTotal,
    });
  }

  function listPendingGenerations() {
    return sql(`
      SELECT id, user_id AS userId, doc_json FROM generations
      WHERE status IN ('queued','running')
         OR (status = 'completed' AND instr(doc_json, '"archivePending":true') > 0)
         OR (status = 'failed' AND credit_status = 'refund_failed')
      ORDER BY created_at ASC`).all()
      .flatMap(row => {
        try {
          const task = JSON.parse(row.doc_json);
          if (!task || typeof task !== 'object' || task.id !== row.id) throw new Error('生成记录标识无效');
          return [{ userId:row.userId, task }];
        } catch (error) {
          console.error('[recovery] 跳过损坏的生成记录', { generationId:row.id, message:error.message });
          return [];
        }
      });
  }

  return Object.freeze({ saveGenerationRecord, findGeneration, deleteGeneration, listGenerations, listPendingGenerations });
}
