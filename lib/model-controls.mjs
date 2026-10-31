import { sql, tx } from './db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { publicVideoCapabilities, videoModelProviderConfigured, validateVideoRequest } from './video-capabilities.mjs';
import { isRouteModel, modelRouteQualities, selectModelRoute, modelRouteSettings, withModelRouteSnapshot } from './model-routes.mjs';
import { currentPricing, modelPrice, videoBillingUnit } from './pricing.mjs';
import { planSortOrderShift } from './sort-order.mjs';
import { IMAGE_MODEL_DESCRIPTIONS, MODEL_DESCRIPTION_MAX_LENGTH } from './model-descriptions.mjs';

export { IMAGE_MODEL_DESCRIPTIONS };

export function validateControlledVideoRequest(input, referenceCount = 0) {
  return validateVideoRequest(input, referenceCount, modelRouteSettings);
}

function controlFromRow(row) {
  return {
    id: row.model_id, modelId: row.model_id, kind: row.kind,
    userVisible: Boolean(row.user_visible), enabled: Boolean(row.enabled),
    sortOrder: row.sort_order, description: row.description ?? null,
    version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at,
  };
}

export function listModelControls() {
  return sql('SELECT * FROM model_controls ORDER BY kind, sort_order, model_id').all().map(controlFromRow);
}

export function modelControl(modelId) {
  const row = sql('SELECT * FROM model_controls WHERE model_id = :modelId').get({ modelId });
  return row ? controlFromRow(row) : null;
}

/** Applies the descriptions kept in the admin console to a public model list. */
export function withModelDescriptions(models, controls = new Map(listModelControls().map(item => [item.modelId, item]))) {
  return models.map(model => {
    const description = controls.get(model.id)?.description;
    return typeof description === 'string' ? { ...model, description } : model;
  });
}

export function isModelEnabled(modelId) {
  const control = modelControl(modelId);
  return control ? control.enabled : false;
}

export function isImageModelAvailable(modelId, env = process.env) {
  const control = modelControl(modelId);
  const key = modelId === 'gpt-image-2.5' ? 'TUZI_DEFAULT_API_KEY' : ['gpt-image-2', 'midjourney'].includes(modelId) ? 'DUOMI_API_KEY' : '';
  return Boolean(key && String(env[key] || '').trim() && control?.enabled && control?.userVisible);
}

function routeForMode(logicalModelId, quality, aspectRatio, mode) {
  const counts = mode.generationType === 'REFERENCE'
    ? ['image', 'video', 'audio'].filter(kind => (mode.referenceLimits?.[kind] ?? (kind === 'image' ? mode.maxImages : 0)) > 0).map(kind => ({ [kind]: 1 }))
    : [{}];
  for (const referenceCounts of counts) {
    const route = selectModelRoute({ logicalModelId, quality, aspectRatio, availableOnly: true, referenceCounts });
    if (route) return route;
  }
  return null;
}

export function publicVideoCapabilitiesWithControls() {
  return withModelRouteSnapshot(buildVideoCapabilitiesWithControls);
}

function buildVideoCapabilitiesWithControls() {
  const controls = new Map(listModelControls().map(item => [item.modelId, item]));
  const base = publicVideoCapabilities(modelRouteSettings);
  const pricing = currentPricing();
  const result = {
    ...base,
    models: base.models
      .filter(model => controls.get(model.id)?.userVisible !== false && controls.get(model.id)?.enabled !== false && model.availability !== 'coming-soon' && videoModelProviderConfigured(model.id))
      .sort((a, b) => Number(a.availability === 'coming-soon') - Number(b.availability === 'coming-soon') || (controls.get(a.id)?.sortOrder ?? 999) - (controls.get(b.id)?.sortOrder ?? 999))
      .map(model => ({ ...model, description: controls.get(model.id)?.description ?? model.description, enabled: controls.get(model.id)?.enabled !== false,
        modes:model.modes.map(mode => isRouteModel(model.id) ? { ...mode, pricing:null, pricingByQuality:undefined,
          durationsByQuality: Object.fromEntries(modelRouteQualities(model.id).map(quality => [quality, Object.fromEntries(mode.aspectRatios.map(aspectRatio => [aspectRatio, routeForMode(model.id, quality, aspectRatio, mode)?.durations || []]))])),
          durations: [...new Set(modelRouteQualities(model.id).flatMap(quality => mode.aspectRatios.flatMap(aspectRatio => routeForMode(model.id, quality, aspectRatio, mode)?.durations || [])))].sort((a,b) => a-b),
          qualityOptions:modelRouteQualities(model.id).filter(quality => mode.qualityOptions.includes(quality) && mode.aspectRatios.some(aspectRatio => routeForMode(model.id, quality, aspectRatio, mode))),
        } : { ...mode,
          pricingByQuality:Object.fromEntries((mode.qualityOptions?.length ? mode.qualityOptions : ['标准']).map(quality => [quality, {
            currency:'credit', unit:videoBillingUnit(pricing, model.id), amount:modelPrice(pricing, model.id, quality, (mode.pricingByQuality?.[quality] || mode.pricing)?.amount ?? pricing.videoPerSecond),
          }])),
        }).filter(mode => mode.qualityOptions?.length && mode.durations?.length && mode.aspectRatios?.length),
      })).filter(model => model.modes.length),
  };
  const visibleIds = new Set(result.models.map(model => model.id));
  result.routing = base.routing.filter(item => visibleIds.has(item.modelId));
  return result;
}

function descriptionPatch(value, current) {
  if (value === undefined) return current;
  if (typeof value !== 'string') throw Object.assign(new Error('模型描述必须是文字'), { statusCode: 400 });
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > MODEL_DESCRIPTION_MAX_LENGTH) throw Object.assign(new Error(`模型描述最多 ${MODEL_DESCRIPTION_MAX_LENGTH} 个字`), { statusCode: 400 });
  return text;
}

function booleanPatch(value, current, field) {
  if (value === undefined) return current;
  if (typeof value !== 'boolean') throw Object.assign(new Error(`${field} 必须是布尔值`), { statusCode: 400 });
  return value;
}

export function updateModelControl(modelId, patch, { actorUserId = null, expectedVersion = null, audit = {} } = {}) {
  return tx(() => {
    const before = modelControl(modelId);
    if (!before) throw Object.assign(new Error('模型不存在'), { statusCode: 404 });
    if (expectedVersion !== null && Number(expectedVersion) !== before.version) throw Object.assign(new Error('模型配置已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const userVisible = booleanPatch(patch.userVisible, before.userVisible, 'userVisible');
    const enabled = booleanPatch(patch.enabled, before.enabled, 'enabled');
    const description = descriptionPatch(patch.description, before.description);
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
    sql(`UPDATE model_controls SET user_visible = :userVisible, enabled = :enabled, sort_order = :sortOrder, description = :description, version = version + 1, updated_by = :actorUserId, updated_at = :updatedAt WHERE model_id = :modelId`).run({ modelId, userVisible: userVisible ? 1 : 0, enabled: enabled ? 1 : 0, sortOrder, description, actorUserId, updatedAt });
    const after = modelControl(modelId);
    appendAuditEvent({ actorUserId, action: 'model.update_control', targetType: 'model', targetId: modelId, before, after, metadata: reordered.length ? { reordered } : null, ...audit });
    return after;
  });
}
