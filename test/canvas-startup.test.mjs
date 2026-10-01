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
  const context={canvas:{on:(name,handler)=>handlers[name]=handler,getState:()=>({nodes:[]})},bridge:{agentMode:true},agentReady:false,switchingConversation:false,syncing:false,resizingChat:false,
    mountEpoch:1,epoch:1,workspace:()=>saved,queueWorkspaceFrame(){},persistLiveCanvasState(){},liveCanvasSnapshot:s=>s,scheduleCanvasSave:()=>writes++};
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
