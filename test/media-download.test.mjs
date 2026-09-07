import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteMedia } from '../desktop/media-download.mjs';

test('desktop media downloads authenticate only same-origin hops and follow signed-storage redirects', async () => {
  const expectedResponse = { ok: true, status: 200 };
  const sessionCalls = [];
  const sameOriginCalls = [];
  const sameOriginFetch = (url, options) => {
    sameOriginCalls.push({ url, options });
    return Promise.resolve({
      status: 302,
      headers: { get: name => name.toLowerCase() === 'location' ? 'https://storage.example.com/signed.mp4' : null },
    });
  };
  const electronSession = {
    fetch(url, options) {
      sessionCalls.push({ url, options });
      return Promise.resolve(expectedResponse);
    },
  };

  const response = await fetchRemoteMedia(
    electronSession,
    'https://studio.example.com/api/files/asset-1/direct',
    {
      sameOriginHeaders: {
        Cookie:'studio_session=secret',
        'X-GuGu-Device-Id':'device-a-123456',
        'X-GuGu-Workspace-Id':'workspace-a-123456',
      },
      sameOriginFetch,
    },
  );

  assert.equal(response, expectedResponse);
  assert.deepEqual(sameOriginCalls, [
    {
      url: 'https://studio.example.com/api/files/asset-1/direct',
      options: {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        headers: {
          'X-GuGu-Desktop':'1',
          Cookie:'studio_session=secret',
          'X-GuGu-Device-Id':'device-a-123456',
          'X-GuGu-Workspace-Id':'workspace-a-123456',
        },
      },
    },
  ]);
  assert.deepEqual(sessionCalls, [
    {
      url: 'https://storage.example.com/signed.mp4',
      options: {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        headers: {},
      },
    },
  ]);
});

import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { downloadMediaToFile } from '../desktop/media-download.mjs';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom00000000')]);

test('desktop saves and hashes media but removes empty and error-page transfers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-transfer-'));
  const target = path.join(dir, 'video.part');
  try {
    const saved = await downloadMediaToFile({}, 'https://media.test/a', target, { kind:'video', fetchMedia:async () => new Response(mp4, { headers:{ 'content-type':'video/mp4' } }) });
    assert.deepEqual(await readFile(target), mp4);
    assert.equal(saved.sha256, createHash('sha256').update(mp4).digest('hex'));
    for (const [payload, type] of [['', 'video/mp4'], ['<html>error</html>', 'text/html'], ['{"error":"expired"}', 'video/mp4'], ['not video', 'video/mp4']]) {
      await assert.rejects(downloadMediaToFile({}, 'https://media.test/a', target, { kind:'video', fetchMedia:async () => new Response(payload, { headers:{ 'content-type':type } }) }));
      await assert.rejects(access(target));
    }
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('stalled media is aborted and its partial file is removed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-stall-'));
  const target = path.join(dir, 'video.part');
  const keepAlive = setInterval(() => {}, 1000);
  let cancelled = false;
  try {
    await assert.rejects(downloadMediaToFile({}, 'https://media.test/a', target, {
      kind:'video', timeoutMs:30,
      fetchMedia:async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(mp4); }, cancel() { cancelled = true; } })),
    }), /停滞/);
    assert.equal(cancelled, true);
    await assert.rejects(access(target));
  } finally { clearInterval(keepAlive); await rm(dir, { recursive:true, force:true }); }
});

test('continuous progress can outlive the idle deadline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-progress-'));
  let timer;
  try {
    const saved = await downloadMediaToFile({}, 'https://media.test/a', path.join(dir, 'video.part'), {
      kind:'video', timeoutMs:100,
      fetchMedia:async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(mp4);
        let chunks = 0;
        timer = setInterval(() => { controller.enqueue(Buffer.alloc(1)); if (++chunks === 8) { clearInterval(timer); controller.close(); } }, 25);
      }, cancel() { clearInterval(timer); } })),
    });
    assert.equal(saved.size, mp4.length + 8);
  } finally { clearInterval(timer); await rm(dir, { recursive:true, force:true }); }
});

test('CDN generic types are inferred from the video container and truncated bodies fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-type-'));
  const target = path.join(dir, 'video.part');
  try {
    const saved = await downloadMediaToFile({}, 'https://media.test/a', target, { kind:'video', fetchMedia:async () => new Response(mp4, { headers:{ 'content-type':'application/binary' } }) });
    assert.equal(saved.mimeType, 'video/mp4');
    await assert.rejects(downloadMediaToFile({}, 'https://media.test/a', target, { kind:'video', fetchMedia:async () => new Response(mp4, { headers:{ 'content-length':'999' } }) }), /不完整/);
    await assert.rejects(access(target));
  } finally { await rm(dir, { recursive:true, force:true }); }
});
