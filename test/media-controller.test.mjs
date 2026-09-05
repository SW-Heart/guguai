import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaController } from '../public/features/media/controller.js';

function createHarness({ account = 'alpha', epoch = 1, listLocal = async () => ({ items:[] }), acknowledgementFailures = 0, initialFiles = [], syncDeliveries = [], removeDramaAssemblyAssets = async () => {} } = {}) {
  const state = { files:[...initialFiles], route:'files', initialSyncReady:true, fileKind:'all' };
  const pendingDownloads = new Map();
  let downloadCount = 0;
  const acknowledgements = [];
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
      if (path.endsWith('/local-ready')) {
        acknowledgements.push({ path, options });
        if (acknowledgementFailures > 0) {
          acknowledgementFailures -= 1;
          throw new Error('确认服务暂不可用');
        }
      }
      return { changes:[], deliveries:syncDeliveries };
    },
    desktopScope: { localAsset: item => ({ ...item, localId:item.id, localStatus:'saved', url:`gugu-media://${item.id}` }) },
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
  return { state, bridge, pendingDownloads, acknowledgements, deliveryTaskPayloads, completedDeliveryTasks, timers, controller, get downloadCount() { return downloadCount; }, setAccount: value => { account = value; }, setEpoch: value => { epoch = value; } };
}

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

test('deleting a local library asset notifies the drama assembly history owner', async () => {
  const removed = [];
  const file = { id:'assembly-a', localId:'assembly-a', localOnly:true, kind:'video', name:'成片.mp4', projectId:'project-a', localStatus:'saved' };
  const harness = createHarness({ initialFiles:[file], removeDramaAssemblyAssets:async (ids, projectId) => removed.push({ ids, projectId }) });

  await harness.controller.removeLocalAsset(file);

  assert.deepEqual(removed, [{ ids:['assembly-a'], projectId:'project-a' }]);
  assert.deepEqual(harness.state.files, []);
});
