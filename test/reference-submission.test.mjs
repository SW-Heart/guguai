import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const frontend = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const backend = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const submission = frontend.slice(frontend.indexOf('async function submitGeneration('), frontend.indexOf("$('#imageModel').addEventListener", frontend.indexOf('async function submitGeneration(')));

function submissionContext({ resolve, requests }) {
  const state = { files:[], refs:{ image:[], video:['local-1','local-2','local-3'] }, tasks:[], generationPreparations:[], modelQuote:{ signature:'old', priceVersion:'old' }, uploadJobs:[], videoFrames:{} };
  const messages = [];
  const context = vm.createContext({
    state, generationSubmissionForms:new Set(), accountScope:{ snapshot:() => ({}), isCurrent:() => true },
    hasUnresolvedReference:() => true, pendingReferenceJob:() => null, needsReferenceUpload:() => false,
    resolveReferenceAssetIds:resolve, referenceCountsForIds:ids => ({ image:ids.length, video:0, audio:0 }),
    renderTasks:() => {}, renderReferences:() => {}, mergeTasksIntoLoadedHistory:() => {}, setCreditBalance:() => {},
    setVideoPromptText:() => {}, setImagePromptText:() => {}, videoPromptEditor:() => ({ dispatchEvent:() => {} }),
    imagePromptEditor:() => ({ dispatchEvent:() => {} }), toast:message => messages.push(message), loadTasks:async () => {}, loadCredits:async () => {},
    syncVideoPromptState:() => {}, updateVideoCost:() => {}, syncImagePromptState:() => {}, updateImageCost:() => {},
    creditText:value => String(value), crypto:{ randomUUID:() => 'request-1' }, Event:class {},
    window:{}, console, api:async (path, options) => {
      const body = JSON.parse(options.body);
      requests.push({ path, body });
      if (path === '/api/model-quote') return { priceVersion:'price-for-two', credits:36 };
      if (path === '/api/generations') return { id:'task-1', creditCost:36, balance:64 };
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  vm.runInContext(submission, context);
  return { context, state, messages };
}

test('reference upload finishes before quote and charge', async () => {
  const requests = [];
  const { context } = submissionContext({
    resolve:async () => { requests.push({ path:'upload' }); return ['cloud-1','cloud-2','cloud-3']; }, requests,
  });
  await context.submitGeneration('video', {}, { modelId:'seedance-2.0', prompt:'视频', referenceAssetIds:['local-1','local-2','local-3'], quality:'720p', duration:15, aspectRatio:'16:9', generationType:'REFERENCE' });
  assert.deepEqual(requests.map(item => item.path), ['upload','/api/model-quote','/api/generations']);
  assert.equal(requests[1].body.referenceCounts.image, 3);
  assert.deepEqual(Array.from(requests[2].body.referenceAssetIds), ['cloud-1','cloud-2','cloud-3']);
  assert.equal(requests[2].body.expectedPriceVersion, 'price-for-two');
  assert.equal(requests[2].body.deferReferenceUpload, undefined);
});

test('duplicate reference slots are quoted and submitted as separate positions', async () => {
  const requests = [];
  const { context, state } = submissionContext({
    resolve:async () => { requests.push({ path:'upload' }); return ['cloud-1','cloud-1','cloud-2']; }, requests,
  });
  await context.submitGeneration('video', {}, { modelId:'seedance-2.0', prompt:'视频', referenceAssetIds:['local-1','local-2','local-3'], quality:'720p', duration:15, aspectRatio:'16:9', generationType:'REFERENCE' });
  assert.deepEqual(requests.map(item => item.path), ['upload','/api/model-quote','/api/generations']);
  assert.equal(requests[1].body.referenceCounts.image, 3);
  assert.deepEqual(Array.from(requests[2].body.referenceAssetIds), ['cloud-1','cloud-1','cloud-2']);
  assert.equal(state.tasks.length, 1);
});

test('eight local reference slots can resolve to the same cloud image without collapsing', async () => {
  const source = frontend.slice(frontend.indexOf('async function resolveReferenceAssetIds('), frontend.indexOf('function hasUnresolvedReference(', frontend.indexOf('async function resolveReferenceAssetIds(')));
  const ids = Array.from({ length:8 }, (_, index) => `local-${index}`);
  const context = vm.createContext({
    state:{ files:[] }, pendingReferenceJob:id => ({ id }), uploadPendingReferenceJob:async () => ({ id:'cloud-1' }),
    replacePendingReferenceId:() => {}, isRemoteReferenceReady:() => false, needsReferenceUpload:() => false,
    renderReferences:() => {},
  });
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(await context.resolveReferenceAssetIds(ids)), Array(8).fill('cloud-1'));
});

test('video reference list retains eight positions for one image', () => {
  const source = frontend.slice(frontend.indexOf('function normalizeVideoReferenceIds('), frontend.indexOf('function desktopMediaKind(', frontend.indexOf('function normalizeVideoReferenceIds(')));
  const context = vm.createContext({
    referenceLimits:() => ({ image:9, video:0, audio:0, total:9 }),
    referenceFileKinds:() => new Set(['image']), referenceFileById:() => ({ kind:'image' }),
  });
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(context.normalizeVideoReferenceIds(Array(8).fill('cloud-1'), 'seedance-2.0')), Array(8).fill('cloud-1'));
});

test('server validates reference limits by positions and retains repeated asset IDs', async () => {
  const source = backend.slice(backend.indexOf('async function validateReferenceAssets('), backend.indexOf('function referenceAssetCounts(', backend.indexOf('async function validateReferenceAssets(')));
  let readinessChecks = 0;
  const context = vm.createContext({
    safeId:value => value, findAsset:(_userId, id) => ({ id, kind:'image', size:100, name:'same.png' }),
    maxReferenceImageBytes:20_000_000, maxUploadBytes:25_000_000,
    referenceAssetHasReadableSource:async () => { readinessChecks++; return true; },
  });
  vm.runInContext(source, context);
  const limits = { image:9, video:0, audio:0, total:9 };
  assert.deepEqual(Array.from(await context.validateReferenceAssets('user', Array(8).fill('cloud-1'), limits)), Array(8).fill('cloud-1'));
  assert.equal(readinessChecks, 1);
  await assert.rejects(context.validateReferenceAssets('user', Array(10).fill('cloud-1'), limits), /最多支持 9 个/);
});

test('server stages one file but forwards all eight reference positions', async () => {
  const source = backend.slice(backend.indexOf('async function resolveRefs('), backend.indexOf('async function validateReferenceAssets(', backend.indexOf('async function resolveRefs(')));
  let staged = 0;
  const context = vm.createContext({
    withMediaTempDir:async (_name, callback) => callback('/tmp'),
    findAsset:(_userId, id) => ({ id, kind:'image' }),
    stageImageReference:async () => { staged++; return 'https://example.test/same.png'; },
  });
  vm.runInContext(source, context);
  const refs = await context.resolveRefs('user', Array(8).fill('cloud-1'), { id:'task', routeId:'route', referenceLimits:{ total:9 } });
  assert.deepEqual(Array.from(refs.images), Array(8).fill('https://example.test/same.png'));
  assert.equal(staged, 1);
});

test('failed reference upload does not create a charged task', async () => {
  const requests = [];
  const { context, state } = submissionContext({ resolve:async () => { throw new Error('上传失败'); }, requests });
  await context.submitGeneration('video', {}, { modelId:'seedance-2.0', prompt:'视频', referenceAssetIds:['local-1'], quality:'720p', duration:15, aspectRatio:'16:9', generationType:'REFERENCE' });
  assert.deepEqual(requests, []);
  assert.deepEqual(state.tasks, []);
});
