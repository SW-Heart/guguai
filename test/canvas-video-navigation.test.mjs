import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
function fixture(){
  const forwarded=[];
  const context=vm.createContext({canvas:{getStage:()=>({content:{dispatchEvent:event=>forwarded.push(event)}})}});
  vm.runInContext(source.slice(source.indexOf('  function forwardCanvasMediaWheel('),source.indexOf('  function alignCard(')),context);
  return {forwarded,run:event=>context.forwardCanvasMediaWheel(event)};
}
class Wheel {
  constructor(type,options={}){this.type=type;Object.assign(this,options);}
  preventDefault(){this.prevented=true;}
  stopPropagation(){this.stopped=true;}
}

test('wheel gestures over video pictures and native playback controls reach the canvas unchanged',()=>{
  for(const clientY of [10,195])for(const ctrlKey of [false,true]){
    const f=fixture();
    const event=new Wheel('wheel',{target:{closest:()=>({tagName:'VIDEO'})},clientY,clientX:20,
      deltaX:35,deltaY:-24,deltaZ:0,deltaMode:0,ctrlKey,shiftKey:true,altKey:false,metaKey:false});
    f.run(event);
    assert.equal(f.forwarded.length,1);
    const forwarded=f.forwarded[0];
    for(const field of ['type','clientX','clientY','deltaX','deltaY','deltaZ','deltaMode','ctrlKey','shiftKey','altKey','metaKey'])assert.equal(forwarded[field],event[field],field);
    assert.equal(forwarded.bubbles,true);assert.equal(forwarded.cancelable,true);
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);
  }
});

test('video controls in an event path are recognized without intercepting other canvas content',()=>{
  const f=fixture();
  const control=new Wheel('wheel',{target:{closest:()=>null},composedPath:()=>[{tagName:'BUTTON'},{tagName:'VIDEO'}]});
  f.run(control);assert.equal(f.forwarded.length,1);
  const background=new Wheel('wheel',{target:{closest:()=>null},composedPath:()=>[{tagName:'CANVAS'}]});
  f.run(background);assert.equal(f.forwarded.length,1);
  assert.equal(background.prevented,undefined);assert.equal(background.stopped,undefined);
});

test('video wheel forwarding runs before playback controls and is removed on unmount',()=>{
  assert.ok(source.includes("addEventListener('wheel',forwardCanvasMediaWheel,{capture:true,passive:false})"));
  assert.ok(source.includes("removeEventListener('wheel',forwardCanvasMediaWheel,true)"));
});

test('hovering text cards scrolls the canvas; editing keeps body scrolling and canvas zoom',()=>{
  for(const editing of [false,true])for(const ctrlKey of [false,true]){
    const f=fixture();
    const card={classList:{contains:()=>editing}};
    const body={closest:selector=>selector==='.dw-document-card'?card:selector==='[data-document-body]'?body:null};
    const event=new Wheel('wheel',{target:body,deltaX:20,deltaY:50,ctrlKey});
    f.run(event);
    const canvasScroll=!editing||ctrlKey;
    assert.equal(f.forwarded.length,canvasScroll?1:0);
    assert.equal(Boolean(event.prevented),canvasScroll);
  }
});

test('hand and middle-button drags start over text without consuming normal text clicks',()=>{
  for(const tool of ['select','hand'])for(const button of [0,1])for(const type of ['pointerdown','mousedown']){
    const forwarded=[];
    const context=vm.createContext({canvas:{getToolType:()=>tool,getStage:()=>({content:{dispatchEvent:event=>forwarded.push(event)}})}});
    vm.runInContext(source.slice(source.indexOf('  function forwardCanvasDocumentPan('),source.indexOf('  function alignCard(')),context);
    const event=new Wheel(type,{target:{closest:()=>({})},button,buttons:button===1?4:1,clientX:40,clientY:60});
    context.forwardCanvasDocumentPan(event);
    const panning=tool==='hand'||button===1;
    assert.equal(forwarded.length,panning?1:0);
    assert.equal(Boolean(event.stopped),panning);
    // Let the browser emit mousedown after pointerdown for the canvas engine.
    assert.equal(Boolean(event.prevented),panning&&type!=='pointerdown');
    if(panning){assert.equal(forwarded[0].bubbles,true);assert.equal(forwarded[0].clientX,40);assert.equal(forwarded[0].button,button);}
  }
});
