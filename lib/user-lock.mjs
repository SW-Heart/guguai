import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_QUEUE_DEPTH = 100;

/** userId -> { tail: Promise, depth: number } */
const locks = new Map();

/**
 * Per-async-context set of user locks held by the *current* call stack.
 * A module-level Set cannot tell genuine re-entry (same operation asking for
 * the same lock twice, a guaranteed deadlock) apart from a second concurrent
 * request for the same user (which must simply queue).
 */
const heldStore = new AsyncLocalStorage();

export class UserLockBusyError extends Error {
  constructor(userId) {
    super('该账号并发请求过多，请稍后再试');
    this.name = 'UserLockBusyError';
    this.statusCode = 503;
    this.userId = userId;
  }
}

export class UserLockReentryError extends Error {
  constructor(userId) {
    super(`检测到同一用户锁的重复获取，会造成死锁：${userId}`);
    this.name = 'UserLockReentryError';
    this.statusCode = 500;
    this.userId = userId;
  }
}

/**
 * Serialises write operations per user. Operations for different users run in
 * parallel. The queue tail is chained so late arrivals wait for everything
 * ahead of them, and the map entry is retired once a user goes idle so the
 * lock table cannot grow without bound.
 */
export function withUserLock(userId, operation) {
  const key = String(userId ?? '');
  if (!key) return Promise.reject(new Error('withUserLock 需要用户标识'));

  const inherited = heldStore.getStore();
  if (inherited?.has(key)) return Promise.reject(new UserLockReentryError(key));

  const entry = locks.get(key) ?? { tail: Promise.resolve(), depth: 0 };
  if (entry.depth >= MAX_QUEUE_DEPTH) return Promise.reject(new UserLockBusyError(key));

  let release;
  const current = new Promise(resolve => { release = resolve; });
  const waitTurn = entry.tail.then(() => {}, () => {});

  entry.depth++;
  entry.tail = current;
  locks.set(key, entry);

  const nextHeld = new Set(inherited ?? []);
  nextHeld.add(key);

  return waitTurn.then(() => heldStore.run(nextHeld, async () => {
    try {
      return await operation();
    } finally {
      entry.depth--;
      release();
      // Only retire the entry when nothing queued behind us while we ran.
      if (entry.depth === 0 && locks.get(key) === entry && entry.tail === current) {
        locks.delete(key);
      }
    }
  }));
}

/** Diagnostics only. */
export function lockStats() {
  return {
    users: locks.size,
    depths: Object.fromEntries([...locks].map(([id, entry]) => [id, entry.depth])),
  };
}
