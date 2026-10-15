import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {bindMediaNameInput,mountMediaNameEditor} from '../public/features/drama/media-name-editor.js';
import {normalizeDirectorWorkspace} from '../public/features/drama/director-actions.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(save=async()=>{}){
  const document=new EventTarget(),input=new EventTarget(),calls=[],errors=[];let finished=0,selected=0;
  Object.assign(input,{value:'原始名称.png',ownerDocument:document,focus(){document.activeElement=this;},select(){selected++;}});
  const controller=bindMediaNameInput(input,{save:async name=>{calls.push(name);await save(name);},done(){finished++;},error:message=>errors.push(message)});
  const key=(value,extra={})=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{key:value,...extra});input.dispatchEvent(event);};
  return {input,document,key,controller,calls,errors,get finished(){return finished;},get selected(){return selected;}};
}
test('editing focuses and selects the entire name; an outside click saves a trimmed name once',async()=>{
  const f=fixture();assert.equal(f.document.activeElement,f.input);assert.equal(f.selected,1);
  f.input.value='  新名称.mp4  ';f.document.dispatchEvent(new Event('pointerdown'));f.input.dispatchEvent(new Event('blur'));await tick();
  assert.deepEqual(f.calls,['新名称.mp4']);assert.equal(f.finished,1);
  f.document.dispatchEvent(new Event('pointerdown'));await tick();assert.equal(f.calls.length,1);
});
test('Escape cancels and an empty name keeps editing without writing',async()=>{
  const empty=fixture();empty.input.value=' \n ';empty.input.dispatchEvent(new Event('blur'));await tick();
  assert.equal(empty.calls.length,0);assert.equal(empty.finished,0);assert.equal(empty.errors[0],'文件名不能为空');empty.controller.destroy();
  const cancel=fixture();cancel.input.value='不保存';cancel.key('Escape');cancel.input.dispatchEvent(new Event('blur'));await tick();
  assert.equal(cancel.calls.length,0);assert.equal(cancel.finished,1);
});
test('Chinese composition does not submit on Enter; failed saves preserve the draft for retry',async()=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw new Error('保存失败');});
  f.input.dispatchEvent(new Event('compositionstart'));f.input.value='角色定妆照';f.key('Enter',{isComposing:true});await tick();assert.equal(f.calls.length,0);
  f.input.dispatchEvent(new Event('compositionend'));f.key('Enter');await tick();
  assert.equal(f.finished,0);assert.equal(f.input.value,'角色定妆照');assert.equal(f.input.readOnly,false);
  fail=false;f.key('Enter');await tick();assert.equal(f.finished,1);assert.equal(f.calls.length,2);
});
test('destroyed editors ignore pending saves and later input events',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));f.key('Enter');f.controller.destroy();resolve();await tick();
  assert.equal(f.finished,0);f.input.dispatchEvent(new Event('blur'));await tick();assert.equal(f.calls.length,1);
});
test('renamed files survive project serialization and reject empty or oversized names',()=>{
  const saved=normalizeDirectorWorkspace({projectAssets:{names:{image:'主角定妆照.png',audio:'背景音乐.wav',empty:'  ',long:'名'.repeat(300)}}});
  const restored=normalizeDirectorWorkspace(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.projectAssets.names.image,'主角定妆照.png');assert.equal(restored.projectAssets.names.audio,'背景音乐.wav');
  assert.ok(!('empty' in restored.projectAssets.names));assert.equal(restored.projectAssets.names.long.length,160);
});

test('canvas readiness mounts a connected rename input after the initial React render',async()=>{
  class Element extends EventTarget {
    constructor(document){super();this.ownerDocument=document;this.children=[];this.style={};this.parent=null;}
    append(element){element.remove();this.children.push(element);element.parent=this;}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
    setAttribute(name,value){this[name]=value;}
    focus(){this.ownerDocument.activeElement=this;}
    select(){this.selected=true;}
    get isConnected(){return this===container||Boolean(this.parent?.isConnected);}
  }
  const previousDocument=globalThis.document;
  const document=new EventTarget();document.createElement=()=>new Element(document);
  const container=new Element(document),saved=[];
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const start=source.indexOf('    const bindCanvas=api=>{');
  const end=source.indexOf('      cancelledNodeCleanup=',start);
  // Run the readiness setup with the real editor; the remaining callback binds canvas events.
  const setup=source.slice(start,end)+'};globalThis.ready=bindCanvas;';
  const context=vm.createContext({mountEpoch:1,epoch:1,canvas:null,mediaNameEditor:null,
    host:{querySelector:()=>container},mountMediaNameEditor,
    canvasMediaNameEntries:()=>[{id:'picture',native:true,name:'原始图片.png',rect:{x:120,y:180,width:240}}],
    saveCanvasMediaName:async(id,name)=>saved.push({id,name}),bridge:{toast:assert.fail}});
  try{
    globalThis.document=document;
    assert.equal((source.match(/mediaNameEditor=mountMediaNameEditor/g)||[]).length,1);
    vm.runInContext(setup,context);
    // createRoot owns the container's initial children until readiness is reported.
    container.children.forEach(child=>child.remove());
    context.ready({});
    context.mediaNameEditor.begin('picture');
    const input=document.activeElement;
    assert.equal(input.className,'dw-media-name-input');assert.equal(input.isConnected,true);
    assert.equal(input.value,'原始图片.png');assert.equal(input.selected,true);
    input.value='主角定妆照.png';
    const enter=new Event('keydown',{cancelable:true});enter.key='Enter';input.dispatchEvent(enter);await tick();
    assert.deepEqual(saved,[{id:'picture',name:'主角定妆照.png'}]);assert.equal(input.isConnected,false);
    context.mediaNameEditor.destroy();context.mediaNameEditor=null;
    context.epoch=2;let disposed=false;context.ready({dispose(){disposed=true;}});
    assert.equal(disposed,true);assert.equal(context.mediaNameEditor,null);
  }finally{context.mediaNameEditor?.destroy();globalThis.document=previousDocument;}
});
