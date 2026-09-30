import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasNodeBounds,placeCanvasNodes,focusCanvasViewport} from '../public/features/drama/canvas-layout.js';

const view={viewport:{x:0,y:0,scale:1},width:1000,height:700};
const separate=(a,b,gap=32)=>a.right<=b.left-gap+.00001||b.right<=a.left-gap+.00001||a.bottom<=b.top-gap+.00001||b.bottom<=a.top-gap+.00001;

test('new content stays beside existing content even when the viewport is far away',()=>{
  const old={id:'old',x:9000,y:-6000,width:280,height:220};
  const position=placeCanvasNodes([{id:'new',width:320,height:320}],{},[old],view).new;
  assert.ok(separate(canvasNodeBounds(old),canvasNodeBounds(position)));
  assert.ok(Math.hypot(position.x-old.x,position.y-old.y)<700);
});

test('empty canvases place the first component at the visible world center',()=>{
  const current={...view,viewport:{x:-1200,y:400,scale:.5}};
  const position=placeCanvasNodes([{id:'new',width:200,height:100}],{},[],current).new;
  assert.equal((position.x+100)*.5-1200,500);
  assert.equal((position.y+50)*.5+400,350);
  const fallback=placeCanvasNodes([{id:'new',width:200,height:100}]).new;
  assert.ok(Number.isFinite(fallback.x)&&Number.isFinite(fallback.y));
});

test('mixed components avoid existing rotated and flipped content and each other',()=>{
  const old=[{id:'rotated',x:400,y:250,width:280,height:228,rotation:38},{id:'flipped',x:1100,y:100,width:500,height:350,scaleX:-1,scaleY:1.5}];
  const nodes=Array.from({length:36},(_,i)=>({id:`new-${i}`,width:i%3?180:420,height:i%2?320:150,rotation:i%4===0?25:0,scaleX:i%5===0?-1:1}));
  const positions=placeCanvasNodes(nodes,{},old,view);
  const rects=[...old,...nodes.map(node=>({...node,...positions[node.id]}))].map(canvasNodeBounds);
  rects.slice(old.length).forEach((rect,index)=>rects.slice(0,index+old.length).forEach(other=>assert.ok(separate(rect,other))));
});

test('saved positions remain unchanged and reserve space for newly arriving content',()=>{
  const saved={x:600,y:200,width:300,height:300};
  const positions={saved};
  const nodes=[{id:'saved',width:100,height:100},{id:'new',width:300,height:300}];
  const result=placeCanvasNodes(nodes,positions,[],view);
  assert.deepEqual(Object.keys(result),['new']);assert.equal(positions.saved,saved);
  assert.ok(separate(canvasNodeBounds(saved),canvasNodeBounds(result.new)));
});

test('invisible nodes and connecting edges do not consume layout space',()=>{
  const empty=placeCanvasNodes([{id:'new',width:200,height:100}],{},[],view);
  const result=placeCanvasNodes([{id:'new',width:200,height:100}],{},[{id:'edge-link',x:-1e6,y:-1e6,width:2e6,height:2e6},{id:'hidden',x:0,y:0,width:2000,height:2000,visible:false}],view);
  assert.deepEqual(result,empty);
});

test('focusing one component centers it without zooming in',()=>{
  const node={id:'new',x:5000,y:-3000,width:320,height:180,scaleX:-1,rotation:30};
  const current={...view,viewport:{x:120,y:80,scale:.4}};
  const viewport=focusCanvasViewport([node],current),rect=canvasNodeBounds(node);
  assert.equal(viewport.scale,.4);
  assert.ok(Math.abs((rect.left+rect.right)/2*viewport.scale+viewport.x-500)<1e-8);
  assert.ok(Math.abs((rect.top+rect.bottom)/2*viewport.scale+viewport.y-350)<1e-8);
});

test('focusing a batch fits all new components into the viewport with margins',()=>{
  const nodes=[{id:'a',x:-2000,y:300,width:800,height:400},{id:'b',x:1000,y:900,width:300,height:1600}];
  const viewport=focusCanvasViewport(nodes,view);
  assert.ok(viewport.scale<1);
  for(const node of nodes){const bounds=canvasNodeBounds(node);assert.ok(bounds.left*viewport.scale+viewport.x>=63);assert.ok(bounds.right*viewport.scale+viewport.x<=937);assert.ok(bounds.top*viewport.scale+viewport.y>=63);assert.ok(bounds.bottom*viewport.scale+viewport.y<=637);}
  assert.equal(focusCanvasViewport([],view),null);
  assert.equal(focusCanvasViewport(nodes,{width:0,height:0}),null);
});
