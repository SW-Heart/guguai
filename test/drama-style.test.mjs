import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dramaStyleCatalog, normalizeDramaStyle, dramaStyleSnapshot, projectDramaStyleSnapshot, applyDramaStyle, visibleGenerationPrompt } from '../lib/drama-style.mjs';
import { buildResourceImagePrompt } from '../public/resource-prompt.js';
import { createAgentTools } from '../lib/agent/tools.mjs';

test('public catalog and stored project style discard private or injected fields',()=>{
  const catalog=dramaStyleCatalog();
  assert.equal(new Set(catalog.map(item=>item.id)).size,26);
  for(const preset of catalog){
    assert.deepEqual(Object.keys(preset).sort(),['coverUrl','description','id','name']);
    const saved=normalizeDramaStyle({...preset,instruction:'injected',name:'tampered'});
    assert.equal(saved.name,preset.name);
    assert.ok(!Object.hasOwn(saved,'instruction'));
    assert.ok(dramaStyleSnapshot(saved).instruction);
  }
});

test('style revisions change only when the actual selection changes',()=>{
  const initial=normalizeDramaStyle({id:'live-action',revision:Infinity});
  assert.equal(initial.revision,1);
  assert.equal(normalizeDramaStyle(initial,{previous:initial,update:true}).revision,1);
  const custom=normalizeDramaStyle({id:'custom',name:'水彩',description:'暖色笔触'},{previous:initial,update:true});
  assert.equal(custom.revision,2);
  assert.equal(normalizeDramaStyle({...custom,description:'冷色笔触'},{previous:custom,update:true}).revision,3);
  assert.throws(()=>normalizeDramaStyle({id:'custom',name:' ',description:'暖色'}),/名称/);
  assert.throws(()=>normalizeDramaStyle({id:'custom',name:'水彩',description:'字'.repeat(1201)}),/1200/);
});

test('content stays intact, snapshots survive selection changes, and overflow is rejected',()=>{
  const style=normalizeDramaStyle({id:'youth-anime'}), snapshot=dramaStyleSnapshot(style);
  const content='两个黑发男人，2026 年办公室，白衬衫，红色杯子。对白：“开始吧！”';
  const prompt=applyDramaStyle(content,snapshot,{type:'video',generationType:'REFERENCE'});
  assert.ok(prompt.endsWith(content));
  assert.match(prompt,/保持输入画面/);
  assert.equal(visibleGenerationPrompt({prompt,userPrompt:content}),content);
  assert.equal(applyDramaStyle(content,null),content);
  assert.throws(()=>applyDramaStyle('字'.repeat(5000),snapshot),/过长/);
  assert.equal(dramaStyleSnapshot(normalizeDramaStyle({id:'live-action'},{previous:style,update:true})).revision,2);
  assert.equal(snapshot.revision,1);
  assert.match(snapshot.instruction,/二维/);
  assert.doesNotMatch(buildResourceImagePrompt({type:'character',name:'女孩'},{styled:true}),/真人|写实/);
});

test('changed frontend entry points use matching cache keys',()=>{
  const read=name=>readFileSync(new URL(`../public/${name}`,import.meta.url),'utf8');
  assert.ok(read('index.html').includes('/app.js?v=508'));
  assert.ok(read('index.html').includes('/styles.css?v=373'));
  assert.ok(read('app.js').includes('./drama-studio.js?v=240'));
  assert.ok(read('drama-studio.js').includes('./features/drama/style-dialog.js?v=2'));
  assert.ok(read('drama-studio.js').includes('./resource-prompt.js?v=4'));
  assert.ok(read('drama-studio.js').includes('./features/drama/merge.js?v=2'));
});

test('project Agent preparation fixes its style revision and job reads hide the private input',async()=>{
  const calls=[],scope={deviceId:'d',workspaceId:'w'};
  const project={id:'drama',style:normalizeDramaStyle({id:'youth-anime'})};
  const snapshot=dramaStyleSnapshot(project.style);
  const task={id:'job',status:'completed',prompt:applyDramaStyle('女孩拿着杯子',snapshot),userPrompt:'女孩拿着杯子',referenceAssetIds:[]};
  const tools=createAgentTools({loadProject:async(user,id,actualScope)=>{
    assert.equal(user,'user');assert.equal(id,project.id);assert.deepEqual(actualScope,scope);return project;
  },generate:async args=>{calls.push(structuredClone(args));return args.previewOnly?{status:200,data:{costMicro:1000000,credits:1,quantity:1}}:{status:202,data:{id:'job'}};},findGeneration:()=>task});
  const session={userId:'user',projectId:project.id,scope,doc:{generations:[]}};
  const prepared=await tools.execute('media_prepare',{type:'image',modelId:'image',prompt:'女孩拿着杯子'},session,{id:'invocation'});
  project.style=normalizeDramaStyle({id:'live-action'},{previous:project.style,update:true});
  await tools.execute('media_submit',{preparedRequestId:prepared.preparedRequestId},session,{id:'submit'});
  assert.equal(calls[0].input.dramaProjectId,project.id);
  assert.equal(calls[0].input.dramaStyleRevision,1);
  assert.equal(calls[1].input.dramaStyleRevision,1);
  const result=await tools.execute('jobs_read',{jobId:task.id},session,{id:'read'});
  assert.equal(result.prompt,task.userPrompt);
  assert.ok(!JSON.stringify(result).includes(snapshot.instruction));
});


test('existing projects keep their private recipe until the actual selection changes',()=>{
  const style=normalizeDramaStyle({id:'youth-anime'});
  const saved={...dramaStyleSnapshot(style),instruction:'previous-approved-recipe',extra:'discard'};
  const project={style,dramaStyleSnapshot:saved};
  assert.equal(projectDramaStyleSnapshot(project).instruction,'previous-approved-recipe');
  assert.ok(!Object.hasOwn(projectDramaStyleSnapshot(project),'extra'));
  project.style=normalizeDramaStyle({id:'live-action'},{previous:style,update:true});
  assert.notEqual(projectDramaStyleSnapshot(project).instruction,'previous-approved-recipe');
});

test('every public preset has its own 3:4 cover without text or private metadata',()=>{
  const allowedChunks=new Set(['IHDR','PLTE','IDAT','IEND','tRNS','gAMA','sRGB','iCCP','cHRM','sBIT','pHYs']);
  for(const style of dramaStyleCatalog()){
    const data=readFileSync(new URL(`../public${style.coverUrl}`,import.meta.url));
    assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a',style.id);
    const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
    assert.equal(width*4,height*3,style.id);
    let at=8;
    while(at<data.length){
      const size=data.readUInt32BE(at),type=data.toString('ascii',at+4,at+8);
      assert.ok(allowedChunks.has(type),`${style.id}: unexpected metadata ${type}`);
      at+=12+size;
    }
    assert.equal(at,data.length,style.id);
  }
});
