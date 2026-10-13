import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {removeGenerationMention,generationPromptMarkup} from '../public/features/drama/canvas-generation-editor.js';
import {removeLinks} from '../public/features/drama/canvas-links.js';

for(const type of ['image','video']){
  test(`${type} reference removal clears all its mentions and preserves other references`,()=>{
    const draft={type,prompt:'使用 @猫.png 和 @猫.png，参考 @狗.png',promptSegments:['使用 ',{id:'cat',label:'猫.png'},' 和 ',{id:'cat',label:'猫.png'},'，参考 ',{id:'dog',label:'狗.png'}],attachments:[{id:'cat',name:'猫.png'},{id:'dog',name:'狗.png'}]};
    removeGenerationMention(draft,'cat');
    draft.attachments=draft.attachments.filter(file=>file.id!=='cat');
    assert.equal(draft.prompt,'使用  和 ，参考 @狗.png');
    assert.deepEqual(draft.promptSegments,['使用 ',' 和 ','，参考 ',{id:'dog',label:'狗.png'}]);
    assert.doesNotMatch(generationPromptMarkup(draft),/猫/);
  });
}

test('restored plain text mentions are cleared using the same bindings as the editor',()=>{
  const draft={prompt:'@猫咪.png 看着 @猫.png，猫.png',promptSegments:[],attachments:[{id:'cat',name:'猫.png'},{id:'kitten',name:'猫咪.png'}]};
  removeGenerationMention(draft,'cat');
  assert.equal(draft.prompt,'@猫咪.png 看着 ，猫.png');
  assert.deepEqual(draft.promptSegments,[{id:'kitten',label:'猫咪.png'},' 看着 ','，猫.png']);
});

test('disconnecting a linked canvas reference removes its mention instead of leaving its filename',()=>{
  const draft={id:'target',prompt:'使用 @角色.png 走路',promptSegments:['使用 ',{id:'source',label:'角色.png'},' 走路'],attachments:[]};
  const state={links:[{from:'source',to:'target'}]};
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const context=vm.createContext({generationDraft:()=>draft,generationPromptView:value=>value,workspace:()=>state,removeLinks,removeGenerationMention,syncCanvas(){},scheduleCanvasSave(){},activeGenerationId:'target',renderGenerationComposer(){}});
  const start=source.indexOf('  function disconnectNodes(');
  vm.runInContext(source.slice(start,source.indexOf('  // Choose what',start)),context);
  context.disconnectNodes('source','target');
  assert.equal(draft.prompt,'使用  走路');
  assert.deepEqual(state.links,[]);
});

test('deleting a canvas material or its edge clears bound mentions from its consumers',()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  for(const deletedId of ['source','edge-link-source--target']){
    const draft={id:'target',prompt:'参考 @猫.png',promptSegments:[],attachments:[]};
    const state={links:[{id:'link-source--target',from:'source',to:'target'}]};
    const context=vm.createContext({workspace:()=>state,generationDraft:()=>draft,generationPromptView:value=>({...value,attachments:[{id:'source',name:'猫.png'}]}),removeGenerationMention,removeLinks,bridge:{markCanvasDirty(){}}});
    const start=source.indexOf('  function removeCanvasInputEdges(');
    vm.runInContext(source.slice(start,source.indexOf('  function handleCanvasDeleteKeydown(',start)),context);
    assert.equal(context.removeCanvasInputEdges([deletedId]),true);
    assert.equal(draft.prompt,'参考 ');
    assert.deepEqual(state.links,[]);
  }
});
