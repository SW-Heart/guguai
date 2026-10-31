import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAssistantSuggestions,applySuggestionSkill,assistantSuggestionGroups,pickAssistantSuggestions} from '../public/features/assistant/suggestions.js';
import {createAgentSkills} from '../lib/agent/skills.mjs';
function events(value={}){
 const handlers=new Map();
 return Object.assign(value,{addEventListener(type,fn){const list=handlers.get(type)||[];list.push(fn);handlers.set(type,list);},emit(type,event={}){return Promise.all((handlers.get(type)||[]).map(fn=>fn(event)));}});
}
function fixture(t,{motion=false,onUse}={}){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 const controller=new AbortController(),animations=[],notices=[];let html='',renders=0,buttons=[];
 const document=events({hidden:false,activeElement:null});
 const editor=events({value:'',focus(){document.activeElement=this;},setSelectionRange(start,end){this.selection=[start,end];},dispatchEvent(event){void this.emit(event.type,event);},scrollIntoView(){}});
 function button(id){
  const row={dataset:{suggestion:id},toggleAttribute(){},setAttribute(){},removeAttribute(){}};
  if(motion)row.animate=(frames,options)=>{
    let resolve,reject,settled=false;
    const animation={target:row,frames,options,startTime:null,cancelled:false,finished:new Promise((yes,no)=>{resolve=yes;reject=no;}),finish(){settled=true;resolve();},cancel(){this.cancelled=true;if(!settled){settled=true;reject(new Error('cancelled'));}}};animations.push(animation);return animation;
  };
  return row;
 }
 document.timeline={get currentTime(){return Date.now();}};
 const container=events({hidden:true,hover:false,matches(){return this.hover;},contains(node){return buttons.includes(node);},querySelectorAll(){return buttons;},set innerHTML(value){html=value;renders++;buttons=[...value.matchAll(/data-suggestion="([^"]+)"/g)].map(([,id])=>button(id));},get innerHTML(){return html;}});
 const component=mountAssistantSuggestions(container,editor,{signal:controller.signal,random:()=>0,reduceMotion:()=>!motion,visibilityTarget:document,onUse,onDraft:text=>notices.push(text)});
 const update=(more={})=>component.update({sessionId:'a',empty:true,disabled:false,...more});update();
 t.after(()=>controller.abort());
 return {component,editor,container,document,controller,animations,notices,update,get renders(){return renders;},get ids(){return buttons.map(button=>button.dataset.suggestion);},tick(ms){t.mock.timers.tick(ms);},hover(active){container.hover=active;return container.emit(active?'pointerenter':'pointerleave',{pointerType:'mouse'});},click(id=buttons[0].dataset.suggestion){return container.emit('click',{target:{closest:()=>({dataset:{suggestion:id}})}});}};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};

test('three prompts rotate every five seconds without adjacent repeats and polling does not restart the countdown',t=>{
 const f=fixture(t),first=f.ids;f.tick(3000);f.update();f.tick(1999);assert.equal(f.renders,1);
 f.tick(1);assert.equal(f.renders,2);assert.equal(f.ids.length,3);assert.ok(f.ids.every((id,index)=>id!==first[index]));
 f.tick(5000);assert.equal(f.renders,3);
});

test('hover freezes prompts and leaving waits a new full five seconds; keyboard focus also pauses',t=>{
 const f=fixture(t);f.tick(4000);void f.hover(true);f.tick(20000);assert.equal(f.renders,1);
 void f.hover(false);f.tick(4999);assert.equal(f.renders,1);f.tick(1);assert.equal(f.renders,2);
 void f.container.emit('focusin');void f.hover(true);void f.hover(false);f.tick(10000);assert.equal(f.renders,2);
 void f.container.emit('focusout',{relatedTarget:null});f.tick(4999);assert.equal(f.renders,2);f.tick(1);assert.equal(f.renders,3);
});

test('hidden tabs, disabled controls and conversation replies stop timers, and abort cleans up',t=>{
 const f=fixture(t);f.document.hidden=true;void f.document.emit('visibilitychange');f.tick(10000);assert.equal(f.renders,1);
 f.document.hidden=false;void f.document.emit('visibilitychange');f.tick(4999);assert.equal(f.renders,1);f.tick(1);assert.equal(f.renders,2);
 f.update({empty:false});f.tick(10000);assert.equal(f.renders,2);
 f.update({disabled:true});f.tick(10000);assert.equal(f.renders,2);
 f.update();f.tick(5000);assert.equal(f.renders,3);
 f.controller.abort();f.tick(10000);assert.equal(f.renders,3);
});

test('each question flips around its own axis, all three share a start time, and hover cancels all rows',async t=>{
 const f=fixture(t,{motion:true}),first=f.ids;
 f.tick(5000);assert.equal(f.animations.length,3);assert.equal(f.renders,1);
 assert.equal(new Set(f.animations.map(animation=>animation.target)).size,3);
 assert.deepEqual(f.animations.map(animation=>animation.startTime),[5000,5000,5000]);
 for(const animation of f.animations)assert.match(animation.frames[1].transform,/rotateX/);
 await f.hover(true);await flush();assert.ok(f.animations.every(animation=>animation.cancelled));assert.deepEqual(f.ids,first);
 await f.hover(false);f.tick(4999);assert.equal(f.animations.length,3);f.tick(1);assert.equal(f.animations.length,6);
 f.animations[3].finish();f.animations[4].finish();await flush();assert.equal(f.renders,1,'all three outgoing rows must finish before swapping');
 f.animations[5].finish();await flush();assert.equal(f.renders,2);assert.equal(f.animations.length,9);
 assert.deepEqual(f.animations.slice(6).map(animation=>animation.startTime),[10000,10000,10000]);
 for(const animation of f.animations.slice(6))animation.finish();await flush();assert.ok(f.animations.slice(6).every(animation=>animation.cancelled));
 f.tick(5000);assert.equal(f.animations.length,12,'the next synchronized flip starts five seconds after the previous one');
});

test('hover during incoming row flips cancels the whole group and restarts only after five seconds',async t=>{
 const f=fixture(t,{motion:true});f.tick(5000);for(const animation of f.animations)animation.finish();await flush();
 assert.equal(f.renders,2);assert.equal(f.animations.length,6);const current=f.ids;
 await f.hover(true);await flush();assert.ok(f.animations.slice(3).every(animation=>animation.cancelled));
 f.tick(10000);assert.deepEqual(f.ids,current);assert.equal(f.animations.length,6);
 await f.hover(false);f.tick(4999);assert.equal(f.animations.length,6);f.tick(1);assert.equal(f.animations.length,9);
});

test('associated skills are available, selected before filling, and are skipped when already selected',async()=>{
 const catalog=await createAgentSkills().search(),names=new Set(catalog.map(skill=>skill.name));
 assert.equal(assistantSuggestionGroups.flat().length,18);
 for(const item of assistantSuggestionGroups.flat())if(item.skill)assert.ok(names.has(item.skill),item.skill);
 const item=pickAssistantSuggestions(()=>0)[0],selected=[];
 await applySuggestionSkill(item,{catalog,selected:'',select:async skill=>selected.push(skill)});assert.deepEqual(selected,[item.skill]);
 await applySuggestionSkill(item,{catalog,selected:item.skill,select:()=>assert.fail('already selected')});
 await assert.rejects(applySuggestionSkill(item,{catalog:[],select:()=>assert.fail('unavailable')}),/暂时不可用/);
 await applySuggestionSkill({},{catalog:[],select:()=>assert.fail('no skill association')});
});

test('skill application completes before filling and never replaces edits made while waiting',async t=>{
 let release,started=0;
 const gate=new Promise(resolve=>release=resolve);
 const f=fixture(t,{onUse:async item=>{assert.ok(item.skill);started++;await gate;return true;}});
 const click=f.click();assert.equal(started,1);assert.equal(f.editor.value,'');f.tick(10000);assert.equal(f.renders,1);
 release();await click;assert.match(f.editor.value,/【/);
 f.editor.value+='用户补充的内容';await f.click();assert.equal(started,1,'protect edited drafts before changing their skill');assert.equal(f.notices.length,1);
});

test('late skill responses do not fill a different conversation',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve);
 const f=fixture(t,{onUse:async()=>{await gate;return true;}});
 const click=f.click();f.update({sessionId:'b'});release();await click;assert.equal(f.editor.value,'');
});
