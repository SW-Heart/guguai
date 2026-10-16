import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
const source=read('features/drama/director-workspace.js');
const links=await import('../public/features/drama/canvas-links.js');
test('ordinary generators render pending, completed and failed outputs inside their own frame',()=>{
  for(const type of ['image','video','audio'])for(const status of ['queued','running','completed','failed']){
    const draft={id:'g',type,prompt:'画面描述'};
    const result={id:'r',parentId:'g',taskId:'t',status,prompt:'生成时的描述'};
    const media=status==='completed'?{kind:type,url:'/result'}:null;
    const context=vm.createContext({...links,workspace:()=>({}),isDocumentCard:()=>false,liveDrafts:()=>[draft,result],
      bridge:{task:()=>({status,progress:42}),media:()=>media},
      generationFrameState:(status,hasMedia)=>hasMedia?'completed':status,generationTaskStatus:task=>task?.status,
      resultFrame:config=>config});
    vm.runInContext(source.slice(source.indexOf('  function nodeContent(n) {'),source.indexOf('  function nodeBounds(')),context);
    const rendered=context.nodeContent({kind:'canvas-generation',title:'生成',item:draft});
    assert.equal(rendered.state,status);assert.equal(rendered.media,media);
    assert.equal(rendered.caption,'生成时的描述');assert.equal(rendered.kind,type);
    draft.status='submitting';
    const pending=context.nodeContent({kind:'canvas-generation',title:'生成',item:draft});
    assert.equal(pending.media,null);assert.equal(pending.caption,'画面描述');
  }
});
function fixture(result,{entity=null,links:linked=[],describe=()=>null,quote={priceVersion:'price-v1'}}={}){
  const draft={id:'canvas-gen-draft',type:'image',prompt:'人物半身照',aspect:'3:4',attachments:[],taskId:'',...(entity?{entity}:{})};
  const workspace={generationDrafts:[draft],links:linked,positions:{[draft.id]:{x:10,y:20,width:280,height:320}}};
  const requests=[],messages=[],saves=[],uploads=[],focused=[],selected=[];
  const context=vm.createContext({activeGenerationId:draft.id,generationSubmitting:false,epoch:1,generationDraft:id=>workspace.generationDrafts.find(item=>item.id===id),workspace:()=>workspace,
    canvasGenerationPayload:request=>({type:request.type,prompt:request.prompt,referenceAssetIds:request.attachments.map(file=>file.id)}),generationConfig:()=>({}),renderGenerationComposer(){},syncCanvas(){},scheduleCanvasSave:now=>saves.push(now),crypto:{randomUUID},
    closeGenerationMenu(){},canvas:{selectNodes:ids=>{selected.push(...ids);const node=workspace.generationDrafts.find(item=>item.id===ids[0]);context.activeGenerationId=node?.taskId?'':node?.id||'';}},focusNewCanvasContent:ids=>focused.push(...ids),
    describeInput:describe,liveCanvasNodes:()=>[{id:'other',x:386,y:20,width:200,height:200}],nodeRect:node=>({x:node.x,y:node.y,width:node.width,height:node.height}),
    canvasGenerationFrameSize:()=>({width:240,height:320}),...links,
    bridge:{toast:message=>messages.push(message),prepareCloudFiles:async files=>{uploads.push(files.map(file=>file.id));return files.map(file=>({id:`cloud-${file.id}`}));},
      agentApi:async(url,options)=>{requests.push({url,options});if(url==='/api/model-quote')return quote;if(result instanceof Error)throw result;return result;}}});
  vm.runInContext(source.slice(source.indexOf('  function generationRequest(draft){'),source.indexOf('  function mount()')),context);
  return {context,draft,workspace,requests,messages,saves,uploads,focused,selected,submit:()=>context.submitGenerationArea()};
}
test('storyboard submission closes the composer and focuses the new pending output',async()=>{
  const f=fixture({id:'shot-task',status:'queued'});f.draft.role='shot';f.draft.type='video';
  await f.submit();
  const output=f.workspace.generationDrafts[1];
  assert.equal(f.context.activeGenerationId,'');
  assert.deepEqual(f.focused,[output.id]);assert.deepEqual(f.selected,[output.id]);
  assert.ok(f.workspace.positions[output.id]);assert.equal(output.taskId,'shot-task');
});
test('failed storyboard submission retains the editable composer without moving the viewport',async()=>{
  const f=fixture(new Error('余额不足'));f.draft.role='shot';
  await f.submit();
  assert.equal(f.context.activeGenerationId,f.draft.id);assert.deepEqual(f.focused,[]);assert.deepEqual(f.selected,[]);
});
for(const type of ['image','video'])test(`single ${type} response displays in place and keeps the generation node editable`,async()=>{
  const f=fixture({id:'accepted-task',status:'queued',balance:98});f.draft.type=type;
  await f.submit();
  assert.equal(f.draft.taskId,'');assert.equal(f.draft.prompt,'人物半身照');assert.equal(f.workspace.generationDrafts.length,2);
  const result=f.workspace.generationDrafts[1];
  assert.equal(result.taskId,'accepted-task');assert.equal(result.status,'queued');assert.equal(result.parentId,f.draft.id);
  assert.equal(f.workspace.positions[result.id],undefined,'the output has no separate canvas frame');
  assert.equal(links.displayedResult(f.workspace.generationDrafts,f.draft).id,result.id);
  assert.deepEqual(f.workspace.positions[f.draft.id],{x:10,y:20,width:280,height:320});
  assert.deepEqual(f.messages,['已开始生成']);assert.deepEqual(f.saves,[true]);assert.equal(f.context.activeGenerationId,'');
  assert.deepEqual(f.selected,[f.draft.id]);assert.deepEqual(f.focused,[f.draft.id]);
  const request=f.requests.find(request=>request.url==='/api/generations');assert.equal(request.options.headers['Idempotency-Key'],JSON.parse(request.options.body).requestId);
  // Keep history while replacing what the same component displays.
  f.context.activeGenerationId=f.draft.id;
  await f.submit();assert.equal(f.workspace.generationDrafts.filter(item=>item.parentId===f.draft.id).length,2);
  assert.equal(links.displayedResult(f.workspace.generationDrafts,f.draft).id,f.workspace.generationDrafts.at(-1).id);
  assert.deepEqual(Object.keys(f.workspace.positions),[f.draft.id]);
});

for(const kind of ['character','location','prop'])test(`${kind} submission closes the composer and selects the pending output`,async()=>{
  const f=fixture({tasks:[{id:'first',status:'running'},{id:'second',status:'queued'}]},{entity:{kind,name:'素材'}});
  await f.submit();
  const outputs=f.workspace.generationDrafts.slice(1);
  assert.equal(f.context.activeGenerationId,'');
  assert.deepEqual(f.selected,[outputs[0].id]);assert.deepEqual(f.focused,outputs.map(item=>item.id));
  assert.ok(f.workspace.positions[outputs[0].id]);
  assert.equal(outputs[0].status,'running');assert.equal(outputs[1].status,'queued');
});
test('a delayed submission does not change the node or composer the user switched to',async()=>{
  const f=fixture({id:'accepted-task',status:'queued'},{entity:{kind:'character',name:'外婆'}});
  const api=f.context.bridge.agentApi;
  let accept;
  f.context.bridge.agentApi=(...args)=>new Promise(resolve=>{accept=()=>resolve(api(...args));});
  const pending=f.submit();
  f.context.activeGenerationId='another-node';
  accept();await pending;
  assert.equal(f.context.activeGenerationId,'another-node');
  assert.deepEqual(f.selected,[]);assert.deepEqual(f.focused,[]);
  assert.equal(f.workspace.generationDrafts[1].taskId,'accepted-task');
});
test('batch responses keep every accepted task within the same component',async()=>{
  const f=fixture({tasks:[{id:'first',status:'running'},{id:'second',status:'queued'}]});await f.submit();
  const [first,second]=f.workspace.generationDrafts.slice(1);
  assert.equal(first.taskId,'first');assert.equal(second.taskId,'second');
  assert.deepEqual(Object.keys(f.workspace.positions),[f.draft.id]);
  assert.equal(links.displayedResult(f.workspace.generationDrafts,f.draft).id,second.id);
  f.draft.primaryId=first.id;
  assert.equal(links.displayedResult(f.workspace.generationDrafts,f.draft).id,first.id);
  assert.deepEqual(f.messages,['已开始生成 2 个']);
});
test('a character card picks its first result as main picture and keeps a chosen one',async()=>{
  const f=fixture({id:'one',status:'queued'},{entity:{kind:'character',name:'外婆'}});
  await f.submit();const first=f.workspace.generationDrafts[1];assert.equal(f.draft.primaryId,first.id);
  f.context.activeGenerationId=f.draft.id;
  await f.submit();assert.equal(f.draft.primaryId,first.id);
});
test('linked text and pictures are part of the request and a shared picture uploads once',async()=>{
  const sources={story:{kind:'text',label:'剧本',text:'雨夜，老宅'},card:{kind:'image',label:'外婆',file:{id:'asset-1',kind:'image',url:'/a.png'}},pic:{kind:'image',label:'外婆 2',file:{id:'asset-1',kind:'image',url:'/a.png'}}};
  const f=fixture({id:'t',status:'queued'},{links:['story','card','pic'].map(from=>({id:links.linkId(from,'canvas-gen-draft'),from,to:'canvas-gen-draft'})),describe:id=>sources[id]});
  await f.submit();
  const body=JSON.parse(f.requests.find(request=>request.url==='/api/generations').options.body);
  assert.equal(body.prompt,'雨夜，老宅\n\n人物半身照');
  assert.deepEqual(f.uploads,[['asset-1']]);assert.deepEqual(body.referenceAssetIds,['cloud-asset-1']);
});
test('a linked card without a finished picture stops the request with a clear reason',async()=>{
  const f=fixture({id:'t'},{links:[{id:links.linkId('card','canvas-gen-draft'),from:'card',to:'canvas-gen-draft'}],describe:()=>({kind:'image',label:'外婆',file:null})});
  await f.submit();assert.equal(f.requests.length,0);assert.match(f.messages[0],/「外婆」还没有生成好的画面/);
});
test('empty response or rejected request reports failure without inventing a result',async()=>{
  for(const result of [{tasks:[]},new Error('余额不足')]){
    const f=fixture(result);await f.submit();assert.equal(f.workspace.generationDrafts.length,1);assert.equal(f.draft.status,'');assert.equal(f.context.generationSubmitting,false);assert.equal(f.saves.length,0);assert.equal(f.messages.length,1);
    assert.equal(f.context.activeGenerationId,f.draft.id);assert.deepEqual(f.selected,[]);assert.deepEqual(f.focused,[]);
  }
});
for(const file of ['features/agent/workspace.js','drama-studio.js'])test(`${file} registers a single task and schedules polling without mistaking sessions for tasks`,()=>{
  const text=read(file),start=text.indexOf('        const tasks=Array.isArray(result.tasks)'),end=text.indexOf('\n        }',start)+'\n        }'.length;
  const calls=[],context=vm.createContext({result:{id:'generated',status:'queued'},url:'/api/generations',options:{method:'POST'},state:{tasks:[{id:'existing',status:'running'}]},scheduleTaskPoll:delay=>calls.push(delay)});
  const run=()=>vm.runInContext(`{${text.slice(start,end)}}`,context);
  run();assert.equal(context.state.tasks[0].id,'generated');assert.deepEqual(calls,[0]);
  context.result={id:'session-id',documents:[]};context.url='/api/agent/sessions';run();assert.equal(context.state.tasks.length,2);
  context.result={tasks:[{id:'generated',status:'running'},{id:'batch',status:'queued'}]};run();assert.equal(context.state.tasks.length,3);assert.equal(context.state.tasks[0].status,'running');
});
test('returning to works refreshes the gallery to recover previously unregistered tasks',()=>{
  const text=read('app.js');let loads=0,renders=0;
  const context=vm.createContext({state:{generationTab:'history'},document:{querySelector:()=>true},syncGenerationTab(){},renderTasks(){renders++;},loadTasks:async options=>{assert.equal(options.background,true);loads++;},loadGenerationHistory(){}});
  vm.runInContext(text.slice(text.indexOf('function setGenerationTab('),text.indexOf('function renderTasks()')),context);
  context.setGenerationTab('works');assert.equal(loads,1);assert.equal(renders,1);
  assert.match(text,/renderTasks\(\);\s*if\(routeChanged\)void loadTasks\(\{background:true\}\);/);
});

test('speech submits the price the user saw and keeps its audio result editable',async()=>{
  const quote={priceVersion:'speech-price-1',credits:.014};
  const f=fixture({id:'audio-task',type:'audio',status:'queued'},{quote});
  Object.assign(f.draft,{type:'audio',speechMode:'tts',speechQuote:quote});
  await f.submit();
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].url,'/api/model-quote');
  assert.equal(JSON.parse(f.requests[1].options.body).expectedPriceVersion,quote.priceVersion);
  assert.equal(f.workspace.generationDrafts[1].type,'audio');assert.equal(f.draft.taskId,'');
});
test('speech blocks submission until quoted and asks for renewed confirmation after a price change',async()=>{
  const f=fixture({id:'unexpected-task'},{quote:{priceVersion:'new',credits:99.014}});
  Object.assign(f.draft,{type:'audio',speechMode:'tts'});
  await f.submit();assert.equal(f.requests.length,0);
  f.draft.speechQuote={priceVersion:'old',credits:.014};await f.submit();
  assert.equal(f.requests.length,1);assert.equal(f.workspace.generationDrafts.length,1);
  assert.match(f.messages.at(-1),/费用已更新/);assert.equal(f.context.generationSubmitting,false);
});
