import { sql, tx } from './db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { publicVideoCapabilities } from './video-capabilities.mjs';
import { availableModelRouteQualities, selectModelRoute, ROUTE_QUALITIES } from './model-routes.mjs';
import { currentPricing, modelPrice } from './pricing.mjs';
import { planSortOrderShift } from './sort-order.mjs';

export function listModelControls() {
  return sql('SELECT * FROM model_controls ORDER BY kind, sort_order, model_id').all().map(row => ({
    id: row.model_id,
    modelId: row.model_id,
    kind: row.kind,
    userVisible: Boolean(row.user_visible),
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }));
}

export function modelControl(modelId) {
  const row = sql('SELECT * FROM model_controls WHERE model_id = :modelId').get({ modelId });
  return row ? {
    id: row.model_id, modelId: row.model_id, kind: row.kind,
    userVisible: Boolean(row.user_visible), enabled: Boolean(row.enabled),
    sortOrder: row.sort_order, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at,
  } : null;
}

export function isModelEnabled(modelId) {
  const control = modelControl(modelId);
  return control ? control.enabled : false;
}

export function publicVideoCapabilitiesWithControls() {
  const controls = new Map(listModelControls().map(item => [item.modelId, item]));
  const base = publicVideoCapabilities();
  const pricing = currentPricing();
  return {
    ...base,
    models: base.models
      .filter(model => controls.get(model.id)?.userVisible !== false)
      .sort((a, b) => Number(a.availability === 'coming-soon') - Number(b.availability === 'coming-soon') || (controls.get(a.id)?.sortOrder ?? 999) - (controls.get(b.id)?.sortOrder ?? 999))
      .map(model => ({ ...model, enabled: controls.get(model.id)?.enabled !== false,
        modes:model.modes.map(mode => model.id.startsWith('seedance-') ? { ...mode,
          durationsByQuality: Object.fromEntries(ROUTE_QUALITIES.map(quality => [quality, Object.fromEntries(mode.aspectRatios.map(aspectRatio => [aspectRatio, selectModelRoute({ logicalModelId:model.id, quality, aspectRatio, referenceCounts:mode.generationType === 'REFERENCE' ? { image:1 } : {} })?.durations || []]))])),
          durations: [...new Set(ROUTE_QUALITIES.flatMap(quality => mode.aspectRatios.flatMap(aspectRatio => selectModelRoute({ logicalModelId:model.id, quality, aspectRatio, referenceCounts:mode.generationType === 'REFERENCE' ? { image:1 } : {} })?.durations || [])))].sort((a,b) => a-b),
          qualityOptions:availableModelRouteQualities(model.id, {
            referenceCounts: mode.generationType === 'REFERENCE' ? { image:1 } : {},
            aspectRatios: mode.aspectRatios,
          }).filter(quality => mode.qualityOptions.includes(quality)),
        } : { ...mode,
          pricingByQuality:Object.fromEntries((mode.qualityOptions?.length ? mode.qualityOptions : ['标准']).map(quality => [quality, {
            currency:'credit', unit:'second', amount:modelPrice(pricing, model.id, quality, (mode.pricingByQuality?.[quality] || mode.pricing)?.amount ?? pricing.videoPerSecond),
          }])),
        }),
      })),
  };
}

function booleanPatch(value, current, field) {
  if (value === undefined) return current;
  if (typeof value !== 'boolean') throw Object.assign(new Error(`${field} 必须是布尔值`), { statusCode: 400 });
  return value;
}

export function updateModelControl(modelId, patch, { actorUserId, expectedVersion = null, audit = {} } = {}) {
  return tx(() => {
    const before = modelControl(modelId);
    if (!before) throw Object.assign(new Error('模型不存在'), { statusCode: 404 });
    if (expectedVersion !== null && Number(expectedVersion) !== before.version) throw Object.assign(new Error('模型配置已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const userVisible = booleanPatch(patch.userVisible, before.userVisible, 'userVisible');
    const enabled = booleanPatch(patch.enabled, before.enabled, 'enabled');
    const sortOrder = patch.sortOrder === undefined ? before.sortOrder : Number(patch.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) throw Object.assign(new Error('排序值无效'), { statusCode: 400 });
    const updatedAt = new Date().toISOString();
    // Keep sort order unique inside one model kind: the edited model takes the
    // requested slot and the other models of the same kind make room for it.
    const reordered = sortOrder === before.sortOrder ? [] : planSortOrderShift(
      sql('SELECT model_id, sort_order FROM model_controls WHERE kind = :kind AND model_id <> :modelId').all({ kind: before.kind, modelId }).map(row => ({ id: row.model_id, order: row.sort_order })),
      { from: before.sortOrder, to: sortOrder, max: 100000 },
    );
    const shift = sql(`UPDATE model_controls SET sort_order = :sortOrder, version = version + 1, updated_by = :actorUserId, updated_at = :updatedAt WHERE model_id = :modelId`);
    for (const item of reordered) shift.run({ modelId: item.id, sortOrder: item.to, actorUserId, updatedAt });
    sql(`UPDATE model_controls SET user_visible = :userVisible, enabled = :enabled, sort_order = :sortOrder, version = version + 1, updated_by = :actorUserId, updated_at = :updatedAt WHERE model_id = :modelId`).run({ modelId, userVisible: userVisible ? 1 : 0, enabled: enabled ? 1 : 0, sortOrder, actorUserId, updatedAt });
    const after = modelControl(modelId);
    appendAuditEvent({ actorUserId, action: 'model.update_control', targetType: 'model', targetId: modelId, before, after, metadata: reordered.length ? { reordered } : null, ...audit });
    return after;
  });
}
