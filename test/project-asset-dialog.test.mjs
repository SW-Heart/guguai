import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const studio = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('project asset dialog leaves the page layout after close', () => {
  assert.match(styles, /\.project-asset-dialog\[open\]\s*\{[^}]*display:\s*flex\s*;[^}]*\}/s);
  assert.match(styles, /\.project-asset-dialog:not\(\[open\]\)\s*\{[^}]*display:\s*none\s*;[^}]*\}/s);
});

test('project asset dialog uses one guarded lifecycle instance', () => {
  assert.match(studio, /querySelectorAll\('dialog#projectAssetDialog'\)/);
  assert.match(studio, /dialogs\.filter\(item=>item!==dialog\)\.forEach\(item=>\{releaseWorkbenchVideos\(item\);item\.remove\(\);\}\)/);
  assert.match(studio, /dialog\.dataset\.projectAssetLifecycleBound!=='true'/);
  assert.match(studio, /button\.onclick=closeProjectAssetDialog/);
});

function uploadHarness(uploadAsset) {
  let handler;
  const button = { disabled:false };
  const errors = [];
  let paints = 0;
  const context = {
    dialog:{ querySelector:() => ({ addEventListener:(_event, callback) => { handler=callback; } }) },
    uploadAsset, uploadImage:async () => ({ id:'fallback' }),
    projectRequest:() => 'current', assertProjectRequest:() => {},
    projectAssetSelection:['existing'], projectAssetCategory:'characters',
    projectAssetCategories:new Map(), state:{ files:[{ id:'existing' }, { id:'image', name:'old' }] },
    paintProjectAssetDialog:() => { paints+=1; }, toast:message => errors.push(message),
  };
  vm.createContext(context);
  const start = studio.indexOf("    dialog.querySelector('[data-project-asset-upload]')");
  const end = studio.indexOf("    dialog.querySelector('[data-project-asset-confirm]')", start);
  vm.runInContext(studio.slice(start,end), context);
  return { context, button, errors, paints:() => paints, click:() => handler({ currentTarget:button }) };
}

test('project upload requests multi-selection and merges every successful file once', async () => {
  const files = [{ id:'image', name:'new' }, { id:'video' }, { id:'audio' }];
  let options;
  const harness = uploadHarness(async value => { options=value; return [...files,files[0]]; });
  await harness.click();
  assert.equal(options.multiple,true);
  assert.equal(options.context,'professional-project');
  assert.deepEqual(Array.from(harness.context.projectAssetSelection),['existing','image','video','audio']);
  assert.deepEqual(Array.from(harness.context.projectAssetCategories),[['image','characters'],['video','characters'],['audio','characters']]);
  assert.deepEqual(Array.from(harness.context.state.files, file => file.id),['image','video','audio','existing']);
  assert.equal(harness.context.state.files[0].name,'new');
  assert.equal(harness.paints(),1);
  assert.equal(harness.button.disabled,false);
});

test('cancelled and failed project uploads keep the selection and allow another attempt', async () => {
  for (const upload of [async () => [], async () => { throw new Error('上传失败'); }]) {
    const harness=uploadHarness(upload);
    await harness.click();
    assert.deepEqual(Array.from(harness.context.projectAssetSelection),['existing']);
    assert.equal(harness.paints(),0);
    assert.equal(harness.button.disabled,false);
  }
});

test('project uploads prevent repeated clicks and ignore results after changing projects', async () => {
  let complete;
  let calls=0;
  const harness=uploadHarness(() => { calls+=1; return new Promise(resolve => { complete=resolve; }); });
  const pending=harness.click();
  assert.equal(harness.button.disabled,true);
  await harness.click();
  assert.equal(calls,1);
  harness.context.assertProjectRequest=() => { throw { stale:true }; };
  complete([{ id:'late' }]);
  await pending;
  assert.deepEqual(Array.from(harness.context.projectAssetSelection),['existing']);
  assert.equal(harness.paints(),0);
  assert.deepEqual(harness.errors,[]);
  assert.equal(harness.button.disabled,false);
});

test('project upload keeps the single-image fallback working', async () => {
  const harness=uploadHarness(null);
  await harness.click();
  assert.deepEqual(Array.from(harness.context.projectAssetSelection),['existing','fallback']);
});

test('desktop drama asset picker returns the complete batch when multiple is requested', async () => {
  const files=[{ id:'one' },{ id:'two' }];
  const calls=[];
  const context={ desktopImportToContext:async (context,options) => { calls.push({ context,options }); return files; } };
  vm.createContext(context);
  const start=app.indexOf('async function pickAndUploadDramaAsset(');
  const end=app.indexOf('\nfunction pickAndImportDramaCanvasAsset',start);
  vm.runInContext(app.slice(start,end),context);
  assert.equal(await context.pickAndUploadDramaAsset({ multiple:true }),files);
  assert.equal(calls[0].options.multiple,true);
  assert.equal(await context.pickAndUploadDramaAsset(),files[0]);
  assert.equal(calls[1].options.multiple,false);
});

test('batch upload changes reach the current versioned frontend entrypoints', async () => {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/\/app\.js\?v=508\b/);
  assert.match(app,/\.\/drama-studio\.js\?v=240\b/);
});

test('short-drama asset imports keep the local copy and skip cloud upload', async () => {
  const start = app.indexOf('async function desktopImportToContext(');
  const source = app.slice(start, app.indexOf('function openUploadPicker(', start));
  for (const target of ['professional-project', 'professional-reference', 'professional']) {
    const synced = [], jobs = [], notices = [];
    const items = [{id:'local-1',kind:'image',name:'角色.png',mimeType:'image/png',size:100},{id:'local-2',kind:'image',name:'场景.png',mimeType:'image/png',size:100}];
    const context = vm.createContext({
      window:{guguDesktop:{media:{chooseAndImport:async () => items,url:async id => `gugu-media://${id}`,syncLocal:async ({assetId}) => { synced.push(assetId); return {cloudAsset:{id:assetId}}; }}}},
      state:{},desktopMediaKind:item => item.kind,verifyImportedImagePreview:async () => {},
      desktopScope:{localAsset:item => ({...item,localId:item.id,localOnly:true,localStatus:'saved'})},
      mediaController:{mergeLocalAssets(){}},createUploadJob:() => { jobs.push(1); return {}; },
      renderReferenceDialog(){},resetReferenceDialogScroll(){},renderReferences(){},loadFiles:async () => {},toast:value => notices.push(value),console,
    });
    vm.runInContext(source, context);
    const files = await context.desktopImportToContext(target, {multiple:true});
    assert.deepEqual(Array.from(files, file => file.id), ['local-1','local-2']);
    assert.ok(files.every(file => file.localOnly && file.url.startsWith('gugu-media://')));
    assert.equal(synced.length, 0);
    assert.equal(jobs.length, 0);
    assert.ok(notices.includes('已添加 2 个素材'));
  }
});

test('generation uploads local references two at a time and reuses recent results', async () => {
  const start = studio.indexOf('  const cloudReferenceCache = new Map();');
  const source = studio.slice(start, studio.indexOf('  async function addLocalDramaAsset(', start));
  const files = Array.from({length:5}, (_, index) => ({id:`local-${index}`,kind:'image',localOnly:true,sha256:`hash-${index}`}));
  let active = 0, peak = 0;
  const synced = [];
  const context = vm.createContext({
    state:{files:[...files]},
    projectRequest:() => ({}),assertProjectRequest(){},assetMissing:() => false,
    asset:id => context.state.files.find(file => file.id === id),
    isRemoteReferenceReady:file => !file.localOnly,
    localAssetId:file => file.localOnly ? file.id : '',
    requireDesktopMedia:() => ({syncLocal:async ({assetId}) => {
      synced.push(assetId);active += 1;peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return {url:`gugu-media://${assetId}`,cloudAsset:{id:`cloud-${assetId}`,url:`/api/files/cloud-${assetId}/content`,remoteStatus:'ready'}};
    }}),
    Date,Promise,Array,Map,
  });
  vm.runInContext(source, context);
  const ids = files.map(file => file.id);
  assert.deepEqual(Array.from(await context.ensureCloudReferenceIds(ids)), ids.map(id => `cloud-${id}`));
  assert.equal(peak, 2);
  assert.equal(synced.length, 5);
  assert.deepEqual(Array.from(await context.ensureCloudReferenceIds(ids)), ids.map(id => `cloud-${id}`));
  assert.equal(synced.length, 5);
});

test('canvas generations and sent messages upload local files only at that moment', async () => {
  const director = await readFile(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
  const generate = director.slice(director.indexOf('  async function submitGenerationArea(){'), director.indexOf('  function mount() {'));
  assert.match(generate, /bridge\.prepareCloudFiles\(draft\.attachments\)[\s\S]*payload\.referenceAssetIds=ready\.map/);
  const send = director.slice(director.indexOf('  async function drainSubmissions(){'), director.indexOf('  function submit('));
  assert.match(send, /bridge\.prepareCloudFiles\(request\.files\)[\s\S]*client\.send\(content,\[\.\.\.new Set\(\[\.\.\.request\.selectionIds,\.\.\.files\.map/);
  for (const bridge of [studio, await readFile(new URL('../public/features/agent/workspace.js', import.meta.url), 'utf8')]) {
    const pick = bridge.slice(bridge.indexOf('      uploadGenerationFile:'), bridge.indexOf('      media:', bridge.indexOf('      uploadGenerationFile:')));
    assert.doesNotMatch(pick, /ensureCloudReferenceIds|cloudFile\(/);
  }
});
