import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
const source=read('features/drama/director-workspace.js');
function fixture(result){
  const draft={id:'canvas-gen-draft',type:'image',prompt:'人物半身照',attachments:[],taskId:''};
  const workspace={generationDrafts:[draft],positions:{[draft.id]:{x:10,y:20,width:280,height:320}}};
  const requests=[],messages=[],saves=[];
  const context=vm.createContext({activeGenerationId:draft.id,generationSubmitting:false,epoch:1,generationDraft:id=>workspace.generationDrafts.find(item=>item.id===id),workspace:()=>workspace,canvasGenerationPayload:()=>({type:draft.type,prompt:draft.prompt}),generationConfig:()=>({}),renderGenerationComposer(){},syncCanvas(){},scheduleCanvasSave:now=>saves.push(now),crypto:{randomUUID},structuredClone,
    bridge:{toast:message=>messages.push(message),agentApi:async(url,options)=>{requests.push({url,options});if(url==='/api/model-quote')return {priceVersion:'price-v1'};if(result instanceof Error)throw result;return result;}}});
  vm.runInContext(source.slice(source.indexOf('  async function submitGenerationArea()'),source.indexOf('  function mount()')),context);
  return {context,draft,workspace,requests,messages,saves,submit:()=>context.submitGenerationArea()};
}
for(const type of ['image','video'])test(`single ${type} response binds the accepted task to its canvas card`,async()=>{
  const f=fixture({id:'accepted-task',status:'queued',balance:98});f.draft.type=type;
  await f.submit();assert.equal(f.draft.taskId,'accepted-task');assert.equal(f.draft.status,'queued');assert.equal(f.workspace.generationDrafts.length,1);
  assert.deepEqual(f.messages,['已开始生成']);assert.deepEqual(f.saves,[true]);assert.equal(f.context.activeGenerationId,'');
  assert.equal(f.requests.filter(request=>request.url==='/api/generations').length,1);
  const request=f.requests.find(request=>request.url==='/api/generations');assert.equal(request.options.headers['Idempotency-Key'],JSON.parse(request.options.body).requestId);
  f.context.activeGenerationId=f.draft.id;await f.submit();assert.equal(f.requests.filter(request=>request.url==='/api/generations').length,1);
});
test('batch responses keep every accepted task and position its extra cards',async()=>{
  const f=fixture({tasks:[{id:'first',status:'running'},{id:'second',status:'queued'}]});await f.submit();
  assert.equal(f.draft.taskId,'first');assert.equal(f.workspace.generationDrafts[1].taskId,'second');assert.equal(f.workspace.positions[f.workspace.generationDrafts[1].id].x,314);
  assert.deepEqual(f.messages,['已开始生成 2 张图片']);
});
test('empty response or rejected request reports failure without binding an invented task',async()=>{
  for(const result of [{tasks:[]},new Error('余额不足')]){
    const f=fixture(result);await f.submit();assert.equal(f.draft.taskId,'');assert.equal(f.draft.status,'');assert.equal(f.context.generationSubmitting,false);assert.equal(f.saves.length,0);assert.equal(f.messages.length,1);
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
