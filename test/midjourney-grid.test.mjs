import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMidjourneyGridService } from '../services/midjourney-grid.mjs';
import { createMediaArchiveService } from '../services/media-archive.mjs';
import { createGenerationRouteHandler } from '../server/routes/generations.mjs';

test('Midjourney grid is split into four center quadrants', async () => {
  const calls = [];
  const service = createMidjourneyGridService({
    executable: 'ffmpeg-test',
    run: async (command, args) => calls.push({ command, args }),
  });
  const outputs = await service.splitImage('/tmp/composite.png', ['/tmp/1.png', '/tmp/2.png', '/tmp/3.png', '/tmp/4.png']);
  assert.deepEqual(outputs, ['/tmp/1.png', '/tmp/2.png', '/tmp/3.png', '/tmp/4.png']);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => call.args[call.args.indexOf('-vf') + 1]), [
    'crop=iw/2:ih/2:0:0',
    'crop=iw/2:ih/2:iw/2:0',
    'crop=iw/2:ih/2:0:ih/2',
    'crop=iw/2:ih/2:iw/2:ih/2',
  ]);
});

test('Midjourney quantity creates four output tasks but charges and submits one request', async () => {
  const records = new Map();
  const queued = [];
  let id = 0;
  const input = {
    type:'image', modelId:'midjourney', prompt:'a red door', quantity:4, size:'1:1', quality:'1', referenceAssetIds:[],
    midjourneyOptions:{ aspectRatio:'1:1', version:'8.2', quality:'1', stylize:100, chaos:0, weird:0 },
  };
  const handler = createGenerationRouteHandler({
    bodyJson:async () => input,
    sendJson:(_res, status, body) => { _res.statusCode = status; _res.body = body; },
    requireUser:() => ({ id:'user-1' }),
    requireDesktopWorkspaceScope:() => ({ deviceId:'device-1', workspaceId:'workspace-1' }),
    findGeneration:(_userId, generationId) => records.get(generationId) || null,
    listGenerations:() => ({ items:[] }),
    setPageHeaders:() => {}, parseLimit:() => 100, safeId:value => String(value || ''),
    publicGeneration:task => task,
    publicDramaProject:project => project,
    loadDramaProject:async () => null,
    validateVideoRequest:() => { throw new Error('unexpected video validation'); },
    validateReferenceAssets:async () => [], referenceAssetCounts:() => ({}), normalizeQuoteReferenceCounts:() => ({}),
    assertReferenceCountsWithinLimits:() => {}, selectModelRoute:() => null, publicRoutePriceVersion:() => '',
    currentPricing:() => ({ imagePerRequestMicro:3_000_000 }), pricingSnapshot:pricing => ({ version:'price-1', total:pricing.imagePerRequestMicro / 1_000_000, totalMicro:pricing.imagePerRequestMicro }),
    staticPriceVersion:() => 'static-1', creditsToMicro:value => Number(value) * 1_000_000, charLength:value => Array.from(value).length,
    walletOf:() => ({ balance:100 }), chargeGenerationMicro:async () => { throw new Error('unexpected single charge'); },
    chargeGenerationBatchMicro:async (_userId, items) => { items.forEach(item => item.metadata.onCharged()); return { balance:96 }; },
    createGenerationRequest:() => {}, findGenerationRequest:() => null, generationRequestFingerprint:() => 'fingerprint',
    enqueueGenerationJob:job => queued.push(job), saveGeneration:(_userId, task) => { records.set(task.id, task); return task; },
    failGeneration:async () => {}, deleteGenerationRecord:async () => ({}), saveDramaProject:async () => {}, ensureUserDirs:async () => {},
    randomId:() => `generated-${++id}`, now:() => '2026-09-09T00:00:00.000Z', resolveVideoPrompt:() => '', buildShotVideoPrompt:() => '',
    isModelEnabled:() => true, fixedModels:{ image:'gpt-image-2' }, imageSizes:new Set(['1:1']), imageModelIds:new Set(['gpt-image-2', 'midjourney']),
    tuziImageModelId:'gpt-image-2.5', tuziImageSizes:new Set(), tuziImageTiers:new Set(), tuziImageCredits:{},
    videoModelIds:{}, legacyVideoModelIds:{}, storyboardEngineVersion:1, r2ReferenceConfigured:true, r2ReferencePublicBaseUrl:'https://reference.test',
    providerAvailability:{ duomi:true, tuzi:false, ttapi:false, cntcn:false, autodl:false, oai:false, oaiVeo:false, oaiMinimax:false },
    runtimeMetrics:{ idempotencyConflicts:0 }, activeGenerations:new Set(),
  });
  const response = {};
  await handler({ method:'POST', headers:{} }, response, new URL('http://localhost/api/generations'));
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.tasks.length, 4);
  assert.equal(response.body.balance, 96);
  assert.deepEqual(response.body.tasks.map(task => task.creditCost), [4, 0, 0, 0]);
  assert.deepEqual(response.body.tasks.map(task => task.creditStatus), ['charged', 'included', 'included', 'included']);
  assert.deepEqual(response.body.tasks.map(task => task.midjourneyOutputIndex), [0, 1, 2, 3]);
  assert.equal(new Set(queued.map(job => job.generationId)).size, 1);
  assert.equal(queued[0].generationId, response.body.tasks[0].id);
  input.quantity = 2;
  const invalidResponse = {};
  await handler({ method:'POST', headers:{} }, invalidResponse, new URL('http://localhost/api/generations'));
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(invalidResponse.body.error, /4 的倍数/);
});

test('Midjourney grid archive creates four independent image assets', async () => {
  const assets = new Map();
  const tasks = Array.from({ length:4 }, (_, index) => ({
    id:`task-${index + 1}`, type:'image', modelId:'midjourney', midjourneyOutputIndex:index,
    originDeviceId:'device-1', originWorkspaceId:'workspace-1', createdAt:'2026-09-09T00:00:00.000Z', assetId:'',
  }));
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const uploads = [];
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'gugu-mj-archive-'));
  const service = createMediaArchiveService({
    assertGenerationJobLease:() => {}, findAsset:(_userId, assetId) => assets.get(assetId) || null,
    findGeneration:(_userId, taskId) => taskById.get(taskId) || null,
    saveAsset:async (_userId, asset) => { assets.set(asset.id, asset); return asset; },
    saveGenerationAsset:(_userId, asset) => { assets.set(asset.id, asset); return asset; },
    withMediaTempDir:async (_label, callback) => { const dir = await mkdtemp(path.join(tempRoot, 'job-')); try { return await callback(dir); } finally { await rm(dir, { recursive:true, force:true }); } },
    generationAssetExtension:() => '.png', generationAssetName:task => `image-${task.id}.png`, generationSourceHeaders:() => {},
    assetObjectKey:(_userId, storageName) => `assets/${storageName}`,
    download:async (_url, target) => { await writeFile(target, 'composite'); return { contentType:'image/png', size:9 }; },
    put:async (objectKey, sourceFile, mimeType) => { uploads.push({ objectKey, sourceFile, mimeType }); },
    remove:async () => {}, splitImage:async (_source, outputFiles) => { await Promise.all(outputFiles.map((file, index) => writeFile(file, `quadrant-${index}`))); },
    statFile:target => stat(target), now:() => '2026-09-09T00:00:01.000Z',
  });
  try {
    const result = await service.archiveMidjourneyGridResult('user-1', tasks, 'https://example.test/grid.png');
    assert.equal(result.length, 4);
    assert.equal(uploads.length, 4);
    assert.deepEqual(result.map(asset => asset.sourceGenerationId), tasks.map(task => task.id));
    assert.ok(result.every(asset => asset.mimeType === 'image/png' && asset.objectKey && !asset.sourceUrl));
  } finally {
    await rm(tempRoot, { recursive:true, force:true });
  }
});
