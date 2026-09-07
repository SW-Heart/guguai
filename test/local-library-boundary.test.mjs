import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDesktopScope } from '../public/platform/desktop-scope.js';
import { createDuomiProvider } from '../providers/duomi.mjs';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const mediaController = await readFile(new URL('../public/features/media/controller.js', import.meta.url), 'utf8');
const dramaStudio = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
const notificationController = await readFile(new URL('../public/features/notifications/controller.js', import.meta.url), 'utf8');
const marketing = await readFile(new URL('../public/marketing.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const marketingPages = await Promise.all(['home.html', 'features.html', 'pricing.html'].map(file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));
const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const generationRoute = await readFile(new URL('../server/routes/generations.mjs', import.meta.url), 'utf8');
const mediaArchive = await readFile(new URL('../services/media-archive.mjs', import.meta.url), 'utf8');

test('desktop file library reads only the local workspace', () => {
  assert.doesNotMatch(app, /function listRemoteFilesPage/);
  assert.doesNotMatch(app, /mergeDesktopFiles|enrichDesktopFiles|remoteFileCursor|remoteFileHasMore|remoteFileTotal/);
  assert.match(app, /createMediaController\(/);
  assert.match(mediaController, /async function listDesktopFiles\(/);
  assert.match(mediaController, /async function loadFiles\(/);
  assert.match(app, /mediaController\.libraryState\(\)/);
  assert.match(app, /function libraryFileMatches\(/);
});

test('completed generation status is not rewritten by local delivery state', () => {
  const start = app.indexOf('function taskDisplayStatus(');
  const end = app.indexOf('\n}', start) + 2;
  const source = app.slice(start, end);
  assert.match(source, /return task\?\.status/);
  assert.doesNotMatch(source, /['"]running['"]/);
});

test('desktop startup stays local and does not receive cross-device history', () => {
  const loadFilesStart = mediaController.indexOf('async function loadFiles(');
  const loadFilesEnd = mediaController.indexOf('\n  async function removeLocalAsset', loadFilesStart);
  const loadFilesSource = mediaController.slice(loadFilesStart, loadFilesEnd);
  assert.doesNotMatch(loadFilesSource, /syncDesktopDeliveries|\/api\/files/);
  const enterAppStart = app.indexOf('async function enterApp(');
  const enterAppEnd = app.indexOf('\nlet accountSettingsRestoreFocus', enterAppStart);
  const enterAppSource = app.slice(enterAppStart, enterAppEnd);
  assert.doesNotMatch(enterAppSource, /syncHistoricalCloudAssets|scheduleDesktopAssetSync/);
  assert.match(mediaController, /async function claimLegacyWorkspace\(user\)/);
  assert.match(server, /\/api\/workspaces\/claim-legacy/);
  const scope = createDesktopScope({ getWindow: () => ({ guguDesktop: {} }), getSyncInfo: () => ({ deviceId: 'device-1', workspaceId: 'workspace-1' }) });
  assert.deepEqual(scope.headers(), { 'X-GuGu-Desktop': '1', 'X-GuGu-Device-Id': 'device-1', 'X-GuGu-Workspace-Id': 'workspace-1' });
  assert.match(desktopMain, /details\.requestHeaders\['X-GuGu-Workspace-Id'\] = workspaceId/);
  assert.doesNotMatch(app, /async function syncHistoricalCloudAssets\(/);
});

test('each login activates its account workspace before the legacy claim', () => {
  const enterAppStart = app.indexOf('async function enterApp(');
  const enterAppEnd = app.indexOf('\nlet accountSettingsRestoreFocus', enterAppStart);
  const enterAppSource = app.slice(enterAppStart, enterAppEnd);
  assert.ok(enterAppSource.indexOf('await activateDesktopAccount(user)') < enterAppSource.indexOf('await claimLegacyWorkspace(user)'));
  assert.match(app, /accountLifecycle\.activate\(user, account => bridge\.workspace\.activateAccount\(String\(account\.id\)\)\)/);
  assert.match(app, /workspace\?\.deactivateAccount\?\.\(\)/);
});

test('frontend entrypoints use the current immutable cache keys', () => {
  assert.match(index, /\/app\.js\?v=252/);
  assert.match(index, /\/styles\.css\?v=217/);
  assert.match(index, /\/styles\/base\.css\?v=2/);
  assert.match(app, /\.\/desktop-media-sync\.js\?v=11/);
  assert.match(app, /\.\/drama-studio\.js\?v=87/);
  assert.match(app, /\.\/state\/account-scope\.js\?v=2/);
  assert.match(app, /\.\/features\/media\/controller\.js\?v=5/);
  assert.match(dramaStudio, /\.\/features\/drama\/pure\.js\?v=3/);
  assert.match(app, /\.\/state\/account-state\.js\?v=1/);
  assert.match(app, /\.\/state\/account-lifecycle\.js\?v=1/);
});


test('account-scoped loaders ignore responses from an older session', () => {
  const creditsStart = app.indexOf('async function loadCredits()');
  const creditsEnd = app.indexOf('\nfunction setCreditPopoverOpen', creditsStart);
  assert.match(app, /const accountScope = createAccountScope\(\{ getUser: \(\) => state\.user \}\)/);
  assert.match(app.slice(creditsStart, creditsEnd), /const requestAccount = accountScope\.snapshot\(\)/);
  assert.match(app.slice(creditsStart, creditsEnd), /accountScope\.isCurrent\(requestAccount\)/);
  assert.match(notificationController, /const requestAccount = accountSnapshot\(\)/);
  assert.match(notificationController, /isAccountCurrent\(requestAccount\)/);
  assert.match(app, /const alipayOrderStorageKey = user =>/);
  assert.match(app, /sessionStorage\.setItem\(alipayOrderStorageKey\(state\.user\)/);
  assert.doesNotMatch(app, /sessionStorage\.setItem\('gugu_alipay_order'/);
  assert.match(marketing, /const paymentOrderStorageKey = user =>/);
  assert.doesNotMatch(marketing, /sessionStorage\.(?:getItem|setItem|removeItem)\('gugu_alipay_order'/);
  assert.match(marketing, /sessionStorage\.setItem\(paymentOrderStorageKey\(purchaseUser\)/);
  marketingPages.forEach(page => assert.match(page, /\/marketing\.js\?v=9/));
  assert.match(app, /const requestAccount = accountScope\.snapshot\(\);\n  const button = \$\('#alipayTopupButton'\)/);
  assert.match(app, /const result = await api\(`\/api\/payments\/alipay\/orders\/\$\{encodeURIComponent\(state\.alipayOrderNo\)\}\/query`[\s\S]*?if \(!accountScope\.isCurrent\(requestAccount\)\) return;/);
  const loadTasksStart = app.indexOf('async function loadTasks(');
  const loadTasksEnd = app.indexOf('\nfunction localFileAction', loadTasksStart);
  assert.match(app.slice(loadTasksStart, loadTasksEnd), /const requestAccount = accountScope\.snapshot\(\)/);
  assert.match(app.slice(loadTasksStart, loadTasksEnd), /if \(!accountScope\.isCurrent\(requestAccount\)\) return state\.tasks;/);
  assert.match(app, /const accountLifecycle = createAccountLifecycle\(/);
  assert.match(app, /resetState:clearDesktopAccountState/);
  assert.match(app, /accountLifecycle\.invalidate\(\);/);
  assert.match(app, /async function activateDesktopAccount\(user\)[\s\S]*?await accountLifecycle\.activate\(user,[\s\S]*?bridge\.workspace\.activateAccount/);
  assert.match(app, /async function enterApp\(user\)[\s\S]*?await activateDesktopAccount\(user\)/);
  assert.match(app, /const startupRequest = accountLifecycle\.snapshot\(\)/);
  assert.match(app, /const isStartupCurrent = \(\) => accountLifecycle\.isCurrent\(startupRequest\)/);
  assert.match(app, /if \(!isStartupCurrent\(\)\) return;/);
  assert.match(app, /tasksRequest = null;/);
  assert.match(app, /dramaController\?\.resetForAccount\?\.\(\)/);
  assert.match(app, /resetAccountState\(state\)/);
  assert.match(dramaStudio, /function resetForAccount\(\)/);
  assert.match(dramaStudio, /const projectRequest = \(\) =>/);
  assert.match(dramaStudio, /const assertProjectRequest = request =>/);
});

test('short-drama event chains stop after a project becomes stale', () => {
  assert.match(dramaStudio, /async function closeProject\(\)[\s\S]*?const request=projectRequest\(\)[\s\S]*?assertProjectRequest\(request\)/);
  assert.match(dramaStudio, /async function navigateStep\(step,request=projectRequest\(\)\)/);
  assert.match(dramaStudio, /async function advanceStep\(step,request=projectRequest\(\)\)/);
  assert.match(dramaStudio, /async function saveAllShots\(quiet=false,request=projectRequest\(\)\)/);
  assert.match(dramaStudio, /saveAllShots\(true,request\)\)await advanceStep\('video',request\)/);
  assert.match(dramaStudio, /advanceStep\('storyboard',request\)/);
  assert.match(dramaStudio, /async function continueProfessionalScript\(\)[\s\S]*?assertProjectRequest\(request\)[\s\S]*?if\(!result\)return/);
  assert.match(dramaStudio, /async function confirmScriptReview\(\)[\s\S]*?assertProjectRequest\(request\)[\s\S]*?if\(!result\)return/);
  assert.match(dramaStudio, /await patch\(\{ assemblyVideos:project\.assemblyVideos \}, \{ quiet:true \}\);\s*assertProjectRequest\(request\)/);
  assert.match(dramaStudio, /const request=projectRequest\(\);\s*const shot=project\.shots\.find\(item=>item\.id===id\);[\s\S]*?assertProjectRequest\(request\);[\s\S]*?const targetProjectId=request\.projectId/);
});

test('short-drama project opening does not wait for the full local library or gallery works', () => {
  const openStart = dramaStudio.indexOf('async function openProject(');
  const openEnd = dramaStudio.indexOf('\n  async function closeProject', openStart);
  const openSource = dramaStudio.slice(openStart, openEnd);
  assert.doesNotMatch(openSource, /await loadFiles\(/);
  assert.match(openSource, /loadTasks\(\{background:true,projectOnly:true\}\)/);
  const loadTasksStart = app.indexOf('async function loadTasks(');
  const loadTasksEnd = app.indexOf('\nfunction localFileAction', loadTasksStart);
  const loadTasksSource = app.slice(loadTasksStart, loadTasksEnd);
  assert.match(loadTasksSource, /projectOnly=false/);
  assert.match(loadTasksSource, /activeOnly \? activeIds : \[\.\.\.projectTaskIds\]/);
  assert.match(loadTasksSource, /const assetTasks = projectOnly \? hydratedTasks : tasks/);
  assert.match(loadTasksSource, /void syncDesktopDeliveries\(\{ assetIds:missingAssetIds \}\)/);
});

test('generation workspace separates works from paginated history', () => {
  assert.match(index, /data-generation-view="works"/);
  assert.match(index, /data-generation-view="history"/);
  assert.doesNotMatch(index, /data-status="(?:all|completed|running)"/);
  assert.doesNotMatch(index, /class="view-toggle/);
  assert.match(app, /api\('\/api\/generations\?view=works&limit=200'/);
  assert.match(app, /URLSearchParams\(\{ view:'history', type:kind, limit:'50' \}\)/);
  assert.match(app, /failedWorkRetentionMs = 5 \* 60 \* 1000/);
  assert.match(app, /setTimeout\(\(\) => expireTransientFailure/);
  assert.match(app, /activeOnly:true/);
});

test('history rows keep status, time, credit, and actions in shared columns', () => {
  assert.match(styles, /\.generation-history-row \{ --history-actions-width: 120px;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) var\(--history-actions-width\)/);
  assert.match(styles, /\.history-open \{ width: 100%;[\s\S]*?grid-template-columns: 56px minmax\(120px, 1fr\) 88px 150px 88px/);
  assert.match(styles, /\.history-actions \{ width: var\(--history-actions-width\); min-width: var\(--history-actions-width\)/);
  assert.match(app, /const creditMarkup = `.*history-credit/s);
});

test('pending video references always insert a real mention node', () => {
  const insertStart = app.indexOf('function insertVideoPromptMentions(');
  const insertEnd = app.indexOf('\nconst formatBytes', insertStart);
  const insertSource = app.slice(insertStart, insertEnd);
  assert.match(insertSource, /videoPromptMentionMarkup\(mention, file\)/);
  assert.match(insertSource, /if \(!chip\) \{/);
  assert.ok(insertSource.indexOf('if (!chip) {') < insertSource.indexOf('range.insertNode(chip)'));
});

test('image prompt supports reference mentions and compiles them before submission', () => {
  assert.match(index, /id="imagePrompt" class="rich-prompt-editor" contenteditable="true"/);
  assert.match(app, /function insertImagePromptMentions\(/);
  assert.match(app, /openReferenceDialog\('image', \{ mentionRequest:imagePromptMentionRequest \}\)/);
  assert.match(app, /prompt:replaceAssetMentions\(prompt, state\.imagePromptMentions\)/);
  assert.match(app, /data-image-prompt-mention-id/);
  assert.match(app, /button\.dataset\.target === 'image'\) removeImagePromptMentionNodes/);
});

test('desktop updater uses single-range differential downloads for Aliyun OSS', () => {
  assert.match(desktopMain, /setFeedURL\(\{ provider: 'generic', url: `\$\{url\}\/`, useMultipleRangeRequest:false \}\)/);
  assert.match(desktopMain, /disableDifferentialDownload = false/);
});

test('byte-identical outputs from different cloud assets keep separate local indexes', () => {
  assert.match(desktopMain, /pathOwner\.cloudAssetId !== cloudAssetId/);
  assert.match(desktopMain, /createHash\('sha256'\)\.update\(cloudAssetId\)/);
  assert.match(desktopMain, /targetName = `\$\{sha256\.slice\(0, 16\)\}-\$\{cloudSuffix\}-\$\{normalizedName\}`/);
});

test('generation submission is idempotent across duplicate form and HTTP events', () => {
  const submitStart = app.indexOf('async function submitGeneration(');
  const submitEnd = app.indexOf("\n$('#imageForm').onsubmit", submitStart);
  const submitSource = app.slice(submitStart, submitEnd);
  assert.match(app, /const generationSubmissionForms = new WeakSet\(\)/);
  assert.match(submitSource, /generationSubmissionForms\.has\(form\)/);
  assert.match(submitSource, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(submitSource, /referenceAssetIds, requestId/);
  assert.match(generationRoute, /id:taskIds\[index\]/);
  assert.match(generationRoute, /const existingTasks = tasks\.map\(task => findGeneration\(user\.id, task\.id, scope\)\)/);
  assert.match(server, /if \(activeGenerations\.has\(task\.id\)\) return activeGenerations\.get\(task\.id\)/);
});

test('legacy workspace claim uses only the local index and runs once per workspace', () => {
  const claimStart = mediaController.indexOf('async function claimLegacyWorkspace(');
  const claimEnd = mediaController.indexOf('\n  async function loadFiles', claimStart);
  const claimSource = mediaController.slice(claimStart, claimEnd);
  assert.match(claimSource, /listDesktopFiles\(\{ limit:200, cursor \}\)/);
  assert.match(claimSource, /\/api\/workspaces\/claim-legacy/);
  assert.match(claimSource, /localStorage\.setItem\(marker, 'complete'\)/);
  assert.doesNotMatch(claimSource, /listHistoricalCloudAssetsPage|hydrateDesktopAsset/);
});

test('workspace boot exposes progress for the initial load', () => {
  assert.match(index, /id="bootProgress"/);
  assert.match(index, /role="progressbar"/);
  assert.match(app, /function setBootProgress\(/);
  assert.match(app, /const initialLoadSteps = \[/);
  assert.doesNotMatch(app, /updateHistoryProgress\(scanned/);
  assert.match(app, /progress:8, progressLabel:'准备本地工作区'/);
});

test('generation polling resolves completed media from the local index only', () => {
  const loadTasksStart = app.indexOf('async function loadTasks(');
  const loadTasksEnd = app.indexOf('\nfunction localFileAction', loadTasksStart);
  const loadTasksSource = app.slice(loadTasksStart, loadTasksEnd);
  assert.match(loadTasksSource, /media\.listLocalByCloudIds\(missingAssetIds\.slice\(index, index \+ 500\)\)/);
  assert.doesNotMatch(loadTasksSource, /api\(`\/api\/files\//);
  assert.doesNotMatch(loadTasksSource, /queueDesktopHydration/);
});

test('a completed desktop hydration invalidates older local-library snapshots', () => {
  const applyStart = mediaController.indexOf('function applyDesktopLocalAsset(');
  const applyEnd = mediaController.indexOf('\n  async function removeDesktopCloudAssets', applyStart);
  const applySource = mediaController.slice(applyStart, applyEnd);
  const loadFilesStart = mediaController.indexOf('async function loadFiles(');
  const loadFilesEnd = mediaController.indexOf('\n  async function removeLocalAsset', loadFilesStart);
  const loadFilesSource = mediaController.slice(loadFilesStart, loadFilesEnd);
  assert.match(mediaController, /mergeDesktopAssetRecord\(previousById\.get\(file\.id\), file\)/);
  assert.ok(applySource.indexOf('localFileStateRevision += 1') < applySource.indexOf('mergeStateFiles([file])'));
  assert.match(loadFilesSource, /const localStateChanged = requestLocalStateRevision !== localFileStateRevision/);
  assert.match(loadFilesSource, /mergeStateFiles\(page\.items\)/);
  assert.doesNotMatch(loadFilesSource, /state\.files = mergeTransientFields/);
});

test('targeted missing-file repairs bypass stale local-ready delivery state', () => {
  const syncStart = mediaController.indexOf('async function syncDesktopDeliveries(');
  const syncEnd = mediaController.indexOf('\n  async function claimLegacyWorkspace', syncStart);
  const syncSource = mediaController.slice(syncStart, syncEnd);
  assert.match(syncSource, /await desktopSyncRequest/);
  assert.match(syncSource, /const currentDeliveries = deliveries\.map\(file => fileById\(file\.id\) \|\| file\)/);
  assert.match(syncSource, /queueDesktopHydration\(currentDeliveries, \{ forceAssetIds:requestedAssetIds \}\)/);
  assert.match(mediaController, /shouldHydrateDesktopAsset\(file, \{ force:forced \}\)/);
});

test('remote cloud deletion removes only the matching local cloud copy', () => {
  const syncStart = mediaController.indexOf('async function syncDesktopDeliveries(');
  const syncEnd = mediaController.indexOf('\n  async function claimLegacyWorkspace', syncStart);
  const syncSource = mediaController.slice(syncStart, syncEnd);
  assert.match(syncSource, /change\?\.action === 'delete'/);
  assert.match(syncSource, /removeDesktopCloudAssets\(deletedCloudAssetIds\)/);
  assert.match(mediaController, /removeLocalByCloudIds/);
  assert.match(syncSource, /queueDesktopHydration\(currentDeliveries, \{ forceAssetIds:requestedAssetIds \}\)/);
});

test('library video deletion updates the owning drama assembly history', () => {
  assert.match(mediaController, /await removeDramaAssemblyAssets\(ids, projectId\)/);
  assert.match(mediaController, /if \(file\.kind === 'video'\) await removeDramaAssemblyAssets\(\[file\.id\], file\.projectId\)/);
  assert.match(app, /removeDramaAssemblyAssets:\(assetIds, projectId\)/);
  assert.match(dramaStudio, /async function removeAssemblyVideosForAssets\(assetIds, projectId = ''\)/);
  assert.match(dramaStudio, /removeAssemblyVideoAssets\(project, assetIds\)/);
});

test('desktop sync consumes asset upserts and queues them for local hydration', () => {
  const syncStart = mediaController.indexOf('async function syncDesktopDeliveries(');
  const syncEnd = mediaController.indexOf('\n  async function claimLegacyWorkspace', syncStart);
  const syncSource = mediaController.slice(syncStart, syncEnd);
  assert.match(syncSource, /change\?\.action === 'upsert' && change\.asset\?\.id/);
  assert.match(syncSource, /\.map\(change => change\.asset\)/);
  assert.match(syncSource, /\.\.\.changedAssets/);
  assert.match(syncSource, /queueSavedDesktopAcknowledgements\(currentDeliveries\)/);
  assert.match(syncSource, /queueDesktopHydration\(currentDeliveries/);
});

test('generation fallback archive refreshes state around network waits', () => {
  const archiveSource = mediaArchive;
  assert.match(archiveSource, /const beforeUpload = findAsset\(userId, assetId\)/);
  assert.match(archiveSource, /const latest = findAsset\(userId, assetId\)/);
  assert.match(archiveSource, /deliveryStatus === 'local_ready'/);
  assert.match(archiveSource, /\.\.\.\(latest \|\| beforeUpload \|\| existing \|\| \{\}\)/);
});

test('production archive wiring provides its runtime storage dependencies', () => {
  const start = server.indexOf('const mediaArchive = createMediaArchiveService({');
  const end = server.indexOf('\n});', start) + 4;
  const wiring = server.slice(start, end);
  assert.match(wiring, /download:downloadToFile/);
  assert.match(wiring, /put:putObject/);
  assert.match(wiring, /remove:deleteObject/);
});

test('desktop file actions only reveal an existing local asset', () => {
  const actionStart = mediaController.indexOf('async function showAssetInFolder(');
  const actionEnd = mediaController.indexOf('\n  async function hydrateDesktopAsset', actionStart);
  const actionSource = mediaController.slice(actionStart, actionEnd);
  assert.match(actionSource, /showInFolder\(localAssetId\)/);
  assert.doesNotMatch(actionSource, /downloadRemote|applyDesktopLocalAsset|saveLocalAs|location\.|window\.open/);
});

test('completed generation cards stay visible while requiring a saved local asset for preview', () => {
  assert.match(app, /task\.status !== 'completed' \|\| Boolean\(task\.assetId\)/);
  assert.match(app, /const localReady = Boolean\(asset && asset\.localStatus === 'saved' && !localSyncing\)/);
  assert.match(app, /That gap is loading, not a missing result/);
  assert.doesNotMatch(app, /<b>成品文件未找到<\/b>/);
  assert.doesNotMatch(app, /api\/files\/\$\{encodeURIComponent\(file\.id\)\}\/download/);
});

test('failed generation details render an explanation instead of a loading spinner', () => {
  const detailStart = app.indexOf('function openGenerationDetail(');
  const detailEnd = app.indexOf('\nfunction copyTextFallback', detailStart);
  const detailSource = app.slice(detailStart, detailEnd);
  assert.match(detailSource, /const detailFailure = task\.status === 'failed' \? taskFailure\(task\) : null/);
  assert.match(detailSource, /detailFailure[\s\S]*?role="alert"/);
});

test('Duomi provider exposes an explicit factory contract', () => {
  assert.equal(typeof createDuomiProvider, 'function');
  assert.throws(() => createDuomiProvider(), /缺少 fetchJson 依赖/);
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
  assert.match(loadTasksSource, /const projectTaskIdsToHydrate = projectOnly \? \[\] : \[\.\.\.projectTaskIds\];/);
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

test('repeated storyboard assembly keeps independent outputs and protects footer clicks', () => {
  assert.match(desktopMain, /async function importFile\(filePath, \{ dedupe = true \} = \{\}\)/);
  assert.match(desktopMain, /const imported = await importFile\(output, \{ dedupe: false \}\);/);
  assert.match(dramaStudio, /id:`assembly_\$\{crypto\.randomUUID\(\)\}`, assetId:result\.id/);
  assert.doesNotMatch(dramaStudio, /project\.assemblyVideos = \[record, \.\.\.\(project\.assemblyVideos \|\| \[\]\)\.filter\(item => item\.assetId !== result\.id\)\]/);
  assert.match(dramaStudio, /if\(changed\)scheduleFlushDeferredProfessionalRender\(\);/);
  assert.match(dramaStudio, /if\(actionBar\)\{deferredProfessionalRender=false;return;\}/);
  assert.match(dramaStudio, /actionBar\.addEventListener\('pointerdown'/);
  assert.match(dramaStudio, /actionBar\.addEventListener\('click'/);
  assert.match(styles, /\.storyboard-workbench \.wb-action-bar \{[\s\S]*?z-index: 100;/);
  assert.match(styles, /\.storyboard-workbench \.wb-action-bar \.wb-assembly-library \{[\s\S]*?cursor: pointer;/);
  assert.match(styles, /\.toast \{[^\n]*pointer-events: none;/);
});

test('storyboard assembly can select any ready shot subset and version combination', () => {
  assert.match(dramaStudio, /function professionalAssemblyCandidates\(\)/);
  assert.match(dramaStudio, /function assemblySelectionItems\(candidates,selection\)/);
  assert.match(dramaStudio, /async function assembleDramaLocally\(selectedItems=null\)/);
  assert.match(dramaStudio, /data-assembly-include/);
  assert.match(dramaStudio, /data-assembly-version/);
  assert.match(dramaStudio, /performProfessionalAssembly\(event\.currentTarget,selectedItems\)/);
  assert.match(dramaStudio, /confirm\.disabled=items\.length<2/);
});
