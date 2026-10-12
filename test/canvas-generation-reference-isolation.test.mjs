import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/features/agent/workspace.js',import.meta.url),'utf8');
const start=source.indexOf('      uploadGenerationFile:');
const handler=source.slice(start,source.indexOf('      media:',start)).trim().replace(/,$/,'');

for(const existing of [false,true]){
  test(`generation reference ${existing?'already on the canvas':'from the file library'} never creates a canvas asset`,async()=>{
    const file={id:'reference',kind:'image',name:'参考图.png'};
    const assetIds=existing?[file.id]:[];
    const project={assetIds},requests=[];
    const context=vm.createContext({navigationEpoch:1,project,state:{files:[]},current:()=>true,
      importCanvasAsset:async options=>{requests.push(options);return file;},previewUrl:()=>'/reference.png',
      cloudFile:()=>assert.fail('choosing a reference must not upload it'),
      saveCanvas:()=>assert.fail('reference selection must not add canvas assets'),
    });
    vm.runInContext(`globalThis.bridge={${handler}}`,context);
    const selected=await context.bridge.uploadGenerationFile();
    assert.equal(selected.id,file.id);assert.equal(selected.previewUrl,'/reference.png');
    assert.deepEqual(project.assetIds,existing?[file.id]:[]);
    assert.equal(project.assetIds,assetIds);assert.equal(context.state.files[0].id,file.id);
    assert.equal(requests[0].generation,true);
  });
}

test('leaving the project while choosing a generation reference discards the selection',async()=>{
  {
    let resolve;
    const context=vm.createContext({navigationEpoch:1,project:{assetIds:[]},state:{files:[]},current:()=>true,previewUrl:()=>'',
      importCanvasAsset:()=>new Promise(done=>{resolve=done;}),
      saveCanvas:()=>assert.fail('must not save canvas assets'),
    });
    vm.runInContext(`globalThis.bridge={${handler}}`,context);
    const pending=context.bridge.uploadGenerationFile();
    await new Promise(done=>setImmediate(done));
    context.navigationEpoch++;context.project={assetIds:[]};resolve({id:'reference'});
    assert.equal(await pending,null);assert.equal(context.project.assetIds.length,0);
  }
});

test('late reference delivery hydrates thumbnail URLs without replacing names, IDs or order',async()=>{
  const {hydrateGenerationReferences}=await import('../public/features/drama/canvas-generation-references.js');
  const references=[{id:'person',name:'陆左',kind:'image',url:''},{id:'scene',name:'卧铺车厢',kind:'image',url:'/old.png'}];
  const draft={attachments:references};
  const files={person:{id:'person',name:'原始文件.png',url:'https://example.com/person.png',previewUrl:'gugu-media://person'},scene:{id:'scene',url:'gugu-media://scene'}};
  assert.equal(hydrateGenerationReferences(draft,id=>files[id]),true);
  assert.equal(draft.attachments,references);assert.equal(draft.attachments[0].name,'陆左');
  assert.equal(draft.attachments[0].url,'gugu-media://person');assert.equal(draft.attachments[1].url,'gugu-media://scene');
  assert.equal(hydrateGenerationReferences(draft,id=>files[id]),false);
  assert.equal(hydrateGenerationReferences(draft,()=>null),false);assert.equal(draft.attachments[0].url,'gugu-media://person');
  assert.equal(hydrateGenerationReferences(undefined,()=>null),false);
});
