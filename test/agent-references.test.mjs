import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { prepareAgentReferences } from '../lib/agent/references.mjs';

const scope = {deviceId:'d',workspaceId:'w'};
const assets = [{id:'scene',name:'客厅',kind:'image'},{id:'person',name:'阿宁原图',kind:'image'},{id:'tail',name:'上一镜',kind:'video'},{id:'voice',name:'对白',kind:'audio'}];
const findAsset = id => assets.find(item=>item.id===id);

test('agent mentions number all actual references in upload order, including unnamed inputs',()=>{
  const result = prepareAgentReferences({prompt:'@阿宁 与 @阿宁 在客厅，承接 @结尾，声音用 @对白。',referenceAssetIds:['scene','tail','person','voice','person'],assetMentions:[{id:'person',label:'阿宁'},{id:'tail',label:'结尾'}]},[],findAsset);
  assert.equal(result.input.prompt,'Image2 与 Image2 在客厅，承接 Video1，声音用 Audio1。');
  assert.deepEqual(result.input.referenceAssetIds,['scene','tail','person','voice']);
  assert.equal(result.displayPrompt,'@阿宁 与 @阿宁 在客厅，承接 @结尾，声音用 @对白。');
  assert.ok(!Object.hasOwn(result.input,'assetMentions'));
});

test('one binding is persisted and reused in later prepared and submitted requests',async()=>{
  const calls=[];
  const tools=createAgentTools({findAsset:(_user,id,actualScope)=>{assert.deepEqual(actualScope,scope);return findAsset(id);},generate:async args=>{calls.push(args);return args.previewOnly?{status:200,data:{credits:1,costMicro:1000000,quantity:1}}:{status:202,data:{id:'job'}};}});
  const session={userId:'u',scope,doc:{generations:[]}};
  await tools.execute('references_bind',{references:[{id:'person',label:'阿宁'},{id:'scene',label:'客厅'}]},session);
  // Simulate saving and restoring the conversation between shots.
  session.doc=JSON.parse(JSON.stringify(session.doc));
  const result=await tools.execute('media_prepare',{type:'video',modelId:'video',prompt:'@阿宁 走进 @客厅，@阿宁 坐下。'},session,{id:'prepare'});
  assert.deepEqual(calls[0].input.referenceAssetIds,['person','scene']);
  assert.equal(calls[0].input.prompt,'Image1 走进 Image2，Image1 坐下。');
  assert.equal(result.prompt,'@阿宁 走进 @客厅，@阿宁 坐下。');
  await tools.execute('media_submit',{preparedRequestId:result.preparedRequestId},session,{id:'submit'});
  assert.deepEqual(calls[1].input,calls[0].input);
  const another=await tools.execute('media_prepare',{type:'video',modelId:'video',prompt:'@阿宁 起身。'},session,{id:'next-shot'});
  assert.deepEqual(another.references.map(item=>item.id),['person']);
  assert.equal(calls[2].input.prompt,'Image1 起身。');
});

test('unknown assets and ambiguous bindings fail before generation or persistence',async()=>{
  let generated=false;
  const tools=createAgentTools({findAsset:(_user,id)=>findAsset(id),generate:async()=>{generated=true;}});
  const session={userId:'u',scope,doc:{}};
  await assert.rejects(tools.execute('references_bind',{references:[{id:'person',label:'阿宁'},{id:'scene',label:'阿宁'}]},session),/多个素材/);
  assert.equal(session.doc.referenceBindings,undefined);
  await assert.rejects(tools.execute('media_prepare',{type:'image',modelId:'image',prompt:'@阿宁',assetMentions:[{id:'foreign',label:'阿宁'}]},session,{id:'prepare'}),/不属于当前工作空间/);
  assert.equal(generated,false);
});

test('longer costume names do not pull in an unused character binding',()=>{
  const result=prepareAgentReferences({prompt:'@阿宁雨衣 走进门口'},[{id:'person',label:'阿宁'},{id:'scene',label:'阿宁雨衣'}],findAsset);
  assert.deepEqual(result.input.referenceAssetIds,['scene']);
  assert.equal(result.input.prompt,'Image1 走进门口');
  const duplicates=id=>({id,name:'人物',kind:'image'});
  assert.throws(()=>prepareAgentReferences({prompt:'@人物 走进门口',referenceAssetIds:['a','b']},[],duplicates),/多个素材/);
});

test('a failed job exposes its original named description and public reason, without raw diagnostics',async()=>{
  const task={id:'job',status:'failed',prompt:'Image1 在街头',referenceAssetIds:['person'],error:'secret upstream endpoint and credentials'};
  const tools=createAgentTools({findGeneration:(_user,id,actualScope)=>{assert.deepEqual(actualScope,scope);return id==='job'?task:null;},publicGeneration:()=>({failure:{code:'CONTENT_REJECTED',message:'内容未通过检查'},error:'内容未通过检查，请调整画面描述'})});
  const session={userId:'u',scope,doc:{prepared:{p:{displayPrompt:'@阿宁 在街头',references:[{id:'person',label:'阿宁'}],result:{jobIds:['job']}}}}};
  const result=await tools.execute('jobs_read',{jobId:'job'},session);
  assert.equal(result.prompt,'@阿宁 在街头');
  assert.equal(result.failure.code,'CONTENT_REJECTED');
  assert.ok(!JSON.stringify(result).includes('secret'));
  const wait=await tools.execute('jobs_wait',{jobIds:['job']},session);
  assert.equal(wait[0].failure.code,'CONTENT_REJECTED');
  await assert.rejects(tools.execute('jobs_read',{jobId:'foreign'},session),/不属于当前工作空间/);
});

test('agent writes persistent named references and continuity facts to a shot',async()=>{
  const project={revision:1,resources:[],shots:[]};
  const tools=createAgentTools({findAsset:(_user,id)=>findAsset(id),loadProject:async()=>project,saveProject:async()=>{},publicProject:value=>value});
  const session={projectId:'p',userId:'u',scope,doc:{referenceBindings:[{id:'person',label:'阿宁',kind:'image'}]}};
  await tools.execute('project_edit',{expectedRevision:1,operation:'add_shot',data:{title:'起身',prompt:'@阿宁 起身',startState:'钥匙在左手',endState:'站在门前',continuityNotes:'承接上一镜左手持钥匙'}},session,{id:'edit'});
  assert.equal(project.shots[0].prompt,'@阿宁 起身');
  assert.deepEqual(project.shots[0].referenceAssetIds,['person']);
  assert.equal(project.shots[0].assetMentions[0].label,'阿宁');
  assert.equal(project.shots[0].startState,'钥匙在左手');
});
