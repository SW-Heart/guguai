// Use one scale for both axes. Independent minimums distort panoramic images.
export function importedImageBounds(size, saved = {}) {
  if (!(size?.width > 0) || !(size?.height > 0)) return {width:280,height:220};
  const scale = Math.min(280 / size.width, 220 / size.height, 1);
  const width = Number.isFinite(saved.width) && saved.width > 0 ? saved.width : size.width * scale;
  return {width, height:width * size.height / size.width};
}
