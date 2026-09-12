import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, closeDatabase, sql } from '../lib/db.mjs';
import { normalizeViralInput, assetSnapshot, assetApprovalHash, planApprovalHash, assertViralReady } from '../lib/viral-lab.mjs';
import { createViralProject, findViralProject, saveViralProject } from '../repositories/viral-projects.mjs';
import { createViralLabRouteHandler } from '../server/routes/viral-lab.mjs';
import { readFileSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { staticEntryFile } from '../server/static.mjs';

openDatabase({ file: ':memory:' });
after(() => closeDatabase());
for (const id of ['a','b']) sql('INSERT INTO users(id,username,password_hash,created_at,doc_json) VALUES(?,?,?,?,?)').run(id,id,'x',new Date().toISOString(),'{}');
const scope = { deviceId:'device-a', workspaceId:'workspace-a' };
const assets = { source:{id:'source',kind:'video',sha256:'a'.repeat(64)}, product:{id:'product',kind:'image',sha256:'b'.repeat(64)}, person:{id:'person',kind:'image',sha256:'c'.repeat(64)} };
const fixture = () => ({ title:'测试复刻', type:'replica', sourceAssetId:'source', productName:'商品', sourceNotes:'0–30秒，固定商品特写，无口播。', materials:[{assetId:'product',role:'product',label:'商品',lookId:''}], units:[{id:'unit1',prompt:'保留固定商品特写，@图片1定义商品外观。无口播。',duration:30,modelId:'seedance-2.5',referenceAssetIds:['product']}] });
const snap = p => assetSnapshot(p,id=>assets[id]);

test('完整提示词不静默截断，错误引用与重复分段被拒绝', () => {
  const input = fixture();input.units[0].prompt='字'.repeat(12000);
  assert.equal(normalizeViralInput(input).units[0].prompt.length,12000);
  input.units[0].prompt='字'.repeat(30001);
  assert.throws(()=>normalizeViralInput(input),/没有被截断/);
  input.units[0].prompt='正常';input.units[0].referenceAssetIds=['other'];
  assert.throws(()=>normalizeViralInput(input),/项目素材/);
  input.units[0].referenceAssetIds=['product'];input.units.push({...input.units[0]});
  assert.throws(()=>normalizeViralInput(input),/编号不能重复/);
});
test('项目保存按账号和设备工作区隔离，CAS 拒绝旧稿覆盖', () => {
  const p=createViralProject('a',scope,fixture());
  assert.equal(findViralProject('b',p.id,scope),null);
  assert.equal(findViralProject('a',p.id,{...scope,workspaceId:'other'}),null);
  assert.equal(findViralProject('a',p.id,{...scope,deviceId:'other'}),null);
  assert.throws(()=>saveViralProject('b',scope,p,p.revision),/项目已更新/);
  const next=saveViralProject('a',scope,{...p,title:'新稿'},p.revision);
  assert.equal(next.revision,2);
  assert.throws(()=>saveViralProject('a',scope,p,p.revision),/项目已更新/);
});
test('内容 hash 与真实引用控制确认失效，改台词不撤销资产确认', () => {
  const p={...normalizeViralInput(fixture()),workflowVersion:'1'};
  p.assetApproval={hash:assetApprovalHash(p,snap(p))};p.planApproval={hash:planApprovalHash(p,snap(p))};
  assert.doesNotThrow(()=>assertViralReady(p,snap(p),{forGeneration:true}));
  p.units[0].prompt+=' 新要求';
  assert.equal(p.assetApproval.hash,assetApprovalHash(p,snap(p)));
  assert.throws(()=>assertViralReady(p,snap(p),{forGeneration:true}),/制作方案已变化/);
  const changed=snap(p).map(f=>f.id==='product'?{...f,sha256:'d'.repeat(64)}:f);
  assert.throws(()=>assertViralReady(p,changed),/检查并确认当前资产/);
  assert.throws(()=>assetSnapshot(p,()=>null),/已删除/);
});

let settles=0,releases=0,llmResult={text:'{}',usage:{inputTokens:10,outputTokens:10}};
const deps = { bodyJson:async req=>req.body, sendJson:(res,status,body)=>Object.assign(res,{status,body}), requireUser:()=>({id:'a'}), requireDesktopWorkspaceScope:()=>scope,
  findAsset:(_user,id)=>assets[id],publicAsset:x=>x,publicGeneration:x=>x,llmConfig:{model:'test'},isLlmConfigured:()=>true,
  conservativeInputTokenUpperBound:()=>100,llmReservationMicro:()=>1000,llmRates:{},reserveLlmCredits:async()=>({}),
  settleLlmCredits:async()=>{settles++;return{chargedCredits:.001,wallet:{balance:10}};},releaseLlmCredits:async()=>{releases++;},markLlmBillingReconcile:async()=>{},callLlm:async()=>llmResult };
const handler=createViralLabRouteHandler(deps);
async function invoke(method,path,body={}) {const res={};await handler.route({method,body},res,new URL(`http://localhost/api/viral-lab/${path}`));return res;}
test('服务端确认生成内容，重复确认不扩大付费授权，输入改动撤销方案',async()=>{
  let p=(await invoke('POST','projects',fixture())).body.project;
  const path=`projects/${p.id}`;
  await assert.rejects(()=>invoke('POST',`${path}/plan-confirm`,{revision:p.revision}),/确认当前资产/);
  p=(await invoke('POST',`${path}/assets-confirm`,{revision:p.revision})).body.project;
  p=(await invoke('POST',`${path}/plan-confirm`,{revision:p.revision})).body.project;
  const first=p.planApproval.requests.unit1;
  p=(await invoke('POST',`${path}/plan-confirm`,{revision:p.revision})).body.project;
  assert.equal(p.planApproval.requests.unit1,first);
  const input={viralProjectId:p.id,viralUnitId:'unit1',viralPlanHash:p.planApproval.hash,requestId:first,expectedPriceVersion:'quoted',prompt:'篡改',duration:15,referenceAssetIds:['other'],videoModel:'evil'};
  const generated=handler.prepareGeneration('a',scope,input);
  assert.equal(generated.prompt,p.units[0].prompt);assert.equal(generated.duration,30);assert.deepEqual(generated.referenceAssetIds,['source','product']);assert.equal(generated.videoModel,'seedance-2.5');
  assert.throws(()=>handler.prepareGeneration('b',scope,input),/不存在/);
  assert.throws(()=>handler.prepareGeneration('a',scope,{...input,requestId:'new-id'}),/授权已失效/);
  p=(await invoke('PATCH',path,{...p,sourceNotes:'新记录'})).body.project;
  assert.ok(p.assetApproval);assert.equal(p.planApproval,null);
  assert.throws(()=>handler.prepareGeneration('a',scope,input),/制作方案已变化/);
});
test('草稿可以分步填写，未完成时不提前计算方案确认 hash',async()=>{
  let p=(await invoke('POST','projects',{type:'replica',title:'分步草稿'})).body.project;
  const path=`projects/${p.id}`;
  p=(await invoke('PATCH',path,{...p,brief:'先记下创作方向'})).body.project;
  assert.equal(p.sourceAssetId,'');
  assert.equal(p.productName,'');
  assert.equal(p.planApproval,null);
});
test('真人参考不能绕过未接入的审核；AI 无效结果已计费不释放已结算费用',async()=>{
  const input=fixture();input.materials.push({assetId:'person',role:'identity',label:'身份'});
  let p=(await invoke('POST','projects',input)).body.project;
  const path=`projects/${p.id}`;
  p=(await invoke('POST',`${path}/assets-confirm`,{revision:p.revision})).body.project;
  p=(await invoke('POST',`${path}/plan-confirm`,{revision:p.revision})).body.project;
  assert.throws(()=>handler.prepareGeneration('a',scope,{viralProjectId:p.id}),/真人素材审核/);
  const q=(await invoke('POST',`${path}/plan-quote`,{revision:p.revision})).body;
  await assert.rejects(()=>invoke('POST',`${path}/plan`,{revision:p.revision,quoteId:'wrong'}),/报价已变化/);
  settles=0;releases=0;
  await assert.rejects(()=>invoke('POST',`${path}/plan`,{revision:p.revision,quoteId:q.quoteId}),/数量不一致/);
  p=findViralProject('a',p.id,scope);assert.equal(p.planning,null);assert.equal(p.units[0].prompt,input.units[0].prompt);assert.equal(settles,1);assert.equal(releases,0);
});
test('新入口刷新可打开，HTML 与模块缓存链路对应',()=>{
  assert.equal(staticEntryFile('/lab',{desktop:true}),'index.html');
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(html,/app\.js\?v=328\b/);assert.doesNotMatch(html,/app\.js\?v=312\b/);
  assert.match(html,/features\/viral-lab\/styles\.css\?v=11/);
  assert.match(app,/features\/viral-lab\/controller\.js\?v=13/);
  assert.match(html,/id="viralLabView"/);assert.match(html,/data-route="lab"/);
});

function insertTask(id, userId, project, status='failed', taskScope=scope) {
  const task = { id, type:'video', status, viralProjectId:project.id, viralUnitId:'unit1', viralPlanHash:project.planApproval?.hash,
    originDeviceId:taskScope.deviceId, originWorkspaceId:taskScope.workspaceId, createdAt:new Date().toISOString() };
  sql('INSERT INTO generations(id,user_id,type,status,created_at,updated_at,doc_json) VALUES(?,?,?,?,?,?,?)').run(id,userId,'video',status,task.createdAt,task.createdAt,JSON.stringify(task));
  return task;
}

test('任务列表只包含本账号工作区，失败分段可重试一次且不改变其他授权', async () => {
  let p=(await invoke('POST','projects',fixture())).body.project;
  const path=`projects/${p.id}`;
  p=(await invoke('POST',`${path}/assets-confirm`,{revision:p.revision})).body.project;
  p=(await invoke('POST',`${path}/plan-confirm`,{revision:p.revision})).body.project;
  const first=p.planApproval.requests.unit1;
  insertTask(first,'a',p);
  insertTask('foreign-user','b',p);
  insertTask('foreign-workspace','a',p,'running',{...scope,workspaceId:'other'});
  const listed=(await invoke('GET','tasks')).body.tasks;
  assert.ok(listed.some(task=>task.id===first));
  assert.ok(!listed.some(task=>task.id.startsWith('foreign-')));
  p=(await invoke('POST',`${path}/retry`,{revision:p.revision,unitId:'unit1'})).body.project;
  assert.notEqual(p.planApproval.requests.unit1,first);
  assert.throws(()=>handler.prepareGeneration('a',scope,{viralProjectId:p.id,viralUnitId:'unit1',viralPlanHash:p.planApproval.hash,requestId:first}),/授权已失效/);
  insertTask(p.planApproval.requests.unit1,'a',p);
  await assert.rejects(()=>invoke('POST',`${path}/retry`,{revision:p.revision,unitId:'unit1'}),/重试一次/);
});

test('确认前拒绝过长提示词及切换模型后超长的原片区间', () => {
  const p={...normalizeViralInput(fixture()),workflowVersion:'1'};
  p.assetApproval={hash:assetApprovalHash(p,snap(p))};
  p.units[0].prompt='字'.repeat(4097);
  assert.throws(()=>assertViralReady(p,snap(p)),/4096/);
  p.units[0].prompt='有效提示词';p.units[0].duration=15;p.units[0].modelId='seedance-2.0';p.units[0].sourceRange={startSeconds:0,endSeconds:30};
  assert.throws(()=>assertViralReady(p,snap(p)),/超过当前模型时长/);
});

test('自动原片分析会落库观察时间线、分段提示词并绑定源视频参考', async () => {
  const executable = `/tmp/viral-lab-test-ffmpeg-${process.pid}.mjs`;
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=';
  await writeFile(executable, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst out=process.argv.at(-1);\nif(out !== '-') writeFileSync(out.replace('frame-%03d.jpg','frame-001.jpg'),Buffer.from('${jpeg}','base64'));\n`); await chmod(executable,0o755);
  const sourceHandler = createViralLabRouteHandler({ ...deps, ensureLocalAsset:async()=>'/tmp/source.mp4', sourceAnalysisExecutable:executable, callLlm:async()=>({ text:JSON.stringify({ summary:'原片摘要', timeline:[{start_seconds:0,end_seconds:8,visual_action:'展示商品',spoken_content:'看这里',speaker_mode:'voiceover'}] }), usage:{inputTokens:10,outputTokens:20} }) });
  async function sourceInvoke(method,path,body={}) { const res={}; await sourceHandler.route({method,body},res,new URL(`http://localhost/api/viral-lab/${path}`)); return res; }
  try {
    let p=(await sourceInvoke('POST','projects',fixture())).body.project;
    const path=`projects/${p.id}`;
    const quote=(await sourceInvoke('POST',`${path}/source-quote`,{revision:p.revision})).body;
    p=(await sourceInvoke('POST',`${path}/source-analyze`,{revision:p.revision,quoteId:quote.quoteId})).body.project;
    assert.equal(p.sourceObservation.summary,'原片摘要'); assert.equal(p.units.length,1); assert.doesNotMatch(p.units[0].prompt,/看这里/); assert.equal(p.sourceObservation.timeline[0].spokenContent,''); assert.equal(p.sourceAnalysisState.status,'completed');
    p=(await sourceInvoke('POST',`${path}/assets-confirm`,{revision:p.revision})).body.project;
    p=(await sourceInvoke('POST',`${path}/plan-confirm`,{revision:p.revision})).body.project;
    const generated=sourceHandler.prepareGeneration('a',scope,{viralProjectId:p.id,viralUnitId:p.units[0].id,viralPlanHash:p.planApproval.hash,requestId:p.planApproval.requests[p.units[0].id]});
    assert.deepEqual(generated.referenceAssetIds,['source','product']);
  } finally { await rm(executable,{force:true}); }
});
