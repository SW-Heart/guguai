import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
const source=read('features/drama/director-workspace.js');
const links=await import('../public/features/drama/canvas-links.js');
function fixture(result,{entity=null,links:linked=[],describe=()=>null}={}){
  const draft={id:'canvas-gen-draft',type:'image',prompt:'人物半身照',aspect:'3:4',attachments:[],taskId:'',...(entity?{entity}:{})};
  const workspace={generationDrafts:[draft],links:linked,positions:{[draft.id]:{x:10,y:20,width:280,height:320}}};
  const requests=[],messages=[],saves=[],uploads=[];
  const context=vm.createContext({activeGenerationId:draft.id,generationSubmitting:false,epoch:1,generationDraft:id=>workspace.generationDrafts.find(item=>item.id===id),workspace:()=>workspace,
    canvasGenerationPayload:request=>({type:request.type,prompt:request.prompt,referenceAssetIds:request.attachments.map(file=>file.id)}),generationConfig:()=>({}),renderGenerationComposer(){},syncCanvas(){},scheduleCanvasSave:now=>saves.push(now),crypto:{randomUUID},
    describeInput:describe,liveCanvasNodes:()=>[{id:'other',x:386,y:20,width:200,height:200}],nodeRect:node=>({x:node.x,y:node.y,width:node.width,height:node.height}),
    canvasGenerationFrameSize:()=>({width:240,height:320}),...links,
    bridge:{toast:message=>messages.push(message),prepareCloudFiles:async files=>{uploads.push(files.map(file=>file.id));return files.map(file=>({id:`cloud-${file.id}`}));},
      agentApi:async(url,options)=>{requests.push({url,options});if(url==='/api/model-quote')return {priceVersion:'price-v1'};if(result instanceof Error)throw result;return result;}}});
  vm.runInContext(source.slice(source.indexOf('  function generationRequest(draft){'),source.indexOf('  function mount()')),context);
  return {context,draft,workspace,requests,messages,saves,uploads,submit:()=>context.submitGenerationArea()};
}
for(const type of ['image','video'])test(`single ${type} response adds a linked result and keeps the generation node editable`,async()=>{
  const f=fixture({id:'accepted-task',status:'queued',balance:98});f.draft.type=type;
  await f.submit();
  assert.equal(f.draft.taskId,'');assert.equal(f.draft.prompt,'人物半身照');assert.equal(f.workspace.generationDrafts.length,2);
  const result=f.workspace.generationDrafts[1];
  assert.equal(result.taskId,'accepted-task');assert.equal(result.status,'queued');assert.equal(result.parentId,f.draft.id);
  assert.ok(f.workspace.positions[result.id].x>f.workspace.positions[f.draft.id].x+280,'the result sits to the right of its node');
  assert.deepEqual(f.messages,['已开始生成']);assert.deepEqual(f.saves,[true]);assert.equal(f.context.activeGenerationId,f.draft.id);
  const request=f.requests.find(request=>request.url==='/api/generations');assert.equal(request.options.headers['Idempotency-Key'],JSON.parse(request.options.body).requestId);
  // Generating again adds another result instead of replacing the first.
  await f.submit();assert.equal(f.workspace.generationDrafts.filter(item=>item.parentId===f.draft.id).length,2);
});
test('batch responses keep every accepted task and stack results without overlap',async()=>{
  const f=fixture({tasks:[{id:'first',status:'running'},{id:'second',status:'queued'}]});await f.submit();
  const [first,second]=f.workspace.generationDrafts.slice(1);
  assert.equal(first.taskId,'first');assert.equal(second.taskId,'second');
  const [a,b]=[f.workspace.positions[first.id],f.workspace.positions[second.id]];
  assert.ok(a.x>=10+280+96&&!(a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height));
  assert.ok(a.x>=586||a.y>=244,'the result avoids existing content');
  assert.deepEqual(f.messages,['已开始生成 2 个']);
});
test('a character card picks its first result as main picture and keeps a chosen one',async()=>{
  const f=fixture({id:'one',status:'queued'},{entity:{kind:'character',name:'外婆'}});
  await f.submit();const first=f.workspace.generationDrafts[1];assert.equal(f.draft.primaryId,first.id);
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
