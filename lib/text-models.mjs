import { readMeta, writeMeta, tx } from './db.mjs';
import { llmRatesFromEnv } from './billing.mjs';
import { textModelName, textModelIcon } from '../public/features/assistant/text-models.js';
// Official list prices per million tokens, checked 2026-11-16. Sources:
// DeepSeek https://api-docs.deepseek.com/zh-cn/quick_start/pricing (CNY, peak hours; off-peak
// is half price, so seeding at peak never charges below cost),
// Kimi https://platform.kimi.com (CNY), Zhipu https://bigmodel.cn/pricing (CNY, list price
// after the launch discount ended), Anthropic / OpenAI / Google / xAI official pricing pages (USD).
// USD prices convert at USD_CNY_RATE (PBOC central parity, about 6.72 in November 2026).
// Providers without a cache write fee bill cache writes as uncached input. OpenAI and xAI
// charge more beyond 272K / 200K prompt tokens; these are the standard-context prices.
// The legacy deepseek-v4-flash name is now served and billed as deepseek-flash.
export const USD_CNY_RATE=6.72;
const yuan=value=>Math.round(value*USD_CNY_RATE*10000)/10000;
const usd=(input,output,cacheRead,cacheCreation=input)=>({inputYuanPerMillion:yuan(input),outputYuanPerMillion:yuan(output),cacheReadYuanPerMillion:yuan(cacheRead),cacheCreationYuanPerMillion:yuan(cacheCreation)});
const cny=(input,output,cacheRead,cacheCreation=input)=>({inputYuanPerMillion:input,outputYuanPerMillion:output,cacheReadYuanPerMillion:cacheRead,cacheCreationYuanPerMillion:cacheCreation});
const deepseekFlash=cny(2,8,0.04);
export const OFFICIAL_TEXT_MODEL_PRICES=Object.freeze({
  'deepseek-flash':deepseekFlash,
  'deepseek-v4-flash':deepseekFlash,
  'deepseek-v4-pro':cny(9,27,0.3),
  'claude-opus-5-5-kiro':usd(4,20,0.2,5),
  'claude-sonnet-5-kiro':usd(2,10,0.2,2.5),
  // Google doubles Gemini 4 Argon to $4 / $20 / $0.20 from 2026-12-01.
  'gemini-4-argon':usd(2,10,0.1),
  'gpt-6-astra':usd(10,50,1),
  'gpt-6-sol':usd(2,10,0.2),
  'gpt-6.1-sol':usd(2,10,0.1),
  'gpt-6-luna':usd(0.1,0.5,0.01),
  'gpt-5.6-sol':usd(4,20,0.4),
  'grok-4.7':usd(2,6,0.5),
  'glm-5.3-flash':cny(0.8,2.8,0.23),
  'kimi-k3':cny(20,100,2),
});
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
  function save(input,expectedVersion,testedAt=null){return transaction(()=>{const current=get();if(expectedVersion!==current.version)throw Object.assign(new Error('配置已更新，请刷新后重试'),{statusCode:409});if(!Array.isArray(input)||input.length>500)throw Object.assign(new Error('模型列表无效'),{statusCode:400});const items=input.map(value=>{const item=normalize(value),old=current.items.find(row=>row.id===item.id);return {...item,testedAt:old?.testedAt||testedAt};});if(new Set(items.map(i=>i.id)).size!==items.length)throw Object.assign(new Error('模型 ID 不能重复'),{statusCode:400});const result={version:current.version+1,items:items.sort((a,b)=>a.sortOrder-b.sortOrder||a.id.localeCompare(b.id))};write(key,JSON.stringify(result));return result;});}
  function recordTest(id,expectedVersion,passed){return transaction(()=>{
    const current=get();
    if(current.version!==expectedVersion)throw Object.assign(new Error('配置已更新，请刷新后重试'),{statusCode:409});
    const item=current.items.find(row=>row.id===id);
    if(!item)throw Object.assign(new Error('模型不存在，请刷新后重试'),{statusCode:404});
    item.testedAt=passed?new Date().toISOString():null;
    delete item.confirmedAt;
    current.version++;write(key,JSON.stringify(current));return current;
  });}
  // Seeded models were already serving users, so they stay available until an
  // administrator retests or disables them.
  return {get,save,recordTest,seed(models,rates){if(get().version)return;const items=models.map((m,index)=>normalize({...m,label:textModelName(m.id),enabled:true,sortOrder:index,contextWindow:m.contextWindow||256000,...Object.fromEntries(['inputYuanPerMillion','outputYuanPerMillion','cacheReadYuanPerMillion','cacheCreationYuanPerMillion'].map(k=>[k,rates[k]])),...OFFICIAL_TEXT_MODEL_PRICES[m.id]}));save(items,0,new Date().toISOString());},list(){return get().items.filter(i=>i.enabled&&i.testedAt);},rates(model,base){const item=get().items.find(i=>i.id===model);if(!item)throw new Error('所选对话模型不可用');return llmRatesFromEnv({YUAN_PER_CREDIT:base.yuanPerCredit,LLM_INPUT_PRICE_YUAN_PER_MILLION:item.inputYuanPerMillion,LLM_OUTPUT_PRICE_YUAN_PER_MILLION:item.outputYuanPerMillion,LLM_CACHE_READ_PRICE_YUAN_PER_MILLION:item.cacheReadYuanPerMillion,LLM_CACHE_CREATION_PRICE_YUAN_PER_MILLION:item.cacheCreationYuanPerMillion});}};
}
export const textModels=createTextModelCatalog();
