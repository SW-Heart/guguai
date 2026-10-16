import { speechModels, speechDesignModel, speechPreviewModel } from '../public/features/speech/catalog.js';
import { creditsToMicro, microToCredits } from './billing.mjs';
import { VIDEO_UPSCALE_CREDITS_PER_SECOND, VIDEO_UPSCALE_MODEL_ID, VIDEO_UPSCALE_PRICE_QUALITY } from '../public/features/generation/upscale.js';
import { sql, tx } from './db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { publicVideoCapabilities } from './video-capabilities.mjs';
import { isRouteModel } from './model-routes.mjs';

export function videoBillingUnit(pricing, modelId) {
  return pricing.videoBillingModes?.[modelId] === 'request' ? 'request' : 'second';
}

export function validateVideoBillingUnit(unit) {
  if (!['request', 'second'].includes(unit)) throw Object.assign(new Error('请选择按次生成或按秒生成'), { statusCode:400 });
  return unit;
}

export function modelPrice(pricing, modelId, quality, fallback) {
  return pricing.modelPrices?.[`${modelId}:${String(quality).toLowerCase()}`] ?? fallback;
}

export function liveLlmRates(defaults) {
  const rates = () => {
    const pricing = currentPricing();
    const inputYuanPerMillion = modelPrice(pricing, 'llm', 'input', defaults.inputYuanPerMillion);
    const outputYuanPerMillion = modelPrice(pricing, 'llm', 'output', defaults.outputYuanPerMillion);
    const cacheReadYuanPerMillion = modelPrice(pricing, 'llm', 'cache-read', defaults.cacheReadYuanPerMillion ?? inputYuanPerMillion);
    const cacheCreationYuanPerMillion = modelPrice(pricing, 'llm', 'cache-creation', defaults.cacheCreationYuanPerMillion ?? inputYuanPerMillion);
    return { ...defaults, inputYuanPerMillion, outputYuanPerMillion, cacheReadYuanPerMillion, cacheCreationYuanPerMillion,
      inputMicroPerToken:inputYuanPerMillion / defaults.yuanPerCredit,
      outputMicroPerToken:outputYuanPerMillion / defaults.yuanPerCredit,
      cacheReadMicroPerToken:cacheReadYuanPerMillion / defaults.yuanPerCredit,
      cacheCreationMicroPerToken:cacheCreationYuanPerMillion / defaults.yuanPerCredit };
  };
  return Object.defineProperties({}, Object.fromEntries([...new Set([...Object.keys(defaults), 'cacheReadYuanPerMillion', 'cacheCreationYuanPerMillion', 'cacheReadMicroPerToken', 'cacheCreationMicroPerToken'])].map(key => [key, { enumerable:true, get:() => rates()[key] }])));
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
    if (!mode || isRouteModel(model.id)) continue;
    for (const quality of mode.qualityOptions?.length ? mode.qualityOptions : ['标准']) {
      fields.push({ modelId:model.id, label:model.label, quality, amount:(mode.pricingByQuality?.[quality] || mode.pricing)?.amount ?? pricing.videoPerSecond, unit:'秒' });
    }
  }
  for (const model of [...speechModels,speechPreviewModel]) fields.push({modelId:model.id,label:model.label,quality:'标准',amount:model.creditsPerTenThousand,unit:'万字符',fixedBilling:true});
  fields.push({modelId:speechDesignModel.id,label:speechDesignModel.label,quality:'标准',amount:speechDesignModel.creditsPerVoice,unit:'音色（首次配音）',fixedBilling:true});
  fields.push({ modelId:VIDEO_UPSCALE_MODEL_ID, label:'视频高清放大', quality:VIDEO_UPSCALE_PRICE_QUALITY, amount:VIDEO_UPSCALE_CREDITS_PER_SECOND, unit:'秒' });
  fields.push({ modelId:'llm', label:'文本模型', quality:'input', amount:Number(process.env.LLM_INPUT_PRICE_YUAN_PER_MILLION || 3), unit:'百万输入 Token（元）' }, { modelId:'llm', label:'文本模型', quality:'output', amount:Number(process.env.LLM_OUTPUT_PRICE_YUAN_PER_MILLION || 6), unit:'百万输出 Token（元）' });
  const inputPrice = Number(process.env.LLM_INPUT_PRICE_YUAN_PER_MILLION || 3);
  fields.push(
    { modelId:'llm', label:'文本模型', quality:'cache-read', amount:Number(process.env.LLM_CACHE_READ_PRICE_YUAN_PER_MILLION ?? inputPrice), unit:'百万缓存读取 Token（元）' },
    { modelId:'llm', label:'文本模型', quality:'cache-creation', amount:Number(process.env.LLM_CACHE_CREATION_PRICE_YUAN_PER_MILLION ?? inputPrice), unit:'百万缓存创建 Token（元）' },
  );
  return fields.map(field => ({ ...field, key:`${field.modelId}:${field.quality.toLowerCase()}`, amount:modelPrice(pricing, field.modelId, field.quality, field.amount), ...(field.unit === '秒' && !field.fixedBilling && field.modelId !== VIDEO_UPSCALE_MODEL_ID ? { billingUnit:videoBillingUnit(pricing, field.modelId), unit:videoBillingUnit(pricing, field.modelId) === 'request' ? '次' : '秒' } : {}) }));
}

export const DEFAULT_PRICING = Object.freeze({ imagePerRequestMicro: 1_000_000, videoPerSecondMicro: 1_000_000 });

function rowToPricing(row) {
  if (!row) return null;
  return {
    version: Number(row.version),
    modelPrices: JSON.parse(row.model_prices_json || '{}'),
    videoBillingModes: JSON.parse(row.video_billing_modes_json || '{}'),
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

export function createPricingVersion({ imagePerRequest, videoPerSecond, modelPrices, videoBillingModes, actorUserId, note = '', expectedVersion = null, audit = {} }) {
  const imageMicro = parsePrice(imagePerRequest, '图片价格');
  const videoMicro = parsePrice(videoPerSecond, '视频价格');
  return tx(() => {
    const current = currentPricing();
    const prices = { ...current.modelPrices };
    const modes = { ...current.videoBillingModes };
    if (videoBillingModes !== undefined) {
      if (!videoBillingModes || typeof videoBillingModes !== 'object' || Array.isArray(videoBillingModes)) throw Object.assign(new Error('视频计费类型无效'), { statusCode:400 });
      const allowedModels = new Set(modelPriceFields(current).filter(field => field.billingUnit).map(field => field.modelId));
      for (const [id, unit] of Object.entries(videoBillingModes)) {
        if (!allowedModels.has(id)) throw Object.assign(new Error('该模型不支持设置视频计费类型'), { statusCode:400 });
        modes[id] = validateVideoBillingUnit(unit);
      }
    }
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
      INSERT INTO pricing_versions(image_per_request_micro, video_per_second_micro, created_by, created_at, note, model_prices_json, video_billing_modes_json)
      VALUES(:imageMicro, :videoMicro, :actorUserId, :createdAt, :note, :modelPrices, :videoBillingModes)
    `).run({ imageMicro, videoMicro, actorUserId, createdAt, note: String(note).slice(0, 500), modelPrices:JSON.stringify(prices), videoBillingModes:JSON.stringify(modes) });
    const version = rowToPricing(sql('SELECT * FROM pricing_versions WHERE version = :version').get({ version: Number(result.lastInsertRowid) }));
    appendAuditEvent({ actorUserId, action: 'pricing.create_version', targetType: 'pricing', targetId: String(version.version), before: current, after: version, ...audit });
    return version;
  });
}

export function pricingSnapshot(pricing, type, quantity = 1) {
  const unit = type === 'image' ? pricing.imagePerRequestMicro : pricing.videoPerSecondMicro;
  const billingUnit = type === 'image' ? 'request' : pricing.videoBillingUnit || 'second';
  const safeQuantity = billingUnit === 'request' ? 1 : Number(quantity);
  if (!Number.isSafeInteger(safeQuantity) || safeQuantity < 1) throw Object.assign(new Error('视频时长无效'), { statusCode: 400 });
  const totalMicro = unit * safeQuantity;
  if (!Number.isSafeInteger(totalMicro)) throw Object.assign(new Error('任务费用超出安全范围'), { statusCode: 400 });
  return {
    version: pricing.version,
    billingUnit,
    unitPriceMicro: unit,
    unitPrice: microToCredits(unit),
    quantity: safeQuantity,
    totalMicro,
    total: microToCredits(totalMicro),
  };
}
