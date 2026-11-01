import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAssistantMessages} from '../public/features/assistant/conversation.js';

// Only the DOM operations used by the history renderer; no client is launched.
function element() {
  return {
    dataset:{},style:{},children:[],innerHTML:'',
    append(child){child.parent=this;this.children.push(child);},
    replaceChildren(...children){this.children=[];children.forEach(child=>this.append(child));},
    insertBefore(child,before){child.remove();const index=this.children.indexOf(before);child.parent=this;this.children.splice(index<0?this.children.length:index,0,child);},
    remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}},
    querySelector(){return null;},
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
