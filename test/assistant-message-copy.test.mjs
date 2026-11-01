import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAssistantMessages,patchAssistantDraft,createAssistantStream} from '../public/features/assistant/conversation.js';
import {renderStreamingMarkdownBlocks} from '../public/features/agent/markdown.js';

// Only the DOM operations used by the history renderer; no client is launched.
function element() {
  return {
    dataset:{},style:{},children:[],innerHTML:'',
    append(child){child.parent=this;this.children.push(child);},
    replaceChildren(...children){this.children=[];children.forEach(child=>this.append(child));},
    insertBefore(child,before){child.remove();const index=this.children.indexOf(before);child.parent=this;this.children.splice(index<0?this.children.length:index,0,child);},
    remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}},
    querySelector(){return null;},
    querySelectorAll(selector){
      const found=this.children.flatMap(child=>child.querySelectorAll(selector));
      if(selector.includes('.dw-message-actions')&&this.className==='dw-message-actions')found.unshift(this);
      if(selector.includes('[data-code-copy]')&&this.innerHTML.includes('data-code-copy'))found.unshift(this.codeCopy??={hidden:false});
      return found;
    },
  };
}

test('tool-only whitespace messages never render empty replies or copy buttons before the answer',t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:element}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const history=element(),welcome=()=>'<div class="assistant-welcome">欢迎</div>';
  const user={id:'user',role:'user',text:'生成剧本'};
  const blanks=['','\n\n','  \t\r\n',null].map((text,i)=>({id:`tool-${i}`,role:'assistant',text}));
  // The same saved messages arrive during tool work and after completion.
  renderAssistantMessages(history,[user,...blanks],welcome);
  assert.deepEqual(history.children.map(node=>node.dataset.messageId),['user']);
  const answer={id:'answer',role:'assistant',text:'# 剧本\n\n```text title="剧本"\n第一场：重逢\n```'};
  renderAssistantMessages(history,[user,...blanks,answer],welcome);
  assert.deepEqual(history.children.map(node=>node.dataset.messageId),['user','answer']);
  const reply=history.children[1];
  assert.equal(reply.children.length,2);
  assert.equal(reply.children[0].className,'dw-message-content');
  assert.match(reply.children[0].innerHTML,/data-code-copy/,'document copy remains available');
  assert.equal(reply.children[1].className,'dw-message-actions','reply copy stays below content');
  assert.equal(reply.children[1].dataset.copyText,answer.text);
  assert.equal((reply.children[1].innerHTML.match(/data-response-action/g)||[]).length,1);
  renderAssistantMessages(history,[user,...blanks,answer],welcome);
  assert.equal(history.children[1],reply,'polling preserves the existing reply and copy button');
  assert.equal(reply.children.length,2);
  // Also remove an empty bubble already mounted by a previous render.
  const stale=element();stale.dataset.messageId='tool-1';history.append(stale);
  renderAssistantMessages(history,[user,...blanks,answer],welcome);
  assert.equal(history.children.length,2);
});

test('the whole current turn waits for tools and the buffered final reply, while earlier replies stay copyable',t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:element}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const history=element(),welcome=()=>'',frames=new Map();let time=1,id=0;
  const oldUser={id:'old-user',role:'user',text:'之前的问题'},oldReply={id:'old-reply',role:'assistant',text:'之前的回复'};
  const user={id:'user',role:'user',text:'请创作'},interim={id:'interim',role:'assistant',text:'先读取相关资料。\n\n```text\n阶段性文稿\n```'};
  const messages=[oldUser,oldReply,user,interim];
  const stream=createAssistantStream({now:()=>time,requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:id=>frames.delete(id),render:view=>renderAssistantMessages(history,view.messages,welcome,{working:view.working})});
  t.after(()=>stream.dispose());
  stream.update({id:'session',state:'running',messages,draft:'',activity:'正在读取资料…'});
  const earlier=history.children[1],pending=history.children[3];
  const actions=node=>node.children.at(-1);
  assert.equal(actions(earlier).hidden,false);
  assert.equal(actions(pending).hidden,true);
  assert.equal(pending.children[0].codeCopy.hidden,true,'closed documents in intermediate messages are also unavailable');
  const text='最终回复正在输出。'.repeat(30);
  stream.update({id:'session',state:'running',messages,draft:text});
  time+=16;const initial=[...frames.values()];frames.clear();initial.forEach(fn=>fn(time));
  stream.update({id:'session',state:'completed',messages:[...messages,{id:'final',role:'assistant',text}],draft:''});
  assert.equal(actions(pending).hidden,true,'server completion must still wait for visible text to finish');
  for(let i=0;i<2000&&frames.size;i++){time+=16;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(time));}
  assert.equal(frames.size,0);
  assert.equal(history.children[3],pending,'completion changes availability without recreating content');
  assert.equal(actions(pending).hidden,true,'intermediate segments never get separate reply actions');assert.equal(pending.children[0].codeCopy.hidden,false);
  assert.equal(actions(history.children.at(-1)).hidden,false);
  assert.equal(actions(history.children.at(-1)).dataset.copyText,`${interim.text}\n\n${text}`);
});

test('saved multi-request answers have one copy action per user question containing every segment in order',t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:element}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const history=element(),welcome=()=>'';
  const user=(id,text)=>({id,role:'user',text}),reply=(id,text)=>({id,role:'assistant',text});
  const messages=[user('q1','第一问'),reply('a1','先读取资料。'),reply('a2','继续读取参考。'),reply('a3','完整方案。'),user('q2','第二问'),reply('b1','先搜索。'),reply('b2','第二份完整答案。')];
  renderAssistantMessages(history,messages,welcome);
  const controls=history.querySelectorAll('.dw-message-actions');
  assert.deepEqual(controls.map(control=>control.hidden),[true,true,false,true,false]);
  assert.deepEqual(controls.filter(control=>!control.hidden).map(control=>control.dataset.copyText),['先读取资料。\n\n继续读取参考。\n\n完整方案。','先搜索。\n\n第二份完整答案。']);
  renderAssistantMessages(history,messages,welcome,{working:true});
  assert.deepEqual(controls.map(control=>control.hidden),[true,true,false,true,true],'the earlier complete answer remains available');
});

test('a closed document in the streaming draft stays uncopyable until the reply leaves the draft',()=>{
  const text='```text title="剧本"\n已经写完的段落\n```\n\n继续补充说明';
  const buttons=[{hidden:false}],content={children:renderStreamingMarkdownBlocks(text).map(html=>({_streamHTML:html})),querySelectorAll:()=>buttons};
  patchAssistantDraft(content,text);assert.equal(buttons[0].hidden,true);
  patchAssistantDraft(content,text);assert.equal(buttons[0].hidden,true);
});
