import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { AGENT_SCHEMA_SQL, createAgentSessionRepository } from '../repositories/agent-sessions.mjs';
import { createAgentRouteHandler } from '../server/routes/agent.mjs';
import { createAgentRuntime } from '../lib/agent/runtime.mjs';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { llmRatesFromEnv } from '../lib/billing.mjs';
import { filterAssistantHistory, renderAssistantHistory } from '../public/features/assistant/presentation.js';
import { assistantApi } from '../public/features/assistant/workspace.js';
import { staticEntryFile } from '../server/static.mjs';

const scope={deviceId:'device-a',workspaceId:'workspace-a'};
function fixture(t, fileOptions={}) {
  const db=new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('user-a'),('user-b');");
  db.exec(AGENT_SCHEMA_SQL);
  t.after(()=>db.close());
  const repo=createAgentSessionRepository({sql:s=>db.prepare(s),tx:fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}});
  const create=(settings={})=>repo.create('user-a',scope,'',{mode:'assistant',model:'model-a',...settings});
  const gateway={config:{configured:true,model:'model-a',maxTokens:1000},listModels:async()=>[{id:'model-a',label:'模型 A'},{id:'model-b',label:'模型 B'}]};
  const runtime={kick(){},interrupt(){}};
  const route=createAgentRouteHandler({...fileOptions,repository:repo,runtime,gateway,skills:{search:async()=>[{name:'script-writing',title:'剧本创作',summary:'场景与对白'},{name:'external-operation',title:'其他操作'}]},requireUser:async()=>({id:'user-a'}),requireDesktopWorkspaceScope:()=>scope,bodyJson:async req=>req.body||{},sendJson:(res,status,data)=>Object.assign(res,{status,data}),walletOf:()=>({balance:100})});
  async function request(path,method='GET',body){const res={};try{await route({method,body},res,new URL(path,'http://local'));}catch(error){res.status=error.statusCode||500;res.data={error:error.message,stack:error.stack};}return res;}
  return {db,repo,create,gateway,request};
}

test('assistant history remains separate from legacy project migration and other account/workspace histories',t=>{
  const {repo,create}=fixture(t);
  const assistant=create();
  repo.enqueue(assistant,{text:'帮我查资料',clientId:'message-1'});
  const creative=repo.create('user-a',scope,'',{model:'model-a'});
  repo.enqueue(creative,{text:'创作一个故事',clientId:'message-2'});
  repo.create('user-b',scope,'',{mode:'assistant',model:'model-a'});
  repo.create('user-a',{...scope,workspaceId:'other'},'',{mode:'assistant',model:'model-a'});
  assert.equal(repo.listAssistant('user-a',scope).length,1);
  assert.equal(repo.listAssistant('user-a',scope)[0].id,assistant.id);
  assert.equal(repo.list('user-a',scope,'').some(item=>item.id===assistant.id),false);
  assert.equal(repo.listProjects('user-a',scope).length,1);
  assert.equal(repo.get(assistant.id,'user-a',scope).agentProjectId,'');
  assert.equal(repo.get(creative.id,'user-a',scope).agentProjectId.length>0,true);
});

test('assistant configuration, model selection, titles and deletion use independent sessions',async t=>{
  const {repo,request}=fixture(t);
  assert.deepEqual((await request('/api/agent/config?mode=assistant')).data.skills.map(skill=>skill.name),['script-writing']);
  const created=await request('/api/agent/sessions','POST',{mode:'assistant',model:'model-b'});
  assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.data.settings.model,'model-b');assert.equal(created.data.canvas,null);
  const id=created.data.id;
  assert.equal((await request(`/api/agent/sessions/${id}/settings`,'POST',{model:'model-a',title:'资料查询'})).status,202);
  const history=await request('/api/agent/sessions?mode=assistant');
  assert.equal(history.data.sessions[0].title,'资料查询');assert.equal(history.data.sessions[0].model,'model-a');
  assert.equal((await request('/api/agent/sessions','POST',{mode:'assistant',model:'missing'})).status,400);
  assert.equal((await request(`/api/agent/sessions/${id}/settings`,'POST',{model:'missing'})).status,400);
  assert.equal((await request(`/api/agent/sessions/${id}/settings`,'POST',{mode:'creative'})).status,400);
  const foreign=repo.create('user-b',scope,'',{mode:'assistant',model:'model-a'});
  assert.equal((await request(`/api/agent/sessions/${foreign.id}`,'DELETE')).status,404);
  assert.equal((await request(`/api/agent/sessions/${id}`,'DELETE')).status,200);
  assert.equal((await request(`/api/agent/sessions/${id}`)).status,404);
  assert.deepEqual((await request('/api/agent/sessions?mode=assistant')).data.sessions,[]);
});

test('assistant rejects creative endpoints, project associations, mode changes and model changes during replies',async t=>{
  const {repo,create,request}=fixture(t);
  const session=create();const base=`/api/agent/sessions/${session.id}`;
  for(const endpoint of ['canvas','documents','approval'])assert.equal((await request(`${base}/${endpoint}`,'POST',{})).status,400);
  assert.equal((await request('/api/agent/sessions','POST',{mode:'assistant',projectId:'project'})).status,400);
  assert.equal((await request(`${base}/messages`,'POST',{text:'hi',clientId:'message-1',selection:['asset']})).status,400);
  const creative=repo.create('user-a',scope,'',{model:'model-a'});
  assert.equal((await request(`/api/agent/sessions/${creative.id}/settings`,'POST',{mode:'assistant'})).status,400);
  assert.equal((await request(`${base}/messages`,'POST',{text:'你好',clientId:'message-2'})).status,202);
  assert.equal((await request(`${base}/settings`,'POST',{model:'model-b'})).status,409);
  assert.throws(()=>repo.settings(session,{...session.settings,model:'model-b'}),{statusCode:409});
});

const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const answer=(content,tool_calls)=>({message:{role:'assistant',content,...(tool_calls?{tool_calls}:{})},usage:{inputTokens:10,outputTokens:5},model:'model-b',providerRequestId:'test-request'});

test('assistant runtime uses the chosen model and search sources while blocking undeclared creative tool calls',async t=>{
  const {repo,create,gateway}=fixture(t);
  const session=create({model:'model-b'});
  repo.enqueue(session,{text:'联网查一下最新资料',clientId:'message-1'});
  const sources={query:'资料',results:[{title:'来源',url:'https://example.com/source',content:'结果'}]};
  let searches=0,steps=0,expectedModel='model-b';const settled=[];
  const activities=[],save=repo.save;repo.save=(session,...args)=>{activities.push(session.doc.activity);return save(session,...args);};
  const tools=createAgentTools({webSearch:async()=>{searches++;return sources;}});
  const execute=tools.execute;tools.execute=async(name,...args)=>{assert.equal(name,'web_search');return execute(name,...args);};
  gateway.contextWindow=async model=>{assert.equal(model,expectedModel);return 128000;};
  gateway.complete=async request=>{
    assert.equal(request.model,expectedModel);
    if(expectedModel==='model-a'){assert.ok(request.messages.some(message=>message.role==='assistant'&&message.content?.includes('https://example.com/source')));return answer('已保留上文，继续回答。');}
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['skills_search','web_search','skills_read']);
    assert.match(request.messages[0].content,/通用助手/);
    if(steps++===0)return answer('我会核实资料。',[call('media_submit',{},'denied'),call('web_search',{query:'资料'},'search')]);
    const results=request.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
    assert.match(results[0].error,/支持文字创作和联网搜索/);
    assert.deepEqual(results[1],sources);
    assert.equal(repo.get(session.id,'user-a',scope).doc.activity,'正在整理资料…');
    request.onDelta('资料来自');
    assert.equal(repo.get(session.id,'user-a',scope).doc.activity,'正在回复…');
    return answer('资料来自[来源](https://example.com/source)。');
  };
  const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async(_user,_id,_response,options)=>settled.push(options.configuredModel),release:async()=>{},reconcile:async()=>{}};
  const runtime=createAgentRuntime({repository:repo,gateway,tools,skills:{search:async()=>[{name:'script-writing',description:'剧本创作'},{name:'unrelated',description:'无关技能'}]},contextFor:async()=>{throw new Error('creative context loaded');},billing});
  t.after(()=>runtime.stop());
  await runtime.kick(session.id);
  const saved=repo.get(session.id,'user-a',scope);
  assert.equal(saved.state,'completed',saved.doc.lastError);
  assert.ok(activities.includes('正在联网搜索资料…'));
  assert.equal(activities.at(-1),'');
  assert.equal(searches,1);assert.equal(steps,2);assert.deepEqual(settled,['model-b','model-b']);
  assert.match(saved.doc.messages.at(-1).content,/https:\/\/example.com\/source/);
  repo.settings(saved,{...saved.settings,model:'model-a'});
  assert.equal(repo.get(session.id,'user-a',scope).settings.model,'model-a');
  expectedModel='model-a';
  repo.enqueue(repo.get(session.id,'user-a',scope),{text:'继续解释上面的资料',clientId:'followup-1'});
  await runtime.kick(session.id);
  assert.equal(repo.get(session.id,'user-a',scope).state,'completed');
  assert.equal(settled.at(-1),'model-a');
  await runtime.stop();
});

test('assistant transport preserves client message identity and sends the assistant mode and selected model',async()=>{
  const calls=[];
  const api=assistantApi(async(path,options)=>{calls.push({path,body:options?.body&&JSON.parse(options.body)});return {};},{getModel:()=> 'model-b'});
  await api('/api/agent/config');await api('/api/agent/sessions?projectId=');
  await api('/api/agent/sessions',{method:'POST',body:JSON.stringify({projectId:'',fresh:true,modelPreferences:{}})});
  await api('/api/agent/sessions/abc/messages',{method:'POST',body:JSON.stringify({text:'你好',clientId:'same-message',modelPreferences:{}})});
  assert.equal(calls[0].path,'/api/agent/config?mode=assistant');
  assert.equal(new URL(calls[1].path,'http://local').searchParams.get('mode'),'assistant');
  assert.deepEqual(calls[2].body,{fresh:true,mode:'assistant',model:'model-b'});
  assert.deepEqual(calls[3].body,{text:'你好',clientId:'same-message'});
});

test('assistant appears below quick creation and each versioned entry loads its current dependencies',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(html,/<button class="rail-button" data-route="assistant" data-rail-tip="通用助手"/);
  assert.match(html,/data-route="video"[^\n]+\n\s*<\/div>\n\s*<button[^>]+data-route="assistant"/);
  assert.match(html,/id="assistantView" class="hidden"/);
  assert.match(html,/\/app.js\?v=635/);
  assert.match(app,/features\/assistant\/workspace.js\?v=17/);
  assert.match(app,/features\/assistant\/workspace.css\?v=14/);
  const workspace=await readFile(new URL('../public/features/assistant/workspace.js',import.meta.url),'utf8');
  assert.match(workspace,/presentation.js\?v=8/);
  assert.match(workspace,/model-picker.js\?v=8/);
  const picker=await readFile(new URL('../public/features/assistant/model-picker.js',import.meta.url),'utf8');
  assert.match(picker,/presentation.js\?v=8/);
  assert.equal(staticEntryFile('/assistant',{desktop:true}),'index.html');
  assert.equal(staticEntryFile('/assistant',{appOnly:false}),'index.html');
});

test('history search matches titles without case sensitivity and safely renders user-provided names',()=>{
  const items=[{id:'a',title:'Claude 使用笔记'},{id:'b',title:'联网搜索资料'},{id:'c',title:'<img src=x onerror=alert(1)>'}];
  assert.deepEqual(filterAssistantHistory(items,'  CLAUDE  '),[items[0]]);
  assert.deepEqual(filterAssistantHistory(items,'搜索'),[items[1]]);
  assert.deepEqual(filterAssistantHistory(items,'不存在'),[]);
  assert.deepEqual(filterAssistantHistory(items,'  '),items);
  const rendered=renderAssistantHistory(items,'c');
  assert.ok(rendered.includes('&lt;img'));
  assert.ok(!rendered.includes('<img'));
  assert.match(rendered,/data-session="c"[^>]+aria-current="page"/);
  assert.match(renderAssistantHistory(items,'a','不存在'),/没有找到相关对话/);
});

test('assistant reads existing writing skills and paginated references without granting creative operations',async t=>{
  const {repo,create,gateway}=fixture(t);
  const session=create();repo.enqueue(session,{text:'把这个故事写成三个分镜提示词',clientId:'writing-1'});
  const catalog=[{name:'script-writing',description:'剧本创作'},{name:'short-drama',description:'短剧改编'},{name:'external-operation',description:'其他操作'}];
  const reads=[],activities=[],save=repo.save;
  repo.save=(session,...args)=>{activities.push(session.doc.activity);return save(session,...args);};
  const skills={search:async()=>catalog,read:async(...args)=>{reads.push(args);return {name:args[0],text:'场景与对白',...(args[2]?{}:{nextOffset:10})};}};
  const tools=createAgentTools({skills});
  let step=0;
  gateway.contextWindow=async()=>128000;
  gateway.complete=async request=>{
    const context=request.messages.find(message=>message.content?.includes?.('script-writing')&&message.role==='user');
    assert.ok(context,'writing catalog is provided');
    assert.ok(!context.content.includes('external-operation'));
    assert.match(request.messages[0].content,/prompt title=/);
    if(step++===0)return answer('我会按故事整理分镜。',[call('skills_search',{query:'剧本'},'search-skills'),call('skills_read',{name:'script-writing'},'read')]);
    if(step===2){
      const result=JSON.parse(request.messages.find(message=>message.tool_call_id==='search-skills').content);
      assert.deepEqual(result,catalog.slice(0,2));
      return answer('已确定人物行动，继续补全描述。',[call('skills_read',{name:'script-writing',resource:'references/scenes-and-revision.md',offset:10},'reference'),call('skills_read',{name:'external-operation'},'denied-skill'),call('documents_write',{title:'稿件',text:'稿件'},'denied-write')]);
    }
    const results=request.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
    assert.match(results.at(-2).error,/不适用于文字创作/);
    assert.match(results.at(-1).error,/暂不支持此操作/);
    return answer('```prompt title="分镜 01"\n雨夜，女孩在门前停步。\n```');
  };
  const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async()=>{},release:async()=>{},reconcile:async()=>{}};
  const runtime=createAgentRuntime({repository:repo,gateway,tools,skills,billing,contextFor:async()=>{throw new Error('must not read canvas');}});
  t.after(()=>runtime.stop());await runtime.kick(session.id);
  const saved=repo.get(session.id,'user-a',scope);
  assert.equal(saved.state,'completed',saved.doc.lastError);
  for(const activity of ['正在查找写作资料…','正在阅读写作资料…','正在整理资料…'])assert.ok(activities.includes(activity),activity);
  assert.deepEqual(reads,[['script-writing',undefined,undefined],['script-writing','references/scenes-and-revision.md',10]]);
  assert.match(saved.doc.messages.at(-1).content,/雨夜/);
});

test('reply status and recovery controls sit at the response position instead of above the composer',async()=>{
  const {renderAssistantShell}=await import('../public/features/assistant/presentation.js');
  const html=renderAssistantShell();
  const response=html.slice(html.indexOf('class="dw-messages"'),html.indexOf('<nav class="dw-message-rail"'));
  assert.match(response,/dw-message-history[\s\S]*dw-message-draft[\s\S]*dw-turn-activity assistant-status/);
  for(const control of ['data-status','data-reconnect','data-resume']){
    assert.ok(response.includes(control));
    assert.ok(!html.slice(html.indexOf('class="assistant-composer-wrap"')).includes(control));
  }
});

test('assistant attachments validate ownership and type, survive reopening, and are passed directly to the chosen model',async t=>{
  const asset={id:'image-a',name:'参考.png',kind:'image'};
  const findAsset=(user,id,where)=>user==='user-a'&&where.workspaceId===scope.workspaceId&&id===asset.id?asset:null;
  const {repo,create,gateway,request}=fixture(t,{findAsset,publicAsset:file=>({...file,url:'/api/files/image-a/content'})});
  const session=create(),base=`/api/agent/sessions/${session.id}`;
  for(const selection of [['private-image'],['not-image'],'bad'])assert.equal((await request(`${base}/messages`,'POST',{text:'看图',clientId:'invalid-attachment',selection})).status,400);
  assert.equal((await request(`${base}/messages`,'POST',{text:'看图',clientId:'too-many-images',selection:['image-a'],documents:Array.from({length:10},()=>({title:'稿件.txt',text:'正文'}))})).status,400);
  const text='分析图片并结合剧本\n\n附件：\n参考.png（素材 ID：image-a）\n\n附带文件：\n剧本.txt';
  assert.equal((await request(`${base}/messages`,'POST',{text,clientId:'image-doc-message',selection:['image-a'],documents:[{title:'剧本.txt',text:'第一场：雨夜重逢。'}]})).status,202);
  const snapshot=(await request(base)).data;
  assert.equal(snapshot.messages[0].images[0].id,'image-a');
  assert.equal(snapshot.messages[0].attachments[1].text,'第一场：雨夜重逢。');
  let completions=0;
  gateway.contextWindow=async()=>128000;
  gateway.complete=async options=>{
    const user=options.messages.find(message=>message.role==='user'&&Array.isArray(message.content));
    assert.ok(user,'image accompanies its original user message');
    assert.match(user.content[0].text,/第一场：雨夜重逢/);
    assert.equal(user.content.find(part=>part.type==='image_url').image_url.url,'data:image/png;base64,AA==');
    assert.equal(options.model,'model-a');completions++;
    return answer('图中内容和剧本的关系如下。');
  };
  const tools=createAgentTools({findAsset,inspectImage:async()=> 'data:image/png;base64,AA=='});
  const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async()=>{},release:async()=>{},reconcile:async()=>{}};
  const runtime=createAgentRuntime({repository:repo,gateway,tools,skills:{search:async()=>[]},billing});t.after(()=>runtime.stop());
  await runtime.kick(session.id);
  assert.equal(repo.get(session.id,'user-a',scope).state,'completed');
  assert.equal((await request(`${base}/messages`,'POST',{text:'继续分析上一张图',clientId:'followup-image-message'})).status,202);
  await runtime.kick(session.id);assert.equal(completions,2);
  assert.equal(repo.get(session.id,'user-a',scope).state,'completed');
  gateway.listModels=async()=>[{id:'model-a',supportsImages:false}];
  assert.equal((await request(`${base}/messages`,'POST',{text:'看图',clientId:'unsupported-model',selection:['image-a']})).status,400);
});

test('selected writing skill persists in its own conversation, survives settings changes and can be removed',async t=>{
  const {repo,request}=fixture(t);
  const catalog=await request('/api/agent/skills?mode=assistant');assert.deepEqual(catalog.data.skills.map(skill=>skill.name),['script-writing']);
  const selected=await request('/api/agent/sessions','POST',{mode:'assistant',model:'model-a',skill:'script-writing'});
  assert.equal(selected.status,200);const base=`/api/agent/sessions/${selected.data.id}`;
  assert.equal(selected.data.settings.skill,'script-writing');
  assert.equal((await request(`${base}/settings`,'POST',{title:'剧本讨论',model:'model-b'})).data.settings.skill,'script-writing');
  assert.equal((await request(base)).data.settings.skill,'script-writing');
  assert.equal((await request(`${base}/settings`,'POST',{skill:'external-operation'})).status,400);
  const other=await request('/api/agent/sessions','POST',{mode:'assistant',model:'model-a'});assert.equal(other.data.settings.skill,'');
  assert.equal((await request(`${base}/settings`,'POST',{skill:''})).data.settings.skill,'');
  await request(`${base}/settings`,'POST',{skill:'script-writing'});
  await request(`${base}/messages`,'POST',{text:'写一场戏',clientId:'required-skill-message'});
  assert.equal((await request(`${base}/settings`,'POST',{skill:''})).status,409);
  assert.equal(repo.get(selected.data.id,'user-a',scope).settings.skill,'script-writing');
});

test('runtime reads the full selected skill before answering and applies it again on follow-up turns',async t=>{
  const {repo,create,gateway}=fixture(t);const session=create({skill:'script-writing'});
  const reads=[];let completions=0;
  const skills={search:async()=>[{name:'script-writing',description:'剧本'}],read:async(name,resource,offset)=>{reads.push([name,resource,offset]);return offset?{text:'第二页：保持可表演对白。'}:{text:'第一页：写出完整场景。',nextOffset:13};}};
  gateway.contextWindow=async()=>128000;
  gateway.complete=async options=>{
    assert.match(options.messages[0].content,/必须按 requiredSkill/);
    const context=options.messages.find(message=>typeof message.content==='string'&&message.content.includes('当前工作区资料'));
    assert.match(context.content,/第一页：写出完整场景。第二页：保持可表演对白。/);
    assert.match(context.content,/"selectedSkill":"script-writing"/);completions++;return answer('第一场：雨夜重逢。');
  };
  const tools=createAgentTools({skills});const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async()=>{},release:async()=>{},reconcile:async()=>{}};
  const runtime=createAgentRuntime({repository:repo,gateway,tools,skills,billing});t.after(()=>runtime.stop());
  for(const [index,text] of ['写一场戏','把对白再精简一点'].entries()){
    repo.enqueue(repo.get(session.id,'user-a',scope),{text,clientId:`required-skill-turn-${index}`});await runtime.kick(session.id);assert.equal(repo.get(session.id,'user-a',scope).state,'completed');
  }
  assert.equal(completions,2);assert.deepEqual(reads.map(read=>read[2]),[0,13,0,13]);
  skills.read=async()=>{throw new Error('技能暂时无法读取');};
  repo.enqueue(repo.get(session.id,'user-a',scope),{text:'继续',clientId:'required-skill-failed'});await runtime.kick(session.id);
  assert.equal(repo.get(session.id,'user-a',scope).state,'paused');assert.equal(completions,2,'must not silently answer without the selected skill');
});

test('local skills are scoped to their conversation snapshot and references stay readable without granting file execution',async t=>{
  const {repo,create,gateway,request}=fixture(t);const session=create(),base=`/api/agent/sessions/${session.id}`;
  const name='local-'+ 'c'.repeat(32),localSkill={name,files:{'SKILL.md':'---\nname: my-writing\ndescription: 自定义对白要求\n---\n# 我的写作技能\n必须先明确人物的意图。','references/对白.md':'对白中保留可表演的行动。'}};
  assert.equal((await request(`${base}/settings`,'POST',{skill:name})).status,400);
  assert.equal((await request(`${base}/settings`,'POST',{skill:name,localSkill:{...localSkill,files:{...localSkill.files,'scripts/run.sh':'echo bad'}}})).status,400);
  const saved=await request(`${base}/settings`,'POST',{skill:name,localSkill});assert.equal(saved.status,202);assert.equal(saved.data.settings.localSkill.title,'我的写作技能');assert.ok(!saved.data.settings.localSkill.files);
  assert.match(repo.get(session.id,'user-a',scope).settings.localSkill.files['SKILL.md'],/人物的意图/);
  const foreign=create();assert.equal((await request(`/api/agent/sessions/${foreign.id}/settings`,'POST',{skill:name})).status,400);
  gateway.contextWindow=async()=>128000;let steps=0;
  gateway.complete=async options=>{
    const context=options.messages.find(message=>typeof message.content==='string'&&message.content.includes('当前工作区资料'));
    assert.match(context.content,/必须先明确人物的意图/);
    assert.ok(!options.tools.some(tool=>/exec|shell/.test(tool.function.name)));
    if(steps++===0)return answer('我先结合你的写作要求梳理对白。',[call('skills_read',{name,resource:'references/对白.md'},'local-ref')]);
    const result=options.messages.find(message=>message.tool_call_id==='local-ref');assert.match(result.content,/可表演的行动/);
    return answer('已按人物的意图改写对白。');
  };
  const skills={search:async()=>[]};const tools=createAgentTools({skills});const billing={rates:llmRatesFromEnv(),reserve:async()=>({}),settle:async()=>{},release:async()=>{},reconcile:async()=>{}};
  const runtime=createAgentRuntime({repository:repo,gateway,tools,skills,billing});t.after(()=>runtime.stop());
  await request(`${base}/messages`,'POST',{text:'改写这段对白',clientId:'local-skill-message'});
  assert.equal((await request(`${base}/settings`,'POST',{skill:name,localSkill})).status,409,'do not replace the snapshot during a reply');
  await runtime.kick(session.id);assert.equal(repo.get(session.id,'user-a',scope).state,'completed');assert.equal(steps,2);
  const cleared=await request(`${base}/settings`,'POST',{skill:''});assert.equal(cleared.data.settings.skill,'');assert.ok(!repo.get(session.id,'user-a',scope).settings.localSkill);
});
