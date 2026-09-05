import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function generationRequestFingerprint(request) {
  return createHash('sha256').update(JSON.stringify(canonicalize(request))).digest('hex');
}
