import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDramaVideoQuoteInput, calculateVirtualShotRange, clampVirtualScrollOffset, dramaVideoQuoteSignature, generationNeedsLocalAssetSync, isMountedVirtualShotScroll, mergeDramaProjectList, mergeProjectResponseWithNewerKeys, normalizeShotVideoParameters, removeAssemblyVideoAssets, shotPreviewContentSignature, shotPreviewRenderSignature, videoPreviewVersionState, videoTaskProgress } from '../public/drama-studio.js';

test('renamed drama projects update the library immediately and move to the top', () => {
  const previous = [
    { id: 'old', title: '旧项目', updatedAt: '2' },
    { id: 'current', title: '旧名称', updatedAt: '1' },
  ];
  const next = mergeDramaProjectList(previous, { id: 'current', title: '新名称', updatedAt: '3' });
  assert.deepEqual(next.map(project => [project.id, project.title]), [['current', '新名称'], ['old', '旧项目']]);
});

test('deleting a video asset removes matching assembly history and legacy final output', () => {
  const project = {
    id:'project-1',
    finalAssetId:'assembly-legacy',
    assemblyVideos:[
      { id:'record-1', assetId:'assembly-legacy' },
      { id:'record-2', assetId:'assembly-keep' },
    ],
  };

  const result = removeAssemblyVideoAssets(project, ['assembly-legacy', 'assembly-legacy']);

  assert.equal(result.changed, true);
  assert.deepEqual(result.project.assemblyVideos, [{ id:'record-2', assetId:'assembly-keep' }]);
  assert.equal(result.project.finalAssetId, '');
  assert.equal(project.assemblyVideos.length, 2, '纯函数不应修改原项目');
  assert.equal(removeAssemblyVideoAssets(result.project, ['not-found']).changed, false);
});

test('an older save response cannot overwrite fields edited while the request was in flight', () => {
  const serverProject = { id:'project-1', revision:8, title:'服务端旧标题', shots:[{ id:'server-shot' }], settings:{ aspectRatio:'9:16' } };
  const localProject = { id:'project-1', revision:7, title:'本地新标题', shots:[{ id:'local-shot' }], settings:{ aspectRatio:'21:9' } };
  const requestVersions = new Map([['title', 1], ['shots', 3], ['settings', 2]]);
  const currentVersions = new Map([['title', 2], ['shots', 3], ['settings', 4]]);

  assert.deepEqual(
    mergeProjectResponseWithNewerKeys(serverProject, localProject, requestVersions, currentVersions),
    { id:'project-1', revision:8, title:'本地新标题', shots:[{ id:'server-shot' }], settings:{ aspectRatio:'21:9' } },
  );
});

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

test('short-drama routed video quotes include every route-selection parameter', () => {
  const shot = {
    aspectRatio:'9:16',
    duration:30,
    generation:{ modelId:'seedance-2.5', type:'REFERENCE', quality:'720p', count:4 },
  };
  const input = buildDramaVideoQuoteInput(shot, ['image', 'image', 'video', 'audio']);

  assert.deepEqual(input, {
    modelId:'seedance-2.5', generationType:'REFERENCE', aspectRatio:'9:16', duration:30, quality:'720p',
    referenceAssetIds:[], referenceCounts:{ image:2, video:1, audio:1 },
  });
  assert.equal(dramaVideoQuoteSignature(input), dramaVideoQuoteSignature(buildDramaVideoQuoteInput({ ...shot, generation:{ ...shot.generation, count:1 } }, ['audio', 'image', 'video', 'image'])));
  assert.notEqual(dramaVideoQuoteSignature(input), dramaVideoQuoteSignature({ ...input, quality:'480p' }));
  assert.notEqual(dramaVideoQuoteSignature(input), dramaVideoQuoteSignature({ ...input, referenceCounts:{ image:1, video:1, audio:1 } }));
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

  assert.notEqual(shotPreviewRenderSignature(shot, tasks.map(item => item.id === 'task-1' ? { ...item, progress:80 } : item), files), initial);
  assert.equal(shotPreviewRenderSignature(shot, tasks.map(item => item.id === 'unrelated' ? { ...item, status:'completed' } : item), files), initial);
  assert.notEqual(shotPreviewRenderSignature(shot, tasks.map(item => item.id === 'task-1' ? { ...item, status:'completed' } : item), files), initial);
  assert.notEqual(shotPreviewRenderSignature(shot, tasks, [{ id:'file-2', url:'/video-2-new.mp4' }]), initial);
  const failed = tasks.map(item => item.id === 'task-1' ? { ...item, status:'failed', error:'参考图片不符合生成要求。请检查图片格式。', failure:{ code:'INVALID_REFERENCE' } } : item);
  assert.notEqual(shotPreviewRenderSignature(shot, failed, files), initial);
  assert.notEqual(shotPreviewRenderSignature(shot, failed.map(item => item.id === 'task-1' ? { ...item, error:'内容未通过生成检查。请调整描述。', failure:{ code:'CONTENT_REJECTED' } } : item), files), shotPreviewRenderSignature(shot, failed, files));
});

test('shot preview content signatures ignore progress-only updates', () => {
  const shot = { selectedVideoTaskId:'task-1', videoVersions:['task-1'] };
  const tasks = [{ id:'task-1', type:'video', status:'running', progress:10, progressStage:'provider_processing', assetId:'' }];

  assert.equal(
    shotPreviewContentSignature(shot, tasks, []),
    shotPreviewContentSignature(shot, [{ ...tasks[0], progress:80, progressStage:'polling_retry' }], []),
  );
  assert.notEqual(
    shotPreviewContentSignature(shot, tasks, []),
    shotPreviewContentSignature(shot, [{ ...tasks[0], status:'completed', assetId:'file-1' }], [{ id:'file-1', url:'gugu-media://file-1' }]),
  );
});

test('video task progress only renders valid, queryable percentages', () => {
  assert.equal(videoTaskProgress({ progress: 0 }), 0);
  assert.equal(videoTaskProgress({ progress: 42.6 }), 43);
  assert.equal(videoTaskProgress({ progress: 100 }), 100);
  assert.equal(videoTaskProgress({ progress: null }), null);
  assert.equal(videoTaskProgress({ progress: 'unknown' }), null);
  assert.equal(videoTaskProgress({ progress: 101 }), null);
});

test('video preview stays in generation state until the local asset is ready', () => {
  assert.equal(videoPreviewVersionState({ status:'queued' }), 'pending');
  assert.equal(videoPreviewVersionState({ status:'running' }), 'pending');
  assert.equal(videoPreviewVersionState({ status:'completed' }, { syncing:true }), 'syncing');
  assert.equal(videoPreviewVersionState({ status:'completed', assetId:'asset-1' }), 'syncing');
  assert.equal(videoPreviewVersionState({ status:'failed' }), 'failed');
  assert.equal(videoPreviewVersionState({ status:'failed' }, { ready:true, syncing:true }), 'failed');
  assert.equal(videoPreviewVersionState({ status:'completed' }), 'missing');
  assert.equal(videoPreviewVersionState(undefined), 'missing');
  assert.equal(videoPreviewVersionState({ status:'completed' }, { ready:true }), 'ready');
});

test('completed generation remains syncing while its local asset is being recovered', () => {
  const task = { status:'completed', assetId:'asset-1' };
  assert.equal(generationNeedsLocalAssetSync(task, undefined), true);
  assert.equal(generationNeedsLocalAssetSync(task, { id:'asset-1' }, () => true), true);
  assert.equal(generationNeedsLocalAssetSync(task, { id:'asset-1' }, () => false), false);
  assert.equal(generationNeedsLocalAssetSync({ status:'completed', assetId:'' }, undefined), false);
  assert.equal(generationNeedsLocalAssetSync({ status:'failed', assetId:'asset-1' }, undefined), false);
});

test('virtual shot range keeps an overscanned window across variable card heights', () => {
  const heights = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

  assert.deepEqual(calculateVirtualShotRange(heights, 0, 250, { overscan:1 }), { start:0, end:3 });
  assert.deepEqual(calculateVirtualShotRange(heights, 600, 350, { overscan:1 }), { start:2, end:5 });
  assert.deepEqual(calculateVirtualShotRange(heights, 99999, 350, { overscan:1 }), { start:9, end:10 });
  assert.deepEqual(calculateVirtualShotRange([100, 0, 100], 100, 1, { overscan:0, estimatedHeight:50 }), { start:1, end:2 });
});

test('virtual shot rendering only accepts the mounted storyboard scroller', () => {
  const shotScroll = { matches: selector => selector === '.wb-shot-scroll' };
  const workspaceMain = { matches: () => false };
  const root = { contains: node => node === shotScroll };

  assert.equal(isMountedVirtualShotScroll(root, shotScroll), true);
  assert.equal(isMountedVirtualShotScroll(root, workspaceMain), false);
  assert.equal(isMountedVirtualShotScroll(root, null), false);
});

test('virtual shot scroll offsets are clamped after shots are deleted', () => {
  assert.equal(clampVirtualScrollOffset(3000, 1200, 1000), 200);
  assert.equal(clampVirtualScrollOffset(900, 800, 1000), 0);
  assert.equal(clampVirtualScrollOffset(-20, 1200, 1000), 0);
});
