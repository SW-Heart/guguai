import test from 'node:test';
import assert from 'node:assert/strict';
import {createCancelledNodeCleanup} from '../public/features/drama/canvas-cancelled-cleanup.js';
function fixture(){
  let now=0,nextId=0;const timers=new Map(),removed=[],classes=new Set();
  const item={id:'cancelled',cancelled:true,element:{classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}}};
  let items=[item];
  const cleanup=createCancelledNodeCleanup({items:()=>items,remove:id=>{removed.push(id);items=items.filter(item=>item.id!==id);cleanup.update();},setTimer:(callback,delay)=>{const id=++nextId;timers.set(id,{callback,time:now+delay});return id;},clearTimer:id=>timers.delete(id)});
  function advance(ms){const until=now+ms;for(;;){const next=[...timers].filter(([,timer])=>timer.time<=until).sort((a,b)=>a[1].time-b[1].time)[0];if(!next)break;now=next[1].time;timers.delete(next[0]);next[1].callback();}now=until;}
  return {item,classes,removed,cleanup,advance,timers};
}
test('cancelled nodes stay for three seconds, then fade for 300 ms and are removed once',()=>{
  const f=fixture();f.cleanup.update();f.advance(2999);assert.equal(f.classes.size,0);assert.equal(f.removed.length,0);
  f.cleanup.update();f.advance(1);assert.ok(f.classes.has('dw-cancelled-removing'));
  f.advance(299);assert.equal(f.removed.length,0);f.advance(1);assert.deepEqual(f.removed,['cancelled']);
  f.advance(10000);assert.equal(f.removed.length,1);
});
test('a status change during either the wait or fade cancels removal and restores visibility',()=>{
  for(const elapsed of [1500,3100]){
    const f=fixture();f.cleanup.update();f.advance(elapsed);f.item.cancelled=false;f.cleanup.update();f.advance(10000);
    assert.equal(f.removed.length,0);assert.equal(f.classes.size,0);assert.equal(f.timers.size,0);
    f.item.cancelled=true;f.cleanup.update();f.advance(2999);assert.equal(f.removed.length,0);f.advance(301);assert.equal(f.removed.length,1);
  }
});
test('non-cancelled nodes are untouched and leaving the project cancels all outstanding work',()=>{
  const f=fixture();f.item.cancelled=false;f.cleanup.update();f.advance(10000);assert.equal(f.timers.size,0);
  f.item.cancelled=true;f.cleanup.update();f.advance(3000);assert.equal(f.classes.size,1);
  f.cleanup.destroy();f.advance(10000);assert.equal(f.removed.length,0);assert.equal(f.classes.size,0);
});
test('the latest status is checked at removal even without a refresh',()=>{
  const f=fixture();f.cleanup.update();f.advance(3000);f.item.cancelled=false;f.advance(300);
  assert.equal(f.removed.length,0);assert.equal(f.classes.size,0);
});
