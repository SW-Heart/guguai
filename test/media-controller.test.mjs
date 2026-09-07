import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaController } from '../public/features/media/controller.js';

function createHarness({ account = 'alpha', epoch = 1, listLocal = async () => ({ items:[] }), acknowledgementFailures = 0, initialFiles = [], syncDeliveries = [], syncPages = null, removeDramaAssemblyAssets = async () => {} } = {}) {
  const state = { files:[...initialFiles], route:'files', initialSyncReady:true, fileKind:'all' };
  const pendingDownloads = new Map();
  let downloadCount = 0;
  const acknowledgements = [];
  const apiCalls = [];
  const deliveryTaskPayloads = [];
  const completedDeliveryTasks = [];
  const timers = [];
  const bridge = {
    media: {
      listLocal,
      saveDeliveryTask: async payload => { deliveryTaskPayloads.push(payload); },
      completeDeliveryTask: async (assetId, workspaceId) => { completedDeliveryTasks.push({ assetId, workspaceId }); },
      downloadRemote: payload => new Promise(resolve => { downloadCount += 1; pendingDownloads.set(payload.assetId, resolve); }),
      removeLocal: async () => {},
    },
    sync: { setCursor: async () => {} },
  };
  const windowObject = { guguDesktop:bridge, setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } };
  const indexes = { invalidateFiles() {} };
  const controller = createMediaController({
    state,
    api: async (path, options) => {
      apiCalls.push(path);
      if (path.startsWith('/api/files/sync?') && syncPages) return syncPages.shift();
      if (path.endsWith('/local-ready')) {
        acknowledgements.push({ path, options });
        if (acknowledgementFailures > 0) {
          acknowledgementFailures -= 1;
          throw new Error('确认服务暂不可用');
        }
      }
      return { changes:[], deliveries:syncDeliveries };
    },
    desktopScope: { localAsset: item => ({ ...item, localId:item.id, localStatus:item.localStatus === 'missing' ? 'missing' : 'saved', url:item.localStatus === 'missing' ? '' : `gugu-media://${item.id}` }) },
    recordIndexes:indexes,
    fileById: id => state.files.find(file => file.id === id),
    accountSnapshot: () => account,
    isAccountCurrent: snapshot => snapshot === account,
    getAccountEpoch: () => epoch,
    getDesktopSyncInfo: () => ({ deviceId:'device-a', workspaceId:'workspace-a', cursor:'' }),
    getWindow: () => windowObject,
    getFileSearch: () => '',
    onChanged: () => {},
    removeDramaAssemblyAssets,
    setTimeoutFn: windowObject.setTimeout,
    clearTimeoutFn: windowObject.clearTimeout,
  });
  return { state, bridge, pendingDownloads, apiCalls, acknowledgements, deliveryTaskPayloads, completedDeliveryTasks, timers, controller, get downloadCount() { return downloadCount; }, setAccount: value => { account = value; }, setEpoch: value => { epoch = value; } };
}

test('deleted local assets disappear from the library and remain missing after cloud sync', async () => {
  const saved = { id:'a', kind:'image', localStatus:'saved', url:'gugu-media://a' };
  const missing = { ...saved, localStatus:'missing', url:'' };
  let items = [saved];
  const harness = createHarness({ initialFiles:[saved], listLocal:async () => ({ items, total:items[0].localStatus === 'missing' ? 0 : 1 }), syncDeliveries:[{ id:'a', localStatus:'remote', deliveryStatus:'awaiting_local', remoteStatus:'pending' }] });
  harness.bridge.media.listLocalByCloudIds = async () => items;
  await harness.controller.loadFiles();
  assert.equal(harness.controller.libraryState().files.length, 1);
  items = [missing];
  await harness.controller.refreshLocalAvailability();
  assert.equal(harness.controller.libraryState().files.length, 0);
  assert.equal(harness.state.files[0].localStatus, 'missing');
  await harness.controller.syncDesktopDeliveries({ assetIds:['a'] });
  assert.equal(harness.downloadCount, 0);
  assert.equal(harness.controller.downloadState('a'), null);
  assert.equal(harness.state.files[0].localStatus, 'missing');
  assert.equal(harness.state.files[0].url, '');
});

test('startup pages exclude missing files without subtracting the live count twice', async () => {
  const items = [{ id:'gone', kind:'image', localStatus:'missing', url:'' }, { id:'present', kind:'image', localStatus:'saved' }];
  const harness = createHarness({ listLocal:async () => ({ items, total:1 }) });
  await harness.controller.loadFiles();
  assert.deepEqual(harness.controller.libraryState().files.map(file => file.id), ['present']);
  assert.equal(harness.controller.libraryState().total, 1);
  assert.equal(harness.state.files.find(file => file.id === 'gone').localStatus, 'missing');
});

test('a file deleted between queueing and downloading is not acknowledged or retried', async () => {
  const harness = createHarness();
  harness.controller.queueDesktopHydration([{ id:'a', deliveryStatus:'awaiting_local', remoteStatus:'pending' }]);
  harness.pendingDownloads.get('a')({ id:'a', kind:'image', localStatus:'missing', localMissing:true, url:'' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.state.files[0].localStatus, 'missing');
  assert.equal(harness.acknowledgements.length, 0);
  assert.equal(harness.timers.length, 0);
  assert.equal(harness.controller.downloadState('a'), null);
});

test('media hydration ignores a delayed download after account invalidation', async () => {
  const harness = createHarness();
  const file = { id:'asset-a', name:'A.mp4', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending', localStatus:'remote' };
  const hydration = harness.controller.hydrateDesktopAsset(file);
  harness.setAccount('beta');
  harness.pendingDownloads.get('asset-a')({ id:'local-a', relativePath:'asset-a.mp4', size:10, sha256:'sha-a', mimeType:'video/mp4' });
  assert.equal(await hydration, null);
  assert.deepEqual(harness.state.files, []);
  assert.equal(harness.acknowledgements.length, 0);
});

test('media reset clears local pagination and hydration retry state', async () => {
  const harness = createHarness();
  const file = { id:'asset-a', name:'A.mp4', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending', localStatus:'remote' };
  harness.controller.queueDesktopHydration([file]);
  assert.equal(harness.controller.isHydrating(file), true);
  harness.controller.reset();
  assert.equal(harness.controller.isHydrating(file), false);
  assert.deepEqual(harness.controller.libraryState(), { files:[], cursor:'', hasMore:true, total:0 });
  assert.equal(harness.timers.length, 0);
});

test('media confirmation retries without downloading the already saved local file', async () => {
  const harness = createHarness({ acknowledgementFailures:1 });
  const file = { id:'asset-a', name:'A.mp4', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending', localStatus:'remote' };
  harness.controller.queueDesktopHydration([file]);
  harness.pendingDownloads.get('asset-a')({ id:'local-a', relativePath:'asset-a.mp4', size:10, sha256:'sha-a', mimeType:'video/mp4' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.downloadCount, 1);
  assert.equal(harness.acknowledgements.length, 1);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.state.files[0].localStatus, 'saved');
  assert.equal(harness.state.files[0].deliveryStatus, 'awaiting_local');

  harness.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.downloadCount, 1);
  assert.equal(harness.acknowledgements.length, 2);
  assert.equal(harness.state.files[0].deliveryStatus, 'local_ready');
  assert.equal(harness.deliveryTaskPayloads[0].workspaceId, 'workspace-a');
  assert.deepEqual(harness.completedDeliveryTasks, [{ assetId:'asset-a', workspaceId:'workspace-a' }]);
});

test('media startup reconciliation retries a saved local file without downloading it', async () => {
  const localFile = { id:'asset-a', name:'A.mp4', kind:'video', url:'gugu-media://asset-a', localStatus:'saved', localId:'local-a', cloudAssetId:'asset-a', deliveryStatus:'awaiting_local', remoteStatus:'pending', size:10, sha256:'sha-a', mimeType:'video/mp4' };
  const harness = createHarness({ initialFiles:[localFile], syncDeliveries:[{ id:'asset-a', name:'A.mp4', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending' }], acknowledgementFailures:1 });
  await harness.controller.syncDesktopDeliveries();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.downloadCount, 0);
  assert.equal(harness.acknowledgements.length, 1);
  assert.equal(harness.timers.length, 1);
  harness.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.downloadCount, 0);
  assert.equal(harness.acknowledgements.length, 2);
  assert.equal(harness.state.files[0].deliveryStatus, 'local_ready');
});

test('media reset cancels an acknowledgement from the previous account', async () => {
  const harness = createHarness({ acknowledgementFailures:1 });
  const file = { id:'asset-a', name:'A.mp4', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending', localStatus:'remote' };
  harness.controller.queueDesktopHydration([file]);
  harness.pendingDownloads.get('asset-a')({ id:'local-a', relativePath:'asset-a.mp4', size:10, sha256:'sha-a', mimeType:'video/mp4' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const staleTimer = harness.timers[0];
  assert.equal(harness.acknowledgements.length, 1);
  harness.setAccount('beta');
  harness.setEpoch(2);
  harness.controller.reset();
  assert.equal(harness.timers.length, 0);
  staleTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.acknowledgements.length, 1);
});

test('media loader owns local pagination and merges pages into the local index', async () => {
  const calls = [];
  const harness = createHarness({
    listLocal: async options => {
      calls.push(options);
      return calls.length === 1
        ? { items:[{ id:'local-a', name:'A.png', kind:'image', url:'file-a' }], total:2, nextCursor:'cursor-a' }
        : { items:[{ id:'local-b', name:'B.png', kind:'image', url:'file-b' }], total:2, nextCursor:'' };
    },
  });

  await harness.controller.loadFiles();
  await harness.controller.loadFiles({ loadMore:true });

  assert.deepEqual(calls.map(options => options.cursor), ['', 'cursor-a']);
  assert.deepEqual(harness.controller.libraryState().files.map(file => file.id), ['local-a', 'local-b']);
  assert.equal(harness.controller.libraryState().total, 2);
  assert.equal(harness.controller.libraryState().hasMore, false);
  assert.deepEqual(harness.state.files.map(file => file.id), ['local-b', 'local-a']);
});

test('refreshing the first local page preserves completed assets used outside that page', async () => {
  const completedAsset = { id:'cloud-older', name:'Older.mp4', kind:'video', localStatus:'saved', url:'gugu-media://older' };
  const harness = createHarness({
    initialFiles:[completedAsset],
    listLocal:async () => ({ items:[{ id:'cloud-newer', name:'Newer.mp4', kind:'video', url:'gugu-media://newer' }], total:201, nextCursor:'cursor-next' }),
  });

  await harness.controller.loadFiles();

  assert.deepEqual(harness.state.files.map(file => file.id), ['cloud-newer', 'cloud-older']);
  assert.deepEqual(harness.controller.libraryState().files.map(file => file.id), ['cloud-newer']);
});

test('deleting a local library asset notifies the drama assembly history owner', async () => {
  const removed = [];
  const file = { id:'assembly-a', localId:'assembly-a', localOnly:true, kind:'video', name:'成片.mp4', projectId:'project-a', localStatus:'saved' };
  const harness = createHarness({ initialFiles:[file], removeDramaAssemblyAssets:async (ids, projectId) => removed.push({ ids, projectId }) });

  await harness.controller.removeLocalAsset(file);

  assert.deepEqual(removed, [{ ids:['assembly-a'], projectId:'project-a' }]);
  assert.deepEqual(harness.state.files, []);
});

test('a stalled download leaves a second slot available, without exceeding two', async () => {
  const harness = createHarness();
  const files = ['a','b','c'].map(id => ({ id, kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending' }));
  harness.controller.queueDesktopHydration(files);
  assert.equal(harness.downloadCount, 2);
  harness.pendingDownloads.get('b')({ id:'local-b', size:20, sha256:'b', mimeType:'video/mp4' });
  await new Promise(setImmediate);
  assert.equal(harness.downloadCount, 3);
  assert.equal(harness.controller.downloadState('a').status, 'downloading');
  harness.controller.reset();
});

test('disk errors stop automatic downloads and explicit retry restarts them', async () => {
  const harness = createHarness();
  const file = { id:'disk', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending' };
  harness.state.files.push(file);
  harness.controller.queueDesktopHydration([file]);
  harness.pendingDownloads.get('disk')({ downloadError:'磁盘已满', retryable:false });
  await new Promise(setImmediate);
  assert.equal(harness.timers.length, 0);
  assert.equal(harness.controller.downloadState('disk').status, 'failed');
  harness.controller.queueDesktopHydration([file]);
  assert.equal(harness.downloadCount, 1);
  harness.controller.retryDownload('disk');
  assert.equal(harness.downloadCount, 2);
  harness.controller.reset();
});

test('repeated download failure requests backup once and eventually stops', async () => {
  const harness = createHarness();
  const file = { id:'network', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending' };
  harness.state.files.push(file);
  harness.bridge.media.downloadRemote = async () => { throw new Error('temporary network failure'); };
  harness.controller.queueDesktopHydration([file]);
  await new Promise(setImmediate);
  for (let i = 0; i < 6; i++) {
    assert.equal(harness.timers.length, 1);
    harness.timers.shift().callback();
    await new Promise(setImmediate);
  }
  assert.equal(harness.timers.length, 0);
  assert.equal(harness.controller.downloadState(file.id).status, 'failed');
  assert.equal(harness.apiCalls.filter(url => url.endsWith('/archive')).length, 1);
});

test('startup consumes both change pages and pending delivery pages', async () => {
  const harness = createHarness({ syncPages:[
    { changes:[], deliveries:[], nextCursor:'change-1', hasMore:true, nextDeliveryCursor:'delivery-1', deliveriesHasMore:true },
    { changes:[], deliveries:[], nextCursor:'change-2', hasMore:false, nextDeliveryCursor:'delivery-2', deliveriesHasMore:true },
    { changes:[], deliveries:[{ id:'last', kind:'video', deliveryStatus:'awaiting_local', remoteStatus:'pending' }], nextCursor:'change-2', hasMore:false, deliveriesHasMore:false },
  ] });
  await harness.controller.syncDesktopDeliveries();
  assert.equal(harness.apiCalls.length, 3);
  assert.match(harness.apiCalls[2], /deliveryCursor=delivery-2/);
  assert.equal(harness.downloadCount, 1);
  harness.controller.reset();
});
