import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
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

const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCaptchaCode(length = 5) {
  return Array.from({ length }, () => CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)]).join('');
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]));
}

function captchaImage(code) {
  const width = 144;
  const height = 48;
  const noise = Array.from({ length: 8 }, () => {
    const x1 = randomInt(width);
    const y1 = randomInt(height);
    const x2 = randomInt(width);
    const y2 = randomInt(height);
    return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="#c7c7d1" stroke-width="1" opacity=".7"/>`;
  }).join('');
  const dots = Array.from({ length: 34 }, () => `<circle cx="${randomInt(width)}" cy="${randomInt(height)}" r="${randomInt(1, 3)}" fill="#b8b8c4" opacity=".55"/>`).join('');
  const letters = [...code].map((character, index) => {
    const x = 18 + index * 25;
    const y = 32 + randomInt(-3, 4);
    const rotate = randomInt(-16, 17);
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" fill="#272735" font-size="23" font-family="Arial,sans-serif" font-weight="700">${escapeXml(character)}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="7" fill="#f5f5f7"/>${noise}${dots}${letters}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** Creates short-lived, IP-bound CAPTCHA challenges for unauthenticated flows. */
export function createCaptchaStore({ ttlMs = 5 * 60_000, maxEntries = 10_000, maxAttempts = 5 } = {}) {
  const challenges = new Map();

  const sweep = timestamp => {
    if (challenges.size < maxEntries) return;
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= timestamp) challenges.delete(id);
    }
  };

  return {
    issue(ip, timestamp = Date.now()) {
      sweep(timestamp);
      if (challenges.size >= maxEntries) challenges.delete(challenges.keys().next().value);
      const id = randomToken();
      const code = randomCaptchaCode();
      const expiresAt = timestamp + ttlMs;
      challenges.set(id, { code, ip: String(ip || 'unknown'), expiresAt, attempts: 0 });
      return { challengeId: id, image: captchaImage(code), expiresAt: new Date(expiresAt).toISOString() };
    },
    verify(challengeId, answer, ip, timestamp = Date.now()) {
      const id = String(challengeId || '');
      const challenge = challenges.get(id);
      if (!challenge || challenge.expiresAt <= timestamp || challenge.ip !== String(ip || 'unknown')) {
        if (challenge?.expiresAt <= timestamp) challenges.delete(id);
        return { ok: false, reason: 'expired' };
      }
      const actual = Buffer.from(String(answer || '').trim().toUpperCase());
      const expected = Buffer.from(challenge.code);
      challenge.attempts += 1;
      const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (ok || challenge.attempts >= maxAttempts) challenges.delete(id);
      return { ok, reason: ok ? 'ok' : 'invalid' };
    },
  };
}

/** Normalizes mainland China mobile numbers accepted by the configured SMS product. */
export function normalizePhoneNumber(value) {
  let phone = String(value || '').trim().replace(/[\s-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  else if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  return /^1[3-9]\d{9}$/.test(phone) ? phone : '';
}

/** Prevents a single client/number pair from repeatedly requesting SMS messages. */
export function createSmsSendLimiter({ intervalMs = 60_000, maxEntries = 10_000 } = {}) {
  const sends = new Map();
  const keyFor = (req, phone) => `${clientIp(req)}\u0000${String(phone)}`;
  const sweep = timestamp => {
    if (sends.size < maxEntries) return;
    for (const [key, sentAt] of sends) if (timestamp - sentAt >= intervalMs) sends.delete(key);
  };
  return {
    remainingMs(req, phone, timestamp = Date.now()) {
      const sentAt = sends.get(keyFor(req, phone));
      if (sentAt === undefined) return 0;
      const remaining = intervalMs - (timestamp - sentAt);
      if (remaining <= 0) { sends.delete(keyFor(req, phone)); return 0; }
      return remaining;
    },
    record(req, phone, timestamp = Date.now()) {
      sweep(timestamp);
      if (!sends.has(keyFor(req, phone)) && sends.size >= maxEntries) sends.delete(sends.keys().next().value);
      sends.set(keyFor(req, phone), timestamp);
    },
  };
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
