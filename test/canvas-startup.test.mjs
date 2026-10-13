import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');

test('initialization cannot save a provisional canvas and session navigation preserves shared edits',async()=>{
  const writes=[];
  const context={agentReady:false,switchingConversation:false,bridge:{agentMode:true,patch:async value=>{writes.push(value);return value;}},workspace:()=>({canvasNodes:[{id:'saved-image'}]})};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  const save=async'),source.indexOf('  const message='))+'\nglobalThis.save=save;',context);
  await context.save();assert.equal(writes.length,0);
  context.agentReady=true;context.switchingConversation=true;
  await context.save();assert.equal(writes.length,1);
  context.switchingConversation=false;
  await context.save();assert.equal(writes.length,2);assert.equal(writes[0].directorWorkspace.canvasNodes[0].id,'saved-image');
  context.bridge.patch=async()=>{throw new Error('网络连接已断开');};
  await assert.rejects(context.save(),/网络连接已断开/);
});

test('initial viewport events do not overwrite saved positions or schedule a save',()=>{
  const handlers={},saved={viewport:{x:90,y:50,scale:.8}};let writes=0;
  const context={canvasContextMenu:null,canvas:{on:(name,handler)=>handlers[name]=handler,getState:()=>({nodes:[]})},bridge:{agentMode:true},agentReady:false,switchingConversation:false,syncing:false,resizingChat:false,
    mountEpoch:1,epoch:1,viewportFrame:0,viewportPersistTimer:0,setTimeout(){},clearTimeout(){},workspace:()=>saved,queueWorkspaceFrame(){},persistLiveCanvasState(){},liveCanvasSnapshot:s=>s,scheduleCanvasSave:()=>writes++};
  vm.createContext(context);
  const start=source.indexOf("      canvas.on('viewport:change'");
  vm.runInContext(source.slice(start,source.indexOf('\n',start)),context);
  const initial={x:0,y:0,scale:1};handlers['viewport:change'](initial);
  context.agentReady=true;context.syncing=true;handlers['viewport:change'](initial);
  context.syncing=false;context.resizingChat=true;handlers['viewport:change'](initial);
  context.resizingChat=false;context.switchingConversation=true;
  assert.equal(saved.viewport.x,90);assert.equal(writes,0);
  handlers['viewport:change']({x:110,y:70,scale:1});
  assert.equal(saved.viewport.x,110);assert.equal(writes,1);
  context.switchingConversation=false;
  context.syncing=false;handlers['viewport:change']({x:120,y:75,scale:1});
  assert.equal(saved.viewport.x,120);assert.equal(writes,2);
});

test('wheel bursts align cards once per frame and copy node state only after the gesture settles',()=>{
  const handlers={},frames=[],timers=[],saved={viewport:{x:0,y:0,scale:1}};
  let geometry=0,persisted=0,cleared=0;
  const context={canvasContextMenu:null,canvas:{on:(name,handler)=>handlers[name]=handler,getState:()=>({nodes:[]})},bridge:{},agentReady:true,syncing:false,resizingChat:false,
    mountEpoch:1,epoch:1,viewportFrame:0,viewportPersistTimer:0,workspace:()=>saved,
    queueWorkspaceFrame:fn=>(frames.push(fn),frames.length),alignCardGeometry:()=>geometry++,positionGenerationComposer(){},connector:null,
    setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout:()=>cleared++,
    persistLiveCanvasState:()=>persisted++,liveCanvasSnapshot:s=>s,scheduleCanvasSave(){}};
  vm.createContext(context);
  const start=source.indexOf("      canvas.on('viewport:change'");
  vm.runInContext(source.slice(start,source.indexOf('\n',start)),context);
  for(let i=0;i<10;i++)handlers['viewport:change']({x:i,y:0,scale:1});
  assert.equal(frames.length,1,'one alignment per frame');
  assert.equal(persisted,0,'no node copy while the wheel is moving');
  assert.equal(saved.viewport.x,9);
  frames[0]();assert.equal(geometry,1);
  timers.at(-1)();assert.equal(persisted,1);
  handlers['viewport:change']({x:20,y:0,scale:1});
  assert.equal(frames.length,2,'the next frame aligns again');
});

test('panning aligns geometry only, and only document cards rebuild the project model',()=>{
  assert.match(source,/function alignCardGeometry\(\)\{if\(!canvas\)return;nodes\(\)\.forEach\(n=>alignCard\(n\.id,undefined,true\)\);\}/);
  const bind=source.slice(source.indexOf('  function bindDocumentCard('),source.indexOf('    let controller=documentCards.get(card);'));
  assert.ok(bind.indexOf("if(!card)return;")<bind.indexOf('nodes()'),'plain cards return before rebuilding nodes');
});
