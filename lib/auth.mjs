import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(await scrypt(String(password), salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Returns the direct peer unless TRUST_PROXY=loopback and that peer is the
 * local reverse proxy. X-Real-IP is trusted only in that configuration, so a
 * public client cannot spoof its address by sending forwarding headers.
 */
export function clientIp(req, env = process.env) {
  const remote = String(req?.socket?.remoteAddress || 'unknown').trim();
  if (env.TRUST_PROXY !== 'loopback' || !LOOPBACK_ADDRESSES.has(remote)) return remote;
  const forwarded = String(req?.headers?.['x-real-ip'] || '').trim();
  return isIP(forwarded) ? forwarded : remote;
}

export function createLoginAttemptLimiter({ maxAttempts = 8, windowMs = 15 * 60_000, maxEntries = 10_000 } = {}) {
  const attempts = new Map();

  const sweep = timestamp => {
    if (attempts.size < maxEntries) return;
    for (const [key, entry] of attempts) {
      if (timestamp - entry.startedAt >= windowMs) attempts.delete(key);
    }
  };

  const keyFor = (req, username) => `${clientIp(req)}\u0000${String(username || '').trim().toLowerCase()}`;

  return {
    isBlocked(req, username, timestamp = Date.now()) {
      const key = keyFor(req, username);
      const entry = attempts.get(key);
      if (!entry) return false;
      if (timestamp - entry.startedAt >= windowMs) {
        attempts.delete(key);
        return false;
      }
      return entry.count >= maxAttempts;
    },
    recordFailure(req, username, timestamp = Date.now()) {
      sweep(timestamp);
      const key = keyFor(req, username);
      if (!attempts.has(key) && attempts.size >= maxEntries) {
        const oldestKey = attempts.keys().next().value;
        if (oldestKey !== undefined) attempts.delete(oldestKey);
      }
      const previous = attempts.get(key);
      const entry = !previous || timestamp - previous.startedAt >= windowMs
        ? { count: 0, startedAt: timestamp }
        : previous;
      entry.count += 1;
      attempts.set(key, entry);
      return entry.count;
    },
    reset(req, username) {
      attempts.delete(keyFor(req, username));
    },
  };
}
