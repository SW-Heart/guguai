import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTextModels } from '../public/features/admin/text-models.js';

test('check all tests every model sequentially, continues after failure, and uses the latest saved version',async()=>{
 const buttons=new Map(['data-text-check-all','data-text-add','data-text-refresh'].map(key=>[key,{textContent:'',disabled:false}]));
 let rows=[];
 const table={set innerHTML(value){rows=[...value.matchAll(/data-text-test="([^"]+)"/g)].map(match=>({dataset:{textTest:match[1]},disabled:false}));}};
 const root={innerHTML:'',querySelector(selector){return selector==='[data-text-table]'?table:buttons.get(selector.slice(1,-1));},querySelectorAll(selector){return selector==='[data-text-test]'?rows:[...buttons.values(),...rows];}};
 let catalog={version:1,items:['deepseek','broken','third'].map(id=>({id,label:id,enabled:true,contextWindow:256000,sortOrder:0}))};
 let active=0;
 const calls=[],toasts=[];
 const api=async(_url,options)=>{
  if(!options)return structuredClone(catalog);
  assert.equal(++active,1);
  try{
   const input=JSON.parse(options.body);
   assert.equal(input.expectedVersion,catalog.version);
   calls.push(input.id);
   await new Promise(resolve=>setImmediate(resolve));
   const passed=input.id!=='broken';
   catalog={version:catalog.version+1,items:catalog.items.map(item=>item.id===input.id?{...item,testedAt:passed?'now':null}:item)};
   return {...structuredClone(catalog),passed,message:passed?'测试成功':'测试失败'};
  }finally{active--;}
 };
 await loadTextModels({root,api,esc:value=>String(value),toast:value=>toasts.push(value),pageHead:()=>'',showAdminDialog:()=>{}});
 buttons.get('data-text-check-all').onclick();
 assert.ok(buttons.get('data-text-check-all').disabled);
 for(let index=0;index<100&&!toasts.length;index++)await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['deepseek','broken','third']);
 assert.deepEqual(toasts,['检查完成：2 个成功，1 个失败']);
 for(let index=0;index<10&&buttons.get('data-text-check-all').disabled;index++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(buttons.get('data-text-check-all').disabled,false);
 assert.equal(catalog.items[0].testedAt,'now');
 assert.equal(catalog.items[1].testedAt,null);
 assert.equal(catalog.items[2].testedAt,'now');
});
