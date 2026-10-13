// This cache is supplemental to live canvas shapes. Eviction drops only our
// reference: a shape that is still displaying the image remains valid.
export class ImageCache extends Map {
  constructor({ maxPixels = 32 * 1024 * 1024, maxEntries = 32 } = {}) {
    super();
    this.maxPixels = maxPixels;
    this.maxEntries = maxEntries;
  }
  set(key, image) {
    this.delete(key);
    super.set(key, image);
    let pixels = [...this.values()].reduce((sum, item) => sum + (item.naturalWidth || 0) * (item.naturalHeight || 0), 0);
    for (const [url, item] of this) {
      if (this.size === 1) break;
      if (this.size <= this.maxEntries && pixels <= this.maxPixels) break;
      this.delete(url);
      pixels -= (item.naturalWidth || 0) * (item.naturalHeight || 0);
    }
    return this;
  }
}

export async function mapImagesWithLimit(items, worker, limit = 2) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length:Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}
