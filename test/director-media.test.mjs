import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {importedImageBounds} from '../public/features/agent/image-bounds.js';
const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const loading=source.slice(source.indexOf('  function assetBounds('),source.indexOf('  function nodeContent('));
test('loaded local images populate the native shape and invalidate empty drawing caches',()=>{
  const url='gugu-media://asset/image-1';
  let painted,cleared=0,drawn=0,updated;
  const shape={image(value){painted=value;},clearCache(){cleared++;},getLayer(){return {batchDraw(){drawn++;}};}};
  const context={epoch:0,syncing:false,automaticImageSizing:new Set(),assetSizes:new Map(),assetSizeLoads:new Map(),assetImages:new Map(),Image:class {naturalWidth=800;naturalHeight=400;},workspace:()=>({positions:{}}),bridge:{markCanvasDirty(){}},canvas:{getCanvasNodeById:()=>({getElement:()=>shape}),getNodeConfigById:()=>({$_type:'image',$_imageUrl:url}),updateNodes(ids,bounds){updated=bounds;}}};
  vm.createContext(context);vm.runInContext(loading,context);
  context.loadAssetSize('image-1',url);
  const image=context.assetSizeLoads.get(url);image.onload();
  assert.equal(painted,image);assert.equal(cleared,1);assert.equal(drawn,1);
  assert.equal(updated.width,280);assert.equal(updated.height,140);
  context.loadAssetSize('image-1',url);assert.equal(context.assetSizeLoads.size,0);
  painted=null;context.epoch++;context.assetSizes.clear();context.loadAssetSize('image-1',url);
  const stale=context.assetSizeLoads.get(url);context.epoch++;stale.onload();assert.equal(painted,null);
});

test('decoding a fresh portrait image keeps it inside the space reserved for it',()=>{
  const url='gugu-media://portrait';
  const node={id:'portrait',$_type:'image',$_imageUrl:url,x:600,y:200,width:280,height:220};
  let updated;
  const context={epoch:1,syncing:false,mainLayer:null,automaticImageSizing:new Set(['portrait']),assetSizes:new Map(),assetSizeLoads:new Map(),assetImages:new Map(),importedImageBounds,
    Image:class {naturalWidth=800;naturalHeight=1600;},workspace:()=>({positions:{}}),bridge:{},
    canvas:{getState:()=>({nodes:[node]}),getCanvasNodeById:()=>null,getNodeConfigById:()=>node,updateNodes(ids,bounds){updated=bounds;}}};
  vm.createContext(context);vm.runInContext(loading,context);
  context.loadAssetSize('portrait',url);context.assetSizeLoads.get(url).onload();
  assert.ok(Math.abs(updated.width-110)<1e-8);assert.ok(Math.abs(updated.height-220)<1e-8);
  assert.ok(Math.abs(updated.x+updated.width/2-(node.x+node.width/2))<1e-8);
  assert.ok(Math.abs(updated.y+updated.height/2-(node.y+node.height/2))<1e-8);
  assert.equal(node.x,600);assert.equal(node.y,200);
});

test('cache eviction does not reload painted shapes but new shapes still receive their image',()=>{
  const url='gugu-media://asset/image-1';
  const shape={image(){},clearCache(){},getLayer:()=>null};
  let currentShape=shape;
  const context={epoch:1,syncing:false,automaticImageSizing:new Set(),assetSizes:new Map(),assetSizeLoads:new Map(),assetImages:new Map(),
    Image:class {naturalWidth=100;naturalHeight=100;},workspace:()=>({positions:{}}),bridge:{},
    canvas:{getCanvasNodeById:()=>({getElement:()=>currentShape}),getNodeConfigById:()=>({$_type:'image',$_imageUrl:url}),updateNodes(){}}};
  vm.createContext(context);vm.runInContext(loading,context);
  context.loadAssetSize('image-1',url);context.assetSizeLoads.get(url).onload();
  context.assetImages.clear();
  context.loadAssetSize('image-1',url);
  assert.equal(context.assetSizeLoads.size,0);
  currentShape={...shape};
  context.loadAssetSize('image-1',url);
  assert.equal(context.assetSizeLoads.size,1,'a recreated shape must not stay blank after cache eviction');
});

test('video picture presses reach the canvas while playback controls remain native',()=>{
  const handlers={},forwarded=[];
  const video={dataset:{},getBoundingClientRect:()=>({bottom:200}),addEventListener(type,handler){handlers[type]=handler;}};
  const element={style:{},querySelectorAll:selector=>selector==='[data-canvas-src]'?[]:[video],querySelector:()=>null};
  const context={bindDocumentCard(){},selected:'video',canvas:{getCanvasNodeById:()=>({htmlElement:element,getElement:()=>({getClientRect:()=>({x:0,y:0,width:280,height:200})})}),getStage:()=>({content:{dispatchEvent:event=>forwarded.push(event)}})}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function alignCard('),source.indexOf('  function alignCards(')),context);
  context.alignCard('video');
  class MouseEvent {
    constructor(type,init){this.type=type;this.clientY=init.clientY;this.clientX=init.clientX;this.button=init.button;}
    stopPropagation(){this.stopped=true;}
    preventDefault(){this.prevented=true;}
  }
  const picture=new MouseEvent('mousedown',{clientX:30,clientY:80,button:0});
  handlers.mousedown(picture);
  assert.equal(forwarded.length,1);assert.equal(forwarded[0].clientX,30);assert.equal(forwarded[0].clientY,80);
  assert.equal(picture.prevented,true);
  const controls=new MouseEvent('mousedown',{clientX:30,clientY:180,button:0});
  handlers.mousedown(controls);
  assert.equal(forwarded.length,1);assert.equal(controls.prevented,undefined);assert.equal(controls.stopped,true);
});

test('video picture wheel gestures reach the canvas while playback controls remain native',()=>{
  const handlers={},forwarded=[];
  const video={dataset:{},getBoundingClientRect:()=>({bottom:200}),addEventListener(type,handler){handlers[type]=handler;}};
  const element={style:{},querySelectorAll:selector=>selector==='[data-canvas-src]'?[]:[video],querySelector:()=>null};
  const context={bindDocumentCard(){},selected:'video',canvas:{getCanvasNodeById:()=>({htmlElement:element,getElement:()=>({getClientRect:()=>({x:0,y:0,width:280,height:200})})}),getStage:()=>({content:{dispatchEvent:event=>forwarded.push(event)}})}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function alignCard('),source.indexOf('  function alignCards(')),context);
  context.alignCard('video');
  class WheelEvent {
    constructor(type,init){Object.assign(this,{type,...init});}
    stopPropagation(){this.stopped=true;}
    preventDefault(){this.prevented=true;}
  }
  const picture=new WheelEvent('wheel',{clientX:30,clientY:80,deltaX:0,deltaY:-120,deltaMode:0,ctrlKey:true});
  handlers.wheel(picture);
  assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].deltaY,-120);
  assert.equal(forwarded[0].clientX,30);
  assert.equal(forwarded[0].ctrlKey,true);
  assert.equal(picture.prevented,true);
  const controls=new WheelEvent('wheel',{clientX:30,clientY:180,deltaY:-120,ctrlKey:true});
  handlers.wheel(controls);
  assert.equal(forwarded.length,1);
  assert.equal(controls.prevented,undefined);
  assert.equal(controls.stopped,true);
});

for(const gesture of [{tool:'select',button:1},{tool:'hand',button:0}])test(`video controls allow canvas panning with ${gesture.tool} tool and button ${gesture.button}`,()=>{
  const handlers={},forwarded=[],selections=[];
  const video={dataset:{},getBoundingClientRect:()=>({bottom:200}),addEventListener(type,handler){handlers[type]=handler;}};
  const element={style:{},querySelectorAll:selector=>selector==='[data-canvas-src]'?[]:[video],querySelector:()=>null};
  const context={bindDocumentCard(){},selected:null,canvas:{getToolType:()=>gesture.tool,
    selectNodes:ids=>selections.push(ids),
    getCanvasNodeById:()=>({htmlElement:element,getElement:()=>({getClientRect:()=>({x:0,y:0,width:280,height:200})})}),
    getStage:()=>({content:{dispatchEvent:event=>forwarded.push(event)}})}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function alignCard('),source.indexOf('  function alignCards(')),context);
  context.alignCard('video');
  // Browser event coordinates and buttons are inherited getters, not own fields.
  class MouseEvent {
    constructor(type,init){this.type=type;this.init=init;}
    get clientX(){return this.init.clientX;}
    get clientY(){return this.init.clientY;}
    get button(){return this.init.button;}
    get buttons(){return this.init.buttons;}
    get bubbles(){return this.init.bubbles;}
    get cancelable(){return this.init.cancelable;}
    stopPropagation(){this.stopped=true;}
    preventDefault(){this.prevented=true;}
  }
  for(const clientY of [80,180]){
    const press=new MouseEvent('mousedown',{clientX:30,clientY,button:gesture.button,buttons:gesture.button===1?4:1});
    handlers.mousedown(press);
    const forwardedPress=forwarded.at(-1);
    assert.equal(forwardedPress.bubbles,true,'middle-button handler on the stage container must receive the press');
    assert.equal(forwardedPress.cancelable,true);
    assert.equal(forwardedPress.button,gesture.button);
    assert.equal(forwardedPress.buttons,press.buttons);
    assert.equal(forwardedPress.clientX,30);
    assert.equal(forwardedPress.clientY,clientY);
    assert.equal(press.prevented,true,'panning must not activate native video controls');
  }
  assert.equal(forwarded.length,2);
  const pointer=new MouseEvent('pointerdown',{clientX:30,clientY:180,button:gesture.button});
  handlers.pointerdown(pointer);
  assert.equal(forwarded.length,3);
  assert.equal(selections.length,0,'panning does not select the video controls');
});
