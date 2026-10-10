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
// Official reference prices supplied by the user on 2026-10-10.
// H3 cards use the supplied MiniMax-H3-Max reference for matching resolutions.
const suppliedPrices = Object.freeze({
  'minimax-h3-15s': { unit:'second', prices:{ '480p':0.33, '768p':0.50 }, label:'MiniMax-H3-Max' },
  'minimax-h3': { unit:'second', prices:{ '480p':0.33, '768p':0.50 }, label:'MiniMax-H3-Max' },
  'gpt-image-2': { unit:'request', prices:{ '标准':0.35 }, label:'GPT-Image-2' },
  'gpt-image-2.5': { unit:'request', prices:{ '1k':0.29, '2k':0.29, '4k':0.29 }, label:'GPT-Image-2.5' },
  'midjourney': { unit:'request', prices:{ '标准':0.32 }, label:'Midjourney' },
});

export function officialPriceDiscount(modelId, row) {
  const baseModel = { 'seedance-2.0-value':'seedance-2.0', 'seedance-2.5-value':'seedance-2.5' }[modelId] || modelId;
  const quality = String(row?.quality || '').toLowerCase();
  const supplied = suppliedPrices[baseModel];
  const officialYuan = supplied ? supplied.prices[quality] : seedancePrices[baseModel]?.[quality];
  const unit = supplied?.unit || 'second';
  const yuan = row?.yuan;
  if (row?.unit !== unit || typeof yuan !== 'number' || !Number.isFinite(yuan) || yuan < 0 || !officialYuan || yuan >= officialYuan) return null;
  // Round down so the badge never overstates savings, including near parity.
  const percent = Math.floor((1 - yuan / officialYuan) * 100 + 1e-9);
  if (percent < 1) return null;
  return {
    label:`${(100 - percent) / 10}折`,
    detail:supplied
      ? `比官方价格低${percent}%。按 ${supplied.label} 官方参考价 ¥${officialYuan.toFixed(2)}/${unit === 'second' ? '秒' : '次'}计算。`
      : `比官方价格低${percent}%。按官方 16:9、无参考视频的参考价 ¥${officialYuan.toFixed(2)}/秒计算；实际费用随画幅和参考视频变化。核对日期：2026-10-10。`,
    source:supplied ? null : source,
  };
}
