export function defaultTitleFromMessage(message) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 10).join('');
}
