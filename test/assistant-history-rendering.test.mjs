import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantHistoryRenderer} from '../public/features/assistant/history-actions.js';

function row(id,title){
  const span={textContent:title},attributes=new Map();
  const button={dataset:{session:id},title,disabled:true,querySelector:()=>span,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),getAttribute:key=>attributes.get(key)};
  const more={setAttribute:(key,value)=>attributes.set(`more-${key}`,value)};
  const classes=new Set();
  return {button,span,classes,querySelector:selector=>selector==='[data-session]'?button:more,
    classList:{toggle(name,value){if(value)classes.add(name);else classes.delete(name);}},
    remove(){if(this.parent){const parent=this.parent;parent.children.splice(parent.children.indexOf(this),1);this.parent=null;}}};
}
function container(){
  let html='',replacements=0;
  return {children:[],scrollTop:128,
    set innerHTML(value){html=value;this.children=[];replacements++;},get innerHTML(){return html;},get replacements(){return replacements;},
    insertBefore(node,before){node.remove();const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,node);node.parent=this;},
  };
}
function documentFixture(t){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  let created=0;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(){return {content:{},set innerHTML(html){created++;const id=html.match(/data-session="([^"]+)"/)[1],title=html.match(/<span>([^<]+)<\/span>/)[1];this.content.firstElementChild=row(id,title);}};}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  return ()=>created;
}

test('polling and skill settings preserve history rows, buttons and scroll; active/title updates stay in place',t=>{
  const created=documentFixture(t),host=container(),render=createAssistantHistoryRenderer(host);
  const items=[{id:'a',title:'剧本',updatedAt:1,skill:''},{id:'b',title:'分镜',updatedAt:1}];
  render(items,'a');
  const [first,second]=host.children,button=first.button;
  render([{...items[0],updatedAt:2,skill:'script-writing',state:'running'},items[1]],'a');
  assert.equal(created(),2);assert.equal(host.replacements,0);
  assert.equal(host.children[0],first);assert.equal(first.button,button);assert.equal(host.scrollTop,128);
  render([{...items[0],title:'新剧本'},items[1]],'b');
  assert.equal(host.children[0],first);assert.equal(host.children[1],second);assert.equal(first.button,button);
  assert.equal(button.disabled,true,'pending navigation lock remains intact');
  assert.equal(button.title,'新剧本');assert.equal(first.span.textContent,'新剧本');
  assert.equal(first.classes.has('is-current'),false);assert.equal(second.button.getAttribute('aria-current'),'page');
  render([items[1],items[0],{id:'c',title:'角色'}],'b');
  assert.equal(created(),3);assert.equal(host.children[0],second);assert.equal(host.children[1],first);
  render([items[0]],'a');assert.deepEqual(host.children,[first]);assert.equal(host.scrollTop,128);
});

test('searching keeps matching row identity and distinguishes the two empty states',t=>{
  documentFixture(t);const host=container(),render=createAssistantHistoryRenderer(host);
  const items=[{id:'a',title:'剧本'},{id:'b',title:'分镜'}];
  render(items,'a');const first=host.children[0];
  render(items,'a','剧');assert.deepEqual(host.children,[first]);
  render(items,'a','找不到');assert.match(host.innerHTML,/没有找到相关对话/);
  render([],'a','');assert.match(host.innerHTML,/对话会保存在这里/);
});
