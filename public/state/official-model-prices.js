// Checked 2026-10-10 against Volcengine's published 16:9 examples,
// without video input. These are reference estimates, not fixed API tariffs.
// https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
const seedancePrices = Object.freeze({
  'seedance-2.0': { '480p':0.46, '720p':0.99, '1080p':2.48 },
  'seedance-2.0-mini': { '480p':0.23, '720p':0.50 },
  'seedance-2.0-fast': { '480p':0.37, '720p':0.80 },
  'seedance-2.5': { '480p':0.67, '720p':1.51, '1080p':3.74 },
});
const source = 'https://docs.volcengine.com/docs/ark/model-pricing?lang=zh';
// Alibaba Cloud's Beijing list prices in CNY, excluding limited-time offers.
// Checked 2026-10-27: https://help.aliyun.com/zh/model-studio/wan3-0-video
const wanReference = Object.freeze({
  unit:'second', prices:{ '480p':0.30, '720p':0.60, '1080p':1.20 },
  label:'Wan 3.0（北京）', source:'https://help.aliyun.com/zh/model-studio/wan3-0-video', checkedAt:'2026-10-27',
});
// Kling has no CNY API tariff for 4.0 yet; its USD list price ($0.157/s 720p,
// $0.235/s 1080p) is converted at 7.1 CNY/USD as agreed with the user on 2026-10-27.
const klingReference = Object.freeze({
  unit:'second', prices:{ '720p':1.11, '1080p':1.67 },
  label:'Kling 4.0 官方美元价（按 1 美元 ≈ 7.1 元折算）', source:'https://fal.ai/models/kling/v4/image-to-video', checkedAt:'2026-10-27',
});
// Official reference prices supplied by the user on 2026-10-10.
// H3 cards use the supplied MiniMax-H3-Max reference for matching resolutions.
const suppliedPrices = Object.freeze({
  'minimax-h3-15s': { unit:'second', prices:{ '480p':0.33, '768p':0.50 }, label:'MiniMax-H3-Max' },
  'minimax-h3': { unit:'second', prices:{ '480p':0.33, '768p':0.50 }, label:'MiniMax-H3-Max' },
  'gpt-image-2': { unit:'request', prices:{ '标准':0.35 }, label:'GPT-Image-2' },
  'gpt-image-2.5': { unit:'request', prices:{ '1k':0.29, '2k':0.29, '4k':0.29 }, label:'GPT-Image-2.5' },
  'midjourney': { unit:'request', prices:{ '标准':0.32 }, label:'Midjourney' },
});

// A video sold per request is compared per second over the longest length the
// model currently offers, which is the best value a buyer can get from one request.
export function requestPricePerSecond(row) {
  const seconds = Number(row?.maxDuration);
  const yuan = row?.yuan;
  if (row?.unit !== 'request' || !Number.isFinite(seconds) || seconds <= 0 || typeof yuan !== 'number' || !Number.isFinite(yuan) || yuan < 0) return null;
  return yuan / seconds;
}

export function officialPriceDiscount(modelId, row) {
  const baseModel = { 'wan-3.0-value':'wan-3.0', 'seedance-2.0-mini-value':'seedance-2.0-mini', 'seedance-2.0-fast-value':'seedance-2.0-fast', 'seedance-2.0-value':'seedance-2.0', 'seedance-2.5-value':'seedance-2.5' }[modelId] || modelId;
  const quality = String(row?.quality || '').toLowerCase();
  const reference = baseModel === 'wan-3.0' ? wanReference : baseModel === 'kling-4.0' ? klingReference : suppliedPrices[baseModel];
  const officialYuan = reference ? reference.prices[quality] : seedancePrices[baseModel]?.[quality];
  const unit = reference?.unit || 'second';
  const perSecond = unit === 'second' ? requestPricePerSecond(row) : null;
  const yuan = perSecond ?? row?.yuan;
  if ((perSecond === null && row?.unit !== unit) || typeof yuan !== 'number' || !Number.isFinite(yuan) || yuan < 0 || !officialYuan || yuan >= officialYuan) return null;
  // Round down so the badge never overstates savings, including near parity.
  const percent = Math.floor((1 - yuan / officialYuan) * 100 + 1e-9);
  if (percent < 1) return null;
  const perRequest = perSecond === null ? '' : `每次 ¥${row.yuan.toFixed(2)}，按最长 ${Number(row.maxDuration)} 秒折算约 ¥${perSecond.toFixed(2)}/秒。`;
  return {
    label:`${(100 - percent) / 10}折`,
    detail:(reference
      ? `比官方价格低${percent}%。按 ${reference.label} 官方参考价 ¥${officialYuan.toFixed(2)}/${unit === 'second' ? '秒' : '次'}计算。${reference.checkedAt ? `核对日期：${reference.checkedAt}。` : ''}`
      : `比官方价格低${percent}%。按官方 16:9、无参考视频的参考价 ¥${officialYuan.toFixed(2)}/秒计算；实际费用随画幅和参考视频变化。核对日期：2026-10-10。`) + perRequest,
    source:reference ? reference.source || null : source,
  };
}
