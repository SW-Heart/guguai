import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVirtualShotRange, normalizeShotVideoParameters, shotPreviewRenderSignature } from '../public/drama-studio.js';

test('switching video model replaces only parameters unsupported by the selected model', () => {
  const shot = {
    aspectRatio: '9:16',
    duration: 15,
    generation: { quality: '480p' },
  };

  const changed = normalizeShotVideoParameters(shot, {
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [4, 5, 15],
    qualityOptions: ['768p', '2k'],
  });

  assert.equal(changed, true);
  assert.deepEqual(shot, {
    aspectRatio: '9:16',
    duration: 15,
    generation: { quality: '768p' },
  });
});

test('switching to a restrictive model selects supported defaults for every incompatible parameter', () => {
  const shot = {
    aspectRatio: '21:9',
    duration: 8,
    generation: { quality: '2k' },
  };

  normalizeShotVideoParameters(shot, {
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [15],
    qualityOptions: ['720p'],
  });

  assert.deepEqual(shot, {
    aspectRatio: '16:9',
    duration: 15,
    generation: { quality: '720p' },
  });
});

test('shot preview signatures react only to tasks and files used by that shot', () => {
  const shot = { selectedVideoTaskId:'task-1', videoVersions:['task-1','task-2'] };
  const tasks = [
    { id:'task-1', status:'running', progress:10, assetId:'' },
    { id:'task-2', status:'completed', assetId:'file-2' },
    { id:'unrelated', status:'running', assetId:'' },
  ];
  const files = [{ id:'file-2', url:'/video-2.mp4' }];
  const initial = shotPreviewRenderSignature(shot, tasks, files);

  assert.equal(shotPreviewRenderSignature(shot, tasks.map(item => item.id === 'task-1' ? { ...item, progress:80 } : item), files), initial);
  assert.equal(shotPreviewRenderSignature(shot, tasks.map(item => item.id === 'unrelated' ? { ...item, status:'completed' } : item), files), initial);
  assert.notEqual(shotPreviewRenderSignature(shot, tasks.map(item => item.id === 'task-1' ? { ...item, status:'completed' } : item), files), initial);
  assert.notEqual(shotPreviewRenderSignature(shot, tasks, [{ id:'file-2', url:'/video-2-new.mp4' }]), initial);
});

test('virtual shot range keeps an overscanned window across variable card heights', () => {
  const heights = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

  assert.deepEqual(calculateVirtualShotRange(heights, 0, 250, { overscan:1 }), { start:0, end:3 });
  assert.deepEqual(calculateVirtualShotRange(heights, 600, 350, { overscan:1 }), { start:2, end:5 });
  assert.deepEqual(calculateVirtualShotRange(heights, 99999, 350, { overscan:1 }), { start:9, end:10 });
  assert.deepEqual(calculateVirtualShotRange([100, 0, 100], 100, 1, { overscan:0, estimatedHeight:50 }), { start:1, end:2 });
});
