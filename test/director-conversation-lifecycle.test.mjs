import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(){
  const input={value:'',style:{},scrollTop:0,get scrollHeight(){return 84+Math.ceil(this.value.length/30)*20;}},form={},sent=[],toasts=[];
  const context={epoch:1,sending:false,switchingConversation:false,skillUpdating:false,uploading:false,documentAttachments:[],submissionQueue:[],drainingSubmissions:false,attachments:[],selected:'',skillSelection:null,agentConfig:{configured:true,skills:[]},agentState:{id:'first'},connectionError:'',historyOpen:true,
    host:{querySelector:selector=>selector==='#directorMessage'?input:selector==='.dw-composer'?form:{hidePopover(){}}},
    bridge:{toast:message=>toasts.push(message)},drawPanels(){},save:async()=>{},
    agentClient:{send:async text=>sent.push(text),open:async()=>{},newConversation:async()=>{}},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function resizeAgentComposer('),source.indexOf('\nfunction messageAttachments(')),context);
  vm.runInContext(source.slice(source.indexOf('  async function switchConversation('),source.indexOf('  function dispose(')),context);
  return {context,input,form,sent,toasts};
}
test('composer grows to a limit, scrolls internally, and returns to its default height after sending',async()=>{
  const {context,input,form,sent}=setup();
  input.value='长内容'.repeat(500);
  context.resizeAgentComposer(input);
  assert.equal(input.style.height,'180px');
  const start=source.indexOf("    host.querySelector('.dw-composer').onsubmit=e=>");
  vm.runInContext(source.slice(start,source.indexOf('\n',start)),context);
  input.scrollTop=35;
  form.onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(input.value,'');
  assert.equal(input.style.height,'76px');
  assert.equal(input.scrollTop,0);
  assert.equal(sent.length,1);
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(css,/\.dw-agent \.dw-composer textarea[^\n]*max-height:180px;overflow-y:auto/);
});
test('a project change during save cannot send into the replacement conversation',async()=>{
  const {context,sent}=setup(),saving=deferred();context.save=()=>saving.promise;
  const request=context.submit('old message');
  context.epoch++;context.agentState={id:'replacement'};context.sending=true;
  saving.resolve();await request;
  assert.deepEqual(sent,[]);assert.equal(context.sending,true);
});
test('a failed send preserves the next draft and releases the send lock',async()=>{
  const {context,input}=setup(),sending=deferred();context.agentClient.send=()=>sending.promise;
  const request=context.submit('failed message');await Promise.resolve();
  input.value='my next draft';sending.reject(new Error('offline'));await request;
  assert.equal(input.value,'my next draft');assert.equal(context.sending,false);
});
test('follow-up prompts queue while the first prompt is being submitted',async()=>{
  const {context,sent}=setup(),first=deferred();context.agentState.state='running';
  context.agentClient.send=async text=>{sent.push(text);if(sent.length===1)await first.promise;};
  const settle=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
  const firstRequest=context.submit('first message');await settle();
  const secondRequest=context.submit('second message');await settle();
  assert.deepEqual(sent,['first message']);
  first.resolve();await Promise.all([firstRequest,secondRequest]);
  assert.deepEqual(sent,['first message','second message']);
});
test('conversation navigation preserves text typed while the request is pending',async()=>{
  const {context,input}=setup(),opening=deferred();context.agentClient.open=()=>opening.promise;
  input.value='previous draft';const request=context.switchConversation('next');
  assert.equal(context.sending,false);assert.equal(context.switchingConversation,true);
  input.value='new draft';opening.resolve();await request;
  assert.equal(input.value,'new draft');assert.equal(context.switchingConversation,false);
});
test('a stale navigation cannot clear the new workspace or release its lock',async()=>{
  const {context,input}=setup(),opening=deferred();context.agentClient.open=()=>opening.promise;
  const request=context.switchConversation('next');context.epoch++;input.value='replacement';
  context.attachments=[{id:'replacement-file'}];opening.resolve();await request;
  assert.equal(input.value,'replacement');assert.equal(context.attachments.length,1);assert.equal(context.switchingConversation,true);
});
test('a render failure cannot permanently hold the send lock',async()=>{
  const {context}=setup();let draws=0;context.drawPanels=()=>{if(++draws===1)throw new Error('render failed');};
  await context.submit('message');assert.equal(context.sending,false);
});
test('changing sessions preserves the activity controls nested inside old history',()=>{
  const activity={parent:'history'},history={remove(){if(activity.parent==='history')activity.removed=true;}};
  const messages={querySelector:selector=>selector==='.dw-turn-activity'?activity:selector==='.dw-message-history'?history:null,append(node){node.parent='messages';}};
  const context={messages,streamSession:'old',agentState:{id:'new'},streamFrame:1,visibleDraft:'old',targetDraft:'old',cancelAnimationFrame(){}};
  vm.createContext(context);
  const start=source.indexOf('    const sessionChanged=streamSession!==agentState?.id;');
  vm.runInContext(source.slice(start,source.indexOf("    targetDraft=agentState?.draft",start)),context);
  assert.equal(activity.parent,'messages');assert.equal(activity.removed,undefined);assert.equal(context.streamSession,'new');
});
test('generation state keeps the composer available for follow-up requirements',()=>{
  assert.match(source,/button\.disabled=.*uploading\|\|switchingConversation\|\|skillUpdating\|\|!agentState/);
  assert.match(source,/busy\?'补充要求'/);
});
test('opening a ready conversation keeps saved canvas visible without failing',()=>{
  const start=source.indexOf('onState:(state,config)=>{')+'onState:'.length;
  const end=source.indexOf('},onError:error=>',start)+1;
  assert.ok(start>='onState:'.length&&end>start);
  const context={token:1,epoch:1,bridge:{agentMode:true,sessionChanged(){},snapshotKey:()=>''},agentState:{id:'cached'},agentReady:false,agentConfig:null,chatMode:'full',canvas:null,saveTimer:0,clearTimeout(){},autoOpenedGenerations:new Set(),hasSavedCanvasContent:()=>true,drawPanels(){},initialMessageSent:true,lastAgentCacheSignature:'',writeCanvasSnapshot:async()=>{}};
  vm.createContext(context);
  const onState=vm.runInContext(`(${source.slice(start,end)})`,context);
  onState({id:'cached',messages:[]},{configured:true});
  assert.equal(context.chatMode,'side');
  assert.equal(context.agentReady,true);
  onState({id:'next',messages:[]},{configured:true});
  assert.equal(context.chatMode,'side');
  context.chatMode='minimized';
  context.canvas={deleteNodes(){assert.fail('switching sessions rebuilt the canvas');},createNodes(){assert.fail('switching sessions rebuilt the canvas');}};
  onState({id:'third',messages:[]},{configured:true});
  assert.equal(context.chatMode,'side');
  context.hasSavedCanvasContent=()=>false;
  onState({id:'empty',messages:[]},{configured:true});
  assert.equal(context.chatMode,'full');
});

test('stream refreshes keep the working status mounted and place drafts before it',()=>{
  let draftNode=null;
  const content={};
  const history={querySelectorAll:()=>[],replaceChildren(){}};
  const activity={remove(){assert.fail('refresh detached the working status');}};
  const container={dataset:{},setAttribute(){},
    querySelector:selector=>selector==='.dw-turn-activity'?activity:selector==='.dw-message-history'?history:draftNode,
    append(){assert.fail('refresh reinserted the working status');},
    insertBefore(node,anchor){assert.equal(anchor,activity);draftNode=node;},
  };
  activity.parentNode=container;
  const context={container,createDraftMessage:()=>({querySelector:()=>content,remove(){draftNode=null;}}),
    patchStreamingContent(node,text){assert.equal(node,content);node.text=text;},
  };
  vm.createContext(context);
  const start=source.indexOf('function renderConversationMessages(');
  vm.runInContext(source.slice(start,source.indexOf('\nexport function createDirectorWorkspace',start)),context);
  context.renderConversationMessages(container,[],'first','streaming',false,false,false);
  const original=draftNode;
  context.renderConversationMessages(container,[],'first second','streaming',false,false,false);
  assert.equal(draftNode,original);assert.equal(content.text,'first second');
  context.renderConversationMessages(container,[],'','complete',false,false,false);
  assert.equal(draftNode,null);assert.equal(activity.parentNode,container);
});

test('switching project sessions preserves unsaved canvas nodes, asset IDs and viewport',()=>{
  const workspaceSource=readFileSync(new URL('../public/features/agent/workspace.js',import.meta.url),'utf8');
  const start=workspaceSource.indexOf('sessionChanged:session=>')+'sessionChanged:'.length;
  const end=workspaceSource.indexOf('\n      project:()=>project',start);
  const context={sessionId:'',project:{id:'project'},normalizeDirectorWorkspace:value=>value||{}};
  vm.createContext(context);
  const change=vm.runInContext(`(${workspaceSource.slice(start,end).trim().replace(/,$/, '')})`,context);
  change({id:'first',agentProjectId:'project',canvas:{directorWorkspace:{canvasNodes:[{id:'saved'}],viewport:{x:5}},assetIds:['saved']}});
  const live=context.project.directorWorkspace;
  live.canvasNodes.push({id:'unsaved'});live.viewport.x=120;
  context.project.assetIds.push('new-file');
  change({id:'second',agentProjectId:'project',canvas:{directorWorkspace:{canvasNodes:[]},assetIds:[]}});
  assert.equal(context.sessionId,'second');assert.equal(context.project.directorWorkspace,live);
  assert.equal(live.viewport.x,120);assert.equal(live.canvasNodes.length,2);
  assert.deepEqual(context.project.assetIds,['saved','new-file']);
});
