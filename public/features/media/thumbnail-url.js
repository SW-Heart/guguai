// Keep full-size source URLs in records and use a derived URL only in cards.
// Older desktops ignore the query and continue returning the original image.
export function imageThumbnailUrl(value) {
  const source = String(value || '');
  if (!source.startsWith('gugu-media://')) return source;
  const url = new URL(source);
  url.searchParams.set('thumbnail', '1');
  return url.href;
}
