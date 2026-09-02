import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const dramaStudio = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
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
  assert.match(app, /async function listHistoricalCloudAssetsPage\(cursor = ''/);
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

test('frontend entrypoints use the current immutable cache keys', () => {
  assert.match(index, /\/app\.js\?v=201/);
  assert.match(app, /\.\/drama-studio\.js\?v=64/);
});

test('historical receive resumes from a per-page checkpoint and acknowledges in batches', () => {
  assert.match(app, /function readHistoricalSyncCheckpoint\(marker\)/);
  assert.match(app, /function writeHistoricalSyncCheckpoint\(marker/);
  assert.match(app, /async function acknowledgeDesktopAssets\(entries\)/);
  const syncStart = app.indexOf('async function syncHistoricalCloudAssets(');
  const syncEnd = app.indexOf('\nasync function runDesktopHydrationQueue', syncStart);
  const syncSource = app.slice(syncStart, syncEnd);
  // 断点必须从已持久化的游标续传，而不是每次都从头扫描。
  assert.match(syncSource, /let cursor = checkpoint\.cursor;/);
  assert.match(syncSource, /let scanned = checkpoint\.scanned;/);
  // 已在本地的素材只允许走批量确认，逐条确认会退化成上万次 HTTP 往返。
  assert.match(syncSource, /await acknowledgeDesktopAssets\(present\)/);
  assert.doesNotMatch(syncSource, /await acknowledgeDesktopAsset\(/);
  // 出现可重试失败的那一页之后不得再前移游标。
  assert.match(syncSource, /if \(pageFailures\) checkpointClean = false;/);
  assert.match(syncSource, /if \(checkpointClean\) writeHistoricalSyncCheckpoint\(marker/);
});

test('workspace boot exposes progress for the initial load', () => {
  assert.match(index, /id="bootProgress"/);
  assert.match(index, /role="progressbar"/);
  assert.match(app, /function setBootProgress\(/);
  assert.match(app, /const initialLoadSteps = \[/);
  assert.match(app, /updateHistoryProgress\(scanned, scanned \? '正在继续接收历史素材' : '正在扫描历史素材'\)/);
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

test('completed generation cards stay visible while requiring a saved local asset for preview', () => {
  assert.match(app, /task\.status !== 'completed' \|\| Boolean\(task\.assetId\)/);
  assert.match(app, /const localReady = Boolean\(asset && asset\.localStatus === 'saved' && !localSyncing\)/);
  assert.match(app, /task\.assetId && !localSyncing/);
  assert.doesNotMatch(app, /api\/files\/\$\{encodeURIComponent\(file\.id\)\}\/download/);
});

test('task polling updates rich short-drama state independently from gallery cards', () => {
  assert.match(app, /const stateChanged = listSignature\(state\.tasks, taskSignatureFields\)/);
  assert.match(app, /const cardsChanged = listSignature\(state\.tasks, taskCardSignatureFields\)/);
  assert.match(app, /if \(stateChanged\) state\.tasks = tasks/);
  assert.match(app, /if \(stateChanged \|\| assetsChanged\) dramaController\?\.refreshTasks\?\.\(\)/);
});

test('project-bound generation statuses override the paginated gallery snapshot', () => {
  const loadTasksStart = app.indexOf('async function loadTasks(');
  const loadTasksEnd = app.indexOf('\nfunction localFileAction', loadTasksStart);
  const loadTasksSource = app.slice(loadTasksStart, loadTasksEnd);
  assert.match(loadTasksSource, /const projectTaskIdsToHydrate = \[\.\.\.projectTaskIds\];/);
  assert.match(loadTasksSource, /\/api\/generations\?ids=\$\{encodeURIComponent\(ids\.join\(','\)\)\}/);
  assert.match(loadTasksSource, /hydratedTasks\[index\] = task/);
});

test('short-drama completed tasks wait for local assets before becoming selectable', () => {
  assert.match(dramaStudio, /generationNeedsLocalAssetSync\(task\(id\), taskAsset\(id\), assetSyncing\)/);
  assert.match(dramaStudio, /file\.localStatus === 'saved'/);
  assert.match(dramaStudio, /!generated\.assetId\|\|!taskLocallyReady\(item\.taskId\)/);
  assert.match(dramaStudio, /function resourceVersionCard[\s\S]*?const syncing=taskSyncing\(taskId\); const ready=taskLocallyReady\(taskId\)/);
  assert.match(dramaStudio, /function videoVersion[\s\S]*?const syncing=taskSyncing\(id\);const ready=taskLocallyReady\(id\)/);
});

test('short-drama task refresh deferred during editing is replayed after blur', () => {
  const refreshStart = dramaStudio.indexOf('function refreshTasks()');
  const refreshEnd = dramaStudio.indexOf('\n  function renderProfessionalShotWindow', refreshStart);
  const refreshSource = dramaStudio.slice(refreshStart, refreshEnd);
  assert.match(refreshSource, /deferProfessionalRender\(\);\s*active\.addEventListener\('blur',scheduleFlushDeferredProfessionalRender,\{once:true\}\)/);
});
