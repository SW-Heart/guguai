import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentConfig, createAgentGateway } from '../lib/agent/gateway.mjs';
import { createAgentSkills } from '../lib/agent/skills.mjs';
import { createAgentTools, validateToolInput } from '../lib/agent/tools.mjs';
import { createAgentRuntime, buildAgentMessages } from '../lib/agent/runtime.mjs';
import { AGENT_SCHEMA_SQL, createAgentSessionRepository } from '../repositories/agent-sessions.mjs';
import { createAgentRouteHandler } from '../server/routes/agent.mjs';
import { llmRatesFromEnv } from '../lib/billing.mjs';

const scope = { deviceId:'device-a', workspaceId:'workspace-a', desktop:true, platform:'darwin' };
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES(\'user-a\'),(\'user-b\');');
  db.exec(AGENT_SCHEMA_SQL);
  const repo = createAgentSessionRepository({ sql:s=>db.prepare(s),tx:fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}} });
  const session = repo.create('user-a', scope, '', { model:'test-model',autoGenerate:false,generationBudgetMicro:0 });
  return {db,repo,session,get:()=>repo.get(session.id,'user-a',scope)};
}
const answer = (content, tool_calls) => ({ message:{role:'assistant',content,...(tool_calls?{tool_calls}:{})},usage:{inputTokens:10,outputTokens:5},model:'test-model',providerRequestId:'req-1' });
const call = (name,args,id='call-a')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function runtimeFixture(f, complete, tools) {
  const counts={reserve:0,settle:0,reconcile:0,release:0};
  const billing={rates:llmRatesFromEnv(),...Object.fromEntries(Object.keys(counts).map(k=>[k,async()=>{counts[k]++;return {};}]))};
  const gateway={config:{model:'test-model',contextBytes:120000,maxTokens:1000},complete};
  const runtime=createAgentRuntime({repository:f.repo,gateway,tools:tools||{definitions:()=>[],images:async()=>[],get:()=>({}),execute:async()=>({ok:true})},skills:{search:async()=>[]},billing});
  return {runtime,counts};
}

test('gateway normalizes custom endpoint and preserves selectable model IDs',async()=>{
  const config=agentConfig({AGENT_API_BASE:'https://gateway.example/v1/chat/completions',AGENT_API_KEY:'secret',AGENT_MODEL:'a',AGENT_MODELS:'a,b'});
  assert.equal(config.baseUrl,'https://gateway.example/v1');
  const requests=[];
  const gateway=createAgentGateway({config,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'r',model:'b',choices:[{message:{role:'assistant',content:'你好'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}}));}});
  assert.deepEqual((await gateway.listModels()).map(m=>m.id),['a','b']);
  const result=await gateway.complete({model:'b',messages:[{role:'user',content:'你好'}],tools:[]});
  assert.equal(requests[0].url,'https://gateway.example/v1/chat/completions');
  assert.equal(requests[0].body.model,'b');
  assert.equal(result.message.content,'你好');
  await assert.rejects(gateway.complete({model:'not-in-catalog',messages:[],tools:[]}),/不可用/);
});

test('SSE handles split UTF-8 and multiple fragmented tool calls with trailing usage',async()=>{
  const events=[{id:'r',choices:[{delta:{content:'先查看',tool_calls:[{index:0,id:'a',function:{name:'models_list',arguments:'{'}},{index:1,id:'b',function:{name:'skills_search',arguments:'{"query":'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'}'}},{index:1,function:{arguments:'"海报"}'}}]},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:12,completion_tokens:8}}];
  const bytes=new TextEncoder().encode(events.map(e=>`data: ${JSON.stringify(e)}\r\n\r\n`).join('')+'data: [DONE]\n\n');
  const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}});
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true,apiKey:'secret',baseUrl:'https://example/v1'},fetchImpl:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})});
  const result=await gateway.complete({model:'m',messages:[],tools:[]});
  assert.equal(result.message.content,'先查看');
  assert.deepEqual(result.message.tool_calls.map(c=>JSON.parse(c.function.arguments)),[{}, {query:'海报'}]);
  assert.deepEqual(result.usage,{inputTokens:12,outputTokens:8});
});

test('missing usage fails closed for reconciliation without retrying generation',async()=>{
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'hi'},finish_reason:'stop'}]}))});
  await assert.rejects(gateway.complete({model:'m',messages:[],tools:[]}),e=>e.billingReconcileRequired===true);
});

test('sessions isolate account/device/workspace and deduplicate user messages',()=>{
  const f=fixture();
  assert.equal(f.repo.get(f.session.id,'user-b',scope),null);
  assert.equal(f.repo.get(f.session.id,'user-a',{...scope,workspaceId:'other'}),null);
  assert.equal(f.repo.get(f.session.id,'user-a',{...scope,deviceId:'other'}),null);
  f.repo.enqueue(f.session,{clientId:'message-1',text:'你好'});
  f.repo.enqueue(f.session,{clientId:'message-1',text:'你好'});
  assert.equal(f.repo.inputs(f.session).length,1);
  assert.throws(()=>f.repo.enqueue(f.session,{clientId:'message-1',text:'changed'}),/不同内容/);
  const claimed=f.repo.claim(f.session.id);assert.ok(claimed);assert.equal(f.repo.claim(f.session.id),null);
  f.repo.release(claimed);assert.throws(()=>f.repo.save(claimed),/执行权/);
  f.db.close();
});

test('plain conversation finishes without forcing any tools or a production plan',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'一起聊一个点子'});
  const {runtime,counts}=runtimeFixture(f,async()=>answer('可以，先从你感兴趣的人物聊起。'));
  await runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');assert.equal(f.get().doc.messages.length,2);
  assert.equal(counts.settle,1);assert.equal(f.get().doc.generations.length,0);
  await runtime.stop();f.db.close();
});

test('agent observes tool results and continues, retaining complete multi-turn history',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'读取素材后给建议'});
  const received=[];let round=0;
  const {runtime}=runtimeFixture(f,async request=>{received.push(request.messages);return round++===0?answer('我先看看素材。',[call('assets_search',{})]):answer('可以采用这个方案。');});
  await runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');assert.equal(received.length,2);
  assert.equal(received[1].find(m=>m.role==='tool').tool_call_id,'call-a');
  await runtime.stop();f.db.close();
});

test('paid tool pauses for exact approval and resumes once without re-planning',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'生成图片'});
  let round=0,submitted=0;
  const tools={definitions:()=>[],images:async()=>[],get:name=>({paid:name==='media_submit'}),execute:async(name,args,s)=>{
    if(name==='media_prepare'){s.doc.prepared={p:{input:{type:'image',prompt:'猫',modelId:'image'},quote:{costMicro:2000000,credits:2,quantity:1}}};return{preparedRequestId:'p'};}
    submitted++;return{jobIds:['job']};
  }};
  const {runtime}=runtimeFixture(f,async()=>round++===0?answer(null,[call('media_prepare',{})]):round===2?answer(null,[call('media_submit',{preparedRequestId:'p'},'call-b')]):answer('已提交。'),tools);
  await runtime.kick(f.session.id);assert.equal(f.get().state,'waiting_approval');assert.equal(submitted,0);
  const approval=f.get().doc.approval;
  assert.throws(()=>f.repo.approve(f.session,'stale',true),/失效/);
  f.repo.approve(f.session,approval.id,true);await runtime.kick(f.session.id);
  assert.equal(submitted,1);assert.equal(f.get().state,'completed');
  await runtime.kick(f.session.id);assert.equal(submitted,1);
  await runtime.stop();f.db.close();
});

test('discussion requests block premature media tools even with automatic budget, then allow explicit production',async()=>{
  const f=fixture();
  f.repo.settings(f.session,{...f.session.settings,autoGenerate:true,generationBudgetMicro:10000000});
  f.repo.enqueue(f.session,{clientId:'plan',text:'做一个15秒动漫风格的打斗视频，构思下角色场景视频分镜设计等'});
  let round=0;const executed=[];
  const tools={definitions:()=>[],images:async()=>[],get:name=>({paid:name==='media_submit'}),execute:async(name,args,s)=>{
    executed.push(name);
    if(name==='media_prepare'){s.doc.prepared={p:{input:{type:'image',prompt:'角色',modelId:'image'},quote:{costMicro:2000000,credits:2,quantity:1}}};return{preparedRequestId:'p'};}
    return{jobIds:['job']};
  }};
  const {runtime}=runtimeFixture(f,async()=>{
    round++;
    if(round===1||round===3)return answer(null,[call('media_prepare',{}),call('media_submit',{preparedRequestId:'p'},'submit')]);
    return answer(round===2?'建议两名剑士在屋顶交锋，分为对峙、交手、收势三个镜头。你想调整角色还是场景？':'已开始制作。');
  },tools);
  await runtime.kick(f.session.id);
  assert.deepEqual(executed,[]);
  assert.equal(f.get().doc.approval,undefined);
  assert.equal(f.get().state,'completed');
  assert.equal(f.get().doc.messages.filter(m=>m.role==='tool'&&m.content.includes('构思讨论阶段')).length,2);
  f.repo.enqueue(f.session,{clientId:'produce',text:'角色场景和分镜都确认，按这个方案开始生成'});
  await runtime.kick(f.session.id);
  assert.deepEqual(executed,['media_prepare','media_submit']);
  assert.equal(f.get().state,'completed');
  await runtime.stop();f.db.close();
});

test('a new prompt arriving during a media wait is scheduled immediately',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'first',text:'先开始第一个创作'});
  let round=0;
  const tools={definitions:()=>[],images:async()=>[],get:name=>({waits:name==='jobs_wait'}),execute:async(name)=>{
    if(name==='jobs_wait'){
      f.repo.enqueue(f.get(),{clientId:'follow-up',text:'继续做第二个创作'});
      return {wait:true};
    }
    return {ok:true};
  }};
  const {runtime}=runtimeFixture(f,async()=>round++===0?answer(null,[call('jobs_wait',{jobIds:['job']})]):answer('第二个创作已开始。'),tools);
  await runtime.kick(f.session.id);
  assert.equal(f.get().state,'queued');
  await runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');
  assert.equal(f.get().doc.messages.at(-1).content,'第二个创作已开始。');
  await runtime.stop();f.db.close();
});

test('uncertain model execution is reconciled after restart, never automatically replayed',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'你好'});
  const claimed=f.repo.claim(f.session.id);claimed.doc.step={id:'step-1',model:'test-model',requestStarted:true};f.repo.save(claimed,'queued');f.repo.release(claimed);
  const {runtime,counts}=runtimeFixture(f,async()=>{throw new Error('must not call');});
  await runtime.kick(f.session.id);assert.equal(counts.reconcile,1);assert.equal(f.get().state,'paused');
  await runtime.stop();f.db.close();
});

test('new user direction cancels unsubmitted tool calls and invalidates approval',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'开始'});
  const claimed=f.repo.claim(f.session.id);claimed.doc.lastInput=f.repo.inputs(claimed)[0].seq;
  claimed.doc.messages=[{role:'user',content:'开始'},answer(null,[call('media_submit',{preparedRequestId:'p'})]).message];
  claimed.doc.pendingCalls=[{id:'invocation-1',call:call('media_submit',{preparedRequestId:'p'})}];claimed.doc.approval={id:'invocation-1'};
  f.repo.save(claimed,'waiting_approval');f.repo.release(claimed);
  f.repo.enqueue(f.session,{clientId:'message-2',text:'不要生成，只讨论'});
  let history;
  const {runtime}=runtimeFixture(f,async r=>{history=r.messages;return answer('好，我们只讨论。');});
  await runtime.kick(f.session.id);assert.equal(f.get().state,'completed');assert.equal(f.get().doc.approval,undefined);
  const tool=history.find(m=>m.role==='tool');assert.match(tool.content,/调整/);
  assert.equal(history.at(-1).content,'不要生成，只讨论');await runtime.stop();f.db.close();
});

test('skill extensions load without code changes and cannot traverse or follow resource symlinks',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'gugu-skills-'));
  try{await mkdir(path.join(root,'poster','references'),{recursive:true});
    await writeFile(path.join(root,'poster','SKILL.md'),'---\nname: poster\ndescription: 海报设计\n---\n创作方法');
    await writeFile(path.join(root,'outside.txt'),'private');await symlink(path.join(root,'outside.txt'),path.join(root,'poster','references','escape.txt'));
    const skills=createAgentSkills({roots:[root]});assert.equal((await skills.search('海报'))[0].name,'poster');
    assert.match((await skills.read('poster')).text,/创作方法/);
    await assert.rejects(skills.read('poster','references/../../outside.txt'),/路径/);
    await assert.rejects(skills.read('poster','references/escape.txt'),/路径/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('tool schemas reject unknown privileged fields and malformed arguments',()=>{
  const schema={type:'object',properties:{name:{type:'string'}},required:['name']};
  assert.throws(()=>validateToolInput({name:'ok',userId:'victim'},schema),/不支持/);
  assert.throws(()=>validateToolInput({name:42},schema),/文本/);
});

test('tool media submissions reuse existing generator with original scope and prepared request identity',async()=>{
  const calls=[];
  const tools=createAgentTools({skills:{},catalog:async()=>[],generate:async args=>{calls.push(args);return args.previewOnly?{status:200,data:{costMicro:2000000,credits:2,quantity:1}}:{status:202,data:{id:'job',balance:8}};}});
  const s={userId:'user-a',scope,doc:{documents:[],generations:[]}};
  const prep=await tools.execute('media_prepare',{type:'image',modelId:'image',prompt:'猫'},s,{id:'invocation-1'});
  await assert.rejects(() => tools.execute('media_submit',prep,s,{id:'invocation-2'})); // Exact schema only accepts request ID.
  const args={preparedRequestId:prep.preparedRequestId};
  const result=await tools.execute('media_submit',args,s,{id:'invocation-2'});
  assert.deepEqual(await tools.execute('media_submit',args,s,{id:'invocation-2'}),result);
  assert.equal(calls.length,2);assert.equal(calls[1].input.requestId,'ag-invocation-1');assert.deepEqual(calls[1].scope,scope);assert.equal(calls[1].maxCostMicro,2000000);
});

test('context trimming keeps assistant calls paired with tool results',()=>{
  const messages=[{role:'user',content:'old'.repeat(1000)},answer(null,[call('a',{})]).message,{role:'tool',tool_call_id:'call-a',content:'old result'},answer('done').message,{role:'user',content:'new'},answer(null,[call('b',{})]).message,{role:'tool',tool_call_id:'call-a',content:'new result'}];
  const result=buildAgentMessages({messages},{},500);
  assert.equal(result.filter(m=>m.role==='tool').length,1);assert.equal(result.at(-2).tool_calls[0].function.name,'b');
});

test('API returns scoped visible conversation without internal reasoning or tool data',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'hello'});
  const claimed=f.repo.claim(f.session.id);claimed.doc.messages=[{role:'assistant',content:'visible',reasoning_content:'private reasoning'}];f.repo.save(claimed,'completed');f.repo.release(claimed);
  const route=createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{},skills:{},sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,findGeneration:()=>null,publicGeneration:v=>v,walletOf:()=>({balance:10})});
  const res={};await route({method:'GET'},res,new URL(`http://localhost/api/agent/sessions/${f.session.id}`));
  assert.equal(res.status,200);assert.doesNotMatch(JSON.stringify(res.data),/private reasoning/);
  f.db.close();
});


test('new conversations retain independent history and scope with real desktop metadata',()=>{
  const f=fixture();
  const first=f.repo.create('user-a',scope,'canvas-a',{model:'first'});
  f.repo.enqueue(first,{clientId:'first-message',text:'第一份创作'});
  assert.equal(f.repo.create('user-a',scope,'canvas-a',{model:'other'}).id,first.id);
  const second=f.repo.create('user-a',scope,'canvas-a',{model:'second'},{fresh:true});
  assert.notEqual(first.id,second.id);
  assert.equal(f.repo.get(first.id,'user-a',scope).settings.model,'first');
  assert.equal(f.repo.inputs(second).length,0);
  assert.equal(f.repo.list('user-a',scope,'canvas-a').length,1);
  f.repo.enqueue(second,{clientId:'second-message',text:'第二份创作'});
  assert.equal(f.repo.list('user-a',scope,'canvas-a').length,2);
  assert.equal(f.repo.list('user-a',scope,'canvas-a').find(c=>c.id===first.id).title,'第一份创作');
  assert.deepEqual(f.repo.list('user-b',scope,'canvas-a'),[]);
  assert.deepEqual(f.repo.list('user-a',{...scope,deviceId:'another'},'canvas-a'),[]);
  f.db.close();
});

test('a follow-up uses prior user and assistant messages and newly selected model',async()=>{
  const f=fixture(), requests=[];
  const {runtime}=runtimeFixture(f,async request=>{requests.push(request);return answer(requests.length===1?'主角叫小林。':'小林决定出发。');});
  f.repo.enqueue(f.session,{clientId:'turn-one',text:'主角叫小林，请记住'});
  await runtime.kick(f.session.id);
  f.repo.settings(f.get(),{...f.get().settings,model:'another-model'});
  f.repo.enqueue(f.get(),{clientId:'turn-two',text:'接着写他的行动'});
  await runtime.kick(f.session.id);
  assert.equal(requests[1].model,'another-model');
  assert.ok(requests[1].messages.some(m=>m.role==='user'&&m.content==='主角叫小林，请记住'));
  assert.ok(requests[1].messages.some(m=>m.role==='assistant'&&m.content==='主角叫小林。'));
  assert.equal(f.get().doc.messages.filter(m=>m.role==='user').length,2);
  await runtime.stop();f.db.close();
});

test('canvas artifacts survive creating another conversation',()=>{
  const f=fixture();const first=f.repo.create('user-a',scope,'canvas-a',{model:'m'});
  f.repo.enqueue(first,{clientId:'turn-one',text:'保存文稿'});
  const claimed=f.repo.claim(first.id);claimed.doc.documents=[{id:'doc-a',title:'文稿',text:'正文',revision:1}];f.repo.save(claimed,'completed');f.repo.release(claimed);
  const second=f.repo.create('user-a',scope,'canvas-a',{model:'m'},{fresh:true});
  assert.equal(f.repo.artifacts(second).documents[0].conversationId,first.id);
  assert.equal(f.repo.artifacts(second).documents[0].text,'正文');
  f.db.close();
});


test('empty conversations stay out of history and do not consume the history limit',()=>{
  const f=fixture();
  try{
    assert.deepEqual(f.repo.list('user-a',scope,''),[]);
    f.repo.enqueue(f.session,{clientId:'first-message',text:'保留已发送的对话'});
    for(let i=0;i<105;i++){
      const empty=f.repo.create('user-a',scope,'',{model:'test-model'},{fresh:true});
      f.repo.settings(empty,{model:'another-model'});
    }
    const history=f.repo.list('user-a',scope,'');
    assert.deepEqual(history.map(item=>item.id),[f.session.id]);
    assert.equal(history[0].title,'保留已发送的对话');
  }finally{f.db.close();}
});
