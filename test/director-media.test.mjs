import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const loading=source.slice(source.indexOf('  function assetBounds('),source.indexOf('  function nodeContent('));
test('loaded local images populate the native shape and invalidate empty drawing caches',()=>{
  const url='gugu-media://asset/image-1';
  let painted,cleared=0,drawn=0,updated;
  const shape={image(value){painted=value;},clearCache(){cleared++;},getLayer(){return {batchDraw(){drawn++;}};}};
  const context={epoch:0,assetSizes:new Map(),assetSizeLoads:new Map(),assetImages:new Map(),Image:class {naturalWidth=800;naturalHeight=400;},workspace:()=>({positions:{}}),canvas:{getCanvasNodeById:()=>({getElement:()=>shape}),getNodeConfigById:()=>({$_type:'image',$_imageUrl:url}),updateNodes(ids,bounds){updated=bounds;}}};
  vm.createContext(context);vm.runInContext(loading,context);
  context.loadAssetSize('image-1',url);
  const image=context.assetSizeLoads.get(url);image.onload();
  assert.equal(painted,image);assert.equal(cleared,1);assert.equal(drawn,1);
  assert.equal(updated.width,280);assert.equal(updated.height,140);
  context.loadAssetSize('image-1',url);assert.equal(context.assetSizeLoads.size,0);
  painted=null;context.epoch++;context.assetSizes.clear();context.loadAssetSize('image-1',url);
  const stale=context.assetSizeLoads.get(url);context.epoch++;stale.onload();assert.equal(painted,null);
});

test('video picture presses reach the canvas while playback controls remain native',()=>{
  const handlers={},forwarded=[];
  const video={dataset:{},getBoundingClientRect:()=>({bottom:200}),addEventListener(type,handler){handlers[type]=handler;}};
  const element={style:{},querySelectorAll:()=>[video],querySelector:()=>null};
  const context={selected:'video',canvas:{getCanvasNodeById:()=>({htmlElement:element,getElement:()=>({getClientRect:()=>({x:0,y:0,width:280,height:200})})}),getStage:()=>({content:{dispatchEvent:event=>forwarded.push(event)}})}};
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
