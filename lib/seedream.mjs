export const SEEDREAM_MODEL_ID = 'seedream-5.0';
export const SEEDREAM_UPSTREAM_MODEL_ID = 'doubao-seedream-5-0-260128';
export const SEEDREAM_CREDITS = 2;
export const SEEDREAM_DIMENSIONS = Object.freeze({
  '1:1':'2048x2048', '16:9':'2560x1440', '9:16':'1440x2560',
  '4:3':'2304x1728', '3:4':'1728x2304', '3:2':'2496x1664', '2:3':'1664x2496',
  '2:1':'2848x1424', '1:2':'1424x2848', '5:4':'2288x1824', '4:5':'1824x2288',
});
export const SEEDREAM_QUALITIES = Object.freeze(['2k', '3k', '4k']);
export const SEEDREAM_DIMENSIONS_BY_QUALITY = Object.freeze(Object.fromEntries(
  SEEDREAM_QUALITIES.map((quality, index) => [quality, Object.freeze(Object.fromEntries(
    Object.entries(SEEDREAM_DIMENSIONS).map(([aspect, size]) => [aspect, size.split('x')
      .map(value => Math.round(Number(value) * (index + 2) / 4) * 2).join('x')]),
  ))]),
));
export function seedreamQualityForSize(size) {
  return SEEDREAM_QUALITIES.find(quality => Object.values(SEEDREAM_DIMENSIONS_BY_QUALITY[quality]).includes(size)) || '';
}
export function seedreamSize(size = '1:1', quality) {
  const tier = String(quality || seedreamQualityForSize(size) || '2k').toLowerCase();
  const dimensions = SEEDREAM_DIMENSIONS_BY_QUALITY[tier];
  return dimensions?.[size] || (dimensions && Object.values(dimensions).includes(size) ? size : '');
}
