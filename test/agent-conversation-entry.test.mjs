import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectLoadingMarkup} from '../public/features/agent/project-loading.js';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
function setup(){
  const elements=[],entries=[],submissions=[];let disposed=0;
  const element=()=>({style:{},dataset:{},classList:{toggle(){}},setAttribute(){},replaceChildren(){},append(child){elements.push(child);},remove(){this.removed=true;}});
  const root=element();
  const context={preferenceUpdating:false,canvas:{},projectLoadingMarkup,emptyEntry:null,emptyEntrySession:'',disposeEmptyEntry:null,agentReady:false,agentState:null,agentConfig:{configured:true,skills:[]},connectionError:'',chatMode:'full',epoch:1,sending:false,switchingConversation:false,skillUpdating:false,
    host:{querySelector:()=>elements.find(node=>!node.removed&&'conversationLoading' in node.dataset),append:node=>elements.push(node)},document:{createElement:element},
    bridge:{agentMode:true,renderEmptyConversation:(node,options)=>{entries.push({node,options});return ()=>disposed++;}},
    agentClient:{settings:async()=>{},start:async()=>{}},submit:async(...args)=>submissions.push(args),drawPanels(){},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function clearEmptyEntry('),source.indexOf('  function drawPanels(')),context);
  const ready=(id='session',messages=[])=>{context.agentReady=true;context.agentState={id,messages,state:'idle',settings:{}};};
  return {context,root,entries,elements,submissions,ready,disposed:()=>disposed};
}
test('opening a saved conversation never paints an empty entry before history arrives',()=>{
  const {context,root,entries,ready,elements}=setup();
  assert.equal(context.drawConversationEntry(root),false);
  assert.equal(root.style.visibility,'hidden');assert.equal(entries.length,0);
  ready('saved',[{role:'user',text:'继续创作'}]);
  assert.equal(context.drawConversationEntry(root),true);
  assert.equal(root.style.visibility,'');assert.equal(entries.length,0);assert.equal(elements[0].removed,true);
});
test('an empty conversation reuses the entry without replacing its draft on polling',()=>{
  const {context,root,entries,ready,disposed}=setup();ready();
  context.drawConversationEntry(root);context.drawConversationEntry(root);
  assert.equal(entries.length,1);
  context.chatMode='side';context.drawConversationEntry(root);assert.equal(entries[0].node.hidden,true);
  context.chatMode='full';context.drawConversationEntry(root);assert.equal(entries[0].node.hidden,false);
  ready('next');context.drawConversationEntry(root);
  assert.equal(entries.length,2);assert.equal(disposed(),1);
});
test('a new empty conversation beside an existing canvas does not mount the full page entry',()=>{
  const {context,root,entries,ready}=setup();ready();context.chatMode='side';
  assert.equal(context.drawConversationEntry(root),true);
  assert.equal(entries.length,0);assert.equal(root.style.visibility,'');
});
test('the shared entry sends files, documents and skill into the current conversation',async()=>{
  const {context,root,entries,ready,submissions}=setup();ready();const settings=[];
  context.agentClient.settings=async value=>settings.push(value);
  context.drawConversationEntry(root);
  const files=[{id:'image',name:'参考图'}],documents=[{title:'剧本',text:'内容'}];
  await entries[0].options.onSubmit('我的想法',files,documents,'image-design');
  assert.equal(settings[0].skill,'image-design');
  assert.equal(submissions.length,1);assert.equal(submissions[0][0],'我的想法');
  assert.equal(submissions[0][1],files);assert.equal(submissions[0][3],documents);
  assert.equal(context.skillUpdating,false);
});
test('switching sessions during skill selection cannot send into the replacement conversation',async()=>{
  const {context,root,entries,ready,submissions}=setup();ready();let resolve;
  context.agentClient.settings=()=>new Promise(done=>{resolve=done;});context.drawConversationEntry(root);
  const pending=entries[0].options.onSubmit('旧消息',[],[],'image-design');
  ready('replacement');resolve();await pending;
  assert.equal(submissions.length,0);
});
test('a failed send retains the entry and a saved first message removes it',async()=>{
  const {context,root,entries,ready,disposed}=setup();ready();context.drawConversationEntry(root);
  context.submit=async()=>{context.connectionError='连接失败';};
  await entries[0].options.onSubmit('保留草稿',[],[],'');context.drawConversationEntry(root);
  assert.equal(entries.length,1);assert.equal(disposed(),0);
  ready('session',[{role:'user',text:'保留草稿'}]);context.drawConversationEntry(root);
  assert.equal(disposed(),1);assert.equal(entries[0].node.removed,true);
});
test('loading failures offer retry without revealing the old blank conversation',()=>{
  const {context,root,entries,elements}=setup();context.connectionError='连接失败';
  assert.equal(context.drawConversationEntry(root),false);
  assert.equal(root.style.visibility,'hidden');assert.equal(entries.length,0);
  assert.equal(elements[0].textContent,'连接失败');assert.equal(elements[1].textContent,'重新加载');
});
test('an initial message from smart creation does not mount another empty entry',()=>{
  const {context,root,entries,ready}=setup();ready();context.bridge.hasInitialContent=()=>true;
  context.drawConversationEntry(root);assert.equal(entries.length,0);
});

test('slow startup keeps a loading state until both session and canvas are ready',()=>{
  const {context,root,elements,ready}=setup();context.canvas=null;
  context.drawConversationEntry(root);
  assert.equal(root.inert,true);
  assert.equal(elements[0].innerHTML,projectLoadingMarkup);
  assert.equal(elements[0].dataset.loadingState,'loading');
  assert.equal(elements.length,1);
  ready('saved',[{role:'user',text:'已有内容'}]);
  assert.equal(context.drawConversationEntry(root),false);
  assert.equal(root.inert,true);
  assert.equal(elements.length,1);
  context.canvas={};
  assert.equal(context.drawConversationEntry(root),true);
  assert.equal(root.inert,false);
  assert.equal(elements[0].removed,true);
});
