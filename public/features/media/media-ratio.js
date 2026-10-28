// Card heights in media lists must not depend on whether a cover or decoder
// is currently attached: previews are released offscreen, and a list whose
// cards change size while scrolling reflows under the pointer. Every list
// sizes media from the best ratio known so far and remembers measured ratios
// across re-rendered card nodes.
const measured = new Map();

// Accepts "16:9", "1024x1536", "1024*1536" or a positive number.
export function parseMediaRatio(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:x×*]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return 0;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

export function rememberMediaRatio(key, width, height) {
  if (!key || !(width > 0) || !(height > 0)) return false;
  const ratio = width / height;
  const previous = measured.get(key);
  if (previous && Math.abs(previous - ratio) < 1e-3) return false;
  measured.set(key, ratio);
  return true;
}

export function knownMediaRatio(key) {
  return key ? measured.get(key) || 0 : 0;
}

// The first usable source wins: a measured ratio, then stored dimensions,
// then the requested aspect or size of the generation.
export function mediaRatio(key, ...candidates) {
  const known = knownMediaRatio(key);
  if (known) return known;
  for (const candidate of candidates) {
    const ratio = Array.isArray(candidate) ? (candidate[0] > 0 && candidate[1] > 0 ? candidate[0] / candidate[1] : 0) : parseMediaRatio(candidate);
    if (ratio) return ratio;
  }
  return 0;
}
