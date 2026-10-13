// Keep full-size source URLs in records and use a derived URL only for display.
// Older desktops ignore the query and continue returning the original image.
export function imageThumbnailUrl(value, size = 512) {
  const source = String(value || '');
  if (!source.startsWith('gugu-media://')) return source;
  const url = new URL(source);
  url.searchParams.set('thumbnail', size === 512 ? '1' : String(size));
  return url.href;
}

// Canvas pictures can be zoomed, so they use a larger edge than cards while
// still keeping 4K uploads from decoding at full size.
export const canvasImageUrl = value => imageThumbnailUrl(value, 2048);
