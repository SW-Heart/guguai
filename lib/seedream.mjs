export const SEEDREAM_MODEL_ID = 'seedream-5.0';
export const SEEDREAM_UPSTREAM_MODEL_ID = 'doubao-seedream-5-0-260128';
export const SEEDREAM_CREDITS = 2;
export const SEEDREAM_55_MODEL_ID = 'seedream-5.5';
export const SEEDREAM_DIMENSIONS = Object.freeze({
  '1:1':'2048x2048', '16:9':'2560x1440', '9:16':'1440x2560',
  '4:3':'2304x1728', '3:4':'1728x2304', '3:2':'2496x1664', '2:3':'1664x2496',
  '2:1':'2848x1424', '1:2':'1424x2848', '5:4':'2288x1824', '4:5':'1824x2288',
});
export const SEEDREAM_QUALITIES = Object.freeze(['2k', '3k', '4k']);
// Every tier scales the 2K dimensions and keeps both sides even.
const SEEDREAM_TIER_SCALES = Object.freeze({ '1k':0.5, '1.5k':0.75, '2k':1, '3k':1.5, '4k':2 });
export const SEEDREAM_DIMENSIONS_BY_QUALITY = Object.freeze(Object.fromEntries(
  Object.entries(SEEDREAM_TIER_SCALES).map(([quality, scale]) => [quality, Object.freeze(Object.fromEntries(
    Object.entries(SEEDREAM_DIMENSIONS).map(([aspect, size]) => [aspect, size.split('x')
      .map(value => Math.round(Number(value) * scale / 2) * 2).join('x')]),
  ))]),
));
// Seedream 5.5 upstream accepts 1K, 1.5K and 2K output; 3K/4K are rejected.
export const SEEDREAM_MODELS = Object.freeze({
  [SEEDREAM_MODEL_ID]:Object.freeze({ id:SEEDREAM_MODEL_ID, label:'Seedream 5.0', upstreamModelId:SEEDREAM_UPSTREAM_MODEL_ID, credits:SEEDREAM_CREDITS, qualities:SEEDREAM_QUALITIES }),
  [SEEDREAM_55_MODEL_ID]:Object.freeze({ id:SEEDREAM_55_MODEL_ID, label:'Seedream 5.5', upstreamModelId:'doubao-seedream-5-5-261028', credits:3, qualities:Object.freeze(['1k', '1.5k', '2k']) }),
});
export function seedreamModel(modelId) {
  return SEEDREAM_MODELS[modelId] || Object.values(SEEDREAM_MODELS).find(model => model.upstreamModelId === modelId) || null;
}
function seedreamQualities(modelId) {
  return (seedreamModel(modelId) || SEEDREAM_MODELS[SEEDREAM_MODEL_ID]).qualities;
}
export function seedreamQualityError(modelId = SEEDREAM_MODEL_ID) {
  const model = seedreamModel(modelId) || SEEDREAM_MODELS[SEEDREAM_MODEL_ID];
  const labels = model.qualities.map(quality => quality.toUpperCase());
  return labels.length === 1 ? `${model.label} 清晰度仅支持 ${labels[0]}` : `${model.label} 清晰度可选 ${labels.join('、')}`;
}
export function seedreamQualityForSize(size, modelId = SEEDREAM_MODEL_ID) {
  return seedreamQualities(modelId).find(quality => Object.values(SEEDREAM_DIMENSIONS_BY_QUALITY[quality]).includes(size)) || '';
}
export function seedreamSize(size = '1:1', quality, modelId = SEEDREAM_MODEL_ID) {
  const tier = String(quality || seedreamQualityForSize(size, modelId) || '2k').toLowerCase();
  if (!seedreamQualities(modelId).includes(tier)) return '';
  const dimensions = SEEDREAM_DIMENSIONS_BY_QUALITY[tier];
  return dimensions?.[size] || (dimensions && Object.values(dimensions).includes(size) ? size : '');
}
