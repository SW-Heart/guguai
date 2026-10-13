import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, createReadStream, openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createThumbnailCache } from '../desktop/media-thumbnails.mjs';

test('thumbnail requests share work, serialize decodes, invalidate revisions and bound disk cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-thumbs-'));
  let count = 0, active = 0, peak = 0;
  const get = createThumbnailCache({ directory, maxEntries:2, concurrency:1, render:async (_source, output) => {
    count++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    await fs.writeFile(output, 'preview');
    active--;
  } });
  try {
    const [a, same, b] = await Promise.all([get('a', {size:1,mtimeMs:1}), get('a', {size:1,mtimeMs:1}), get('b', {size:1,mtimeMs:1})]);
    assert.equal(a, same); assert.notEqual(a, b);
    assert.equal(count, 2); assert.equal(peak, 1);
    assert.equal(await get('a', {size:1,mtimeMs:1}), a); assert.equal(count, 2);
    assert.notEqual(await get('a', {size:2,mtimeMs:2}), a);
    assert.equal((await fs.readdir(directory)).length, 2);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('a failed thumbnail leaves no partial cache, is remembered, and does not block other files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-thumbs-'));
  let renders = 0;
  const get = createThumbnailCache({ directory, render:async (source, output) => {
    renders++;
    await fs.writeFile(output, 'partial');
    if (source === 'bad') throw new Error('decode failed');
  } });
  try {
    await assert.rejects(get('bad', {size:1,mtimeMs:1}), /decode failed/);
    assert.deepEqual(await fs.readdir(directory), []);
    await assert.rejects(get('bad', {size:1,mtimeMs:1}), error => error.cached === true);
    assert.equal(renders, 1);
    assert.equal(await fs.readFile(await get('good', {size:1,mtimeMs:1}), 'utf8'), 'partial');
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('cached thumbnails are served without waiting behind slow decodes, per requested size', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-thumbs-'));
  let unblock, started;
  const slowStarted = new Promise(resolve => { started = resolve; });
  const sizes = [];
  const get = createThumbnailCache({ directory, concurrency:1, render:async (source, output, size) => {
    sizes.push(size);
    if (source === 'slow') { started(); await new Promise(resolve => { unblock = resolve; }); }
    await fs.writeFile(output, `${source}-${size}`);
  } });
  try {
    const cached = await get('a', {size:1,mtimeMs:1});
    assert.notEqual(await get('a', {size:1,mtimeMs:1}, 2048), cached);
    const slow = get('slow', {size:1,mtimeMs:1});
    await slowStarted;
    assert.equal(await get('a', {size:1,mtimeMs:1}), cached);
    unblock();
    await slow;
    assert.deepEqual(sizes, [512, 2048, 512]);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

const main = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
test('local protocol serves thumbnail bytes and original ranges, with account checks after rendering', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-protocol-'));
  try {
    await fs.writeFile(path.join(directory, 'original.png'), 'original-content');
    await fs.writeFile(path.join(directory, 'thumb.png'), 'small');
    const context = vm.createContext({ workspace:directory, workspaceEpoch:1, workspaceAccountId:'a',
      Response, URL, fs, path, Readable, createReadStream,
      libraryAsset:() => ({ relativePath:'original.png', kind:'image' }), isInside:() => true,
      localMediaMimeType:() => 'image/png',
      createThumbnailCache:() => async () => path.join(directory, 'thumb.png'),
      app:{getPath:() => directory}, productName:'GuGu AI', process:{ platform:'linux', env:{} }, runFfmpeg:() => {},
    });
    vm.runInContext(main.slice(main.indexOf('function parseLocalMediaRange('), main.indexOf('// 每次列素材')), context);
    vm.runInContext(main.slice(main.indexOf('let localThumbnail = null;'), main.indexOf('async function openOfflinePage(')), context);
    const thumb = await context.serveLocalMedia(new Request('gugu-media://asset/a?thumbnail=1'));
    assert.equal(await thumb.text(), 'small');
    const original = await context.serveLocalMedia(new Request('gugu-media://asset/a', {headers:{range:'bytes=0-7'}}));
    assert.equal(original.status, 206); assert.equal(await original.text(), 'original');
    context.changeAccount = () => { context.workspaceEpoch++; return path.join(directory, 'thumb.png'); };
    vm.runInContext('localThumbnail = changeAccount', context);
    const stale = await context.serveLocalMedia(new Request('gugu-media://asset/a?thumbnail=1'));
    assert.equal(stale.status, 404);
    vm.runInContext('localThumbnail = async () => { throw new Error("decode failed"); }', context);
    context.console = { warn:() => {} };
    const fallback = await context.serveLocalMedia(new Request('gugu-media://asset/a?thumbnail=2048'));
    assert.equal(fallback.status, 200);
    assert.equal(await fallback.text(), 'original-content');
    context.libraryAsset = () => ({ relativePath:'original.png', kind:'video', mimeType:'video/mp4' });
    const video = await context.serveLocalMedia(new Request('gugu-media://asset/a?thumbnail=1'));
    assert.equal(video.status, 404, 'a missing video frame must not return video bytes to an image');
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('desktop upload passes a file-backed Blob without reading the full source into a Buffer', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-upload-'));
  try {
    await fs.writeFile(path.join(directory, 'a.mp4'), 'video-data');
    let body;
    const context = vm.createContext({ workspace:directory, workspaceEpoch:1, path, openAsBlob,
      fs:{ stat:fs.stat, readFile:() => { throw new Error('full-file buffering is forbidden'); } },
      libraryAsset:() => ({id:'a',name:'a.mp4',relativePath:'a.mp4',size:10,mimeType:'video/mp4'}),
      isInside:() => true, assertActiveWorkspace:() => {},
      cloudRequest:async () => ({ok:true,json:async () => ({method:'PUT',uploadUrl:'https://storage.invalid/a',uploadId:'a'})}),
      fetchWithTimeout:async (_fetch, _url, options) => { body=options.body; return {ok:true}; },
      completeCloudUpload:async () => ({id:'cloud-a'}), upsertLocalAsset:() => {}, localMediaUrl:() => 'gugu-media://asset/a',
    });
    vm.runInContext(main.slice(main.indexOf('async function syncLocalAsset('), main.indexOf('async function downloadRemoteAssetInternal(')), context);
    await context.syncLocalAsset({assetId:'a'});
    assert.equal(await body.text(), 'video-data');
    assert.equal(body.type, 'video/mp4');
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('canvas pictures use a 2048px display copy while records and crop keep the original', async () => {
  const { imageThumbnailUrl, canvasImageUrl } = await import('../public/features/media/thumbnail-url.js');
  assert.equal(imageThumbnailUrl('gugu-media://asset/a'), 'gugu-media://asset/a?thumbnail=1');
  assert.equal(canvasImageUrl('gugu-media://asset/a'), 'gugu-media://asset/a?thumbnail=2048');
  assert.equal(canvasImageUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
  const bundle = await fs.readFile(new URL('../public/vendor/director/reference-canvas.js', import.meta.url), 'utf8');
  assert.match(bundle, /guguDisplayUrl=globalThis\.guguCanvasImageUrl\?\.\(t\)\?\?t/);
  assert.match(bundle, /if\(_\.dataset\?\.guguThumbnail\)\{let guguOriginal=new Image/);
  const panel = await fs.readFile(new URL('../scripts/director/reference-canvas/control/FloatingMenuContainer.tsx', import.meta.url), 'utf8');
  assert.match(panel, /image\.dataset\?\.guguThumbnail/);
  const { patchWhiteboardImageSource } = await import('../scripts/director/whiteboard-resize.mjs');
  const loader = 'let e = new Image();\n e.crossOrigin = "anonymous", e.src = t, e.onload = () => {\n this.getElement().image(e) }';
  const cover = 'let e = new Image();\n e.crossOrigin = "anonymous", e.src = t, e.onload = () => {\n this.cover.image(e) }';
  const patched = patchWhiteboardImageSource(loader + cover);
  assert.match(patched, /guguDisplayUrl/);
  assert.equal(patched.match(/guguDisplayUrl =/g).length, 1);
});

test('a crashed page reloads automatically and stops on the retry page after repeated crashes', () => {
  const start = main.indexOf('const rendererCrashTimes = [];');
  const source = main.slice(start, main.indexOf('async function createWindow('));
  const reloads = [], offline = [], timers = [];
  const window = { isDestroyed:() => false, webContents:{ isDestroyed:() => false, reload:() => reloads.push(1) } };
  const context = vm.createContext({ isQuitting:false, mainWindow:window, Date, console:{ warn:() => {} },
    setTimeout:fn => timers.push(fn), runDesktopAction:(_label, fn) => fn(),
    openOfflinePage:(message, options) => offline.push([message, options]) });
  vm.runInContext(source, context);
  context.recoverRendererCrash({ reason:'clean-exit' });
  assert.equal(timers.length, 0);
  for (let i = 0; i < 4; i++) { context.recoverRendererCrash({ reason:'oom' }); timers.shift()(); }
  assert.equal(reloads.length, 3);
  assert.equal(offline.length, 1);
  assert.equal(JSON.stringify(offline[0][1]), JSON.stringify({ autoRetry:false }));
});

test('video frames skip the opening half second and retry from the start for short clips', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-frame-'));
  try {
    const calls = [];
    const context = vm.createContext({ fs, runFfmpeg:async args => {
      calls.push(args);
      const seek = args.includes('-ss');
      if (!seek) await fs.writeFile(args.at(-1), 'frame');
    } });
    const source = main.slice(main.indexOf('async function renderLocalThumbnail('), main.indexOf('async function serveLocalMedia('));
    vm.runInContext(source, context);
    const output = path.join(directory, 'out.tmp');
    await context.renderLocalThumbnail('clip.mp4', output, 512, 'video');
    assert.equal(calls.length, 2);
    assert.equal(calls[0][calls[0].indexOf('-ss') + 1], '0.5');
    assert.equal(calls[1].includes('-ss'), false);
    assert.equal(await fs.readFile(output, 'utf8'), 'frame');
    calls.length = 0;
    await context.renderLocalThumbnail('photo.png', output, 512, 'image');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('-ss'), false);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('covers live in an app cache folder outside the workspace and are never added to the library', () => {
  const block = main.slice(main.indexOf('let localThumbnail = null;'), main.indexOf('async function openOfflinePage('));
  assert.match(block, /directory:path\.join\(process\.platform === 'win32' && process\.env\.LOCALAPPDATA \? process\.env\.LOCALAPPDATA : app\.getPath\('cache'\), productName, 'media-thumbnails'\)/);
  assert.doesNotMatch(block, /upsertLocalAsset|claimLocalAsset|targetWorkspace, 'media-thumbnails'|workspace, 'media-thumbnails'/);
});

test('the cache is bounded by total bytes, dropping the least recently used first', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-thumbs-'));
  const get = createThumbnailCache({ directory, maxBytes:25, render:async (_source, output) => fs.writeFile(output, '0123456789') });
  try {
    const a = await get('a', {size:1,mtimeMs:1});
    await new Promise(resolve => setTimeout(resolve, 15));
    const b = await get('b', {size:1,mtimeMs:1});
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(await get('a', {size:1,mtimeMs:1}), a, 'touching a keeps it recent');
    await new Promise(resolve => setTimeout(resolve, 15));
    const c = await get('c', {size:1,mtimeMs:1});
    const left = await fs.readdir(directory);
    assert.equal(left.length, 2);
    assert.ok(left.includes(path.basename(a)) && left.includes(path.basename(c)));
    assert.ok(!left.includes(path.basename(b)), 'the least recently used entry is removed');
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});
