import test from 'node:test';
import assert from 'node:assert/strict';
import {slashSkillQuery,matchingSkills,renderSkillOptions,mountAssistantSkillPicker} from '../public/features/assistant/skill-picker.js';
import {readAssistantRequiredSkill} from '../lib/agent/assistant-skills.mjs';
const skills=[{name:'script-writing',title:'剧本创作',summary:'场景与对白'},{name:'short-drama',title:'短剧创作',summary:'分集和分镜'}];

test('slash completion follows the cursor, supports Chinese search and leaves URLs and ordinary text alone',()=>{
 assert.deepEqual(slashSkillQuery('/剧本',3),{start:0,end:3,query:'剧本'});
 assert.deepEqual(slashSkillQuery('帮我 /短剧',6),{start:3,end:6,query:'短剧'});
 assert.deepEqual(slashSkillQuery('先写\n/剧本 再调整',6),{start:3,end:6,query:'剧本'});
 for(const text of ['https://example.com/','普通/文字','没有斜杠','/技能 已结束'])assert.equal(slashSkillQuery(text,text.length),null);
 assert.deepEqual(matchingSkills(skills,'分镜'),[skills[1]]);
 assert.deepEqual(matchingSkills(skills,'SCRIPT'),[skills[0]]);
 assert.equal(matchingSkills(skills,'不存在').length,0);
 const html=renderSkillOptions([{name:'script-writing',title:'<img src=x>',summary:'<script>'}],0,'script-writing');
 assert.ok(!html.includes('<img'));assert.match(html,/aria-selected="true"/);assert.match(html,/已选中/);
});

function fixture(t,options={}){
 const node=()=>({hidden:false,disabled:false,style:{},attributes:{},listeners:{},children:[],setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},contains(){return false;}});
 const input=node(),menu=node(),list=node(),chip=node(),remove=node(),label=node(),document=node(),window=node();
 Object.assign(input,{value:'',selectionStart:0,selectionEnd:0,focus(){document.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);}});
 Object.assign(menu,{showPopover(){this.open=true;},hidePopover(){this.open=false;}});
 chip.querySelector=()=>label;list.id='assistantSkillList';document.activeElement=input;window.innerHeight=900;window.innerWidth=1200;
 for(const [name,value] of Object.entries({document,window})){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});t.after(()=>{if(old)Object.defineProperty(globalThis,name,old);else delete globalThis[name];});}
 const selectors={'#assistantMessage':input,'[data-skill-menu]':menu,'[data-skill-list]':list,'[data-selected-skill]':chip,'[data-remove-skill]':remove,'.assistant-composer':{getBoundingClientRect:()=>({left:250,top:650,bottom:850,width:700})}};
 const choices=[],signal=new AbortController();
 const picker=mountAssistantSkillPicker({querySelector:key=>selectors[key]},{signal:signal.signal,onChange:async name=>{choices.push(name);return true;},...options});
 const update=(selected='',disabled=false)=>picker.update({skills,selected,disabled});
 const type=text=>{input.value=text;input.selectionStart=input.selectionEnd=text.length;input.dispatchEvent(new Event('input'));};
 const key=async(key,isComposing=false)=>{const event={key,isComposing,preventDefault(){this.prevented=true;},stopImmediatePropagation(){},stopPropagation(){}};for(const fn of input.listeners.keydown||[])await fn(event);await new Promise(resolve=>setImmediate(resolve));return event;};
 return {input,menu,list,chip,label,remove,choices,picker,update,type,key,signal};
}

test('keyboard selection consumes the slash command, displays the saved choice and closes safely',async t=>{
 const f=fixture(t);f.update();f.type('/');assert.equal(f.menu.open,true);assert.equal(f.input.attributes['aria-expanded'],'true');
 await f.key('ArrowDown');f.update(); // polling must not reset keyboard selection
 assert.equal((await f.key('Enter')).prevented,true);assert.deepEqual(f.choices,['short-drama']);assert.equal(f.input.value,'');assert.equal(f.menu.open,false);
 f.update('short-drama');assert.equal(f.chip.hidden,false);assert.equal(f.label.textContent,'短剧创作');
 f.type('正文 /剧本');await f.key('Tab');assert.equal(f.input.value,'正文 ');assert.equal(f.choices.at(-1),'script-writing');
 f.type('/不存在');assert.equal((await f.key('Enter')).prevented,true);assert.equal(f.choices.length,2);
 await f.key('Escape');assert.equal(f.menu.open,false);assert.equal(f.input.value,'/不存在');
 f.type('/');await f.key('Enter',true);assert.equal(f.menu.open,true,'IME confirmation must not choose a skill');
 f.update('script-writing',true);assert.equal(f.menu.open,false);assert.equal(f.remove.disabled,true);
 f.update();assert.equal(f.chip.hidden,true);f.type('/');f.signal.abort();assert.equal(f.menu.open,false);
});

test('required skill reader loads every page and rejects invalid or incomplete skills',async()=>{
 const reads=[];
 const result=await readAssistantRequiredSkill({read:async(name,resource,offset)=>{reads.push({name,resource,offset});return offset?{text:'第二页'}:{text:'第一页',nextOffset:3};}},'script-writing');
 assert.equal(result.instructions,'第一页第二页');assert.deepEqual(reads.map(read=>read.offset),[0,3]);
 await assert.rejects(readAssistantRequiredSkill({read:()=>assert.fail('not allowed')},'external-operation'),/不可用/);
 await assert.rejects(readAssistantRequiredSkill({read:async()=>({text:'正文',nextOffset:0})},'script-writing'),/无法读取/);
 await assert.rejects(readAssistantRequiredSkill({read:async()=>({text:''})},'script-writing'),/无法读取/);
});

test('local skill action stays after the results and remains available with no matches',()=>{
 for(const rows of [skills,[]]){
  const html=renderSkillOptions(rows,rows.length,'');
  assert.match(html,/data-add-local-skill/);assert.match(html,/添加本地 Skill/);
  assert.ok(html.indexOf('data-add-local-skill')>html.indexOf('assistant-skill-options'));
  assert.match(html,/id="assistant-skill-add"[^>]+aria-selected="true"/);
 }
});

test('changed skill menu and entry assets use the current cache keys',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const [file,urls] of [['public/index.html',['/app.js?v=640']],['public/app.js',['features/assistant/workspace.js?v=17','features/assistant/workspace.css?v=14']],['public/features/assistant/workspace.js',['./skill-picker.js?v=2']]]){
  const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');for(const url of urls)assert.ok(source.includes(url),`${file}: ${url}`);
 }
});

test('keyboard activation opens the add action even when filtering has no results',async t=>{
 let additions=0;const f=fixture(t,{onAdd:async()=>{additions++;return true;}});f.update();
 f.type('/');await f.key('ArrowUp');await f.key('Enter');assert.equal(additions,1);assert.equal(f.input.value,'');
 f.type('/没有结果');await f.key('Enter');assert.equal(additions,2);assert.equal(f.input.value,'');assert.deepEqual(f.choices,[]);
});
