const storagePrefix = 'gugu:model-price-seen:';

export function priceCatalogSignature(items) {
  if (!Array.isArray(items)) return null;
  const prices = items
    .filter(item => item?.available === true && item.enabled !== false && item.availability !== 'coming-soon' && Number.isFinite(Number(item.credits)) && Number.isFinite(Number(item.yuan)))
    .map(item => [String(item.modelId), String(item.quality), String(item.unit), Number(item.credits), Number(item.yuan)]);
  prices.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(prices);
}

export function createModelPriceNotice({ storage, accountKey, onChange }) {
  const fallback = new Map();
  const key = () => `${storagePrefix}${encodeURIComponent(String(accountKey()))}`;
  const read = name => {
    try { return storage.getItem(name) ?? fallback.get(name) ?? null; }
    catch { return fallback.get(name) ?? null; }
  };
  const write = (name, signature) => {
    fallback.set(name, signature);
    try { storage.setItem(name, signature); }
    catch {}
  };
  function update(items, { viewing = false } = {}) {
    const signature = priceCatalogSignature(items);
    if (signature === null) return;
    const name = key();
    const seen = read(name);
    if (seen === null || viewing) write(name, signature);
    onChange(!viewing && seen !== null && seen !== signature);
  }
  return { update, markViewed: items => update(items, { viewing:true }) };
}
