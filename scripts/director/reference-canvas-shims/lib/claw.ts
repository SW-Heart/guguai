export function normalizeClawMediaUrl(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
