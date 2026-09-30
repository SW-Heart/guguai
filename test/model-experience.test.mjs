import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { MODEL_EXPERIENCE_SCHEMA_SQL, createModelExperienceRepository } from '../repositories/model-experience.mjs';

const scope = { deviceId:'device-a', workspaceId:'workspace-a' };
const task = { id:'generation-a', modelId:'image-model', type:'image', status:'completed', assetId:'asset-a', prompt:'一只黑猫在窗边', quality:'high', creditCostMicro:1500000, createdAt:'2026-09-25T10:00:00Z', finishedAt:'2026-09-25T10:01:00Z' };
const asset = { id:'asset-a', kind:'image', sha256:'image-sha' };

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE generations(id TEXT PRIMARY KEY); INSERT INTO users VALUES('user-a'),('user-b'); INSERT INTO generations VALUES('generation-a');");
  db.exec(MODEL_EXPERIENCE_SCHEMA_SQL);
  const store = createModelExperienceRepository({ sql: text => db.prepare(text) });
  const tools = createAgentTools({
    skills:{}, catalog:async()=>[{id:'image-model',kind:'image'}], modelExperienceStore:store,
    findGeneration:(userId,id,requestedScope)=>userId==='user-a'&&id===task.id&&requestedScope.workspaceId===scope.workspaceId?task:null,
    listGenerations:(userId,options)=>({items:userId==='user-a'&&options.modelId===task.modelId&&options.workspaceId===scope.workspaceId?[task]:[],total:1}),
    findAsset:(userId,id,requestedScope)=>userId==='user-a'&&id===asset.id&&requestedScope.workspaceId===scope.workspaceId?asset:null,
  });
  const session = {userId:'user-a',scope,doc:{imageIds:[]}};
  return {db,store,tools,session};
}

test('model experience records observed results and keeps them in the owning workspace',async()=>{
  const f=fixture();
  try{
    const description=await f.tools.execute('models_describe',{modelId:'image-model'},f.session);
    assert.equal(description.workspaceExperience.generationCount,1);
    const empty=await f.tools.execute('models_experience',{modelId:'image-model'},f.session);
    assert.equal(empty.totalRecords,1);
    assert.equal(empty.observed,0);
    assert.equal(empty.samples[0].recordedCostCredits,1.5);
    const input={generationId:task.id,expectedRevision:0,findings:[{aspect:'composition',verdict:'works',note:'主体在画面中央',source:'image'}]};
    await assert.rejects(f.tools.execute('model_experience_note',input,f.session,{id:'call-a'}),/先读取/);
    f.session.doc.imageIds.push(asset.id);
    const saved=await f.tools.execute('model_experience_note',input,f.session,{id:'call-a'});
    assert.deepEqual(saved,{generationId:task.id,revision:1,findingCount:1});
    assert.deepEqual(await f.tools.execute('model_experience_note',input,f.session,{id:'call-a'}),saved);
    await assert.rejects(f.tools.execute('model_experience_note',input,f.session,{id:'call-b'}),/已更新/);
    const profile=await f.tools.execute('models_experience',{modelId:'image-model'},f.session);
    assert.equal(profile.observed,1);
    assert.equal(profile.samples[0].observation.findings[0].note,'主体在画面中央');
    assert.equal(f.store.read('user-a',task.id,{...scope,workspaceId:'another'}),null);
    assert.equal(f.store.read('user-b',task.id,scope),null);
    await assert.rejects(f.tools.execute('model_experience_read',{generationId:task.id},{...f.session,userId:'user-b'}),/不属于当前工作空间/);
  }finally{f.db.close();}
});

test('model observations reject unsupported evidence and unverified claims',async()=>{
  const f=fixture();
  try{
    const base={generationId:task.id,expectedRevision:0};
    await assert.rejects(f.tools.execute('model_experience_note',{...base,findings:[{aspect:'motion',verdict:'issue',note:'动作中断',source:'frame',evidenceTimes:[2]}]},f.session,{id:'frame'}),/先读取引用的视频帧/);
    await assert.rejects(f.tools.execute('model_experience_note',{...base,findings:[{aspect:'identity',verdict:'works',note:'用户说人物一致',source:'user'}]},f.session,{id:'user'}),/待核对/);
    await assert.rejects(f.tools.execute('model_experience_note',{...base,findings:[{aspect:'technical',verdict:'works',note:'分辨率正确',source:'technical'}]},f.session,{id:'technical'}),/先探测视频/);
    f.session.doc.imageIds.push(asset.id);
    await assert.rejects(f.tools.execute('model_experience_note',{...base,findings:[{aspect:'audio',verdict:'works',note:'声音合适',source:'image'}]},f.session,{id:'image-audio'}),/单张图片不能证明/);
    assert.equal(f.store.read('user-a',task.id,scope),null);
  }finally{f.db.close();}
});
