import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDramaStudio } from '../public/drama-studio.js';

test('the full drama controller initializes with the optimization dialog enabled', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis,'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis,'window');
  const back = {};
  const root = {querySelector:() => null,querySelectorAll:() => [],contains:() => false};
  globalThis.document = {addEventListener(){},querySelector:selector => selector === '#dramaStage' ? root : selector === '#dramaTopBack' ? back : null};
  globalThis.window = {addEventListener(){}};
  try {
    const studio = createDramaStudio({api:() => {throw new Error('initialization must not send requests');},state:{route:'drama',files:[],tasks:[]},esc:String,toast(){},setCreditBalance(){}});
    assert.equal(typeof studio.load,'function');
    assert.equal(typeof studio.render,'function');
    assert.equal(typeof studio.resetForAccount,'function');
    assert.equal(typeof back.onclick,'function');
    assert.equal(studio.project,null);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis,'document',previousDocument); else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis,'window',previousWindow); else delete globalThis.window;
  }
});

test('a failed drama initialization can retry and concurrent callers share one attempt', async () => {
  const source = readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code = source.slice(source.indexOf('let dramaController = null;'),source.indexOf('function renderRouteLoadingShell('))
    .replace(/import\('\.\/drama-studio\.js\?v=\d+'\)/,"importStudio()");
  let attempts = 0;
  const controller = {load(){}};
  const context = Object.fromEntries(['api','esc','toast','setCreditBalance','creditText','loadTasks','scheduleTaskPoll','loadCredits','loadFiles','pickAndUploadDramaImage','pickAndUploadDramaAsset','pickAndImportDramaCanvasAsset','confirmDelete','taskFailure','isDesktopAssetSyncing','desktopSyncMarkup','showDesktopAssetInFolder','removeDesktopCloudAssets','syncDesktopDeliveries'].map(name => [name,() => {}]));
  Object.assign(context,{state:{},mediaController:{},accountScope:{},desktopSyncInfo:{},
    importStudio:async () => ({createDramaStudio:() => {if (++attempts === 1) throw new ReferenceError('controller initialization failed');return controller;}})});
  vm.createContext(context);vm.runInContext(code,context);
  const first = context.ensureDramaController();
  assert.equal(context.ensureDramaController(),first);
  await assert.rejects(first,/initialization failed/);
  assert.equal(await context.ensureDramaController(),controller);
  assert.equal(attempts,2);
  assert.equal(await context.ensureDramaController(),controller);
  assert.equal(attempts,2,'successful initialization remains cached');
});
