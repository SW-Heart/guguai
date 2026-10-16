import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
import { createModelRoute, ensureDefaultModelRoutes, modelRoute, selectModelRoute, updateModelRoute } from '../lib/model-routes.mjs';
import { placeholderReferenceImage } from '../lib/placeholder-image.mjs';
import { refreshGenerationRetryRoute } from '../services/generation-retry.mjs';

const request = { logicalModelId:'seedance-2.0', quality:'1080p', duration:15, aspectRatio:'16:9' };

test('placeholder images are opaque black PNGs in the requested ratio', () => {
  for (const [ratio, width, height] of [['16:9', 1280, 720], ['9:16', 720, 1280], ['1:1', 960, 960], ['21:9', 1680, 720]]) {
    const image = placeholderReferenceImage(ratio);
    assert.equal(image.mimeType, 'image/png');
    assert.deepEqual([image.width, image.height], [width, height]);
    const { buffer } = image;
    assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
    assert.deepEqual([buffer.readUInt32BE(16), buffer.readUInt32BE(20)], [width, height]);
    assert.equal(buffer[25], 2, 'RGB without an alpha channel');
    const idatLength = buffer.readUInt32BE(33);
    assert.equal(buffer.subarray(37, 41).toString('ascii'), 'IDAT');
    const pixels = inflateSync(buffer.subarray(41, 41 + idatLength));
    assert.equal(pixels.length, (width * 3 + 1) * height);
    assert.ok(pixels.every(byte => byte === 0));
  }
  assert.equal(placeholderReferenceImage('unknown').width, 1280);
});

test('text placeholder image route setting', async t => {
  const originalKey = process.env.DIW_KEY;
  t.beforeEach(() => {
    resetForTests();
    openDatabase({ file:':memory:' });
    process.env.DIW_KEY = 'test-key';
    ensureDefaultModelRoutes();
  });
  t.afterEach(() => {
    closeDatabase({ checkpoint:false });
    if (originalKey === undefined) delete process.env.DIW_KEY;
    else process.env.DIW_KEY = originalKey;
  });
  const addImageOnlyRoute = (extra = {}) => {
    const route = createModelRoute({ logicalModelId:request.logicalModelId, quality:request.quality, credentialId:'diw-main', upstreamModelId:`image-only-${Math.random()}`, priority:1, costYuan:0.1, salePriceYuan:0.2, durations:[15], ...extra });
    updateModelRoute(route.id, { adminEnabled:true });
    return modelRoute(route.id);
  };

  await t.test('is off by default and image-only channels skip text requests', () => {
    const route = addImageOnlyRoute();
    assert.equal(route.textPlaceholderImage, false);
    // Default seed CD route requires an image.
    assert.equal(modelRoute('sd20-720-diw-cd').textPlaceholderImage, false);
    assert.notEqual(selectModelRoute({ ...request, quality:'720p', referenceCounts:{} })?.id, 'sd20-720-diw-cd');
  });

  await t.test('lets an image-only channel take text requests once switched on', () => {
    assert.notEqual(selectModelRoute({ ...request, quality:'720p', referenceCounts:{} })?.id, 'sd20-720-diw-cd');
    const updated = updateModelRoute('sd20-720-diw-cd', { textPlaceholderImage:true });
    assert.equal(updated.textPlaceholderImage, true);
    assert.equal(selectModelRoute({ ...request, quality:'720p', referenceCounts:{} }).id, 'sd20-720-diw-cd');
    assert.equal(selectModelRoute({ ...request, quality:'720p', referenceCounts:{ image:1 } }).id, 'sd20-720-diw-cd');
    // Other edits keep the setting.
    assert.equal(updateModelRoute('sd20-720-diw-cd', { priority:1 }).textPlaceholderImage, true);
  });

  await t.test('requires the channel to accept at least one image', () => {
    const route = addImageOnlyRoute({ textPlaceholderImage:true });
    assert.equal(route.textPlaceholderImage, true);
    assert.throws(() => updateModelRoute(route.id, { referenceLimits:{ image:0, video:3, audio:3 } }), /至少为 1/);
    assert.throws(() => updateModelRoute(route.id, { textPlaceholderImage:'yes' }), /设置无效/);
  });

  await t.test('a retry on another channel takes that channel setting', () => {
    const next = updateModelRoute('sd20-720-diw-cd', { textPlaceholderImage:true });
    const task = { routeId:'other', routePriority:0, routeTextPlaceholderImage:false, generationRetryCount:2, generationAttempts:[{ routeId:'other' }, { routeId:'other' }], quality:'720p', duration:15, aspectRatio:'16:9', videoModelId:'seedance-2.0' };
    refreshGenerationRetryRoute(task, { selectModelRoute:() => next });
    assert.equal(task.routeTextPlaceholderImage, true);
  });
});
