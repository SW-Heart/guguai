import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const app = read('app.js'), director = read('features/drama/director-workspace.js');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const images = count => Array.from({length:count}, (_,i) => ({id:`image-${i}`,kind:'image',name:`图片 ${i}`}));

function dialogFixture(options = {chat:true,multiple:true,maxFiles:30}) {
  const nodes = new Map(), notices = [], files = images(31), buttons = files.map(file => ({dataset:{id:file.id}}));
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {close(){},showModal(){}});
    return nodes.get(selector);
  };
  const state = {files,uploadJobs:[],referenceTarget:'canvas',referenceKind:'all',dialogSelection:[]};
  const context = vm.createContext({
    state,canvasAssetRequest:null,referenceDialogCommitted:false,$:node,
    $$:selector => selector === '.reference-option' ? buttons : [],
    window:{guguDesktop:{}},toast:value => notices.push(value),esc:value => value,
    referenceFileById:id => state.files.find(file => file.id === id),
    referenceDialogLimitIds:() => state.dialogSelection,withoutSupersededLocalFiles:value => value,
    sortFilesByRecency:value => value,referenceMediaMarkup:() => '',pendingReferenceJob:() => null,
    resetReferenceDialogScroll(){},openReferenceDialog(){},
  });
  vm.runInContext(extract(app,'function pickAndImportDramaCanvasAsset(',"$('#uploadButton').onclick"),context);
  vm.runInContext(extract(app,'async function uploadCanvasDialogAsset(',"$('#dialogUpload').onclick"),context);
  vm.runInContext(extract(app,'function renderReferenceDialog(','function syncSegmentedControl('),context);
  // Use the real canvas-confirmation branch without the unrelated generation branch.
  const confirmation = extract(app,"$('#confirmReference').onclick = () => {",'  const pendingCount =');
  vm.runInContext(`${confirmation}\n};`,context);
  const result = context.pickAndImportDramaCanvasAsset(options);
  return {context,state,notices,buttons,node,result};
}

test('chat picker selects 30 images and confirms every file in selection order', async () => {
  const f = dialogFixture();
  f.context.renderReferenceDialog();
  for (const button of f.buttons) button.onclick();
  assert.equal(f.state.dialogSelection.length,30);
  assert.equal(f.node('#selectionCount').textContent,'已选择 30 / 30');
  assert.match(f.notices.at(-1),/30/);
  f.node('#confirmReference').onclick();
  assert.deepEqual(Array.from(await f.result, file => file.id),images(30).map(file => file.id));
});

test('mixed media share the 30-file allowance and unselecting restores capacity', () => {
  const f = dialogFixture();
  f.state.files.forEach((file,i) => { file.kind = ['image','video','audio'][i%3]; });
  f.context.renderReferenceDialog();
  for (const button of f.buttons) button.onclick();
  assert.equal(f.state.dialogSelection.length,30);
  f.buttons[0].onclick();f.buttons[30].onclick();
  assert.equal(f.state.dialogSelection.length,30);
  assert.equal(f.state.dialogSelection.at(-1),'image-30');
});

test('batch upload appends to selected files and receives the remaining capacity', async () => {
  const f = dialogFixture({chat:true,multiple:true,maxFiles:5}), calls = [];
  f.state.dialogSelection = ['image-0'];
  f.context.desktopImportToContext = async (context,options) => { calls.push({context,options});return images(4).slice(1); };
  await f.context.uploadCanvasDialogAsset();
  assert.deepEqual(Array.from(f.state.dialogSelection),images(4).map(file => file.id));
  assert.equal(calls[0].context,'director-chat');
  assert.equal(calls[0].options.multiple,true);
  assert.equal(calls[0].options.maxFiles,4);
  f.state.dialogSelection.push('image-4');
  await f.context.uploadCanvasDialogAsset();
  assert.equal(calls.length,1);
});

test('finishing an upload after the picker closes does not add stale selections', async () => {
  const f = dialogFixture();let complete;
  f.context.desktopImportToContext = () => new Promise(resolve => { complete = resolve; });
  const pending = f.context.uploadCanvasDialogAsset();
  f.context.canvasAssetRequest = null;complete(images(2));await pending;
  assert.equal(f.state.dialogSelection.length,0);
});

test('generation and canvas pickers keep their single-file return contract', async () => {
  for (const options of [{generation:true,multiple:true},{}]) {
    const f = dialogFixture(options);
    f.context.renderReferenceDialog();f.buttons[0].onclick();f.buttons[1].onclick();
    assert.equal(f.state.dialogSelection.length,1);
    f.node('#confirmReference').onclick();
    assert.equal((await f.result).id,'image-0');
  }
});

function conversationFixture() {
  const button = {},notices = [],calls = [];
  const context = vm.createContext({
    attachments:[],documentAttachments:[],uploading:false,switchingConversation:false,epoch:1,agentState:{id:'session'},
    host:{querySelector:() => button},drawPanels(){},
    bridge:{toast:value => notices.push(value),uploadChatFile:async options => { calls.push(options);return images(31); }},
  });
  vm.runInContext(extract(director,"    host.querySelector('[data-agent-upload]').onclick=",'    const saveSettingsButton='),context);
  return {context,button,notices,calls};
}

test('conversation upload retains all 30 images and blocks further batches', async () => {
  const f = conversationFixture();await f.button.onclick();
  assert.deepEqual(Array.from(f.context.attachments, file => file.id),images(30).map(file => file.id));
  assert.equal(f.calls[0].maxFiles,30);
  await f.button.onclick();assert.equal(f.calls.length,1);
  assert.match(f.notices.at(-1),/30/);
});

test('conversation allowance includes existing documents and skips duplicate files', async () => {
  const f = conversationFixture();f.context.documentAttachments = [{title:'文档'}];
  f.context.attachments = images(2);await f.button.onclick();
  assert.equal(f.calls[0].maxFiles,27);
  assert.equal(f.context.attachments.length,29);
  assert.equal(new Set(Array.from(f.context.attachments, file => file.id)).size,29);
});

test('switching conversations during a batch does not add old files', async () => {
  const f = conversationFixture();let complete;
  f.context.bridge.uploadChatFile = () => new Promise(resolve => { complete = resolve; });
  const pending = f.button.onclick();f.context.agentState = {id:'replacement'};complete(images(30));await pending;
  assert.equal(f.context.attachments.length,0);
  assert.equal(f.context.uploading,false);
});

test('desktop batch upload stops at 30 successful files before syncing the 31st', async () => {
  const synced = [],notices = [],items = images(31).map(file => ({...file,mimeType:'image/png',size:100}));
  let pickerOptions;
  const context = vm.createContext({
    window:{guguDesktop:{media:{chooseAndImport:async options => { pickerOptions = options;return items; },url:async id => `gugu-media://${id}`,syncLocal:async ({assetId}) => { synced.push(assetId);return {cloudAsset:{id:assetId}}; }}}},
    state:{},desktopMediaKind:() => 'image',verifyImportedImagePreview:async () => {},desktopScope:{localAsset:item => item},
    mediaController:{mergeLocalAssets(){}},createUploadJob:() => ({}),updateUploadJob(){},finishUploadJob(){},
    cloudAssetFromDesktopSync:value => value.cloudAsset,renderReferenceDialog(){},resetReferenceDialogScroll(){},renderReferences(){},loadFiles:async () => {},toast:value => notices.push(value),console,
  });
  vm.runInContext(extract(app,'async function desktopImportToContext(','function openUploadPicker('),context);
  const files = await context.desktopImportToContext('director-chat',{multiple:true,maxFiles:30});
  assert.equal(pickerOptions.multiple,true);
  assert.equal(files.length,30);assert.equal(synced.length,30);
  assert.ok(notices.some(value => /最多添加 30/.test(value)));
});

function agentBridgeFixture() {
  const saves = [], notices = [], files = images(30);
  const context = vm.createContext({
    navigationEpoch:1,current:() => true,project:{assetIds:[]},state:{files:[]},
    importCanvasAsset:async () => files,cloudFile:async file => file,
    toast:value => notices.push(value),saveCanvas:async value => saves.push(value),
  });
  const source = extract(read('features/agent/workspace.js'),'      uploadChatFile:','      uploadGenerationFile:').trim().replace(/,$/,'');
  vm.runInContext(`globalThis.bridge={${source}};`,context);
  return {context,saves,notices};
}

test('agent prepares every selected file and saves all 30 IDs together', async () => {
  const f = agentBridgeFixture();const files = await f.context.bridge.uploadChatFile();
  assert.deepEqual(Array.from(files,file => file.id),images(30).map(file => file.id));
  assert.equal(f.saves.length,1);
  assert.deepEqual(Array.from(f.saves[0].assetIds),images(30).map(file => file.id));
});

test('one failed image does not discard the rest of an agent batch', async () => {
  const f = agentBridgeFixture();
  f.context.cloudFile = async file => { if(file.id === 'image-1')throw new Error('读取失败');return file; };
  const files = await f.context.bridge.uploadChatFile();
  assert.equal(files.length,29);assert.equal(f.saves[0].assetIds.length,29);
  assert.match(f.notices[0],/读取失败/);
});

test('leaving a project during preparation cannot save old files to its replacement', async () => {
  const f = agentBridgeFixture();let complete,markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  f.context.cloudFile = () => new Promise(resolve => { complete = resolve;markStarted(); });
  const pending = f.context.bridge.uploadChatFile();await started;
  f.context.navigationEpoch++;complete(images(1)[0]);
  assert.equal((await pending).length,0);assert.equal(f.saves.length,0);
});

test('the short-drama conversation prepares all 30 selected files too', async () => {
  const context = vm.createContext({
    projectRequest:() => ({}),assertProjectRequest(){},importCanvasAsset:async () => images(30),
    state:{files:[]},ensureCloudReferenceIds:async ids => ids,assetPreviewUrl:() => '',toast(){},
  });
  const source = extract(read('drama-studio.js'),'      uploadChatFile:','      uploadGenerationFile:').trim().replace(/,$/,'');
  vm.runInContext(`globalThis.bridge={${source}};`,context);
  const files = await context.bridge.uploadChatFile();
  assert.deepEqual(Array.from(files,file => file.id),images(30).map(file => file.id));
});
