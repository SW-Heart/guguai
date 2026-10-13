import {mapImagesWithLimit} from '../public/features/media/image-cache.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {placeCanvasRow} from '../public/features/drama/canvas-layout.js';
import {importedImageBounds} from '../public/features/agent/image-bounds.js';
import {mediaFrameSize} from '../public/features/agent/frames.js';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const director=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const files=Array.from({length:120},(_,i)=>({id:`file-${i}`,kind:i%2?'video':'image'}));

test('canvas picker has no batch count limit while chat and generation keep their limits',async()=>{
  const context=vm.createContext({canvasAssetRequest:null,$:()=>({}),openReferenceDialog(){}});
  vm.runInContext(app.slice(app.indexOf('function pickAndImportDramaCanvasAsset('),app.indexOf("$('#uploadButton').onclick")),context);
  for(const [options,multiple,limit] of [[{multiple:true},true,Infinity],[{chat:true,multiple:true,maxFiles:80},true,30],[{generation:true,multiple:true},false,1]]){
    const result=context.pickAndImportDramaCanvasAsset(options);
    assert.equal(context.canvasAssetRequest.multiple,multiple);
    assert.equal(context.canvasAssetRequest.limit,limit);
    context.canvasAssetRequest.resolve(files);
    assert.equal((await result).length,120);
  }
});

test('uploading over 30 mixed canvas files retains all selected files',async()=>{
  let options,contextName;
  const context=vm.createContext({canvasAssetRequest:{multiple:true,limit:Infinity,chat:false},state:{files:[],dialogSelection:['existing']},
    desktopImportToContext:async(name,value)=>{contextName=name;options=value;return files;},renderReferenceDialog(){},toast:message=>assert.fail(message)});
  vm.runInContext(app.slice(app.indexOf('async function uploadCanvasDialogAsset()'),app.indexOf("$('#dialogUpload').onclick")),context);
  await context.uploadCanvasDialogAsset();
  assert.equal(options.multiple,true);assert.equal(options.maxFiles,Infinity);assert.equal(contextName,'director-canvas');
  assert.equal(context.state.files.length,120);assert.equal(context.state.dialogSelection.length,121);
});

test('batch import reveals and selects every item with one sync, focus and save',async()=>{
  const revealed=[],selected=[],focused=[];let syncs=0,saves=0;
  const positions={};
  const context=vm.createContext({mapImagesWithLimit,epoch:1,bridge:{importAsset:async()=>files,toast:message=>assert.fail(message)},
    liveCanvasNodes:()=>[],canvasView:()=>({width:1000,height:700}),workspace:()=>({positions}),placeCanvasRow,importedImageBounds,mediaFrameSize,
    syncing:false,automaticImageSizing:new Set(),assetImages:new Map(),assetSizes:new Map(),
    revealCanvasItem:id=>revealed.push(id),canvas:{getNodeConfigById:()=>null,selectNodes:ids=>selected.push([...ids])},syncCanvas:()=>syncs++,focusNewCanvasContent:ids=>focused.push([...ids]),save:async()=>saves++});
  vm.runInContext(director.slice(director.indexOf('  async function prepareImportedCanvasRow('),director.indexOf('  function syncCanvas()')),context);
  await context.importAssetIntoCanvas();
  assert.deepEqual(revealed,files.map(file=>file.id));assert.deepEqual(selected,[revealed]);assert.deepEqual(focused,[revealed]);
  assert.equal(syncs,1);assert.equal(saves,1);
  assert.equal(Object.keys(positions).length,120);
  assert.ok(Object.values(positions).every(position=>position.y===positions[files[0].id].y));
  await context.importAssetIntoCanvas({x:-120,y:345});
  assert.equal(positions[files[0].id].x,-120);assert.equal(positions[files[0].id].y,345);
  assert.equal(positions[files[1].id].x,-120+positions[files[0].id].width+32);
  assert.ok(Object.values(positions).every(position=>position.y===345));
  assert.equal(syncs,2);
  context.bridge.importAsset=async()=>null;await context.importAssetIntoCanvas();assert.equal(syncs,2);
  context.bridge.importAsset=async()=>{context.epoch++;return files;};await context.importAssetIntoCanvas();assert.equal(syncs,2);
});

test('row preparation waits for every image dimension before placement',async()=>{
  const pending=[];
  const context=vm.createContext({mapImagesWithLimit,epoch:1,assetImages:new Map(),assetSizes:new Map(),importedImageBounds,mediaFrameSize,
    Image:class {constructor(){this.naturalWidth=100;this.naturalHeight=1000;}decode(){return new Promise(resolve=>pending.push(resolve));}}});
  vm.runInContext(director.slice(director.indexOf('  async function prepareImportedCanvasRow('),director.indexOf('  async function importAssetIntoCanvas(')),context);
  let complete=false;
  const result=context.prepareImportedCanvasRow([{id:'a',kind:'image',url:'a.png'},{id:'b',kind:'image',url:'b.png'}],1).then(value=>{complete=true;return value;});
  pending[0]();await Promise.resolve();assert.equal(complete,false);
  pending[1]();const items=await result;
  assert.equal(items.length,2);assert.equal(items[0].width,22);assert.equal(items[0].height,220);
});
