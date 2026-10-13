import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {mountDocumentCard,documentCardMarkup,documentDownload} from '../public/features/drama/document-card.js';

test('card names sit outside the frame without repeated type and name rows',()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const context=vm.createContext({escape:value=>String(value),canvasIcon:()=>'',});
  vm.runInContext(source.slice(source.indexOf('  function productionCard('),source.indexOf('  // Every generated picture')),context);
  for(const [label,name] of [['角色','外婆'],['场景','场景 1'],['分镜','分镜 1']]){
    const html=context.productionCard({id:'card',label,name,prompt:'画面描述'});
    assert.ok(html.includes(`<span class="dw-frame-caption">${name}</span>`));
    assert.ok(!html.includes('dw-entity-name'));
    assert.ok(!html.includes('dw-node-kind'));
    assert.ok(!html.includes('<header'));
  }
  const document=documentCardMarkup({id:'note',kind:'note',item:{}});
  assert.ok(document.includes('class="dw-frame-caption" data-document-title'));
  assert.ok(!document.includes('dw-node-kind'));
});
function harness(save=async(node,input)=>({title:node.title,text:input.text,revision:input.expectedRevision+1})){
  const elements=new Map(),events=new Map();
  for(const name of ['body','title','title-input','revision','feedback','edit','save','cancel','copy','download','ask']){
    let value='';
    elements.set(`[data-document-${name}]`,{textContent:'',scrollTop:0,scrollLeft:0,focus(){},addEventListener(type,callback){events.set(`${name}:${type}`,callback);},get value(){return value;},set value(next){value=next;this.scrollTop=0;this.scrollLeft=0;}});
  }
  const card={querySelector:selector=>elements.get(selector),querySelectorAll:()=>['edit','save','cancel','copy','download','ask'].map(name=>elements.get(`[data-document-${name}]`)),classList:{toggle(){}}};
  const node={id:'doc-1',kind:'document',title:'文稿',text:'第一段\n第二段',item:{revision:1}};
  const copied=[];
  const controller=mountDocumentCard(card,{save,ask(){},copy:async text=>copied.push(text),download(){}});
  controller.update(node);
  return {controller,node,events,copied,el:name=>elements.get(`[data-document-${name}]`)};
}
test('canvas document shell is stable across selection, content and revision changes',()=>{
  const h=harness();
  assert.equal(documentCardMarkup(h.node),documentCardMarkup({...h.node,text:'新正文',title:'新标题',item:{revision:2}}));
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  assert.match(source,/if\(isDocumentCard\(n\)\)\{el.hidden=true;el.innerHTML='';return;\}/);
});
test('reading and editing survive polling without losing scroll or draft',()=>{
  const h=harness(),body=h.el('body');body.scrollTop=210;body.scrollLeft=8;
  h.controller.update({...h.node});assert.equal(body.scrollTop,210);
  h.el('edit').onclick();assert.equal(body.readOnly,false);body.value='手动修改';body.scrollTop=85;
  h.controller.update({...h.node,text:'后台更新',item:{revision:2}});
  assert.equal(body.value,'手动修改');assert.equal(body.scrollTop,85);
  h.el('cancel').onclick();assert.equal(body.value,'后台更新');assert.equal(body.readOnly,true);
});
test('save uses the revision from when editing began and ignores older polls afterwards',async()=>{
  const calls=[];const h=harness(async(node,input)=>{calls.push(input);return {title:node.title,text:input.text,revision:3};});
  h.el('edit').onclick();h.el('body').value='修改正文';
  h.controller.update({...h.node,item:{revision:2}});
  await h.el('save').onclick();assert.deepEqual(calls,[{text:'修改正文',expectedRevision:1}]);
  h.controller.update(h.node);assert.equal(h.el('body').value,'修改正文');assert.equal(h.el('body').readOnly,true);
});
test('failed saves preserve editable draft and allow copying it',async()=>{
  const h=harness(async()=>{throw new Error('文稿已有新内容');});h.el('edit').onclick();h.el('body').value='保留修改';
  await h.el('save').onclick();assert.equal(h.el('body').value,'保留修改');assert.equal(h.el('body').readOnly,false);
  assert.equal(h.el('feedback').textContent,'文稿已有新内容');assert.equal(h.el('save').disabled,false);
  await h.el('copy').onclick();assert.deepEqual(h.copied,['保留修改']);
});
test('save prevents duplicate submissions and editing while in flight',async()=>{
  let resolve,calls=0;const h=harness(()=>{calls++;return new Promise(done=>resolve=done);});h.el('edit').onclick();
  const saving=h.el('save').onclick();await h.el('save').onclick();h.el('cancel').onclick();
  assert.equal(calls,1);assert.equal(h.el('body').readOnly,true);assert.equal(h.el('cancel').disabled,true);
  resolve({title:'文稿',text:'已保存',revision:2});await saving;assert.equal(h.el('body').value,'已保存');
});
test('scroll and keyboard events stay inside the card without cancelling native behavior',()=>{
  const h=harness();let stopped=0;
  for(const type of ['wheel','pointerup','keydown'])h.events.get(`body:${type}`)({stopPropagation(){stopped++;},preventDefault(){assert.fail('native interaction must remain enabled');}});
  assert.equal(stopped,3);
  h.controller.update(h.node,true);h.el('edit').onclick();assert.equal(h.el('body').readOnly,true);
});
test('transcripts stay readable and download as SRT',()=>{
  const h=harness();const node={id:'transcript',kind:'source-transcript',text:'台词',title:'台词',item:{cues:[{startSeconds:1.2,endSeconds:3,text:'你好'}]}};
  h.controller.update(node);assert.equal(h.el('edit').hidden,true);assert.equal(h.el('body').value,'1.2–3 秒  你好');
  assert.deepEqual(documentDownload(node,''),{extension:'srt',text:'1\n00:00:01,200 --> 00:00:03,000\n你好'});
});

test('text cards written on the canvas can be renamed while editing; scripts edit in place',async()=>{
  const calls=[];const h=harness(async(node,input)=>{calls.push(input);return {title:input.title||node.title,text:input.text,revision:2};});
  h.controller.update({id:'canvas-note-1',kind:'note',title:'文字',text:'',item:{revision:1,role:'text'}});
  assert.equal(h.el('edit').hidden,false);
  h.controller.edit();assert.equal(h.el('title-input').hidden,false);assert.equal(h.el('title').hidden,true);
  h.el('title-input').value='人物小传';h.el('body').value='外婆，八十六岁';
  await h.el('save').onclick();
  assert.deepEqual(calls,[{text:'外婆，八十六岁',expectedRevision:1,title:'人物小传'}]);
  assert.equal(h.el('title').textContent,'人物小传');assert.equal(h.el('title-input').hidden,true);
  assert.match(documentCardMarkup({id:'story',kind:'story',title:'剧本',text:'',item:{}}),/aria-label="剧本"/);
  assert.match(documentCardMarkup({id:'canvas-note-2',kind:'note',title:'剧本',text:'',item:{role:'script'}}),/aria-label="剧本"/);
});
