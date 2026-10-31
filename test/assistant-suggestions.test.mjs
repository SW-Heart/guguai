import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assistantSuggestionGroups,pickAssistantSuggestions,renderAssistantSuggestions,fillAssistantSuggestion,mountAssistantSuggestions} from '../public/features/assistant/suggestions.js';
import {renderAssistantShell} from '../public/features/assistant/presentation.js';

test('each draw includes one distinct prompt from each creative task with visible fill-in content',()=>{
 assert.equal(assistantSuggestionGroups.flat().length,18);
 for(const choice of [0,.5,.99]){
  const items=pickAssistantSuggestions(()=>choice);
  assert.equal(items.length,3);assert.equal(new Set(items.map(item=>item.id)).size,3);
  for(const [index,item] of items.entries()){
   assert.ok(assistantSuggestionGroups[index].includes(item));
   assert.match(item.text,/【[^】]+】/);assert.ok(item.description);assert.ok(!/[→↗]/.test(item.title));
  }
 }
 assert.notDeepEqual(pickAssistantSuggestions(()=>0),pickAssistantSuggestions(()=>.99));
});

function input(value=''){
 return {value,events:[],listeners:{},addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},focus(){this.focused=true;},setSelectionRange(start,end){this.selection=[start,end];},dispatchEvent(event){this.events.push(event.type);for(const listener of this.listeners[event.type]||[])listener(event);}};
}
test('clicking a prompt selects the first field without submitting or replacing a draft',()=>{
 const item=pickAssistantSuggestions(()=>0)[0],editor=input();
 assert.equal(fillAssistantSuggestion(editor,item),true);
 assert.equal(editor.value,item.text);assert.equal(editor.focused,true);assert.equal(editor.value.slice(...editor.selection),'【填写时长，例如60秒】');assert.deepEqual(editor.events,['input']);
 const draft=input('用户已经写好的需求');assert.equal(fillAssistantSuggestion(draft,item),false);assert.equal(draft.value,'用户已经写好的需求');assert.deepEqual(draft.events,[]);
});

test('polls and typing keep the current suggestions; new conversations redraw and active replies hide them',()=>{
 let listener,draws=0,rendered='',renderCount=0;
 const buttons=pickAssistantSuggestions(()=>.5).map(item=>({dataset:{suggestion:item.id},attributes:{},toggleAttribute(key,value){if(value)this.attributes[key]='';else delete this.attributes[key];},setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];}})),container={hidden:true,addEventListener:(_event,fn)=>listener=fn,querySelectorAll:()=>buttons,set innerHTML(value){rendered=value;renderCount++;},get innerHTML(){return rendered;}};
 const editor=input(),notices=[];
 const suggestions=mountAssistantSuggestions(container,editor,{random:()=>{draws++;return .5;},onDraft:notice=>notices.push(notice)});
 suggestions.update({sessionId:'a',empty:true,disabled:false});const html=container.innerHTML;
 assert.equal(draws,3);assert.equal(container.hidden,false);
 suggestions.update({sessionId:'a',empty:true,disabled:false});assert.equal(draws,3);assert.equal(renderCount,1);assert.equal(container.innerHTML,html);
 const item=pickAssistantSuggestions(()=>.5)[0];listener({target:{closest:()=>({dataset:{suggestion:item.id}})}});assert.equal(editor.value,item.text);assert.equal(buttons[0].attributes['aria-current'],'true');assert.ok('data-filled' in buttons[0].attributes);
 editor.value+='\n用户补充的内容';
 listener({target:{closest:()=>({dataset:{suggestion:item.id}})}});assert.equal(notices.length,1);assert.equal(editor.value,item.text+'\n用户补充的内容');
 editor.value='';editor.dispatchEvent(new Event('input'));assert.ok(buttons.every(button=>!('data-filled' in button.attributes)));
 suggestions.update({sessionId:'a',empty:false,disabled:true});assert.equal(container.hidden,true);assert.ok(buttons.every(button=>button.disabled));
 suggestions.update({sessionId:'b',empty:true,disabled:false});assert.equal(draws,6);assert.equal(renderCount,2);
 suggestions.update({sessionId:'a',empty:true,disabled:false});assert.equal(draws,9);suggestions.destroy();
});

test('suggestions appear below the composer and every changed entry uses fresh cache versions',async()=>{
 const html=renderAssistantShell();assert.match(html,/<\/form>\s*<div data-suggestions class="assistant-suggestions"/);
 const rows=renderAssistantSuggestions(pickAssistantSuggestions(()=>0));assert.equal((rows.match(/class="gugu-lucide /g)||[]).length,3);assert.equal((rows.match(/class="assistant-suggestion-label"/g)||[]).length,3);assert.ok(!rows.includes('已填入'));assert.ok(!rows.includes('提供剧本和预期时长'));
 const markup=renderAssistantSuggestions([{id:'safe',title:'<img src=x>',description:'<script>'}]);assert.ok(!markup.includes('<img'));assert.ok(!markup.includes('<script>'));
 for(const [file,urls] of [['public/index.html',['/app.js?v=636']],['public/app.js',['features/assistant/workspace.js?v=17','features/assistant/workspace.css?v=14']],['public/features/assistant/workspace.js',['./suggestions.js?v=5','./presentation.js?v=8','./model-picker.js?v=8']],['public/features/assistant/model-picker.js',['./presentation.js?v=8']]]){
  const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');for(const url of urls)assert.ok(source.includes(url),`${file}: ${url}`);
 }
});

test('untouched suggestions can be switched, while user edits remain protected',()=>{
 const first=pickAssistantSuggestions(()=>0)[0],second=pickAssistantSuggestions(()=>0)[1],editor=input();
 assert.equal(fillAssistantSuggestion(editor,first),true);
 assert.equal(fillAssistantSuggestion(editor,second,{replaceValue:first.text}),true);assert.equal(editor.value,second.text);
 editor.value=editor.value.replace('【填写题材、主要人物或想表达的情节】','讲一个雨夜重逢的故事');
 const edited=editor.value;assert.equal(fillAssistantSuggestion(editor,first,{replaceValue:second.text}),false);assert.equal(editor.value,edited);
});
