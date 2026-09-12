import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(){
  const input={value:''},sent=[],toasts=[];
  const context={epoch:1,sending:false,switchingConversation:false,uploading:false,attachments:[],selected:'',agentState:{id:'first'},connectionError:'',historyOpen:true,
    host:{querySelector:selector=>selector==='#directorMessage'?input:{hidePopover(){}}},
    bridge:{toast:message=>toasts.push(message)},drawPanels(){},save:async()=>{},
    agentClient:{send:async text=>sent.push(text),open:async()=>{},newConversation:async()=>{}},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function switchConversation('),source.indexOf('  function dispose(')),context);
  return {context,input,sent,toasts};
}
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
  const start=source.indexOf('    if(streamSession!==agentState?.id)');
  vm.runInContext(source.slice(start,source.indexOf("    targetDraft=agentState?.draft",start)),context);
  assert.equal(activity.parent,'messages');assert.equal(activity.removed,undefined);assert.equal(context.streamSession,'new');
});
