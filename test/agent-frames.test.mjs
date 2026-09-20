import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaFrameSize,generationFrames,placeMediaFrames} from '../public/features/agent/frames.js';

test('media frames preserve requested and measured aspect ratios',()=>{
  for(const ratio of ['9:16','16:9','1:1','1024x1536']){
    const [w,h]=ratio.split(/[:x]/).map(Number),size=mediaFrameSize({aspectRatio:ratio});
    assert.ok(Math.abs(size.width/size.height-w/h)<1e-10);assert.equal(Math.max(size.width,size.height),320);
  }
  const real=mediaFrameSize({width:1920,height:1080,aspectRatio:'1:1'});assert.equal(real.width/real.height,1920/1080);
});

test('prepared outputs become actual tasks without changing canvas identity or order',()=>{
  const doc={prepared:{p:{input:{type:'image',prompt:'画面',size:'9:16'},quote:{quantity:4},createdAt:100}},generations:[]};
  const before=generationFrames(doc);assert.equal(before.length,4);assert.equal(before[0].status,'waiting_approval');
  doc.prepared.p.result={jobIds:['a','b','c','d']};
  doc.generations=doc.prepared.p.result.jobIds.map((id,index)=>({id,canvasId:`p-${index}`,batchId:'p',createdAt:100,index}));
  assert.deepEqual(generationFrames(doc).map(g=>g.canvasId),before.map(g=>g.canvasId));
});

test('mixed-size batches wrap without overlaps and retain moved positions on later generations',()=>{
  const frames=Array.from({length:7},(_,i)=>({id:`a-${i}`,batchId:'a',aspectRatio:i%2?'9:16':'16:9'}));
  const positions=placeMediaFrames(frames,{},[{x:0,y:300,width:400,height:300}]);
  for(const [i,a] of Object.values(positions).entries())for(const b of Object.values(positions).slice(i+1))assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);
  assert.ok(positions['a-0'].y>600);
  positions['a-0']={x:900,y:1800,width:180,height:320};
  const next=placeMediaFrames([...frames,{id:'b',batchId:'b'}],positions);
  assert.deepEqual(Object.keys(next),['b']);assert.ok(next.b.y>2120);assert.equal(positions['a-0'].x,900);
});

test('new generation frames are placed in the current viewport',()=>{
  const view={viewport:{x:-1200,y:-800,scale:1},width:900,height:600};
  const result=placeMediaFrames([{id:'new',aspectRatio:'16:9'}],{},[{x:0,y:1800,width:320,height:228}],view);
  const frame=result.new;
  assert.ok(frame.x>=1200&&frame.x+frame.width<=2076);
  assert.ok(frame.y>=824&&frame.y+frame.height<=1376);
  assert.ok(Math.abs(frame.x+frame.width/2-1650)<1);
  assert.ok(Math.abs(frame.y+frame.height/2-1100)<1);
});

test('viewport placement finds the nearest visible space beside centered material',()=>{
  const view={viewport:{x:0,y:0,scale:1},width:1000,height:700};
  const centered={x:340,y:236,width:320,height:228};
  const result=placeMediaFrames([{id:'new',aspectRatio:'1:1'}],{},[centered],view);
  const frame=result.new;
  assert.ok(frame.x>=12&&frame.x+frame.width<=988);
  assert.ok(frame.y>=12&&frame.y+frame.height<=688);
  assert.ok(frame.x>=centered.x+centered.width+8||frame.x+frame.width<=centered.x-8||frame.y>=centered.y+centered.height+8||frame.y+frame.height<=centered.y-8);
});
