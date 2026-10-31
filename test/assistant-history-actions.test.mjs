import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renameAssistantConversation,deleteAssistantConversation,assistantConversationMenuPosition} from '../public/features/assistant/history-actions.js';
import {renderAssistantHistory,renderAssistantShell} from '../public/features/assistant/presentation.js';
function fixture(){
 const calls=[],draft={text:'还没有发送的草稿',files:['image-a']};
 const client={settings:async value=>calls.push(['settings',value]),history:async()=>calls.push(['history']),newConversation:async()=>calls.push(['new'])};
 const request=async(path,options)=>{calls.push([path,options]);return {};};
 return {calls,client,request,draft,currentId:()=> 'current'};
}

test('each history row has a separate, escaped action trigger without nesting buttons',()=>{
 const html=renderAssistantHistory([{id:'current',title:'当前对话'},{id:'other',title:'<img src=x>'}],'current');
 assert.equal((html.match(/data-history-more=/g)||[]).length,2);
 assert.match(html,/data-history-more="other"[^>]+aria-label="&lt;img src=x&gt;的操作"/);
 assert.ok(!html.includes('<img'));
 assert.match(html,/<\/button><button type="button" class="assistant-history-more"/);
 assert.match(renderAssistantHistory([{id:'a',title:'找得到'},{id:'b',title:'不相关'}],'a','找得'),/data-history-more="a"/);
});

test('renaming another conversation sends only its title and preserves the active view and draft',async()=>{
 const f=fixture();await renameAssistantConversation({...f,id:'other',title:'新的名字'});
 assert.deepEqual(f.calls, [['/api/agent/sessions/other/settings',{method:'POST',body:JSON.stringify({title:'新的名字'})}],['history']]);
 assert.deepEqual(f.draft,{text:'还没有发送的草稿',files:['image-a']});
 const active=fixture();await renameAssistantConversation({...active,id:'current',title:'当前新名字'});assert.deepEqual(active.calls,[['settings',{title:'当前新名字'}],['history']]);
});

test('deleting another conversation keeps the current one; deleting the current conversation opens a new one',async()=>{
 const other=fixture();await deleteAssistantConversation({...other,id:'other'});assert.deepEqual(other.calls,[['/api/agent/sessions/other',{method:'DELETE'}],['history']]);
 assert.equal(other.draft.text,'还没有发送的草稿');
 const active=fixture();await deleteAssistantConversation({...active,id:'current'});assert.deepEqual(active.calls,[['/api/agent/sessions/current',{method:'DELETE'}],['new'],['history']]);
});

test('failed mutations do not navigate or refresh away from the existing conversation',async()=>{
 const f=fixture();f.request=async()=>{throw new Error('服务暂时不可用');};
 await assert.rejects(deleteAssistantConversation({...f,id:'current'}),/暂时不可用/);assert.deepEqual(f.calls,[]);
 await assert.rejects(renameAssistantConversation({...f,id:'other',title:'修改'}),/暂时不可用/);assert.deepEqual(f.calls,[]);
});

test('row menu stays on screen near the bottom of the sidebar and remains outside the compact chat inert region',()=>{
 const bottom=assistantConversationMenuPosition({right:225,top:730,bottom:760},900,800);assert.ok(bottom.top+90<800);assert.ok(bottom.top<730);
 const right=assistantConversationMenuPosition({right:1000,top:30,bottom:60},900,800);assert.ok(right.left+168<=892);assert.equal(right.top,66);
 const html=renderAssistantShell();assert.match(html,/<\/section>\s*<div id="assistantConversationMenu"/);assert.match(html,/data-delete-name/);assert.match(html,/role="menu" aria-label="对话操作"/);
});

test('changed history actions are reachable through updated cached entry points',async()=>{
 for(const [file,urls] of [['public/index.html',['/app.js?v=641']],['public/app.js',['features/assistant/workspace.js?v=17','features/assistant/workspace.css?v=14']],['public/features/assistant/workspace.js',['./history-actions.js?v=1','./presentation.js?v=8','./model-picker.js?v=8']],['public/features/assistant/model-picker.js',['./presentation.js?v=8']]]){
  const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');for(const url of urls)assert.ok(source.includes(url),`${file}: ${url}`);
 }
});
