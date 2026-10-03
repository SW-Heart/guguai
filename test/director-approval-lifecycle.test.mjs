import test from 'node:test';
import assert from 'node:assert/strict';
import { mountGenerationApproval } from '../public/features/agent/generation-approval.js';

class Element {
  constructor(tagName){this.tagName=tagName;this.listeners={};this.attributes={};this.textContent='';this.hidden=false;this.disabled=false;this.nodes=new Map();}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(type,callback){this.listeners[type]=callback;}
  querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Element());return this.nodes.get(selector);}
  append(element){this.child=element;element.parentNode=this;this.appendCount=(this.appendCount||0)+1;}
  showModal(){throw new Error('Generation confirmation must stay inside the conversation');}
  close(){throw new Error('Inline confirmation has no modal lifecycle');}
  focus(){this.focused=true;}
  remove(){if(this.parentNode)this.parentNode.child=null;this.parentNode=null;this.removed=true;}
  fire(type){this.listeners[type]?.({preventDefault(){}});}
}
const approval={id:'request-1',title:'生成视频',quantity:1,credits:3,prompt:'@阿宁 持钥匙\n走向门口',references:[{id:'person',label:'阿宁'}]};
function setup(onDecision=async()=>{}){
  const host=new Element();let card;
  host.ownerDocument={createElement:tagName=>(card=new Element(tagName))};
  const controller=mountGenerationApproval(host,{onDecision});
  return {controller,host,card};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('inline confirmation displays the full named prompt before any paid action without moving focus',async()=>{
  const decisions=[];
  const {controller,host,card}=setup(async(...args)=>decisions.push(args));
  assert.equal(host.child,undefined);
  controller.update(approval);
  assert.equal(card.tagName,'section');assert.equal(card.className,'dw-agent-approval');
  assert.equal(card.attributes['aria-label'],'生成确认');
  assert.equal(host.child,card);assert.equal(card.attributes['aria-modal'],undefined);
  assert.equal(card.querySelector('[data-approval-prompt]').textContent,approval.prompt);
  assert.equal(card.querySelector('[data-approval-prompt]').focused,undefined);
  assert.equal(card.querySelector('[data-approval-references]').textContent,'@阿宁');
  assert.deepEqual(decisions,[]);
  controller.update({...approval});assert.equal(host.appendCount,1);
  card.querySelector('[data-approval-generate]').fire('click');
  await settle();assert.deepEqual(decisions,[['request-1',true]]);assert.equal(host.child,null);
});

test('cancel declines once and snapshot removal leaves no confirmation space',async()=>{
  const decisions=[];const {controller,host,card}=setup(async(...args)=>decisions.push(args));
  controller.update(approval);
  card.fire('cancel');await settle();assert.deepEqual(decisions,[]);assert.equal(host.child,card);
  card.querySelector('[data-approval-cancel]').fire('click');
  await settle();assert.deepEqual(decisions,[['request-1',false]]);assert.equal(host.child,null);
  assert.doesNotThrow(()=>controller.update(null));
  controller.update(approval);assert.equal(host.child,card);
  controller.update(null);assert.equal(host.child,null);
  controller.destroy();assert.equal(card.removed,true);
});

test('a double click cannot submit twice and a failed decision preserves the prompt for retry',async()=>{
  let calls=0,reject;
  const {controller,host,card}=setup(()=>{calls++;return new Promise((_resolve,no)=>{reject=no;});});
  controller.update(approval);
  const button=card.querySelector('[data-approval-generate]');
  button.fire('click');button.fire('click');assert.equal(calls,1);assert.equal(button.disabled,true);
  reject(new Error('连接失败'));await settle();
  assert.equal(host.child,card);assert.equal(button.disabled,false);
  assert.equal(card.querySelector('[data-approval-prompt]').textContent,approval.prompt);
  assert.equal(card.querySelector('[data-approval-error]').textContent,'连接失败');
  assert.equal(card.querySelector('[data-approval-error]').hidden,false);
  button.fire('click');assert.equal(calls,2);
  reject(new Error('连接失败'));await settle();controller.destroy();
});

test('a stale response cannot remove a newer approval',async()=>{
  let finish;const {controller,host,card}=setup(()=>new Promise(resolve=>{finish=resolve;}));
  controller.update(approval);card.querySelector('[data-approval-generate]').fire('click');
  controller.update({...approval,id:'request-2',prompt:'新的画面',references:[]});
  finish();await settle();
  assert.equal(host.child,card);assert.equal(card.querySelector('[data-approval-prompt]').textContent,'新的画面');
  assert.equal(card.querySelector('[data-approval-references]').hidden,true);
  assert.equal(card.querySelector('[data-approval-generate]').disabled,false);
  controller.destroy();
});

test('destroying a pending approval prevents later responses or snapshots from restoring it',async()=>{
  let reject;const {controller,host,card}=setup(()=>new Promise((_resolve,no)=>{reject=no;}));
  controller.update(approval);card.querySelector('[data-approval-generate]').fire('click');
  controller.destroy();reject(new Error('连接失败'));await settle();controller.update(approval);
  assert.equal(host.child,null);assert.equal(card.querySelector('[data-approval-error]').textContent,'');
});
