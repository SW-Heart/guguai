import { readMeta, writeMeta, tx } from './db.mjs';
import { llmRatesFromEnv } from './billing.mjs';
import { textModelName, textModelIcon } from '../public/features/assistant/text-models.js';
export function createTextModelCatalog({read=readMeta,write=writeMeta,transaction=tx}={}) {
  const key='text-model-catalog-v1';
  const get=()=>JSON.parse(read(key)||'{"version":0,"items":[]}');
  function normalize(input){
    const bad=()=>{throw Object.assign(new Error('请检查模型 ID、名称、单价、上下文长度和排序'),{statusCode:400});};
    const id=String(input.id||'').trim(), label=String(input.label||textModelName(id)).trim();
    if(!/^[A-Za-z0-9][\w./:@+-]{0,199}$/.test(id)||!label||label.length>120)bad();
    const contextWindow=Number(input.contextWindow??256000),sortOrder=Number(input.sortOrder??0);
    if(!Number.isSafeInteger(contextWindow)||contextWindow<8192||contextWindow>2000000||!Number.isSafeInteger(sortOrder)||Math.abs(sortOrder)>100000)bad();
    if(typeof input.enabled!=='boolean')bad();
    const prices={};for(const name of ['inputYuanPerMillion','outputYuanPerMillion','cacheReadYuanPerMillion','cacheCreationYuanPerMillion']){const raw=input[name]??input.inputYuanPerMillion;if(typeof raw!=='number')bad();prices[name]=raw;if(!Number.isFinite(prices[name])||prices[name]<0||prices[name]>100000)bad();}
    return {id,label,contextWindow,sortOrder,enabled:input.enabled,...prices,iconKey:textModelIcon(id,label)};
  }
  function save(input,expectedVersion){return transaction(()=>{const current=get();if(expectedVersion!==current.version)throw Object.assign(new Error('配置已更新，请刷新后重试'),{statusCode:409});if(!Array.isArray(input)||input.length>500)throw Object.assign(new Error('模型列表无效'),{statusCode:400});const items=input.map(value=>{const item=normalize(value),old=current.items.find(row=>row.id===item.id);return {...item,testedAt:old?.testedAt||null};});if(new Set(items.map(i=>i.id)).size!==items.length)throw Object.assign(new Error('模型 ID 不能重复'),{statusCode:400});const result={version:current.version+1,items:items.sort((a,b)=>a.sortOrder-b.sortOrder||a.id.localeCompare(b.id))};write(key,JSON.stringify(result));return result;});}
  function recordTest(id,expectedVersion,passed){return transaction(()=>{
    const current=get();
    if(current.version!==expectedVersion)throw Object.assign(new Error('配置已更新，请刷新后重试'),{statusCode:409});
    const item=current.items.find(row=>row.id===id);
    if(!item)throw Object.assign(new Error('模型不存在，请刷新后重试'),{statusCode:404});
    item.testedAt=passed?new Date().toISOString():null;
    delete item.confirmedAt;
    current.version++;write(key,JSON.stringify(current));return current;
  });}
  return {get,save,recordTest,seed(models,rates){if(get().version)return;const items=models.map((m,index)=>normalize({...m,label:textModelName(m.id),enabled:true,sortOrder:index,contextWindow:m.contextWindow||256000,...Object.fromEntries(['inputYuanPerMillion','outputYuanPerMillion','cacheReadYuanPerMillion','cacheCreationYuanPerMillion'].map(k=>[k,rates[k]]))}));save(items,0);},list(){return get().items.filter(i=>i.enabled&&i.testedAt);},rates(model,base){const item=get().items.find(i=>i.id===model);if(!item)throw new Error('所选对话模型不可用');return llmRatesFromEnv({YUAN_PER_CREDIT:base.yuanPerCredit,LLM_INPUT_PRICE_YUAN_PER_MILLION:item.inputYuanPerMillion,LLM_OUTPUT_PRICE_YUAN_PER_MILLION:item.outputYuanPerMillion,LLM_CACHE_READ_PRICE_YUAN_PER_MILLION:item.cacheReadYuanPerMillion,LLM_CACHE_CREATION_PRICE_YUAN_PER_MILLION:item.cacheCreationYuanPerMillion});}};
}
export const textModels=createTextModelCatalog();
