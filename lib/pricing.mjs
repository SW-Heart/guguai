import { creditsToMicro, microToCredits } from './billing.mjs';
import { sql, tx } from './db.mjs';
import { appendAuditEvent } from './audit.mjs';

export const DEFAULT_PRICING = Object.freeze({ imagePerRequestMicro: 1_000_000, videoPerSecondMicro: 1_000_000 });

function rowToPricing(row) {
  if (!row) return null;
  return {
    version: Number(row.version),
    imagePerRequestMicro: Number(row.image_per_request_micro),
    videoPerSecondMicro: Number(row.video_per_second_micro),
    imagePerRequest: microToCredits(Number(row.image_per_request_micro)),
    videoPerSecond: microToCredits(Number(row.video_per_second_micro)),
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    note: row.note || '',
  };
}

export function currentPricing() {
  return rowToPricing(sql('SELECT * FROM pricing_versions ORDER BY version DESC LIMIT 1').get()) || {
    version: 0, ...DEFAULT_PRICING,
    imagePerRequest: microToCredits(DEFAULT_PRICING.imagePerRequestMicro),
    videoPerSecond: microToCredits(DEFAULT_PRICING.videoPerSecondMicro),
  };
}

export function pricingHistory(limit = 50) {
  return sql('SELECT * FROM pricing_versions ORDER BY version DESC LIMIT :limit').all({ limit }).map(rowToPricing);
}

export function parsePrice(value, field) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw Object.assign(new Error(`${field} 必须是 0 到 6 位小数的非负数字`), { statusCode: 400 });
  const micro = creditsToMicro(text);
  if (micro > 1_000_000_000_000) throw Object.assign(new Error(`${field} 超出允许范围`), { statusCode: 400 });
  return micro;
}

export function createPricingVersion({ imagePerRequest, videoPerSecond, actorUserId, note = '', expectedVersion = null, audit = {} }) {
  const imageMicro = parsePrice(imagePerRequest, '图片价格');
  const videoMicro = parsePrice(videoPerSecond, '视频价格');
  return tx(() => {
    const current = currentPricing();
    if (expectedVersion !== null && Number(expectedVersion) !== current.version) throw Object.assign(new Error('价格已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const createdAt = new Date().toISOString();
    const result = sql(`
      INSERT INTO pricing_versions(image_per_request_micro, video_per_second_micro, created_by, created_at, note)
      VALUES(:imageMicro, :videoMicro, :actorUserId, :createdAt, :note)
    `).run({ imageMicro, videoMicro, actorUserId, createdAt, note: String(note).slice(0, 500) });
    const version = rowToPricing(sql('SELECT * FROM pricing_versions WHERE version = :version').get({ version: Number(result.lastInsertRowid) }));
    appendAuditEvent({ actorUserId, action: 'pricing.create_version', targetType: 'pricing', targetId: String(version.version), before: current, after: version, ...audit });
    return version;
  });
}

export function pricingSnapshot(pricing, type, quantity = 1) {
  const unit = type === 'image' ? pricing.imagePerRequestMicro : pricing.videoPerSecondMicro;
  const safeQuantity = type === 'image' ? 1 : Number(quantity);
  if (!Number.isSafeInteger(safeQuantity) || safeQuantity < 1) throw Object.assign(new Error('视频时长无效'), { statusCode: 400 });
  const totalMicro = unit * safeQuantity;
  if (!Number.isSafeInteger(totalMicro)) throw Object.assign(new Error('任务费用超出安全范围'), { statusCode: 400 });
  return {
    version: pricing.version,
    billingUnit: type === 'image' ? 'request' : 'second',
    unitPriceMicro: unit,
    unitPrice: microToCredits(unit),
    quantity: safeQuantity,
    totalMicro,
    total: microToCredits(totalMicro),
  };
}
