import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/drama-studio.js',import.meta.url),'utf8');
const costSource=source.slice(source.indexOf('  function professionalVideoCostState('),source.indexOf('  function ensureProfessionalVideoSettings('));
function pricingContext(prices){
  const context={state:{config:{modelPrices:prices}},professionalVideoUsesDynamicQuote:()=>true,canonicalVideoModelId:id=>id,creditText:String};
  vm.createContext(context);vm.runInContext(costSource,context);return context;
}
test('routed video estimates update synchronously with duration, quality and quantity',()=>{
  const context=pricingContext([{modelId:'seedance-2.0',quality:'720p',credits:2.5,unit:'second'},{modelId:'seedance-2.0',quality:'480p',credits:1,unit:'second'}]);
  const shot={duration:15,generation:{modelId:'seedance-2.0',quality:'720p',count:2}};
  assert.equal(context.professionalVideoCostState(shot).credits,75);
  shot.duration=10;shot.generation.quality='480p';shot.generation.count=4;
  assert.equal(context.professionalVideoCostState(shot).credits,40);
});
test('missing catalog prices never block submitting a task or invent a zero price',()=>{
  const result=pricingContext([]).professionalVideoCostState({duration:15,generation:{modelId:'seedance-2.0',quality:'720p'}});
  assert.equal(result.ready,true);assert.equal(result.credits,null);
});
test('generation paints its pending preview before the save resolves and never requests a quote',async()=>{
  let release;const save=new Promise(resolve=>release=resolve);let renders=0;let submissions=0;
  const shot={id:'s',script:'内容',duration:15,generation:{modelId:'seedance-2.0',count:1}};
  const context={project:{id:'p',shots:[shot]},currentProfessionalShot:()=>shot,professionalGenerationPending:new Set(),refreshProfessionalPrices:()=>Promise.resolve(),projectRequest:()=>({}),ensureProfessionalVideoSettings(){},professionalProductionWarning:()=>'',shotGenerationReady:()=>true,render:()=>renders++,flushSave:()=>save,isProjectRequestCurrent:()=>true,cloneProjectValue:structuredClone,shotGenerationAssetIds:()=>[],videoRequestShot:s=>s,shotVideoPrompt:s=>s.script,ensureCloudReferenceIds:async()=>[],api:async url=>{assert.equal(url,'/api/generations');submissions++;return {id:'task'};},state:{tasks:[]},setCreditBalance(){},scheduleTaskPoll(){},loadTasks:async()=>{},loadCredits:async()=>{},toast(){}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  async function generateProfessionalVideo(){'),source.indexOf('  async function selectProfessionalVideo(')),context);
  const pending=context.generateProfessionalVideo();
  assert.equal(renders,1);assert.equal(context.professionalGenerationPending.has('s'),true);
  await context.generateProfessionalVideo();assert.equal(submissions,0);
  release();await pending;assert.equal(submissions,1);assert.equal(context.professionalGenerationPending.size,0);
});

test('startup task refresh preserves numeric credits while updating the action label',()=>{
  const credits={textContent:'37.5'};
  const action={textContent:'生成'};
  const card={classList:{toggle(){}},querySelector:selector=>{
    // The nested credit value is also a last child and is encountered first.
    if(selector==='[data-wb-generate] span:last-child')return credits;
    if(selector==='[data-wb-generate-label]')return action;
    return null;
  }};
  let status='completed';
  const context={project:{shots:[{id:'s',selectedVideoTaskId:'t'}]},state:{route:'drama',tasks:[],files:[]},
    patchProfessionalAssetSurfaces(){},taskDisplayStatus:()=>status,taskLocallyReady:()=>status==='completed',
    root:{querySelector:selector=>selector.startsWith('[data-wb-shot=')?card:null},CSS:{escape:String},
    professionalPreviewTaskIds:new Map(),shotPreviewContentSignatureFromMaps:()=> 'same',localDeliverySignature:()=>'',task:()=>null,
    assetSyncing(){},shotPreviewSignatures:new Map([['s','same']]),patchWorkbenchPreviewProgress(){}};
  assert.match(source,/<span data-wb-generate-label>/);
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function patchProfessionalTaskSurfaces(){'),source.indexOf('  function activateProfessionalShot(')),context);
  for(const nextStatus of ['completed','running','failed','completed']){
    status=nextStatus;
    context.patchProfessionalTaskSurfaces();
    assert.equal(credits.textContent,'37.5');
    assert.equal(action.textContent,status==='completed'?'再次生成':'生成');
  }
});

test('background catalog refresh updates estimates without clearing prices on failure and deduplicates requests',async()=>{
  let calls=0;let resolveRequest;let fail=false;let paints=0;
  const initial=[{modelId:'seedance-2.0',quality:'720p',credits:2,unit:'second'}];
  const context={state:{route:'drama',config:{modelPrices:initial},pricing:{}},project:{shots:[{id:'s'}]},
    accountSnapshot:()=> 'account',isAccountCurrent:()=>true,
    api:()=>{calls++;return fail?Promise.reject(new Error('offline')):new Promise(resolve=>resolveRequest=resolve);},
    root:{querySelectorAll:()=>[{dataset:{wbShot:'s'}}]},refreshWorkbenchShotStatus:()=>paints++,
    setTimeout,clearTimeout,setInterval,clearInterval,Date};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  let priceRefreshTimer ='),source.indexOf('  const professionalGenerationPending =')),context);
  const pending=context.refreshProfessionalPrices({force:true});
  const duplicate=context.refreshProfessionalPrices({force:true});
  assert.equal(calls,1);assert.equal(context.state.config.modelPrices[0].credits,2);
  resolveRequest({modelPrices:[{...initial[0],credits:3}]});await pending;await duplicate;
  assert.equal(context.state.config.modelPrices[0].credits,3);assert.equal(paints,1);
  await context.refreshProfessionalPrices();assert.equal(calls,1);
  fail=true;await context.refreshProfessionalPrices({force:true});
  assert.equal(context.state.config.modelPrices[0].credits,3);assert.equal(paints,1);
});
