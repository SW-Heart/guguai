import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
function setup(prepareChatAsset){
  const input={value:'保留我的草稿',focus(){}};
  const context={sending:false,switchingConversation:false,uploading:false,submissionQueue:[],drainingSubmissions:false,epoch:1,agentState:{id:'chat'},attachments:[],nodes:()=>[{id:'local',kind:'asset'},{id:'generated',kind:'generation',taskId:'task'}],bridge:{prepareChatAsset,toast(){}},drawPanels(){},host:{querySelector:selector=>selector==='#directorMessage'?input:{classList:{remove(){}},hidden:true}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function attachCanvasFiles'),source.indexOf('  function drawInspector')),context);
  return {context,input};
}
test('canvas files become cloud-backed composer attachments without replacing the draft',async()=>{
  const calls=[];
  const {context,input}=setup(async args=>{calls.push(args);return {id:args.assetId?'cloud-image':'cloud-video',name:'素材'};});
  await context.attachCanvasFiles(['local','generated']);
  assert.deepEqual(Array.from(context.attachments,f=>f.id),['cloud-image','cloud-video']);
  assert.equal(calls[0].assetId,'local');assert.equal(calls[1].taskId,'task');
  await context.attachCanvasFiles(['local']);
  assert.equal(context.attachments.length,2);assert.equal(input.value,'保留我的草稿');assert.equal(context.uploading,false);
});
test('failed uploads leave the draft and existing attachments intact',async()=>{
  const {context,input}=setup(async()=>{throw new Error('上传失败');});
  context.attachments.push({id:'existing'});
  await context.attachCanvasFiles(['local']);
  assert.equal(context.attachments.length,1);assert.equal(input.value,'保留我的草稿');assert.equal(context.uploading,false);
});
test('an upload cannot attach to a different conversation',async()=>{
  let resolve;
  const {context}=setup(()=>new Promise(done=>{resolve=done;}));
  const pending=context.attachCanvasFiles(['local']);
  context.agentState={id:'another'};resolve({id:'cloud'});await pending;
  assert.equal(context.attachments.length,0);
});

test('image actions submit the selected cloud file with a concrete editing request',async()=>{
  const {context}=setup(async()=>({id:'cloud-image',name:'photo.png'}));
  context.agentConfig={configured:true};
  let sent;
  context.submit=async(text,files,ids)=>{sent={text,files,ids};};
  vm.runInContext(source.slice(source.indexOf('  async function runImageAction'),source.indexOf('  async function downloadCanvasFiles')),context);
  await context.runImageAction('cutout',['local']);
  assert.match(sent.text,/透明背景/);assert.equal(sent.files[0].id,'cloud-image');assert.equal(sent.ids[0],'local');
  assert.equal(context.attachments.length,0);assert.equal(context.uploading,false);
  context.bridge.prepareChatAsset=async()=>{throw new Error('文件同步失败');};sent=null;
  await assert.rejects(context.runImageAction('upscale',['local']),/文件同步失败/);
  assert.equal(sent,null);assert.equal(context.uploading,false);
});

test('quick actions preserve unrelated composer attachments and text',async()=>{
  const {context,input}=setup(async()=>({id:'cloud'}));
  context.attachments.push({id:'draft-file',name:'draft.png'});
  context.save=async()=>{};
  let sent;
  context.agentClient={send:async(text,ids)=>{sent={text,ids};}};
  vm.runInContext(source.slice(source.indexOf('  function redrawComposer('),source.indexOf('  function dispose(')),context);
  await context.submit('增强清晰度',[{id:'action-file',name:'action.png'}],['local']);
  assert.match(sent.text,/action-file/);assert.doesNotMatch(sent.text,/draft-file/);
  assert.equal(context.attachments[0].id,'draft-file');assert.equal(input.value,'保留我的草稿');
});

test('every floating toolbar action has a specific translated tooltip',()=>{
  const menu=readFileSync(new URL('../scripts/director/reference-canvas/control/FloatingMenu.tsx',import.meta.url),'utf8');
  const translations=readFileSync(new URL('../scripts/director/reference-canvas-shims/i18n.ts',import.meta.url),'utf8');
  for(const [,key] of menu.matchAll(/i18n.t\('(common:canvas.quickActions.[^']+)'\)/g)){
    assert.ok(translations.includes(`'${key}': '`),key);
  }
});

test('chat resize isolates canvas state and restores the pre-resize scene',()=>{
  assert.match(source,/resizingChat=false, resizeCanvasSnapshot=null/);
  assert.match(source,/if\(syncing\|\|resizingChat\)return/);
  assert.match(source,/if\(resizingChat\)return;requestAnimationFrame\(alignCards\)/);
  assert.match(source,/event\.stopPropagation\(\);[\s\S]*resizeCanvasSnapshot=captureCanvasForResize\(\)/);
  assert.match(source,/restoreCanvasAfterResize\(\);[\s\S]*resizingChat=false/);
});
