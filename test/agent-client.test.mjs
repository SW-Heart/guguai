import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreativeAgentClient} from '../public/features/agent/client.js';

test('startup loads session and configuration concurrently without publishing partial state',async()=>{
  const requests=[],states=[];let resolveConfig,resolveSession;
  const client=createCreativeAgentClient({projectId:'p',onState:(state,config)=>states.push({state,config}),onError(){},api:async url=>{
    requests.push(url);
    if(url==='/api/agent/config')return new Promise(resolve=>{resolveConfig=resolve;});
    if(url==='/api/agent/sessions')return new Promise(resolve=>{resolveSession=resolve;});
    if(url.includes('?'))return {sessions:[]};
    throw new Error(url);
  }});
  try{
    const pending=client.start();
    assert.deepEqual(requests,['/api/agent/config','/api/agent/sessions']);
    resolveSession({id:'saved',state:'idle',canvas:{nodes:['image','video']}});
    await Promise.resolve();await Promise.resolve();
    assert.equal(states.length,0);
    resolveConfig({configured:true});await pending;
    assert.equal(states.length,1);assert.equal(states[0].state.id,'saved');assert.equal(states[0].config.configured,true);
  }finally{client.dispose();}
});

test('leaving a project during startup ignores the delayed response',async()=>{
  const states=[];let resolveConfig;
  const client=createCreativeAgentClient({projectId:'p',onState:state=>states.push(state),onError(){},api:async url=>{
    if(url==='/api/agent/config')return new Promise(resolve=>{resolveConfig=resolve;});
    return {id:'old',state:'idle'};
  }});
  const pending=client.start();client.dispose();resolveConfig({configured:true});await pending;
  assert.deepEqual(states,[]);
});

test('a real startup failure is reported without publishing incomplete content',async()=>{
  const states=[];
  const client=createCreativeAgentClient({projectId:'p',onState:state=>states.push(state),onError(){},api:async url=>{
    if(url==='/api/agent/config')throw new Error('网络连接已断开');
    return {id:'saved',state:'idle'};
  }});
  try{await assert.rejects(client.start(),/网络连接已断开/);assert.deepEqual(states,[]);}
  finally{client.dispose();}
});

test('a missing saved conversation falls back after configuration loads',async()=>{
  const states=[];
  const client=createCreativeAgentClient({projectId:'p',initialSessionId:'removed',onState:state=>states.push(state),onError(){},api:async url=>{
    if(url==='/api/agent/config')return {configured:true};
    if(url.endsWith('/removed'))throw Object.assign(new Error('不存在'),{status:404});
    if(url.includes('?'))return {sessions:[]};
    return {id:'replacement',state:'idle'};
  }});
  try{await client.start();assert.equal(states.length,1);assert.equal(states[0].id,'replacement');}
  finally{client.dispose();}
});

test('reopening after a client restart loads the saved conversation',async()=>{
  const requests=[];
  const client=createCreativeAgentClient({projectId:'p',initialSessionId:'saved-chat',onState:()=>{},onError:()=>{},api:async url=>{
    requests.push(url);
    if(url==='/api/agent/config')return {configured:true};
    if(url==='/api/agent/sessions/saved-chat')return {id:'saved-chat',state:'paused',messages:[{role:'user',text:'继续聊'}]};
    if(url.startsWith('/api/agent/sessions?'))return {sessions:[{id:'saved-chat'}]};
    throw new Error(url);
  }});
  try{
    await client.start();
    assert.ok(requests.includes('/api/agent/sessions/saved-chat'));
    assert.ok(!requests.includes('/api/agent/sessions'));
  }finally{client.dispose();}
});

test('failed navigation resumes polling the conversation that remains open',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let polls=0;
  const client=createCreativeAgentClient({projectId:'p',onState(){},onError(){},api:async url=>{
    if(url==='/api/agent/config')return {configured:true};
    if(url.includes('?'))return {sessions:[]};
    if(url==='/api/agent/sessions')return {id:'first',state:'running'};
    if(url.endsWith('/missing'))throw new Error('unavailable');
    if(url.endsWith('/first')){polls++;return {id:'first',state:'running'};}
    throw new Error(url);
  }});
  try{await client.start();await assert.rejects(client.open('missing'),/unavailable/);t.mock.timers.tick(500);await Promise.resolve();assert.equal(polls,1);}
  finally{client.dispose();}
});

test('conversation navigation discards responses from a previously open conversation',async()=>{
  const states=[];let releaseOld;
  const client=createCreativeAgentClient({projectId:'p',onState:s=>{if(s)states.push(s.id);},onError:()=>{},api:async(url,options)=>{
    if(url==='/api/agent/config')return {models:[{id:'m'}],configured:true};
    if(url.startsWith('/api/agent/sessions?'))return {sessions:[]};
    if(url==='/api/agent/sessions')return {id:'first',state:'idle',settings:{model:'m'}};
    if(url.endsWith('/old'))return new Promise(resolve=>{releaseOld=resolve;});
    if(url.endsWith('/new'))return {id:'new',state:'idle',settings:{model:'m'}};
    throw new Error(url);
  }});
  try{
    await client.start();
    const old=client.open('old');await client.open('new');releaseOld({id:'old',state:'idle'});await old;
    assert.deepEqual(states,['first','new']);
  }finally{client.dispose();}
});

test('selected skill reaches the first conversation and does not carry into a fresh one',async()=>{
  const bodies=[];
  const client=createCreativeAgentClient({projectId:'p',initialSkill:'video-replication',onState:()=>{},onError:()=>{},api:async(url,options)=>{
    if(url==='/api/agent/config')return {models:[{id:'m'}],configured:true};
    if(url.startsWith('/api/agent/sessions?'))return {sessions:[]};
    bodies.push(JSON.parse(options.body));return {id:`session-${bodies.length}`,state:'idle',settings:{model:'m'}};
  }});
  try{await client.start();await client.newConversation();assert.deepEqual(bodies[0],{projectId:'p',fresh:false,skill:'video-replication'});assert.deepEqual(bodies[1],{projectId:'p',fresh:true});}finally{client.dispose();}
});

test('smart creation conversations stay in their project',async()=>{
  const requests=[];
  const client=createCreativeAgentClient({projectId:'',agentProjectId:'creative-1',onState:()=>{},onError:()=>{},api:async(url,options)=>{
    requests.push({url,body:options?.body&&JSON.parse(options.body)});
    if(url==='/api/agent/config')return {models:[{id:'m'}],configured:true};
    if(url.startsWith('/api/agent/sessions?'))return {sessions:[]};
    return {id:'session-1',state:'idle',settings:{model:'m'}};
  }});
  try{
    await client.start();
    assert.equal(requests.find(item=>item.url.includes('?')).url,'/api/agent/sessions?agentProjectId=creative-1');
    assert.equal(requests.find(item=>item.body).body.agentProjectId,'creative-1');
  }finally{client.dispose();}
});

test('a fresh project conversation reuses workspace content but clears the old transcript and activity',async()=>{
  const states=[],bodies=[];
  const canvas={directorWorkspace:{canvasNodes:[{id:'image'}]},assetIds:['image']};
  const client=createCreativeAgentClient({projectId:'',agentProjectId:'project',onState:value=>states.push(value),onError(){},api:async(url,options)=>{
    if(url==='/api/agent/config')return {configured:true};
    if(url.includes('?'))return {sessions:[]};
    const body=JSON.parse(options.body);bodies.push(body);
    if(!body.fresh)return {id:'first',agentProjectId:'project',settings:{model:'m',skill:'image-design'},messages:[{text:'旧消息'}],draft:'旧回复',activity:'制作中',approval:{id:'old'},canvas,documents:[{id:'doc'}],generations:[{id:'generated'}]};
    return {id:'second',agentProjectId:'project',settings:{model:'m',skill:''},messages:[],draft:'',activity:'',approval:null,workspaceUnchanged:true};
  }});
  try{
    await client.start();await client.newConversation();
    assert.equal(bodies[1].previousSessionId,'first');
    assert.equal(bodies[1].agentProjectId,'project');
    const fresh=states.at(-1);
    assert.equal(fresh.canvas,canvas);assert.equal(fresh.documents[0].id,'doc');assert.equal(fresh.generations[0].id,'generated');
    assert.deepEqual(fresh.messages,[]);assert.equal(fresh.draft,'');assert.equal(fresh.activity,'');assert.equal(fresh.approval,null);assert.equal(fresh.settings.skill,'');
    assert.equal('workspaceUnchanged' in fresh,false);
  }finally{client.dispose();}
});
