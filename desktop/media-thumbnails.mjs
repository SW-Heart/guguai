import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Serialize decodes in a separate process. Requests for the same file share
// work; cache keys include the source revision so replaced files stay fresh.
export function createThumbnailCache({ directory, render, maxEntries = 256 }) {
  const pending = new Map();
  let queue = Promise.resolve();
  return async function thumbnail(source, stat) {
    const key = createHash('sha256').update(JSON.stringify([source, stat.size, stat.mtimeMs])).digest('hex');
    const target = path.join(directory, `${key}.png`);
    if (pending.has(key)) return pending.get(key);
    const request = queue.then(async () => {
      if (await fs.stat(target).then(info => info.size > 0).catch(() => false)) return target;
      await fs.mkdir(directory, { recursive:true });
      const temporary = path.join(directory, `${key}-${randomUUID()}.png`);
      try {
        await render(source, temporary);
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force:true }).catch(() => {}); }
      const entries = await fs.readdir(directory);
      if (entries.length > maxEntries) {
        const old = (await Promise.all(entries.filter(name => name.endsWith('.png') && name !== `${key}.png`).map(async name => {
          const file = path.join(directory, name);
          const info = await fs.stat(file).catch(() => null);
          return { file, time:info?.mtimeMs || 0 };
        }))).sort((a, b) => a.time - b.time);
        await Promise.all(old.slice(0, entries.length - maxEntries).map(item => fs.rm(item.file, { force:true }).catch(() => {})));
      }
      return target;
    });
    pending.set(key, request);
    queue = request.catch(() => {});
    try { return await request; }
    finally { pending.delete(key); }
  };
}
