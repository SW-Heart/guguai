import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('desktop file library reads only the local workspace', () => {
  assert.doesNotMatch(app, /function listRemoteFilesPage/);
  assert.doesNotMatch(app, /mergeDesktopFiles|enrichDesktopFiles|remoteFileCursor|remoteFileHasMore|remoteFileTotal/);
  assert.match(app, /listDesktopFiles\(\{\s*limit:200,\s*cursor,\s*kind:/s);
  assert.match(app, /function libraryFileMatches\(/);
});

test('history is received before the local-only file library becomes visible', () => {
  const loadFilesStart = app.indexOf('async function loadFiles(');
  const loadFilesEnd = app.indexOf('\nfunction assetDisplayName', loadFilesStart);
  const loadFilesSource = app.slice(loadFilesStart, loadFilesEnd);
  assert.doesNotMatch(loadFilesSource, /syncDesktopDeliveries|\/api\/files/);
  const enterAppStart = app.indexOf('async function enterApp(');
  const enterAppEnd = app.indexOf('\nlet accountSettingsRestoreFocus', enterAppStart);
  const enterAppSource = app.slice(enterAppStart, enterAppEnd);
  assert.ok(enterAppSource.indexOf('await syncHistoricalCloudAssets(user)') < enterAppSource.indexOf('showApp()'));
  assert.match(app, /async function listHistoricalCloudAssetsPage\(cursor = ''\)/);
  assert.match(app, /localStorage\.setItem\(marker, 'complete'\)/);
  assert.match(app, /async function runDesktopAssetSyncWorker\(\)/);
  assert.match(app, /scheduleDesktopAssetSync\(0\)/);
});

test('each login activates its account workspace before historical receive', () => {
  const enterAppStart = app.indexOf('async function enterApp(');
  const enterAppEnd = app.indexOf('\nlet accountSettingsRestoreFocus', enterAppStart);
  const enterAppSource = app.slice(enterAppStart, enterAppEnd);
  assert.ok(enterAppSource.indexOf('await activateDesktopAccount(user)') < enterAppSource.indexOf('await syncHistoricalCloudAssets(user)'));
  assert.match(app, /workspace\.activateAccount\(String\(user\.id\)\)/);
  assert.match(app, /workspace\?\.deactivateAccount\?\.\(\)/);
});

test('account workspace activation changes the frontend cache key', () => {
  assert.match(index, /\/app\.js\?v=192/);
});

test('generation polling resolves completed media from the local index only', () => {
  const loadTasksStart = app.indexOf('async function loadTasks(');
  const loadTasksEnd = app.indexOf('\nfunction localFileAction', loadTasksStart);
  const loadTasksSource = app.slice(loadTasksStart, loadTasksEnd);
  assert.match(loadTasksSource, /media\.listLocalByCloudIds\(missingAssetIds\.slice\(index, index \+ 500\)\)/);
  assert.doesNotMatch(loadTasksSource, /api\(`\/api\/files\//);
  assert.doesNotMatch(loadTasksSource, /queueDesktopHydration/);
});

test('remote change deletion cannot remove a local library asset', () => {
  const syncStart = app.indexOf('async function syncDesktopDeliveries(');
  const syncEnd = app.indexOf('\nfunction scheduleDesktopAssetSync', syncStart);
  const syncSource = app.slice(syncStart, syncEnd);
  assert.doesNotMatch(syncSource, /removeLocal|change\.action|deletedCloudAssetIds/);
  assert.match(syncSource, /queueDesktopHydration\(deliveries\)/);
});

test('desktop file actions only reveal an existing local asset', () => {
  const actionStart = app.indexOf('async function showDesktopAssetInFolder(');
  const actionEnd = app.indexOf('\nasync function hydrateDesktopAsset', actionStart);
  const actionSource = app.slice(actionStart, actionEnd);
  assert.match(actionSource, /showInFolder\(localAssetId\)/);
  assert.doesNotMatch(actionSource, /downloadRemote|applyDesktopLocalAsset|saveLocalAs|location\.|window\.open/);
});

test('completed generation cards require a saved local asset', () => {
  assert.match(app, /task\.status !== 'completed' \|\| Boolean\(task\.assetId && fileById\(task\.assetId\)\?\.localStatus === 'saved'\)/);
  assert.doesNotMatch(app, /api\/files\/\$\{encodeURIComponent\(file\.id\)\}\/download/);
});
