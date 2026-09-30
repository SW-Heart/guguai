import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { mountModelPreferencePicker } from '../public/features/agent/model-preference-picker.js';
import { normalizeModelPreferences } from '../public/features/agent/model-preferences.js';

// Exercise the controller with an in-memory DOM, without opening a browser or client.
function element(selector = '') {
  const listeners = new Map(), children = new Map();
  return {
    selector, dataset:{}, style:{}, scrollTop:0, scrollHeight:500, offsetWidth:390, offsetHeight:400, tabIndex:0,
    classList:{toggle(){}},setAttribute(name,value){this[name]=value;},remove(){this.removed=true;},focus(){},contains(){return false;},
    matches(query){return query === ':popover-open' ? Boolean(this.open) : query.split(',').includes(this.selector);},
    closest(){return this;},
    getBoundingClientRect(){return {top:700,bottom:744,left:150};},
    addEventListener(type,callback){listeners.set(type,callback);},
    emit(type,event={}){return listeners.get(type)?.(event);},
    showPopover(){this.open=true;this.emit('toggle',{newState:'open'});},
    hidePopover(){this.open=false;this.emit('toggle',{newState:'closed'});},
    querySelector(query){if(!children.has(query))children.set(query,element(query));return children.get(query);},
    querySelectorAll(){return [];},
  };
}
async function withPicker(action, options={}) {
  const oldDocument=globalThis.document,oldWindow=globalThis.window,created=[],saved=[],abort=new AbortController();
  globalThis.document={activeElement:null,createElement(){const node=element();created.push(node);return node;},body:{append(){}},addEventListener(){}};
  globalThis.window={innerWidth:1000,innerHeight:900,addEventListener(){}};
  const picker=mountModelPreferencePicker({insertAdjacentElement(){}},{scope:'first',signal:abort.signal,loadCatalog:async()=>[{id:'image-a',label:'图片 A',kind:'image'}],onSave:async value=>saved.push(value),...options});
  const wrapper=created[0],popup=created[1],trigger=wrapper.querySelector('button');
  const settle=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
  const open=async()=>{trigger.emit('click');await settle();};
  const choose=()=>{const automatic=popup.querySelector('[data-preference-auto]');automatic.checked=false;popup.emit('change',{target:automatic});const model=element('[data-preference-model]');model.dataset.preferenceModel='image-a';model.checked=true;popup.emit('change',{target:model});};
  try{await settle();await action({picker,popup,trigger,saved,open,choose,settle});}
  finally{abort.abort();if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;}
}

test('cancel discards draft selections and complete saves exactly the chosen category',async()=>{
  await withPicker(async({picker,popup,saved,open,choose})=>{
    await open();choose();
    assert.deepEqual(picker.getValue(),normalizeModelPreferences());
    await popup.emit('click',{target:popup.querySelector('[data-preference-cancel]')});
    assert.deepEqual(picker.getValue(),normalizeModelPreferences());assert.equal(saved.length,0);
    await open();choose();
    await popup.emit('click',{target:popup.querySelector('[data-preference-save]')});
    assert.deepEqual(picker.getValue(),{image:{mode:'manual',modelIds:['image-a']},video:{mode:'auto',modelIds:[]}});
    assert.equal(saved.length,1);assert.equal(popup.open,false);
  });
});

test('the entry has only an icon and keeps accessible descriptions when the conversation changes',async()=>{
  await withPicker(async({picker,popup,trigger,open})=>{
    await open();picker.update({scope:'legacy',value:undefined});
    assert.equal(popup.open,false);assert.deepEqual(picker.getValue(),normalizeModelPreferences());
    assert.match(trigger['aria-label'],/图片：自动选择；视频：自动选择/);
    assert.doesNotMatch(readFileSync(new URL('../public/features/agent/model-preference-picker.js',import.meta.url),'utf8'),/data-preference-summary/);
  },{value:{image:{mode:'manual',modelIds:['image-a']}}});
});

test('failed saves keep the committed preference and allow correcting the draft',async()=>{
  await withPicker(async({picker,popup,open,choose})=>{
    await open();choose();await popup.emit('click',{target:popup.querySelector('[data-preference-save]')});
    assert.deepEqual(picker.getValue(),normalizeModelPreferences());assert.equal(popup.open,true);
    assert.equal(popup.querySelector('[data-preference-error]').textContent,'连接失败');
    assert.equal(popup.querySelector('[data-preference-save]').disabled,false);
  },{onSave:async()=>{throw new Error('连接失败');}});
});

test('a late save cannot overwrite the newly opened conversation',async()=>{
  let release;
  await withPicker(async({picker,popup,open,choose})=>{
    await open();choose();
    const pending=popup.emit('click',{target:popup.querySelector('[data-preference-save]')});
    picker.update({scope:'replacement',value:undefined});release();await pending;
    assert.deepEqual(picker.getValue(),normalizeModelPreferences());assert.equal(popup.open,false);
  },{onSave:()=>new Promise(resolve=>{release=resolve;})});
});

test('a newly mounted picker restores account choices before opening its draft',async()=>{
  const preferences={image:{mode:'manual',modelIds:['image-a']},video:{mode:'auto',modelIds:[]}},readiness=[];
  await withPicker(async({picker,popup,saved,open})=>{
    assert.deepEqual(picker.getValue(),preferences);assert.deepEqual(readiness,[true]);
    await open();assert.equal(popup.querySelector('[data-preference-auto]').checked,false);
    assert.match(popup.querySelector('[data-preference-list]').innerHTML,/checked/);assert.equal(saved.length,0);
  },{loadCatalog:async()=>({models:[{id:'image-a',label:'图片 A',kind:'image'}],modelPreferences:preferences}),onReady:ready=>readiness.push(ready)});
});

test('a failed initial preference load cannot save automatic defaults and retry restores the account choice',async()=>{
  let available=false;
  const preferences={image:{mode:'manual',modelIds:['image-a']},video:{mode:'auto',modelIds:[]}};
  await withPicker(async({picker,popup,open,settle})=>{
    await open();assert.equal(popup.querySelector('[data-preference-save]').disabled,true);
    available=true;popup.emit('click',{target:popup.querySelector('[data-preference-retry]')});await settle();
    assert.deepEqual(picker.getValue(),preferences);assert.equal(popup.querySelector('[data-preference-auto]').checked,false);
    assert.equal(popup.querySelector('[data-preference-save]').disabled,false);
  },{loadCatalog:async()=>{if(!available)throw new Error('offline');return {models:[{id:'image-a',label:'图片 A',kind:'image'}],modelPreferences:preferences};}});
});
