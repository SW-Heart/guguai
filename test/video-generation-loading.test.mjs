import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVideoGenerationLoadingController, renderVideoGenerationLoading, updateVideoGenerationProgress } from '../public/features/drama/video-generation-loading.js';

test('video loading only shows measured progress and updates it without replacing the animation',()=>{
  for(const progress of [null,undefined,0,NaN,'unknown'])assert.doesNotMatch(renderVideoGenerationLoading({progress}),/\d+%/);
  assert.match(renderVideoGenerationLoading({progress:100}),/99%/);
  const progressNode={textContent:'',hidden:true};
  const element={querySelector:()=>progressNode};
  updateVideoGenerationProgress(element,42.6);
  assert.equal(progressNode.textContent,'43%');assert.equal(progressNode.hidden,false);
  updateVideoGenerationProgress(element,null);
  assert.equal(progressNode.textContent,'');assert.equal(progressNode.hidden,true);
});

test('video fields pause offscreen and are released on replacement and page exit',()=>{
  let onIntersection,disconnects=0;
  const observed=new Set(),events=[];
  const host={IntersectionObserver:class{
    constructor(callback){onIntersection=callback;}
    observe(canvas){observed.add(canvas);}
    unobserve(canvas){observed.delete(canvas);}
    disconnect(){observed.clear();disconnects++;}
  }};
  const first={id:'first',isConnected:true},second={id:'second',isConnected:true};
  const scope={querySelectorAll:()=>[first,second],contains:canvas=>canvas===first};
  const controller=createVideoGenerationLoadingController({host,createDither:canvas=>({start:()=>events.push(`start:${canvas.id}`),stop:()=>events.push(`stop:${canvas.id}`)})});
  controller.hydrate(scope);controller.hydrate(scope);
  assert.equal(observed.size,2);assert.deepEqual(events,[]);
  onIntersection([{target:first,isIntersecting:true},{target:second,isIntersecting:false}]);
  assert.deepEqual(events,['start:first','stop:second']);
  controller.release(scope);
  assert.equal(observed.has(first),false);
  onIntersection([{target:first,isIntersecting:true}]);
  assert.deepEqual(events,['start:first','stop:second','stop:first']);
  controller.reset();assert.equal(disconnects,1);assert.equal(observed.size,0);
  assert.equal(events.at(-1),'stop:second');
});

test('video fields work without an intersection observer and clear detached canvases',()=>{
  let starts=0,stops=0;
  const canvas={isConnected:true};let canvases=[canvas];
  const controller=createVideoGenerationLoadingController({host:{},createDither:()=>({start:()=>starts++,stop:()=>stops++})});
  const scope={querySelectorAll:()=>canvases};
  controller.hydrate(scope);controller.hydrate(scope);assert.equal(starts,1);
  canvas.isConnected=false;canvases=[];controller.hydrate(scope);assert.equal(stops,1);
  controller.reset();assert.equal(stops,1);
});

test('video loading and every changed entrypoint have current cache keys',()=>{
  const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
  assert.match(read('drama-studio.js'),/video-generation-loading\.js\?v=1/);
  assert.match(read('features/drama/video-generation-loading.js'),/prompt-optimization-loading\.js\?v=1/);
  assert.match(read('app.js'),/drama-studio\.js\?v=220\b/);
  assert.match(read('index.html'),/app\.js\?v=479\b/);
  assert.match(read('index.html'),/styles\.css\?v=360\b/);
});
