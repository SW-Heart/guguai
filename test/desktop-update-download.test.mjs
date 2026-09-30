import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { downloadUpdateToFile } from '../desktop/update-download.mjs';

const bytes = Buffer.from('installer bytes');
const file = { downloadUrl:'https://updates.test/client.dmg', size:bytes.length, sha512:createHash('sha512').update(bytes).digest('base64') };

test('updates are saved only after size and digest checks; bad responses are cleaned up', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'update-download-'));
  const target = path.join(dir, 'update.part');
  try {
    const progress = [];
    await downloadUpdateToFile(async () => new Response(bytes), file, target, { onProgress:value => progress.push(value) });
    assert.deepEqual(await readFile(target), bytes);
    assert.equal(progress.at(-1).percent, 100);
    for (const payload of [bytes.subarray(0, 5), Buffer.alloc(bytes.length), Buffer.concat([bytes, bytes])]) {
      await assert.rejects(downloadUpdateToFile(async () => new Response(payload), file, target), /完整性校验失败|大小与清单不一致/);
      await assert.rejects(access(target));
    }
    let cancelled = false;
    await assert.rejects(downloadUpdateToFile(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status:503 }), file, target), /503/);
    assert.equal(cancelled, true);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('stalled update connections and bodies release the download and remove partial files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'update-stall-'));
  const target = path.join(dir, 'update.part');
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(downloadUpdateToFile((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once:true });
    }), file, target, { timeoutMs:20 }), /停滞/);
    let cancelled = false;
    await assert.rejects(downloadUpdateToFile(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 3)); },
      cancel() { cancelled = true; },
    })), file, target, { timeoutMs:20 }), /停滞/);
    assert.equal(cancelled, true);
    await assert.rejects(access(target));
    await downloadUpdateToFile(async () => new Response(bytes), file, target);
    assert.deepEqual(await readFile(target), bytes);
  } finally { clearInterval(keepAlive); await rm(dir, { recursive:true, force:true }); }
});

test('progress callback failures reject the transfer instead of escaping a stream event', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'update-callback-'));
  const target = path.join(dir, 'update.part');
  try {
    await assert.rejects(downloadUpdateToFile(async () => new Response(bytes), file, target, { onProgress:() => { throw new Error('window gone'); } }), /window gone/);
    await assert.rejects(access(target));
  } finally { await rm(dir, { recursive:true, force:true }); }
});
