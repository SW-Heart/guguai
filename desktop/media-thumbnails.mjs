import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Decode in separate processes with a small concurrency budget. Requests for
// the same file share work; cache keys include the source revision and size so
// replaced files stay fresh. Cached thumbnails are served without queueing and
// their mtime is refreshed on use, so eviction drops the least recently used.
// The budget is in bytes as well as entries: a 2048px canvas copy can be
// several megabytes, so a count alone would not bound disk use.
export function createThumbnailCache({ directory, render, maxEntries = 4096, maxBytes = 1024 * 1024 * 1024, concurrency = 2 }) {
  const pending = new Map();
  const failed = new Set();
  const waiting = [];
  let running = 0;
  let entryCount = null;
  let entryBytes = 0;
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
    // `.png` entries come from older versions and are pruned like current ones.
    const names = (await fs.readdir(directory).catch(() => [])).filter(name => /\.(?:thumb|png)$/.test(name));
    const entries = (await Promise.all(names.map(async name => {
      const info = await fs.stat(path.join(directory, name)).catch(() => null);
      return info && { name, file:path.join(directory, name), time:info.mtimeMs, size:info.size };
    }))).filter(Boolean).sort((a, b) => a.time - b.time);
    entryCount = entries.length;
    entryBytes = entries.reduce((sum, item) => sum + item.size, 0);
    for (const item of entries) {
      if (entryCount <= maxEntries && entryBytes <= maxBytes) break;
      if (item.name === keep) continue;
      await fs.rm(item.file, { force:true }).catch(() => {});
      entryCount--; entryBytes -= item.size;
    }
  })().finally(() => { pruning = null; });
  return async function thumbnail(source, stat, size = 512, kind = 'image') {
    const key = createHash('sha256').update(JSON.stringify([source, stat.size, stat.mtimeMs, size, kind])).digest('hex');
    const target = path.join(directory, `${key}.thumb`);
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
          const rendered = (await fs.stat(temporary).catch(() => null))?.size || 0;
          if (!rendered) throw new Error('缩略图为空');
          await fs.rename(temporary, target);
          entryBytes += rendered;
        } catch (error) {
          failed.add(key);
          throw error;
        } finally { await fs.rm(temporary, { force:true }).catch(() => {}); }
      } finally { releaseSlot(); }
      if (entryCount === null || ++entryCount > maxEntries || entryBytes > maxBytes) await prune(`${key}.thumb`);
      return target;
    })();
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  };
}
