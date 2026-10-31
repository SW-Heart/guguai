import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantStream} from '../public/features/assistant/conversation.js';
function fixture(immediate=false){
 let time=1,id=0;const frames=new Map(),views=[];
 const stream=createAssistantStream({now:()=>time,immediate:()=>immediate,render:(view,info)=>views.push({...view,...info}),requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:id=>frames.delete(id)});
 return {stream,views,frames,step(){time+=16;const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(time));},drain(){for(let i=0;i<2000&&frames.size;i++)this.step();assert.equal(frames.size,0);}};
}
const value=(draft='',messages=[],more={})=>({id:'a',state:'running',draft,messages,...more});
test('assistant spreads polled bursts over frames and drains the completed tail without jumping',()=>{
 const f=fixture(),user={id:'u',role:'user',text:'你好'};
 f.stream.update(value('',[user]));
 const text='连续回复文字。'.repeat(15)+'😀';
 f.stream.update(value(text,[user]));assert.equal(f.views.at(-1).draft,'');
 for(let i=0;i<20;i++)f.step();
 const partial=f.views.at(-1).draft;assert.ok(partial.length>0&&partial.length<text.length);
 const final={id:'reply',role:'assistant',text};
 f.stream.update(value('',[user,final],{state:'completed'}));
 assert.deepEqual(f.views.at(-1).messages,[user]);assert.equal(f.views.at(-1).draft,partial);
 f.drain();assert.deepEqual(f.views.at(-1).messages,[user,final]);assert.equal(f.views.at(-1).draft,'');
 assert.ok(f.views.some(view=>view.frameOnly&&view.draft.length>partial.length));
});
test('switching sessions cancels the previous reveal and loading a saved draft shows it immediately',()=>{
 const f=fixture();f.stream.update(value());f.stream.update(value('old'.repeat(50)));
 assert.ok(f.frames.size);
 f.stream.update(value('已保存的回复',[],{id:'b'}));
 assert.equal(f.frames.size,0);assert.equal(f.views.at(-1).draft,'已保存的回复');
 f.stream.update(value('已保存的回复继续',[],{id:'b'}));f.stream.dispose();const count=f.views.length;f.step();assert.equal(f.views.length,count);
});
test('reduced motion shows bursts immediately and reopening completed history does not animate',()=>{
 const f=fixture(true);f.stream.update(value());f.stream.update(value('直接显示😀'));assert.equal(f.views.at(-1).draft,'直接显示😀');assert.equal(f.frames.size,0);
 const saved=[{id:'final',role:'assistant',text:'完整历史回复'}];
 f.stream.update(value('',saved,{id:'b',state:'completed'}));assert.deepEqual(f.views.at(-1).messages,saved);assert.equal(f.frames.size,0);
});

test('a reply completed before the first animation frame still reveals smoothly',()=>{
 const f=fixture(),reply={id:'fast',role:'assistant',text:'快速返回但仍平滑显示的回复。'.repeat(5)};
 f.stream.update(value());f.stream.update(value(reply.text));
 f.stream.update(value('',[reply],{state:'completed'}));
 assert.deepEqual(f.views.at(-1).messages,[]);
 f.step();assert.notDeepEqual(f.views.at(-1).messages,[reply]);
 f.drain();assert.deepEqual(f.views.at(-1).messages,[reply]);
});

test('reply activity follows thinking, tool work and the visible reply until its buffered tail finishes',()=>{
 const f=fixture();
 f.stream.update(value());
 assert.equal(f.views.at(-1).working,true);
 assert.equal(f.views.at(-1).draft,'');
 f.stream.update(value('',[],{activity:'正在搜索资料…'}));
 assert.equal(f.views.at(-1).activity,'正在搜索资料…');
 const text='正在逐步显示的回复。'.repeat(30);
 f.stream.update(value(text));f.step();
 f.stream.update(value('',[{id:'result',role:'assistant',text}],{state:'completed'}));
 assert.equal(f.views.at(-1).working,true,'keep status while the response is still being revealed');
 f.drain();assert.equal(f.views.at(-1).working,false);
 f.stream.update(value('',[],{id:'other',state:'idle'}));
 assert.equal(f.views.at(-1).working,false);
 f.stream.update(value('',[],{state:'paused'}));
 assert.equal(f.views.at(-1).working,false);
 f.stream.dispose();
});
