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
