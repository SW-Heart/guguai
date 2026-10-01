import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchMediaController } from '../public/features/drama/workbench-media.js';

function harness(count=100){
  const callbacks=[];const observers=[];const timers=new Map();let timerId=0;
  const videos=Array.from({length:count},(_,index)=>({
    dataset:{wbVideoSrc:`gugu-media://clip-${index}`},isConnected:true,src:'',pauses:0,loads:0,
    getAttribute(name){return name==='src'?this.src:null;},removeAttribute(){this.src='';},pause(){this.pauses++;},load(){this.loads++;},
  }));
  class Observer {
    constructor(callback){callbacks.push(callback);this.observed=new Set();observers.push(this);}
    observe(video){this.observed.add(video);}
    unobserve(video){this.observed.delete(video);}
    disconnect(){this.observed.clear();}
  }
  const controller=createWorkbenchMediaController({Observer,setTimer:callback=>{timers.set(++timerId,callback);return timerId;},clearTimer:id=>timers.delete(id)});
  return {controller,videos,observers,timers,
    scope:list=>({querySelectorAll:()=>list}),
    visibility:(list,visible)=>callbacks.at(-1)(list.map(target=>({target,isIntersecting:visible}))),
    expire(){for(const [id,callback] of [...timers]){timers.delete(id);callback();}},callbacks,
  };
}

test('videos load on entry, release after leaving and reload when visible again',()=>{
  const h=harness();h.controller.hydrate(h.scope(h.videos));
  assert.equal(h.videos.filter(video=>video.src).length,0);
  h.visibility(h.videos.slice(0,3),true);
  assert.equal(h.videos.filter(video=>video.src).length,3);
  h.visibility([h.videos[0]],false);assert.equal(h.timers.size,1);
  h.visibility([h.videos[0]],true);assert.equal(h.timers.size,0,'brief scroll excursions must not restart the decoder');
  assert.equal(h.videos[0].loads,0);
  h.visibility([h.videos[0]],false);h.expire();
  assert.equal(h.videos[0].src,'');assert.equal(h.videos[0].pauses,1);assert.equal(h.videos[0].loads,1);
  h.visibility([h.videos[0]],true);assert.equal(h.videos[0].src,h.videos[0].dataset.wbVideoSrc);
});

test('repeated scrolling through a large library keeps decoder resources bounded',()=>{
  const h=harness(240);h.controller.hydrate(h.scope(h.videos));
  for(let pass=0;pass<4;pass++){
    for(let start=0;start<h.videos.length;start+=4){
      const visible=h.videos.slice(start,start+4);h.visibility(visible,true);
      assert.ok(h.videos.filter(video=>video.src).length<=4);
      h.visibility(visible,false);h.expire();
      assert.equal(h.videos.filter(video=>video.src).length,0);
    }
  }
  h.controller.reset();assert.equal(h.timers.size,0);assert.equal(h.observers[0].observed.size,0);
});

test('removed previews and account changes cancel timers and ignore late observer callbacks',()=>{
  const h=harness(3);h.controller.hydrate(h.scope(h.videos));h.controller.hydrate(h.scope(h.videos));
  assert.equal(h.observers[0].observed.size,3);
  h.visibility(h.videos,true);h.visibility(h.videos,false);
  h.controller.release(h.scope([h.videos[0]]));assert.equal(h.videos[0].src,'');assert.equal(h.timers.size,2);
  const oldCallback=h.callbacks[0];h.controller.reset();assert.equal(h.timers.size,0);
  oldCallback(h.videos.map(target=>({target,isIntersecting:true})));assert.ok(h.videos.every(video=>!video.src));
  h.controller.hydrate(h.scope([h.videos[1]]));
  oldCallback([{target:h.videos[0],isIntersecting:true}]);assert.equal(h.videos[0].src,'');
  h.videos[1].isConnected=false;h.visibility([h.videos[1]],true);assert.equal(h.observers[1].observed.size,0);
});

test('without IntersectionObserver, release still unloads media deterministically',()=>{
  const h=harness(2);const controller=createWorkbenchMediaController({Observer:null});
  controller.hydrate(h.scope(h.videos));assert.ok(h.videos.every(video=>video.src));
  controller.reset();assert.ok(h.videos.every(video=>!video.src));
});
