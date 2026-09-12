import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { openLocalLibrary, closeLocalLibrary, upsertLocalAsset, getLocalAsset } from '../desktop/local-library.mjs';
import { mergeDesktopAssetRecord, shouldRemoveUploadJobLocalAsset } from '../public/desktop-media-sync.js';

const main = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const frontend = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const extract = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));

test('batch import skips an unreadable image and still selects the next decodable image', async () => {
  const jobs = [];
  const messages = [];
  const items = ['broken', 'valid'].map(id => ({ id, name:`${id}中文.webp`, mimeType:'image/webp', size:100 }));
  const context = vm.createContext({
    window:{ guguDesktop:{ media:{ chooseAndImport:async () => items, url:async id => `gugu-media://asset/${id}` } } },
    Image:class { async decode() { if (this.src.endsWith('/broken')) throw new Error('decode failed'); } },
    state:{ referenceTarget:'video' },
    desktopScope:{ localAsset:item => item }, mediaController:{ mergeLocalAssets:() => {} }, loadFiles:async () => {},
    referenceFileKinds:() => new Set(['image']), referenceLimits:() => ({ image:9 }),
    referenceDialogLimitIds:() => [], desktopMediaKind:() => 'image', videoReferenceCounts:() => ({ image:0 }),
    createUploadJob:(_file, _context, options) => { const job = { ...options }; jobs.push(job); return job; },
    autoSelectUploadedReference:() => true, pendingReferenceFile:job => job,
    projectPendingReferenceToCreation:() => {}, renderReferenceDialog:() => {},
    resetReferenceDialogScroll:() => {}, renderReferences:() => {},
    toast:message => messages.push(message), console:{ warn:() => {} },
  });
  vm.runInContext(extract(frontend, 'async function verifyImportedImagePreview(', 'function openUploadPicker('), context);
  const results = await context.desktopImportToContext('reference');
  assert.equal(jobs.length, 1);
  assert.equal(results[0].localAssetId, 'valid');
  assert.ok(messages.some(message => message.includes('本地图片无法读取或解码')));
});

test('changed frontend entries use matching refreshed cache keys', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const controller = await fs.readFile(new URL('../public/features/media/controller.js', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=321'));
  assert.ok(frontend.includes('./features/media/controller.js?v=7'));
  for (const source of [frontend, controller]) assert.ok(source.includes('desktop-media-sync.js?v=13'));
});

test('reimport restores missing bytes at the indexed path and preserves identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-reimport-'));
  try {
    const source = path.join(root, '原图.jpg');
    await fs.writeFile(source, 'image');
    const existing = { id:'local-a', cloudAssetId:'cloud-a', relativePath:'library/旧图.jpg', size:5, localStatus:'missing' };
    let stored;
    const context = vm.createContext({ fs, path, randomUUID, workspace:root, workspaceEpoch:1,
      hashFile:async () => ({ sha256:'hash', size:5 }), assertActiveWorkspace:() => {},
      findLocalAssetByDigest:() => existing, localAssetPath:asset => path.join(root, asset.relativePath),
      upsertLocalAsset:asset => { stored = asset; }, console:{ info:() => {} } });
    vm.runInContext(extract(main, 'async function importFile(', 'async function chooseAndImportFiles('), context);
    const result = await context.importFile(source);
    assert.equal(await fs.readFile(path.join(root, existing.relativePath), 'utf8'), 'image');
    assert.equal(result.id, existing.id);
    assert.equal(result.cloudAssetId, existing.cloudAssetId);
    assert.equal(result.reused, true);
    assert.equal(stored.localStatus, 'saved');
    const merged = mergeDesktopAssetRecord(existing, { ...stored, url:'gugu-media://asset/local-a' });
    assert.equal(merged.localStatus, 'saved');
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});

test('missing reference fails before requesting an upload intent', async () => {
  let requests = 0;
  const context = vm.createContext({ workspace:'/workspace', workspaceEpoch:1, path,
    libraryAsset:() => ({ id:'a', name:'图片.jpg', relativePath:'library/a.jpg' }), isInside:() => true,
    fs:{ readFile:async () => { throw Object.assign(new Error('missing'), { code:'ENOENT' }); } },
    cloudRequest:async () => { requests++; }, console:{ warn:() => {} } });
  vm.runInContext(extract(main, 'async function syncLocalAsset(', 'async function downloadRemoteAssetInternal('), context);
  await assert.rejects(context.syncLocalAsset({ assetId:'a' }), /请从原图重新导入/);
  assert.equal(requests, 0);
});

test('dialog cleanup and direct removal retain references used by a submission', () => {
  const active = { id:'active', context:'reference', deferUpload:true, localAssetId:'local-a', removeLocalOnDiscard:true, inUse:1 };
  const unused = { ...active, id:'unused', localAssetId:'local-b', inUse:0 };
  const removed = [];
  const state = { refs:{ image:[], video:[] }, videoFrames:{}, uploadJobs:[active, unused] };
  const context = vm.createContext({ state, shouldRemoveUploadJobLocalAsset,
    window:{ guguDesktop:{ media:{ removeLocal:async id => { removed.push(id); } } } },
    loadFiles:() => {}, notifyUploadSurfaceChanged:() => {} });
  vm.runInContext(extract(frontend, 'function removeUploadJob(', 'function autoSelectUploadedReference('), context);
  vm.runInContext(extract(frontend, 'function cleanupUncommittedReferenceJobs(', 'function restoreReferenceDialogOriginal('), context);
  context.cleanupUncommittedReferenceJobs();
  context.removeUploadJob('active');
  assert.deepEqual(state.uploadJobs.map(job => job.id), ['active']);
  assert.deepEqual(removed, []);
});

test('removing a reference then cancelling the remaining batch preserves files and records across reopen', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-reference-retain-'));
  try {
    await fs.mkdir(path.join(root, 'library'));
    openLocalLibrary(root);
    const files = Array.from({ length:6 }, (_, index) => ({ id:`local-${index}`, name:`中文图${index}.webp`, relativePath:`library/中文图${index}.webp`, kind:'image', size:5, localStatus:'saved', url:`gugu-media://asset/local-${index}` }));
    for (const file of files) { await fs.writeFile(path.join(root, file.relativePath), 'image'); upsertLocalAsset(file); }
    const jobs = files.map(file => ({ id:`job-${file.id}`, localAssetId:file.id, context:'reference', deferUpload:true, removeLocalOnDiscard:true }));
    const state = { files, uploadJobs:jobs, refs:{ image:[], video:[] }, videoFrames:{} };
    let deletes = 0;
    const context = vm.createContext({ state, shouldRemoveUploadJobLocalAsset,
      window:{ guguDesktop:{ media:{ removeLocal:async () => { deletes++; } } } }, notifyUploadSurfaceChanged:() => {} });
    vm.runInContext(extract(frontend, 'function removeUploadJob(', 'function autoSelectUploadedReference('), context);
    vm.runInContext(extract(frontend, 'function cleanupUncommittedReferenceJobs(', 'function restoreReferenceDialogOriginal('), context);
    vm.runInContext(extract(frontend, 'function pendingReferenceJob(', 'function videoReferenceCounts('), context);
    context.removeUploadJob(jobs[0].id);
    context.cleanupUncommittedReferenceJobs();
    assert.equal(state.uploadJobs.length, 0);
    assert.equal(deletes, 0);
    for (const file of files) assert.equal(context.referenceFileById(file.id).url, file.url);
    closeLocalLibrary();
    openLocalLibrary(root);
    for (const file of files) {
      assert.equal(getLocalAsset(file.id).relativePath, file.relativePath);
      assert.equal(await fs.readFile(path.join(root, file.relativePath), 'utf8'), 'image');
    }
  } finally { closeLocalLibrary(); await fs.rm(root, { recursive:true, force:true }); }
});
