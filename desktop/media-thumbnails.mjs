import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Decode in separate processes with a small concurrency budget. Requests for
// the same file share work; cache keys include the source revision and size so
// replaced files stay fresh. Cached thumbnails are served without queueing and
// their mtime is refreshed on use, so eviction drops the least recently used.
export function createThumbnailCache({ directory, render, maxEntries = 2048, concurrency = 2 }) {
  const pending = new Map();
  const failed = new Set();
  const waiting = [];
  let running = 0;
  let entryCount = null;
  let pruning = null;
  const acquire = () => running < concurrency ? (running++, Promise.resolve()) : new Promise(resolve => waiting.push(resolve));
  const releaseSlot = () => { const next = waiting.shift(); if (next) next(); else running--; };
  const cached = async target => {
    const info = await fs.stat(target).catch(() => null);
    if (!info?.size) return false;
    const now = new Date();
    await fs.utimes(target, now, now).catch(() => {});
    return true;
  };
  // Count entries in memory and scan the directory only when over budget.
  const prune = keep => pruning ||= (async () => {
    const entries = (await fs.readdir(directory).catch(() => [])).filter(name => name.endsWith('.png'));
    entryCount = entries.length;
    if (entries.length <= maxEntries) return;
    const old = (await Promise.all(entries.filter(name => name !== keep).map(async name => {
      const file = path.join(directory, name);
      const info = await fs.stat(file).catch(() => null);
      return { file, time:info?.mtimeMs || 0 };
    }))).sort((a, b) => a.time - b.time);
    const removed = old.slice(0, entries.length - maxEntries);
    await Promise.all(removed.map(item => fs.rm(item.file, { force:true }).catch(() => {})));
    entryCount -= removed.length;
  })().finally(() => { pruning = null; });
  return async function thumbnail(source, stat, size = 512, kind = 'image') {
    const key = createHash('sha256').update(JSON.stringify([source, stat.size, stat.mtimeMs, size, kind])).digest('hex');
    const target = path.join(directory, `${key}.png`);
    if (failed.has(key)) throw Object.assign(new Error('缩略图生成失败'), { cached:true });
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      if (await cached(target)) return target;
      await acquire();
      try {
        if (await cached(target)) return target;
        await fs.mkdir(directory, { recursive:true });
        const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
        try {
          await render(source, temporary, size, kind);
          if (!(await fs.stat(temporary).catch(() => null))?.size) throw new Error('缩略图为空');
          await fs.rename(temporary, target);
        } catch (error) {
          failed.add(key);
          throw error;
        } finally { await fs.rm(temporary, { force:true }).catch(() => {}); }
      } finally { releaseSlot(); }
      if (entryCount === null || ++entryCount > maxEntries) await prune(`${key}.png`);
      return target;
    })();
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  };
}
