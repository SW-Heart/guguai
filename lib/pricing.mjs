import { creditsToMicro, microToCredits } from './billing.mjs';
import { sql, tx } from './db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { publicVideoCapabilities } from './video-capabilities.mjs';

export function modelPrice(pricing, modelId, quality, fallback) {
  return pricing.modelPrices?.[`${modelId}:${String(quality).toLowerCase()}`] ?? fallback;
}

export function liveLlmRates(defaults) {
  const rates = () => {
    const pricing = currentPricing();
    const inputYuanPerMillion = modelPrice(pricing, 'llm', 'input', defaults.inputYuanPerMillion);
    const outputYuanPerMillion = modelPrice(pricing, 'llm', 'output', defaults.outputYuanPerMillion);
    return { ...defaults, inputYuanPerMillion, outputYuanPerMillion,
      inputMicroPerToken:inputYuanPerMillion / defaults.yuanPerCredit,
      outputMicroPerToken:outputYuanPerMillion / defaults.yuanPerCredit };
  };
  return Object.defineProperties({}, Object.fromEntries(Object.keys(defaults).map(key => [key, { enumerable:true, get:() => rates()[key] }])));
}

export function modelPriceFields(pricing = currentPricing()) {
  const fields = [
    { modelId:'gpt-image-2', label:'GPT-Image-2', quality:'标准', amount:pricing.imagePerRequest, unit:'次' },
    ...['1K', '2K', '4K'].map((quality, index) => ({ modelId:'gpt-image-2.5', label:'GPT Image 2.5', quality, amount:2 ** index, unit:'次' })),
    { modelId:'midjourney', label:'Midjourney', quality:'标准', amount:4, unit:'次（四宫格）' },
    { modelId:'minimax-h3', label:'Minimax H3（兼容模型）', quality:'768p', amount:2, unit:'秒' },
    { modelId:'minimax-h3', label:'Minimax H3（兼容模型）', quality:'2k', amount:3, unit:'秒' },
  ];
  for (const model of publicVideoCapabilities().models) {
    const mode = model.modes?.find(item => item.generationType === 'TEXT') || model.modes?.[0];
    if (!mode || model.id.startsWith('seedance-')) continue;
    for (const quality of mode.qualityOptions?.length ? mode.qualityOptions : ['标准']) {
      fields.push({ modelId:model.id, label:model.label, quality, amount:(mode.pricingByQuality?.[quality] || mode.pricing)?.amount ?? pricing.videoPerSecond, unit:'秒' });
    }
  }
  fields.push({ modelId:'llm', label:'文本模型', quality:'input', amount:Number(process.env.LLM_INPUT_PRICE_YUAN_PER_MILLION || 3), unit:'百万输入 Token（元）' }, { modelId:'llm', label:'文本模型', quality:'output', amount:Number(process.env.LLM_OUTPUT_PRICE_YUAN_PER_MILLION || 6), unit:'百万输出 Token（元）' });
  return fields.map(field => ({ ...field, key:`${field.modelId}:${field.quality.toLowerCase()}`, amount:modelPrice(pricing, field.modelId, field.quality, field.amount) }));
}

export const DEFAULT_PRICING = Object.freeze({ imagePerRequestMicro: 1_000_000, videoPerSecondMicro: 1_000_000 });

function rowToPricing(row) {
  if (!row) return null;
  return {
    version: Number(row.version),
    modelPrices: JSON.parse(row.model_prices_json || '{}'),
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

export function createPricingVersion({ imagePerRequest, videoPerSecond, modelPrices, actorUserId, note = '', expectedVersion = null, audit = {} }) {
  const imageMicro = parsePrice(imagePerRequest, '图片价格');
  const videoMicro = parsePrice(videoPerSecond, '视频价格');
  return tx(() => {
    const current = currentPricing();
    const prices = { ...current.modelPrices };
    if (modelPrices !== undefined) {
      if (!modelPrices || typeof modelPrices !== 'object' || Array.isArray(modelPrices)) throw Object.assign(new Error('模型价格格式无效'), { statusCode:400 });
      const allowed = new Set(modelPriceFields(current).map(field => field.key));
      for (const [key, value] of Object.entries(modelPrices)) {
        if (!allowed.has(key)) throw Object.assign(new Error(`未知模型价格：${key}`), { statusCode:400 });
        prices[key] = microToCredits(parsePrice(value, key));
      }
    }
    if (expectedVersion !== null && Number(expectedVersion) !== current.version) throw Object.assign(new Error('价格已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const createdAt = new Date().toISOString();
    const result = sql(`
      INSERT INTO pricing_versions(image_per_request_micro, video_per_second_micro, created_by, created_at, note, model_prices_json)
      VALUES(:imageMicro, :videoMicro, :actorUserId, :createdAt, :note, :modelPrices)
    `).run({ imageMicro, videoMicro, actorUserId, createdAt, note: String(note).slice(0, 500), modelPrices:JSON.stringify(prices) });
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
