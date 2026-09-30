import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentImageReader } from '../services/agent-image-analysis.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const asset = { id:'generated-image', kind:'image', storageName:'generated-image.png', sourceUrl:'https://provider.example/result', deliveryStatus:'local_ready', remoteStatus:'local_only' };

async function fixture(t, { bytes = png, fail, large = false, r2Configured = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-agent-image-test-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const recovered = [], directories = [];
  const inspect = createAgentImageReader({
    r2Configured,
    signedAssetUrl:async (key, ttl) => { assert.equal(ttl, 900); return `https://storage.example/${key}`; },
    ensureLocalAsset:async (userId, input, directory) => {
      recovered.push({ userId, asset:input, directory });
      if (fail) throw fail;
      const file = path.join(directory, input.storageName);
      await writeFile(file, bytes);
      if (large) await truncate(file, 21 * 1024 * 1024);
      return file;
    },
    withMediaTempDir:async (_label, callback) => {
      const directory = await mkdtemp(path.join(root, 'read-'));
      directories.push(directory);
      try { return await callback(directory); }
      finally { await rm(directory, { recursive:true, force:true }); }
    },
  });
  return { inspect, recovered, directories };
}

test('generated image delivered to desktop is readable without a cloud object', async t => {
  const f = await fixture(t);
  assert.equal(await f.inspect(asset, 'user-a'), `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(f.recovered[0].userId, 'user-a');
  assert.equal(f.recovered[0].asset, asset);
  await assert.rejects(access(f.directories[0]), { code:'ENOENT' });
});

test('cloud images retain signed URLs without downloading', async t => {
  const f = await fixture(t);
  assert.equal(await f.inspect({ ...asset, objectKey:'image-key' }, 'user-a'), 'https://storage.example/image-key');
  assert.equal(f.recovered.length, 0);
});

test('local image bytes remain readable when cloud storage is not configured', async t => {
  const f = await fixture(t, { r2Configured:false });
  assert.match(await f.inspect({ ...asset, sourceUrl:'', objectKey:'old-key' }, 'user-a'), /^data:image\/png;base64,/);
});

test('image input uses actual file type instead of provisional generation metadata', async t => {
  const f = await fixture(t, { bytes:Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  assert.match(await f.inspect({ ...asset, mimeType:'image/png' }, 'user-a'), /^data:image\/jpeg;base64,/);
});

test('unavailable originals explain recovery without claiming they were never uploaded', async t => {
  const cause = new Error('provider URL expired');
  const f = await fixture(t, { fail:cause });
  await assert.rejects(f.inspect(asset, 'user-a'), error => error.cause === cause && /重新添加图片/.test(error.message) && !/上传|云端/.test(error.message));
  await assert.rejects(access(f.directories[0]), { code:'ENOENT' });
});

test('error pages and oversized files are rejected before becoming model image inputs', async t => {
  for (const options of [{ bytes:Buffer.from('<html>error</html>') }, { large:true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.inspect(asset, 'user-a'), /格式无法读取|超过 20 MB/);
    await assert.rejects(access(f.directories[0]), { code:'ENOENT' });
  }
});
