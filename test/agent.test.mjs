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
import { estimateInputTokens, inputBudget, nextCompaction } from '../lib/agent/context.mjs';
import { AGENT_SCHEMA_SQL, createAgentSessionRepository } from '../repositories/agent-sessions.mjs';
import { defaultTitleFromMessage } from '../public/features/agent/default-title.js';
import { createAgentRouteHandler } from '../server/routes/agent.mjs';
import { llmRatesFromEnv } from '../lib/billing.mjs';
import { normalizeModelPreferences } from '../lib/agent/model-preferences.mjs';

const imagePreference = ids => ({image:{mode:'manual',modelIds:ids},video:{mode:'auto',modelIds:[]}});

const scope = { deviceId:'device-a', workspaceId:'workspace-a', desktop:true, platform:'darwin' };
test('skill list loads without waiting for the model catalog', async () => {
  const skills = [{name:'image-design',title:'图像设计',summary:'海报、角色、场景和产品图'}];
  let modelRequests = 0;
  const route = createAgentRouteHandler({
    repository:{}, runtime:{},
    gateway:{config:{configured:true,model:'test-model'},listModels:async()=>{modelRequests++;throw new Error('模型服务不可用');}},
    skills:{search:async()=>skills},
    sendJson:(res,status,data)=>Object.assign(res,{status,data}),
    requireUser:async()=>({id:'user-a'}), requireDesktopWorkspaceScope:()=>scope,
  });
  const res = {};
  await route({method:'GET'},res,new URL('http://localhost/api/agent/skills'));
  assert.equal(res.status,200);
  assert.deepEqual(res.data,{skills});
  assert.equal(modelRequests,0);
});
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
function runtimeFixture(f, complete, tools, skills = {search:async()=>[]}, model = 'test-model') {
  const counts={reserve:0,settle:0,reconcile:0,release:0};
  const billing={rates:llmRatesFromEnv(),...Object.fromEntries(Object.keys(counts).map(k=>[k,async()=>{counts[k]++;return {};}]))};
  const gateway={config:{model,maxTokens:1000},contextWindow:async()=>384000,complete};
  const runtime=createAgentRuntime({repository:f.repo,gateway,tools:tools||{definitions:()=>[],images:async()=>[],get:()=>({}),execute:async()=>({ok:true})},skills,billing});
  return {runtime,counts};
}

test('30 inspected generation images reach the next model request with their asset identities', async () => {
  const f = fixture();
  const assets = Array.from({ length:30 }, (_, i) => ({ id:`generated-${i}`, kind:'image', sourceUrl:`https://provider.example/${i}`, remoteStatus:'local_only' }));
  const inspections = [];
  const tools = createAgentTools({
    findAsset:(userId, id, requestedScope) => {
      assert.equal(userId, 'user-a');
      assert.equal(requestedScope.workspaceId, scope.workspaceId);
      return assets.find(asset => asset.id === id);
    },
    publicAsset:asset => ({ id:asset.id, kind:asset.kind }),
    inspectImage:async (asset, userId) => {
      assert.equal(userId, 'user-a');
      inspections.push(asset.id);
      return `data:image/png;base64,${Buffer.from(asset.id).toString('base64')}`;
    },
  });
  f.repo.enqueue(f.session, { clientId:'inspect-generated-images', text:'检查这 30 张参考图' });
  let requests = 0;
  const { runtime } = runtimeFixture(f, async request => {
    if (!requests++) return answer('', assets.map(asset => call('assets_inspect', { assetId:asset.id }, `inspect-${asset.id}`)));
    const content = request.messages.at(-1).content;
    assert.deepEqual(content.filter(item => item.type === 'image_url').map(item => item.image_url.url), assets.map(asset => `data:image/png;base64,${Buffer.from(asset.id).toString('base64')}`));
    for (const asset of assets) assert.ok(content.some(item => item.type === 'text' && item.text.includes(asset.id)));
    return answer('已读取 30 张参考图。');
  }, tools);
  try {
    await runtime.kick(f.session.id);
    assert.equal(f.get().state, 'completed');
    assert.equal(requests, 2);
    assert.equal(inspections.length, 60);
  } finally { await runtime.stop(); f.db.close(); }
});

test('reading a 31st image cannot silently evict earlier images, and repeat reads stay deduplicated', async () => {
  const ids = Array.from({ length:30 }, (_, i) => `image-${i}`);
  const session = { userId:'user-a', scope, doc:{ imageIds:[...ids] } };
  const tools = createAgentTools({ findAsset:(_userId,id) => ({ id, kind:'image' }), publicAsset:value => value, inspectImage:async () => 'https://example.test/image.png' });
  await tools.execute('assets_inspect', { assetId:ids[0] }, session);
  await assert.rejects(tools.execute('assets_inspect', { assetId:'image-31' }, session), /最多查看 30 张/);
  assert.deepEqual(session.doc.imageIds, ids);
  assert.equal((await tools.images(session)).filter(part => part.type === 'image_url').length, 30);
});

test('message API preserves 30 image selections plus a canvas selection and rejects overflow explicitly', async () => {
  const f = fixture();
  let input = { clientId:'thirty-images', text:'请检查这些图片', selection:['canvas-node', ...Array.from({ length:30 }, (_, i) => `image-${i}`)] };
  const route = createAgentRouteHandler({ repository:f.repo, runtime:{ kick() {} }, gateway:{config:{model:'test-model'}}, skills:{}, bodyJson:async () => input, sendJson:(res,status,data) => Object.assign(res,{status,data}), requireUser:() => ({id:'user-a'}), requireDesktopWorkspaceScope:() => scope, findGeneration:() => null, publicGeneration:v => v, walletOf:() => ({balance:10}) });
  try {
    const res = {};
    await route({method:'POST'}, res, new URL(`http://localhost/api/agent/sessions/${f.session.id}/messages`));
    assert.equal(res.status, 202);
    assert.deepEqual(JSON.parse(f.repo.inputs(f.get())[0].selection_json), input.selection);
    input = { ...input, clientId:'too-many-images', selection:Array.from({length:51}, (_,i) => `image-${i}`) };
    const overflow = {};
    await route({method:'POST'}, overflow, new URL(`http://localhost/api/agent/sessions/${f.session.id}/messages`));
    assert.equal(overflow.status, 400);
    assert.equal(f.repo.inputs(f.get()).length, 1);
  } finally { f.db.close(); }
});

test('gateway normalizes custom endpoint and preserves selectable model IDs',async()=>{
  const config=agentConfig({AGENT_API_BASE:'https://gateway.example/v1/chat/completions',AGENT_API_KEY:'secret',AGENT_MODEL:'a',AGENT_MODELS:'a,b'});
  assert.equal(config.baseUrl,'https://gateway.example/v1');
  assert.equal(agentConfig({AGENT_API_BASE:'https://gateway.example',AGENT_API_KEY:'secret'}).configured,false);
  const requests=[];
  const gateway=createAgentGateway({config,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'r',model:'b',choices:[{message:{role:'assistant',content:'你好'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}}));}});
  assert.deepEqual((await gateway.listModels()).map(m=>m.id),['a','b']);
  const result=await gateway.complete({model:'b',messages:[{role:'user',content:'你好'}],tools:[]});
  assert.equal(requests[0].url,'https://gateway.example/v1/chat/completions');
  assert.equal(requests[0].body.model,'b');
  assert.equal(result.message.content,'你好');
  await assert.rejects(gateway.complete({model:'not-in-catalog',messages:[],tools:[]}),/不可用/);
});

test('model windows use a 1M DeepSeek cap and require metadata for other models',async()=>{
  assert.equal(agentConfig({}).modelContextWindows['deepseek-v4-flash'],1000000);
  const config=agentConfig({AGENT_API_BASE:'https://gateway.example',AGENT_API_KEY:'secret',AGENT_MODEL:'deepseek-v4-flash',AGENT_MODEL_CONTEXT_WINDOWS:'custom:32768'});
  const gateway=createAgentGateway({config,fetchImpl:async()=>new Response(JSON.stringify({data:[{id:'deepseek-v4-flash',context_window:1000000},{id:'custom',context_window:16000},{id:'unknown'}]}))});
  assert.equal(await gateway.contextWindow('deepseek-v4-flash'),1000000);
  assert.equal(await gateway.contextWindow('custom'),16000);
  await assert.rejects(gateway.contextWindow('unknown'),/暂时无法使用/);
  assert.throws(()=>agentConfig({AGENT_MODEL_CONTEXT_WINDOWS:'broken'}),/配置无效/);
  const explicit=agentConfig({AGENT_API_BASE:'https://gateway.example',AGENT_API_KEY:'secret',AGENT_MODEL:'custom',AGENT_MODELS:'custom'});
  const discovered=createAgentGateway({config:explicit,fetchImpl:async()=>new Response(JSON.stringify({data:[{id:'custom',context_window:65536}]}))});
  assert.equal(await discovered.contextWindow('custom'),65536);
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

test('gateway records why a complete but unusable model reply was rejected',async()=>{
  const choices=[
    {message:{content:'未写完'},finish_reason:'length'},
    {message:{content:null,tool_calls:[{type:'function',function:{name:'jobs_wait',arguments:'{}'}}]},finish_reason:'tool_calls'},
    {message:{content:null},finish_reason:'stop'},
  ];
  let index=0;
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true},fetchImpl:async()=>new Response(JSON.stringify({choices:[choices[index++]],usage:{prompt_tokens:10,completion_tokens:2}}))});
  for(const reason of ['length','incomplete_tool_call','empty_response']){
    const result=await gateway.complete({model:'m',messages:[],tools:[]});
    assert.equal(result.invalidOutput,true);
    assert.equal(result.invalidOutputReason,reason);
  }
});

test('gateway requires a protocol stop signal instead of judging response punctuation',async()=>{
  const choices=[
    {message:{content:'回复到一半'}},
    {message:{content:'这是一个较长的创作方案。'.repeat(25)+'关于声音：建议先'},finish_reason:'stop'},
  ];
  let index=0;
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true},fetchImpl:async()=>new Response(JSON.stringify({choices:[choices[index++]],usage:{prompt_tokens:10,completion_tokens:2}}))});
  assert.equal((await gateway.complete({model:'m',messages:[],tools:[]})).invalidOutputReason,'incomplete_response');
  assert.equal((await gateway.complete({model:'m',messages:[],tools:[]})).invalidOutput,undefined);
});

test('SSE EOF before DONE is not committed as a completed assistant reply',async()=>{
  const events=[
    {choices:[{delta:{content:'关于声音：建议先'},finish_reason:'stop'}]},
    {choices:[],usage:{prompt_tokens:10,completion_tokens:6}},
  ];
  const body=events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
  const config={...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true};
  const gateway=createAgentGateway({config,fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})});
  const result=await gateway.complete({model:'m',messages:[],tools:[]});
  assert.equal(result.message.content,'关于声音：建议先');
  assert.equal(result.finishReason,'stop');
  assert.equal(result.invalidOutputReason,'incomplete_stream');
  const completed=createAgentGateway({config,fetchImpl:async()=>new Response(body+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
  assert.equal((await completed.complete({model:'m',messages:[],tools:[]})).invalidOutput,undefined);
});

test('SSE finishes at DONE even if the upstream keeps the connection open',async()=>{
  let cancelled=false;
  const body='data: '+JSON.stringify({choices:[{delta:{content:'回复完整。'},finish_reason:'stop'}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:2,completion_tokens:3}})+'\n\n'
    +'data: [DONE]\n\n';
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(body));},cancel(){cancelled=true;}});
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true},fetchImpl:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),streamIdleTimeoutMs:20});
  const result=await gateway.complete({model:'m',messages:[],tools:[]});
  assert.equal(result.message.content,'回复完整。');
  assert.equal(result.invalidOutput,undefined);
  assert.equal(cancelled,true);
});

test('a stalled reply stream is retryable instead of waiting for the full request timeout',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'半句话'}}]})+'\n\n'));},cancel(){cancelled=true;}});
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true},fetchImpl:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),streamIdleTimeoutMs:20});
  await assert.rejects(gateway.complete({model:'m',messages:[],tools:[]}),error=>error.retryableReply===true);
  assert.equal(cancelled,true);
});

test('runtime retries an unfinished SSE stream without saving its partial text',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'unfinished-stream',text:'请说明制作步骤'});
  let attempts=0;
  const config={...agentConfig({AGENT_MODEL:'test-model',AGENT_MODELS:'test-model'}),configured:true};
  const gateway=createAgentGateway({config,fetchImpl:async()=>{
    attempts++;
    const text=attempts===1?'制作步骤：建议先':'制作步骤：先确定分镜，再准备画面和声音。';
    const events=[{choices:[{delta:{content:text},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:8}}];
    const body=events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+(attempts===1?'':'data: [DONE]\n\n');
    return new Response(body,{headers:{'content-type':'text/event-stream'}});
  }});
  const {runtime,counts}=runtimeFixture(f,request=>gateway.complete(request));
  try{
    await runtime.kick(f.session.id);
    assert.equal(attempts,2);
    assert.equal(f.get().state,'completed');
    assert.equal(f.get().doc.messages.at(-1).content,'制作步骤：先确定分镜，再准备画面和声音。');
    assert.equal(counts.settle,2);
  }finally{await runtime.stop();f.db.close();}
});

test('connection failures keep reconciliation internal and explain how to continue',async()=>{
  const gateway=createAgentGateway({config:{...agentConfig({AGENT_MODEL:'m',AGENT_MODELS:'m'}),configured:true},fetchImpl:async()=>{throw new TypeError('fetch failed');}});
  await assert.rejects(gateway.complete({model:'m',messages:[],tools:[]}),error=>error.billingReconcileRequired===true&&/点击“继续”/.test(error.message)&&!/用量|费用|核对/.test(error.message));
});

test('runtime retries a broken reply stream without saving the partial sentence',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'retry-stream',text:'请写完整回复'});
  let attempts=0;
  const {runtime,counts}=runtimeFixture(f,async({onDelta})=>{
    attempts++;
    if(attempts===1){onDelta('这句话只写到一');throw Object.assign(new Error('回复中途断开'),{retryableReply:true,billingReconcileRequired:true});}
    onDelta('这句话已经写完整。');
    return answer('这句话已经写完整。');
  });
  try{
    await runtime.kick(f.session.id);
    assert.equal(attempts,2);
    assert.equal(counts.reconcile,1);
    assert.equal(counts.settle,1);
    assert.equal(f.get().state,'completed');
    assert.equal(f.get().doc.draft,undefined);
    assert.equal(f.get().doc.messages.at(-1).content,'这句话已经写完整。');
  }finally{await runtime.stop();f.db.close();}
});

test('repeated reply disconnections pause after bounded automatic retries',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'retry-limit',text:'继续'});
  let attempts=0;
  const {runtime,counts}=runtimeFixture(f,async({onDelta})=>{
    attempts++;
    onDelta(`未完成片段${attempts}`);
    throw Object.assign(new Error('回复中途断开，点击“继续”重新获取回复。'),{retryableReply:true,billingReconcileRequired:true});
  });
  try{
    await runtime.kick(f.session.id);
    assert.equal(attempts,3);
    assert.equal(counts.reconcile,3);
    assert.equal(f.get().state,'paused');
    assert.equal(f.get().doc.draft,undefined);
    assert.ok(!f.get().doc.messages.some(message=>message.role==='assistant'));
  }finally{await runtime.stop();f.db.close();}
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

test('selected skill is a visible hint without eagerly loading its instructions',async()=>{
  const f=fixture(),session=f.get();
  f.repo.settings(session,{...session.settings,skill:'video-replication'});
  f.repo.enqueue(f.get(),{clientId:'replicate-video',text:'我想复刻一条视频，请告诉我需要提供什么。'});
  let sent;
  const {runtime}=runtimeFixture(f,async request=>{sent=request.messages;return answer('请先提供参考视频。');},undefined,createAgentSkills());
  await runtime.kick(f.session.id);
  assert.match(sent[1].content,/"selectedSkill":"video-replication"/);
  assert.equal(sent[1].role,'user');
  assert.doesNotMatch(JSON.stringify(sent),/# 爆款视频复刻/);
  await runtime.stop();f.db.close();
});

test('creative requests initially see only skill metadata and can continue without a skill',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'poster',text:'请设计一张产品海报'});
  const sent=[];
  const {runtime}=runtimeFixture(f,async request=>{sent.push(request.messages);return answer('我会先安排主视觉。');},undefined,createAgentSkills());
  await runtime.kick(f.session.id);
  assert.match(sent[0][1].content,/"name":"image-design","description":/);
  assert.doesNotMatch(JSON.stringify(sent[0]),/# 图像设计/);
  f.repo.enqueue(f.get(),{clientId:'hello',text:'你好，今天怎么样？'});
  await runtime.kick(f.session.id);
  assert.doesNotMatch(sent[1][1].content,/# 图像设计/);
  await runtime.stop();f.db.close();
});

test('a selected skill does not force unrelated creative instructions into the task',async()=>{
  const f=fixture(),session=f.get();
  f.repo.settings(session,{...session.settings,skill:'image-design'});
  f.repo.enqueue(f.get(),{clientId:'video',text:'请帮我制作一条视频'});
  let sent;
  const {runtime}=runtimeFixture(f,async request=>{sent=request.messages;return answer('先确定画面目标。');},undefined,createAgentSkills());
  await runtime.kick(f.session.id);
  assert.match(sent[1].content,/"selectedSkill":"image-design"/);
  assert.doesNotMatch(sent[1].content,/# 图像设计/);
  assert.doesNotMatch(sent[1].content,/# 视频制作/);
  await runtime.stop();f.db.close();
});

test('the agent reads a skill on demand and its full text is not carried into a later user turn',async()=>{
  const f=fixture(),skills=createAgentSkills();
  f.repo.enqueue(f.session,{clientId:'poster',text:'请设计一张海报'});
  const requests=[];
  const toolset={definitions:()=>[],images:async()=>[],get:()=>({}),execute:async(name,args)=>name==='skills_read'?skills.read(args.name,args.resource):{}};
  let round=0;
  const {runtime}=runtimeFixture(f,async request=>{requests.push(request.messages);return round++===0?answer('',[call('skills_read',{name:'image-design'})]):answer('已完成。');},toolset,skills);
  await runtime.kick(f.session.id);
  assert.equal(requests[0][1].role,'user');
  assert.doesNotMatch(JSON.stringify(requests[0]),/# 图像设计/);
  assert.match(requests[1].find(message=>message.role==='tool').content,/# 图像设计/);
  f.repo.enqueue(f.get(),{clientId:'hello',text:'你好'});
  await runtime.kick(f.session.id);
  const later=requests[2];
  assert.doesNotMatch(JSON.stringify(later),/# 图像设计/);
  assert.match(later.find(message=>message.role==='tool').content,/previous_turn_skill_read/);
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
  const {runtime}=runtimeFixture(f,async()=>round++===0?answer(null,[call('media_prepare',{})]):round===2?answer('这次生成一张猫的图片，按你刚才确认的画面制作。',[call('media_submit',{preparedRequestId:'p'},'call-b')]):answer('已提交。'),tools);
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
    if(round===1||round===3)return answer('角色设为两名剑士，先生成屋顶对峙的角色参考图，供后续片段保持外观一致。',[call('media_prepare',{}),call('media_submit',{preparedRequestId:'p'},'submit')]);
    return answer(round===2?'建议两名剑士在屋顶交锋，分为对峙、交手、收势三个镜头。你想调整角色还是场景？':'已开始制作。');
  },tools);
  await runtime.kick(f.session.id);
  assert.deepEqual(executed,[]);
  assert.equal(f.get().doc.approval,undefined);
  assert.equal(f.get().state,'completed');
  assert.equal(f.get().doc.messages.filter(m=>m.role==='tool'&&m.content.includes('讨论或拆解阶段')).length,2);
  f.repo.enqueue(f.session,{clientId:'produce',text:'角色场景和分镜都确认，按这个方案开始生成'});
  await runtime.kick(f.session.id);
  assert.deepEqual(executed,['media_prepare','media_submit']);
  assert.equal(f.get().state,'completed');
  await runtime.stop();f.db.close();
});

for (const automatic of [false, true]) {
  test(`silent generation must recover with a visible plan before ${automatic ? 'automatic submission' : 'approval'}`, async () => {
    const f = fixture();
    f.repo.settings(f.session, {...f.session.settings, autoGenerate:automatic, generationBudgetMicro:10000000});
    f.repo.enqueue(f.session, {clientId:'replicate', text:'复刻参考视频，人物改说中文。'});
    let round = 0, preparedCount = 0, submitted = 0;
    const summary = '原片已确认五位角色，按各段出镜关系改为中文对话。这次先制作人物参考图，用于后续视频保持角色外观一致。';
    const toolset = {definitions:()=>[], images:async()=>[], get:name=>({paid:name==='media_submit'}), execute:async(name,args,s)=>{
      if (name === 'media_prepare') {
        preparedCount++;
        s.doc.prepared = {p:{input:{type:'image',prompt:'五位角色参考图',modelId:'image'},quote:{costMicro:1000000,credits:1,quantity:1}}};
        return {preparedRequestId:'p'};
      }
      submitted++;
      s.doc.prepared.p.result = {jobIds:['job']};
      return s.doc.prepared.p.result;
    }};
    const {runtime} = runtimeFixture(f, async request => {
      round++;
      if (round === 1) return answer('我先看原片和复刻方法，再定方案。', [call('media_prepare',{},'prepare')]);
      if (round === 2) {
        const response = answer('  ', [call('media_submit',{preparedRequestId:'p'},'silent-submit')]);
        response.message.reasoning_content = '仅内部的分析不能作为制作说明';
        return response;
      }
      if (round === 3) {
        const feedback = JSON.parse(request.messages.find(m => m.role === 'tool' && m.tool_call_id === 'silent-submit').content);
        assert.equal(feedback.code, 'progress_required');
        assert.equal(submitted, 0);
        assert.equal(f.get().doc.approval, undefined);
        assert.notEqual(f.get().doc.prepared.p.status, 'failed');
        return answer(summary, [call('media_submit',{preparedRequestId:'p'},'explained-submit')]);
      }
      return answer('人物参考图已开始生成。');
    }, toolset);
    try {
      await runtime.kick(f.session.id);
      assert.equal(preparedCount, 1, 'reuse the quote instead of preparing again');
      assert.equal(f.get().state, automatic ? 'completed' : 'waiting_approval');
      const route = createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{config:{model:'test-model'}},skills:{},
        sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,
        findGeneration:()=>null,publicGeneration:v=>v,walletOf:()=>({balance:10})});
      const res = {};
      await route({method:'GET'},res,new URL(`http://localhost/api/agent/sessions/${f.session.id}`));
      assert.ok(res.data.messages.some(m => m.role === 'assistant' && m.text === summary));
      assert.doesNotMatch(JSON.stringify(res.data), /仅内部的分析|progress_required/);
      if (!automatic) {
        assert.equal(submitted, 0);
        f.repo.enqueue(f.get(), {clientId:'confirm',text:'确认生成'});
        await runtime.kick(f.session.id);
      }
      assert.equal(submitted, 1);
      assert.equal(f.get().state, 'completed');
      await runtime.kick(f.session.id);
      assert.equal(submitted, 1);
    } finally { await runtime.stop(); f.db.close(); }
  });
}

test('silent read steps require a public finding without treating saved documents or reasoning as a reply', async () => {
  const f = fixture();
  f.repo.enqueue(f.session,{clientId:'analyze',text:'分析这些素材并给出建议'});
  const executed = [];
  let round = 0;
  const toolset = {definitions:()=>[],images:async()=>[],get:()=>({}),execute:async(name,args,s)=>{
    executed.push(name);
    if (name === 'documents_write') s.doc.documents.push({id:'analysis',title:'分析',text:'仅保存到文稿的发现',revision:1});
    return {ok:true};
  }};
  const {runtime} = runtimeFixture(f,async request=>{
    round++;
    if (round === 1) return answer('我先对照素材，再给你结论。',[call('assets_search',{},'search')]);
    if (round === 2) return answer(null,[call('assets_inspect',{},'inspect')]);
    if (round === 3) return answer(null,[call('documents_write',{},'write')]);
    if (round === 4) return answer(null,[call('workspace_read',{},'silent-read')]);
    if (round === 5) {
      assert.equal(JSON.parse(request.messages.at(-1).content).code,'progress_required');
      assert.deepEqual(executed,['assets_search','assets_inspect','documents_write']);
      return answer('素材中有两个不同场景，建议分别安排段落；接下来核对已有方案。',[call('workspace_read',{},'explained-read')]);
    }
    return answer('建议保留两个场景的顺序。');
  },toolset);
  try {
    await runtime.kick(f.session.id);
    assert.equal(f.get().state,'completed');
    assert.deepEqual(executed,['assets_search','assets_inspect','documents_write','workspace_read']);
  } finally { await runtime.stop(); f.db.close(); }
});

test('a restored silent approval respects cancellation before requesting a new summary', async () => {
  const f = fixture();
  f.repo.enqueue(f.session,{clientId:'legacy-request',text:'生成一张猫的图片'});
  const claimed = f.repo.claim(f.session.id);
  claimed.doc.lastInput = f.repo.inputs(claimed)[0].seq;
  claimed.doc.messages = [{role:'user',content:'生成一张猫的图片'},answer(null,[call('media_submit',{preparedRequestId:'p'},'legacy-submit')]).message];
  claimed.doc.prepared = {p:{input:{type:'image',prompt:'猫',modelId:'image'},quote:{costMicro:1000000,credits:1,quantity:1}}};
  claimed.doc.pendingCalls = [{id:'legacy-invocation',call:call('media_submit',{preparedRequestId:'p'},'legacy-submit')}];
  claimed.doc.approval = {id:'legacy-invocation'};
  f.repo.save(claimed,'waiting_approval');
  f.repo.release(claimed);
  f.repo.approve(f.get(),'legacy-invocation',false);
  let submitted = 0;
  const {runtime} = runtimeFixture(f, async request => {
    const result = JSON.parse(request.messages.find(m => m.role === 'tool').content);
    assert.equal(result.error,'用户取消了这次生成');
    assert.equal(result.code,undefined);
    return answer('已取消这次生成。');
  }, {definitions:()=>[],images:async()=>[],get:name=>({paid:name==='media_submit'}),execute:async()=>{submitted++;return {};}});
  try {
    await runtime.kick(f.session.id);
    assert.equal(submitted,0);
    assert.equal(f.get().doc.prepared.p.status,'cancelled');
    assert.equal(f.get().doc.approval,undefined);
    assert.equal(f.get().state,'completed');
  } finally { await runtime.stop(); f.db.close(); }
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
  assert.match(f.get().doc.activity,/点击“继续”/);assert.doesNotMatch(f.get().doc.activity,/费用|核对/);
  await runtime.stop();
  f.repo.control(f.get(),'resume');
  const next=runtimeFixture(f,async()=>answer('你好，接着聊。'));
  await next.runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');
  assert.deepEqual(f.get().doc.messages.map(({role,content})=>[role,content]),[['user','你好'],['assistant','你好，接着聊。']]);
  assert.equal(next.counts.settle,1);
  await next.runtime.stop();f.db.close();
});

test('a failed connection can resume the same conversation without a new user message',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'first-message',text:'接着上面的想法聊'});
  const failed=runtimeFixture(f,async()=>{throw Object.assign(new Error('连接暂时中断，点击“继续”重新获取回复。'),{billingReconcileRequired:true});});
  await failed.runtime.kick(f.session.id);
  assert.equal(f.get().state,'paused');assert.equal(failed.counts.reconcile,1);
  assert.equal(f.get().doc.messages.at(-1).content,'接着上面的想法聊');
  await failed.runtime.stop();
  f.repo.control(f.get(),'resume');
  const resumed=runtimeFixture(f,async()=>answer('我们可以从角色动作开始。'));
  await resumed.runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');
  assert.equal(f.get().doc.messages.at(-1).content,'我们可以从角色动作开始。');
  assert.equal(f.get().doc.messages.filter(message=>message.role==='user').length,1);
  await resumed.runtime.stop();f.db.close();
});

test('invalid reply retries once with the same extracted frames and does not replay media tools',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'first-message',text:'看看刚生成的视频'});
  const seen=[],executed=[];
  let round=0;
  const tools={definitions:()=>[],images:async s=>(s.doc.frameImages||[]).map(frame=>({type:'image_url',image_url:{url:frame.imageUrl,detail:'low'}})),get:()=>({}),execute:async(name,_args,s)=>{
    executed.push(name);
    s.doc.frameImages=[{assetId:'video-a',timeSeconds:1,imageUrl:'data:image/jpeg;base64,AA=='}];
    return {frames:[{timeSeconds:1}]};
  }};
  const {runtime,counts}=runtimeFixture(f,async request=>{
    seen.push(request.messages);
    if(round++===0)return answer(null,[call('video_frames',{assetId:'video-a',times:[1]})]);
    if(round===2)return {...answer(null),invalidOutput:true,invalidOutputReason:'empty_response',finishReason:'stop'};
    return answer('视频已经生成好了。');
  },tools);
  await runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');
  assert.deepEqual(executed,['video_frames']);
  assert.equal(seen.length,3);
  assert.equal(seen[1].at(-1).content[1].image_url.url,'data:image/jpeg;base64,AA==');
  assert.equal(seen[2].at(-1).content[1].image_url.url,'data:image/jpeg;base64,AA==');
  assert.match(seen[2][1].content,/上次回复没有形成可用结果/);
  assert.equal(f.get().doc.frameImages.length,0);
  assert.equal(f.get().doc.lastInvalidOutput.reason,'empty_response');
  assert.equal(f.get().doc.lastInvalidOutput.imageCount,1);
  assert.equal(counts.settle,3);
  await runtime.stop();f.db.close();
});

test('repeated invalid replies pause with a usable continue path and retain diagnostics',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'first-message',text:'继续说明视频结果'});
  const invalid={...answer(null),invalidOutput:true,invalidOutputReason:'incomplete_tool_call',finishReason:'tool_calls',providerRequestId:'req-invalid'};
  const failed=runtimeFixture(f,async()=>invalid);
  await failed.runtime.kick(f.session.id);
  assert.equal(f.get().state,'paused');
  assert.equal(failed.counts.settle,2);
  assert.match(f.get().doc.activity,/点击“继续”/);
  assert.doesNotMatch(f.get().doc.activity,/换一个模型/);
  assert.equal(f.get().doc.lastInvalidOutput.providerRequestId,'req-invalid');
  assert.equal(f.get().doc.lastInvalidOutput.reason,'incomplete_tool_call');
  assert.equal(f.get().doc.invalidOutputAttempts.length,2);
  await failed.runtime.stop();
  f.repo.control(f.get(),'resume');
  const resumed=runtimeFixture(f,async()=>answer('视频结果已经可以查看。'));
  await resumed.runtime.kick(f.session.id);
  assert.equal(f.get().state,'completed');
  assert.equal(f.get().doc.messages.filter(message=>message.role==='user').length,1);
  assert.equal(f.get().doc.messages.at(-1).content,'视频结果已经可以查看。');
  await resumed.runtime.stop();f.db.close();
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
  const laterRoot=await mkdtemp(path.join(os.tmpdir(),'gugu-skills-later-'));
  try{await mkdir(path.join(root,'poster','references'),{recursive:true});
    await writeFile(path.join(root,'poster','SKILL.md'),'---\nname: poster\ndescription: 海报设计\n---\n创作方法');
    await mkdir(path.join(laterRoot,'poster'));await writeFile(path.join(laterRoot,'poster','SKILL.md'),'---\nname: poster\ndescription: 替换海报设计\n---\n不应覆盖');
    await writeFile(path.join(root,'outside.txt'),'private');await symlink(path.join(root,'outside.txt'),path.join(root,'poster','references','escape.txt'));
    await mkdir(path.join(root,'leaked'));await writeFile(path.join(root,'outside-skill.md'),'---\nname: leaked\ndescription: 不应读取\n---\n外部内容');await symlink(path.join(root,'outside-skill.md'),path.join(root,'leaked','SKILL.md'));
    const skills=createAgentSkills({roots:[root]});assert.equal((await skills.search('海报'))[0].name,'poster');
    assert.deepEqual(await skills.search('完全不相关的问题'),[]);
    assert.deepEqual(await skills.search('不应读取'),[]);
    assert.match((await skills.read('poster')).text,/创作方法/);
    assert.match((await createAgentSkills({roots:[root,laterRoot]}).read('poster')).text,/创作方法/);
    await assert.rejects(skills.read('poster','references/../../outside.txt'),/路径/);
    await assert.rejects(skills.read('poster','references/escape.txt'),/路径/);
  }finally{await rm(root,{recursive:true,force:true});await rm(laterRoot,{recursive:true,force:true});}
});

test('Chinese skill searches rank relevant methods without activating them',async()=>{
  const skills=createAgentSkills();
  assert.equal((await skills.search('做一张海报'))[0].name,'image-design');
  assert.deepEqual((await skills.search('设计短剧分镜视频')).slice(0,2).map(item=>item.name),['short-drama','video-production']);
  assert.equal((await skills.search('分析参考视频并复刻'))[0].name,'video-replication');
  assert.deepEqual((await skills.search('检查生成视频')).slice(0,2).map(item=>item.name),['creative-review','video-production']);
  assert.deepEqual((await skills.search('点评这张图')).map(item=>item.name),['creative-review','image-design']);
  assert.deepEqual((await skills.search('做海报')).map(item=>item.name),['image-design']);
  assert.deepEqual((await skills.search('写短剧')).map(item=>item.name),['short-drama']);
  assert.deepEqual((await skills.search('做个短视频')).map(item=>item.name),['video-production']);
  assert.deepEqual(await skills.search('你好'),[]);
});

test('Seedance versions and common aliases discover the dedicated prompting skill', async () => {
  const skills = createAgentSkills();
  for (const query of ['Seedance 2.0', 'Seedance 2.5', 'Seedance2.0', 'Seedance2.5', 'see dance 提示词', 'see dance2.5', 'sd25-pe', '豆包视频模型', '创作圣经']) {
    assert.equal((await skills.search(query))[0]?.name, 'seedance-creation-bible', query);
  }
  for (const query of ['做个短视频', '做海报', '你好', '设计数据库索引']) {
    assert.ok(!(await skills.search(query)).some(skill => skill.name === 'seedance-creation-bible'), query);
  }
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

test('agent generation preparation and submission preserve all 30 ordered reference IDs', async () => {
  const references = Array.from({length:30}, (_,i) => `reference-${i}`);
  const calls = [];
  const tools = createAgentTools({ generate:async args => {
    calls.push(args);
    return args.previewOnly ? {status:200,data:{costMicro:1000000,credits:1,quantity:1}} : {status:202,data:{id:'seedance-job'}};
  } });
  const session = {userId:'user-a',scope,doc:{generations:[]}};
  const prepared = await tools.execute('media_prepare', {type:'video',modelId:'seedance-2.5',prompt:'按顺序使用参考图片',referenceAssetIds:references}, session, {id:'prepare-thirty'});
  await tools.execute('media_submit', {preparedRequestId:prepared.preparedRequestId}, session, {id:'submit-thirty'});
  assert.equal(calls.length, 2);
  for (const request of calls) assert.deepEqual(request.input.referenceAssetIds, references);
});

test('context projection keeps assistant calls paired with tool results',()=>{
  const messages=[{role:'user',content:'old'.repeat(1000)},answer(null,[call('a',{})]).message,{role:'tool',tool_call_id:'call-a',content:'old result'},answer('done').message,{role:'user',content:'new'},answer(null,[call('b',{})]).message,{role:'tool',tool_call_id:'call-a',content:'new result'}];
  const result=buildAgentMessages({messages},{},'instructions');
  assert.equal(result.filter(m=>m.role==='tool').length,2);
  assert.equal(result.at(-2).tool_calls[0].function.name,'b');
  assert.equal(nextCompaction({messages}),null);
});

test('budget includes tools and images as well as message text',()=>{
  const messages=[{role:'system',content:'small'}];
  const bare=estimateInputTokens(messages,[]);
  assert.ok(estimateInputTokens(messages,[{schema:'x'.repeat(4000)}],2)>bare+24000);
  assert.ok(inputBudget(384000,6000)<384000-6000);
});

test('30 low-detail images fit the context estimate while retaining conservative billing holds', () => {
  const messages = [{ role:'user', content:Array.from({ length:30 }, () => ({ type:'image_url', image_url:{ url:'data:image/png;base64,AA==', detail:'low' } })) }];
  const context = estimateInputTokens(messages, [], 30);
  const billing = estimateInputTokens(messages, [], 30, { forBilling:true });
  assert.ok(context < inputBudget(384000, 6000));
  assert.ok(billing > 30 * 12000);
  assert.equal(billing - context, 30 * (12000 - 4096));
  assert.equal(estimateInputTokens(messages), context);
  messages[0].content[0].image_url.detail = 'high';
  // "high" also adds one byte to the serialized message.
  assert.equal(estimateInputTokens(messages, [], 30) - context, 12000 - 4096 + 1);
});

test('large tool results have a readable preview and remain available in chunks',async()=>{
  const callId='large-call', full='作品资料'.repeat(5000);
  const doc={messages:[{role:'user',content:'读取资料'},answer(null,[call('workspace_read',{},callId)]).message,{role:'tool',tool_call_id:callId,content:full}]};
  const view=buildAgentMessages(doc,{},'instructions');
  assert.equal(view.at(-1).role,'tool');
  assert.match(view.at(-1).content,/tool_result_read/);
  assert.ok(estimateInputTokens(view,[])<Buffer.byteLength(full));
  assert.equal(doc.messages.at(-1).content,full);
  const tools=createAgentTools({skills:{},catalog:async()=>[]});
  const first=await tools.execute('tool_result_read',{toolCallId:callId,offset:0},{doc},{id:'read-call'});
  assert.equal(first.text,full.slice(0,6000));
  assert.equal(first.nextOffset,6000);
});

test('long sessions compact earlier turns while preserving full transcript and current request',async()=>{
  const f=fixture();
  f.repo.enqueue(f.session,{clientId:'compact-turn',text:'继续写第三幕。'});
  const claimed=f.repo.claim(f.session.id);
  claimed.doc.messages=[
    {role:'user',content:'目标：写短剧。'+ '甲'.repeat(8000)},answer('已确定人物甲。').message,
    {role:'user',content:'第二幕。'+ '乙'.repeat(8000)},answer('已确定第二幕。').message,
    {role:'user',content:'继续写第三幕。'+ '丙'.repeat(8000)},
  ];
  claimed.doc.lastInput=f.repo.inputs(claimed).at(-1).seq;
  f.repo.save(claimed,'queued');f.repo.release(claimed);
  const requests=[];
  const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async()=>({}),release:async()=>({}),reconcile:async()=>({})};
  const gateway={config:{model:'test-model',maxTokens:1000},contextWindow:async()=>70000,complete:async request=>{requests.push(request);return answer(requests.length===1?'目标：写短剧；人物甲和第二幕已确定。':'第三幕完成。');}};
  const runtime=createAgentRuntime({repository:f.repo,gateway,tools:{definitions:()=>[],images:async()=>[],get:()=>({}),execute:async()=>({})},skills:{search:async()=>[]},billing});
  await runtime.kick(f.session.id);
  assert.equal(requests.length,2);
  assert.equal(requests[0].tools.length,0);
  assert.match(requests[0].messages[1].content,/较早对话/);
  assert.match(requests[1].messages[2].content,/人物甲/);
  assert.equal(f.get().doc.compaction.through,2);
  assert.equal(f.get().doc.messages.length,6);
  assert.equal(f.get().doc.messages[0].content.startsWith('目标：写短剧'),true);
  assert.ok(estimateInputTokens(requests[1].messages,[])<=inputBudget(70000,1000));
  await runtime.stop();f.db.close();
});

test('oversized active turn stops before a model request',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'large-turn',text:'甲'.repeat(25000)});
  let calls=0;
  const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async()=>({}),release:async()=>({}),reconcile:async()=>({})};
  const runtime=createAgentRuntime({repository:f.repo,gateway:{config:{model:'test-model',maxTokens:1000},contextWindow:async()=>8192,complete:async()=>{calls++;return answer('unexpected');}},tools:{definitions:()=>[],images:async()=>[],get:()=>({}),execute:async()=>({})},skills:{search:async()=>[]},billing});
  await runtime.kick(f.session.id);
  assert.equal(calls,0);
  assert.equal(f.get().state,'paused');
  assert.match(f.get().doc.lastError,/超过/);
  await runtime.stop();f.db.close();
});

test('a saved compaction response is applied after restart without another summary call',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'resume-summary',text:'继续'});
  const claimed=f.repo.claim(f.session.id);
  claimed.doc.messages=[{role:'user',content:'旧目标'},{role:'assistant',content:'旧决定'},{role:'user',content:'继续'}];
  claimed.doc.lastInput=f.repo.inputs(claimed).at(-1).seq;
  claimed.doc.step={id:'compact-1',kind:'compaction',compactThrough:2,model:'test-model',response:answer('目标和决定已记住。')};
  f.repo.save(claimed,'queued');f.repo.release(claimed);
  const requests=[],settled=[];
  const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async(_u,id)=>{settled.push(id);},release:async()=>({}),reconcile:async()=>({})};
  const runtime=createAgentRuntime({repository:f.repo,gateway:{config:{model:'test-model',maxTokens:1000},contextWindow:async()=>384000,complete:async request=>{requests.push(request);return answer('完成');}},tools:{definitions:()=>[],images:async()=>[],get:()=>({}),execute:async()=>({})},skills:{search:async()=>[]},billing});
  await runtime.kick(f.session.id);
  assert.equal(settled[0],'compact-1');
  assert.equal(settled.length,2);
  assert.equal(requests.length,1);
  assert.match(requests[0].messages[2].content,/目标和决定已记住/);
  assert.equal(f.get().doc.compaction.through,2);
  await runtime.stop();f.db.close();
});

test('API returns scoped visible conversation without internal reasoning or tool data',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'message-1',text:'hello'});
  const claimed=f.repo.claim(f.session.id);claimed.doc.messages=[{role:'assistant',content:'visible',reasoning_content:'private reasoning'}];f.repo.save(claimed,'completed');f.repo.release(claimed);
  const route=createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{config:{model:'test-model'}},skills:{},sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,findGeneration:()=>null,publicGeneration:v=>v,walletOf:()=>({balance:10})});
  const res={};await route({method:'GET'},res,new URL(`http://localhost/api/agent/sessions/${f.session.id}`));
  assert.equal(res.status,200);assert.doesNotMatch(JSON.stringify(res.data),/private reasoning/);
  f.db.close();
});

test('message previews survive processing and reopen with the correct same-named document',async()=>{
  const f=fixture();
  const text='请参考这些文件\n\n附件：\n画面.png（素材 ID：image-one）\n原片.mp4（素材 ID：video-one）\n台词.mp3（素材 ID：audio-one）\n成片.mp4（素材 ID：generated-video）\n其他.pdf（素材 ID：private-file）\n\n附带文件：\n剧本.txt';
  for(const [clientId,body] of [['first-upload','第一稿'],['second-upload','第二稿']]){
    f.repo.enqueue(f.get(),{clientId,text,documents:[{title:'剧本.txt',text:body}]});
  }
  const assets={
    'image-one':{id:'image-one',kind:'image',name:'画面.png'},
    'video-one':{id:'video-one',kind:'video',name:'原片.mp4'},
    'audio-one':{id:'audio-one',kind:'audio',name:'台词.mp3'},
    'generated-asset':{id:'generated-asset',kind:'video',name:'成片.mp4'},
  };
  const route=createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{config:{model:'test-model'}},skills:{},
    sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,
    findAsset:(userId,id,requestedScope)=>{assert.equal(userId,'user-a');assert.equal(requestedScope.workspaceId,scope.workspaceId);return assets[id];},
    publicAsset:asset=>({...asset,url:`/media/${asset.id}`,size:1024}),
    findGeneration:(_userId,id)=>id==='generated-video'?{assetId:'generated-asset'}:null,
    publicGeneration:value=>value,walletOf:()=>({balance:10}),
  });
  const snapshot=async()=>{const res={};await route({method:'GET'},res,new URL(`http://localhost/api/agent/sessions/${f.session.id}`));assert.equal(res.status,200);return res.data;};
  const {runtime}=runtimeFixture(f,async()=>answer('收到。'));
  try{
    const pending=(await snapshot()).messages.filter(item=>item.role==='user');
    assert.equal(pending.length,2);
    for(const [index,message] of pending.entries()){
      assert.equal(message.text,'请参考这些文件');
      assert.equal(message.attachments.length,6);
      assert.deepEqual(message.attachments.slice(0,4).map(file=>file.kind),['image','video','audio','video']);
      assert.equal(message.images.length,1);
      assert.equal(message.attachments[3].url,'/media/generated-asset');
      assert.equal(message.attachments[4].status,'unavailable');
      assert.equal(message.attachments[4].url,undefined);
      assert.equal(message.attachments[5].text,index===0?'第一稿':'第二稿');
    }
    await runtime.kick(f.session.id);
    const reopened=(await snapshot()).messages.filter(item=>item.role==='user');
    assert.deepEqual(reopened,pending);
    assert.ok(f.get().doc.messages[0].content.includes('素材 ID：video-one'),'model context retains attachment identities');
  }finally{await runtime.stop();f.db.close();}
});

test('legacy transcript attachments preview without matching input records and ordinary prose remains intact',async()=>{
  const f=fixture();f.repo.enqueue(f.session,{clientId:'legacy-trigger',text:'旧消息'});
  const claimed=f.repo.claim(f.session.id);claimed.doc.lastInput=f.repo.inputs(claimed)[0].seq;
  claimed.doc.messages=[{role:'user',content:'这是视频\n\n附件：\n视频.mov（素材 ID：legacy-video）'},{role:'user',content:'请说明素材 ID：legacy-video 的含义，不要删除这句话。'}];
  f.repo.save(claimed,'completed');f.repo.release(claimed);
  const route=createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{config:{model:'test-model'}},skills:{},sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,
    findAsset:(_userId,id)=>id==='legacy-video'?{id,name:'视频.mov',kind:'video'}:null,publicAsset:value=>({...value,url:'/media/video'}),findGeneration:()=>null,publicGeneration:value=>value,walletOf:()=>({balance:10})});
  try{
    const res={};await route({method:'GET'},res,new URL(`http://localhost/api/agent/sessions/${f.session.id}`));
    assert.equal(res.data.messages[0].text,'这是视频');
    assert.equal(res.data.messages[0].attachments[0].kind,'video');
    assert.equal(res.data.messages[1].text,claimed.doc.messages[1].content);
    assert.equal(res.data.messages[1].attachments,undefined);
  }finally{f.db.close();}
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

test('a follow-up uses prior messages and the configured model despite a saved model',async()=>{
  const f=fixture(), requests=[];
  const {runtime}=runtimeFixture(f,async request=>{requests.push(request);return answer(requests.length===1?'主角叫小林。':'小林决定出发。');},undefined,undefined,'configured-new');
  f.repo.enqueue(f.session,{clientId:'turn-one',text:'主角叫小林，请记住'});
  await runtime.kick(f.session.id);
  f.repo.settings(f.get(),{...f.get().settings,model:'another-model'});
  f.repo.enqueue(f.get(),{clientId:'turn-two',text:'接着写他的行动'});
  const claimed=f.repo.claim(f.session.id);claimed.doc.step={id:'old-step',model:'another-model'};f.repo.save(claimed,'queued');f.repo.release(claimed);
  await runtime.kick(f.session.id);
  assert.deepEqual(requests.map(request=>request.model),['configured-new','configured-new']);
  assert.ok(requests[1].messages.some(m=>m.role==='user'&&m.content==='主角叫小林，请记住'));
  assert.ok(requests[1].messages.some(m=>m.role==='assistant'&&m.content==='主角叫小林。'));
  assert.equal(f.get().doc.messages.filter(m=>m.role==='user').length,2);
  await runtime.stop();f.db.close();
});

test('historical conversation settings reflect the configured model and ignore an old client selection',async()=>{
  const f=fixture();
  let input={model:'unavailable-old'};
  const route=createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{config:{model:'configured-new'},listModels:async()=>{assert.fail('model catalog should not be needed');}},skills:{search:async()=>[]},
    bodyJson:async()=>input,sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,
    findGeneration:()=>null,publicGeneration:value=>value,walletOf:()=>({balance:10})});
  try{
    const url=new URL(`http://localhost/api/agent/sessions/${f.session.id}`);
    const before={};await route({method:'GET'},before,url);
    assert.equal(before.data.settings.model,'configured-new');
    const updated={};await route({method:'POST'},updated,new URL(`${url}/settings`));
    assert.equal(updated.data.settings.model,'configured-new');
    assert.equal(f.get().settings.model,'configured-new');
  }finally{f.db.close();}
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

test('smart creation projects keep conversations and one shared canvas isolated',()=>{
  const f=fixture();
  const first=f.repo.createProject('user-a',scope,'第一部作品');
  const second=f.repo.createProject('user-a',scope,'第二部作品');
  const conversation=f.repo.create('user-a',scope,'',{model:'m'},{agentProjectId:first.id});
  f.repo.enqueue(conversation,{clientId:'first-turn',text:'一只猫'});
  f.repo.saveCanvas(conversation,{directorWorkspace:{canvasNodes:[{id:'cat',type:'image'}]},assetIds:['asset-1']});
  const followup=f.repo.create('user-a',scope,'',{model:'m'},{agentProjectId:first.id,fresh:true});
  assert.notEqual(followup.id,conversation.id);
  assert.deepEqual(f.repo.canvas(followup).assetIds,['asset-1']);
  assert.equal(f.repo.listProjectSessions('user-a',scope,first.id).length,1);
  assert.deepEqual(f.repo.canvas(f.repo.create('user-a',scope,'',{model:'m'},{agentProjectId:second.id})).assetIds,[]);
  assert.equal(f.repo.getProject(first.id,'user-b',scope),null);
  assert.deepEqual(f.repo.listProjects('user-a',scope).map(project=>project.id).sort(),[first.id,second.id].sort());
  f.db.close();
});

test('conversation and default project titles use the first ten characters of the first message',()=>{
  const f=fixture();
  try{
    assert.equal(defaultTitleFromMessage('  😀请帮我设计一只可爱的小猫角色  '),'😀请帮我设计一只可爱');
    assert.equal(defaultTitleFromMessage('第一行\n第二行'),'第一行 第二行');
    const project=f.repo.createProject('user-a',scope);
    const first=f.repo.create('user-a',scope,'',{model:'m'},{agentProjectId:project.id});
    f.repo.enqueue(first,{clientId:'first',text:'请帮我设计一只可爱的小猫角色'});
    assert.equal(f.repo.getProject(project.id,'user-a',scope).title,'请帮我设计一只可爱的');
    assert.equal(f.repo.listProjects('user-a',scope).find(item=>item.id===project.id).title,'请帮我设计一只可爱的');
    assert.equal(f.repo.listProjectSessions('user-a',scope,project.id)[0].title,'请帮我设计一只可爱的');
    f.repo.enqueue(first,{clientId:'second',text:'第二条消息不会改变项目名称'});
    assert.equal(f.repo.getProject(project.id,'user-a',scope).title,'请帮我设计一只可爱的');
    const named=f.repo.createProject('user-a',scope,'手动命名的项目');
    const namedSession=f.repo.create('user-a',scope,'',{model:'m'},{agentProjectId:named.id});
    f.repo.enqueue(namedSession,{clientId:'named-first',text:'这条消息不应覆盖手动填写的名称'});
    assert.equal(f.repo.getProject(named.id,'user-a',scope).title,'手动命名的项目');
    f.repo.enqueue(f.session,{clientId:'standalone-first',text:'独立对话的第一条消息超过十个字'});
    assert.equal(f.repo.list('user-a',scope,'').find(item=>item.id===f.session.id).title,'独立对话的第一条消息');
    const withFile=f.repo.create('user-a',scope,'',{model:'m'},{fresh:true});
    f.repo.enqueue(withFile,{clientId:'with-file',text:'你好\n\n附件：\n参考图（素材 ID：image-1）'});
    assert.equal(f.repo.list('user-a',scope,'').find(item=>item.id===withFile.id).title,'你好');
  }finally{f.db.close();}
});

test('audio transcription fills a missing source digest and saves Japanese results',async()=>{
  const f=fixture();
  try{
    const project=f.repo.createProject('user-a',scope,'台词测试');
    const session=f.repo.create('user-a',scope,'',{model:'m'},{agentProjectId:project.id});
    const asset={id:'video-without-digest',kind:'video',name:'原片.mp4'};
    const digest='a'.repeat(64);
    let digestCalls=0,transcribeCalls=0;
    const tools=createAgentTools({
      findAsset:(_userId,id)=>id===asset.id?asset:null,
      transcriptStore:{list:(s,id)=>f.repo.listTranscripts(s,id),write:(s,record)=>f.repo.saveTranscript(s,record)},
      inspectVideo:{
        ensureDigest:async()=>{digestCalls++;return digest;},
        audioInfo:async()=>({hasAudio:true,durationSeconds:20.1}),
        transcribe:async(_userId,_asset,options)=>{
          transcribeCalls++;
          assert.equal(options.language,'ja');
          return {modelId:'nova-3',language:'ja',startSeconds:0,endSeconds:20.1,text:'こんにちは',words:[{text:'こんにちは',startSeconds:0,endSeconds:1}],cues:[{text:'こんにちは',startSeconds:0,endSeconds:1}],hasSpeech:true};
        },
      },
    });
    const first=await tools.execute('audio_transcribe',{assetId:asset.id,language:'ja'},session);
    assert.equal(first.sourceSha256,digest);
    assert.equal(first.cached,false);
    assert.equal(f.repo.listTranscripts(session,asset.id)[0].text,'こんにちは');
    const second=await tools.execute('audio_transcribe',{assetId:asset.id,language:'ja'},session);
    assert.equal(second.cached,true);
    assert.equal(digestCalls,1);
    assert.equal(transcribeCalls,1);
    assert.throws(()=>f.repo.saveTranscript(session,{assetId:asset.id,sourceSha256:undefined}),/无法确认素材内容/);
  }finally{f.db.close();}
});

test('earlier standalone conversations appear as projects with their saved canvas',()=>{
  const f=fixture();
  f.repo.enqueue(f.session,{clientId:'legacy-turn',text:'旧创作'});
  f.repo.saveCanvas(f.session,{directorWorkspace:{},assetIds:['old-asset']});
  const [project]=f.repo.listProjects('user-a',scope);
  assert.equal(project.title,'旧创作');
  assert.equal(f.repo.get(f.session.id,'user-a',scope).agentProjectId,project.id);
  assert.deepEqual(f.repo.canvas(f.repo.get(f.session.id,'user-a',scope)).assetIds,['old-asset']);
  assert.equal(f.repo.listProjects('user-a',scope).length,1);
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

test('video editing may validate during discussion, but renders only after a production request', async () => {
  const f = fixture();
  const executed = [];
  const toolset = { definitions: () => [], images: async () => [], get: () => ({}), execute: async (_name, args) => { executed.push(args.dryRun === true ? 'validate' : 'render'); return { ok: true }; } };
  let round = 0;
  const { runtime } = runtimeFixture(f, async () => {
    round++;
    if (round === 1) return answer('我先检查图文出现的时间。', [call('video_edit', { dryRun: true }, 'validate')]);
    if (round === 2) return answer('准备制作画面。', [call('video_edit', { dryRun: false }, 'premature')]);
    if (round === 3) return answer('画面方案已检查，尚未制作。');
    if (round === 4) return answer('按已确定的方案制作画面。', [call('video_edit', {}, 'render')]);
    return answer('制作完成。');
  }, toolset);
  try {
    f.repo.enqueue(f.session, { clientId: 'plan-only', text: '只讨论这段视频的画面方案，不要制作。' });
    await runtime.kick(f.session.id);
    assert.deepEqual(executed, ['validate']);
    assert.match(f.get().doc.messages.find(message => message.tool_call_id === 'premature').content, /讨论/);
    f.repo.enqueue(f.get(), { clientId: 'produce-edit', text: '开始制作，按这个方案完成。' });
    await runtime.kick(f.session.id);
    assert.deepEqual(executed, ['validate', 'render']);
  } finally { await runtime.stop(); f.db.close(); }
});

test('creating a conversation in its current project avoids model lookup and workspace serialization',async()=>{
  const f=fixture();
  try{
    const project=f.repo.createProject('user-a',scope,'作品');
    const old=f.repo.create('user-a',scope,'',{model:'test-model',skill:'image-design',autoGenerate:true,generationBudgetMicro:10},{agentProjectId:project.id});
    f.repo.saveCanvas(old,{directorWorkspace:{canvasNodes:[{id:'image',type:'image'}]},assetIds:['asset']});
    let lookups=0;
    const route=createAgentRouteHandler({repository:{...f.repo,artifacts(){assert.fail('reloaded project history');},canvas(){assert.fail('serialized shared canvas');}},runtime:{},
      gateway:{config:{model:'default'},listModels:async()=>{lookups++;throw new Error('slow model service');}},skills:{search:async()=>[]},
      bodyJson:async()=>({agentProjectId:project.id,fresh:true,previousSessionId:old.id,model:'test-model'}),
      sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:async()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,walletOf:()=>({balance:100}),findGeneration:()=>null,publicGeneration:v=>v});
    const res={};await route({method:'POST'},res,new URL('http://localhost/api/agent/sessions'));
    assert.equal(res.status,200);assert.notEqual(res.data.id,old.id);assert.equal(res.data.workspaceUnchanged,true);assert.deepEqual(res.data.messages,[]);
    assert.equal(res.data.settings.model,'default');assert.equal(res.data.settings.skill,'');assert.equal(res.data.settings.autoGenerate,false);assert.equal(lookups,0);
    assert.deepEqual(f.repo.canvas(f.repo.get(res.data.id,'user-a',scope)).assetIds,['asset']);
  }finally{f.db.close();}
});

test('a conversation from another project cannot enable workspace reuse or inherit its model',async()=>{
  const f=fixture();
  try{
    const a=f.repo.createProject('user-a',scope,'A'),b=f.repo.createProject('user-a',scope,'B');
    const old=f.repo.create('user-a',scope,'',{model:'invalid'},{agentProjectId:a.id});
    let lookups=0;
    const route=createAgentRouteHandler({repository:f.repo,runtime:{},gateway:{config:{model:'default'},listModels:async()=>{lookups++;return [{id:'default'}];}},skills:{search:async()=>[]},
      bodyJson:async()=>({agentProjectId:b.id,fresh:true,previousSessionId:old.id,model:'invalid'}),
      sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:async()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,walletOf:()=>({balance:100}),findGeneration:()=>null,publicGeneration:v=>v});
    const res={};await route({method:'POST'},res,new URL('http://localhost/api/agent/sessions'));
    assert.equal(res.status,200);
    assert.equal(res.data.settings.model,'default');
    assert.equal(res.data.workspaceUnchanged,undefined);
    assert.equal(lookups,0);
  }finally{f.db.close();}
});

test('message enqueue atomically persists preferences with the turn and rejects changed retries', () => {
  const f=fixture(),first=imagePreference(['image-a']),next=imagePreference(['image-b']);
  try{
    f.repo.saveUserModelPreferences('user-a',first);
    f.repo.enqueue(f.session,{clientId:'model-pref-first',text:'生成图片',modelPreferences:first});
    assert.deepEqual(f.get().settings.modelPreferences,first);
    f.repo.settings(f.get(),{...f.get().settings,modelPreferences:next});
    assert.deepEqual(JSON.parse(f.repo.inputs(f.get())[0].model_preferences_json),first);
    f.repo.enqueue(f.get(),{clientId:'model-pref-first',text:'生成图片',modelPreferences:first});
    assert.equal(f.repo.inputs(f.get()).length,1);
    assert.deepEqual(f.get().settings.modelPreferences,next);
    assert.throws(()=>f.repo.enqueue(f.get(),{clientId:'model-pref-first',text:'生成图片',modelPreferences:next}),/不同模型偏好重试/);
    f.repo.enqueue(f.get(),{clientId:'model-pref-next',text:'再生成一张'});
    assert.deepEqual(JSON.parse(f.repo.inputs(f.get())[1].model_preferences_json),next);
    const fresh=f.repo.create('user-a',scope,'',{model:'test-model'});
    assert.deepEqual(fresh.settings.modelPreferences,next);
  }finally{f.db.close();}
});

test('model preference API saves account choices without changing skill or budget and discovers media independently of chat models',async()=>{
  const f=fixture(),catalog=[{id:'image-a',label:'图片 A',kind:'image'},{id:'video-a',label:'视频 A',kind:'video'}];
  let input={},modelRequests=0;
  const route=createAgentRouteHandler({repository:f.repo,runtime:{kick(){}},gateway:{config:{model:'test-model'},listModels:async()=>{modelRequests++;throw new Error('offline');}},skills:{search:async()=>[]},mediaCatalog:async()=>catalog,bodyJson:async()=>input,sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:async()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,walletOf:()=>({balance:100}),publicGeneration:value=>value});
  try{
    const catalogResponse={};await route({method:'GET'},catalogResponse,new URL('http://localhost/api/agent/media-models'));
    assert.deepEqual(JSON.parse(JSON.stringify(catalogResponse.data.models)),catalog);assert.equal(modelRequests,0);
    f.repo.settings(f.session,{...f.session.settings,skill:'existing-skill',autoGenerate:true,generationBudgetMicro:9000000});
    input={modelPreferences:imagePreference(['image-a'])};const response={};
    await route({method:'POST'},response,new URL(`http://localhost/api/agent/sessions/${f.session.id}/settings`));
    assert.deepEqual(response.data.settings.modelPreferences,input.modelPreferences);
    assert.equal(response.data.settings.skill,'existing-skill');assert.equal(response.data.settings.autoGenerate,true);assert.equal(response.data.settings.generationBudgetMicro,9000000);
    input={clientId:'preferred-message',text:'生成一张图片',modelPreferences:imagePreference(['image-a'])};
    await route({method:'POST'},{},new URL(`http://localhost/api/agent/sessions/${f.session.id}/messages`));
    assert.deepEqual(JSON.parse(f.repo.inputs(f.get())[0].model_preferences_json),input.modelPreferences);
    input={modelPreferences:imagePreference(['video-a'])};
    await assert.rejects(route({method:'POST'},{},new URL(`http://localhost/api/agent/sessions/${f.session.id}/settings`)),/暂不可用/);
  }finally{f.db.close();}
});

test('runtime keeps the sent preference while settings change and blocks a model outside the allowed list',async()=>{
  const f=fixture(),generated=[];
  f.repo.settings(f.session,{...f.session.settings,autoGenerate:true,generationBudgetMicro:10000000,modelPreferences:imagePreference(['image-a'])});
  f.repo.enqueue(f.get(),{clientId:'model-pref-runtime',text:'生成一张图片',modelPreferences:imagePreference(['image-a'])});
  const tools=createAgentTools({catalog:async()=>[],generate:async args=>{generated.push(args);return {status:200,data:args.previewOnly?{costMicro:1000000,credits:1,quantity:1}:{id:'generated-a',status:'queued'}};}});
  let requests=0;
  const {runtime}=runtimeFixture(f,async request=>{
    assert.ok(request.messages[0].content.includes('image-a'));assert.ok(!request.messages[0].content.includes('image-b'));
    if(!requests++){
      f.repo.settings(f.get(),{...f.get().settings,modelPreferences:imagePreference(['image-b'])});
      return answer('我会生成一张图片。',[call('media_prepare',{type:'image',modelId:'image-b',prompt:'一只猫'},'outside')]);
    }
    if(requests===2){assert.match(request.messages.at(-1).content,/不在本次选择中/);return answer('我会使用所选模型生成一只猫。',[call('media_prepare',{type:'image',modelId:'image-a',prompt:'一只猫'},'allowed')]);}
    if(requests===3){const prepared=JSON.parse(request.messages.at(-1).content);return answer('使用所选图片模型，生成一只猫供你查看。',[call('media_submit',{preparedRequestId:prepared.preparedRequestId},'submit')]);}
    return answer('图片已开始生成。');
  },tools);
  try{
    await runtime.kick(f.session.id);
    assert.equal(f.get().state,'completed');assert.equal(generated.length,2);
    assert.ok(generated.every(args=>args.input.modelId==='image-a'));
    assert.deepEqual(f.get().settings.modelPreferences,imagePreference(['image-b']));
    assert.deepEqual(f.get().doc.runModelPreferences,imagePreference(['image-a']));
  }finally{await runtime.stop();f.db.close();}
});

test('an earlier prepared request cannot bypass a new manual selection or create a charge confirmation',async()=>{
  const f=fixture();
  f.session.doc.prepared={old:{input:{type:'image',modelId:'image-b',prompt:'猫'},quote:{credits:1,costMicro:1000000,quantity:1}}};
  f.db.prepare('UPDATE agent_sessions SET doc_json=? WHERE id=?').run(JSON.stringify(f.session.doc),f.session.id);
  f.repo.enqueue(f.get(),{clientId:'model-pref-stale',text:'生成一张图片',modelPreferences:imagePreference(['image-a'])});
  let requests=0,submissions=0;
  const tools=createAgentTools({catalog:async()=>[],generate:async()=>{submissions++;return {status:200,data:{}};}});
  const {runtime}=runtimeFixture(f,async request=>{
    if(!requests++)return answer('我会生成一张猫的图片。',[call('media_submit',{preparedRequestId:'old'},'old-submit')]);
    assert.match(request.messages.at(-1).content,/不在本次选择中/);return answer('请使用当前选择的模型重新准备图片。');
  },tools);
  try{await runtime.kick(f.session.id);assert.equal(f.get().state,'completed');assert.equal(submissions,0);assert.equal(f.get().doc.approval,undefined);}
  finally{await runtime.stop();f.db.close();}
});

test('account preference API works before creating a conversation and new project snapshots use the saved choice',async()=>{
  const f=fixture(),preferences=imagePreference(['image-a']);let input={},userId='user-b';
  const route=createAgentRouteHandler({repository:f.repo,runtime:{kick(){}},gateway:{config:{model:'chat'}},skills:{search:async()=>[]},mediaCatalog:async()=>[{id:'image-a',label:'图片 A',kind:'image'}],bodyJson:async()=>input,sendJson:(res,status,data)=>Object.assign(res,{status,data}),requireUser:async()=>({id:userId}),requireDesktopWorkspaceScope:()=>scope,walletOf:()=>({balance:100}),publicGeneration:v=>v});
  const url=path=>new URL(`http://localhost/api/agent/${path}`);
  try{
    input={modelPreferences:preferences};const saved={};await route({method:'PUT'},saved,url('model-preferences'));
    assert.deepEqual(saved.data.modelPreferences,preferences);
    assert.equal(f.repo.list('user-b',scope,'').length,0);
    const p=f.repo.createProject('user-b',scope,'新项目');
    input={agentProjectId:p.id};const first={};await route({method:'POST'},first,url('sessions'));
    assert.deepEqual(first.data.settings.modelPreferences,preferences);
    input={agentProjectId:p.id,fresh:true,previousSessionId:first.data.id};const fresh={};await route({method:'POST'},fresh,url('sessions'));
    assert.deepEqual(fresh.data.settings.modelPreferences,preferences);assert.equal(fresh.data.workspaceUnchanged,true);
    userId='user-a';const other={};await route({method:'GET'},other,url('model-preferences'));
    assert.deepEqual(other.data.modelPreferences,normalizeModelPreferences());
    assert.deepEqual(f.repo.userModelPreferences('user-b'),preferences);
  }finally{f.db.close();}
});
