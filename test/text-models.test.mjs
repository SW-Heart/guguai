import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTextModelCatalog,OFFICIAL_TEXT_MODEL_PRICES } from '../lib/text-models.mjs';
import { agentConfig,createAgentGateway } from '../lib/agent/gateway.mjs';
import { llmRatesFromEnv,llmCostMicro } from '../lib/billing.mjs';
import { textModelName,textModelIcon,textModelLogoMarkup } from '../public/features/assistant/text-models.js';
const row=(id,more={})=>({id,label:textModelName(id),enabled:true,sortOrder:0,contextWindow:256000,inputYuanPerMillion:3,outputYuanPerMillion:6,cacheReadYuanPerMillion:1,cacheCreationYuanPerMillion:3,...more});
function fixture(){let saved;return createTextModelCatalog({read:()=>saved,write:(_k,v)=>{saved=v;},transaction:fn=>fn()});}
test('text catalog persists editable names, prices, windows and order, with version conflict protection',()=>{
 const c=fixture();c.save([row('gpt-4o',{sortOrder:20}),row('deepseek-v4-pro',{sortOrder:10}),row('hidden',{enabled:false})],0);
 assert.deepEqual(c.list(),[]);
 assert.equal(c.get().items.find(i=>i.id==='deepseek-v4-pro').label,'DeepSeek V4 Pro');
 assert.throws(()=>c.save([],0),{statusCode:409});
 assert.throws(()=>c.save([row('same'),row('same')],1),{statusCode:400});
 for(const changed of [{inputYuanPerMillion:-1},{outputYuanPerMillion:Infinity},{contextWindow:12},{sortOrder:0.2},{enabled:'yes'}])assert.throws(()=>c.save([row('bad',changed)],1),{statusCode:400});
 assert.equal(c.get().version,1);
 c.seed([{id:'old-env'}],llmRatesFromEnv());assert.equal(c.get().version,1);
});
test('models seeded from the existing setup stay available to creative and assistant chats',async()=>{
 const c=fixture();c.seed([{id:'deepseek-v4-flash',contextWindow:1000000}],llmRatesFromEnv());
 assert.deepEqual(c.list().map(i=>i.id),['deepseek-v4-flash']);
 const gateway=createAgentGateway({config:agentConfig({AGENT_MODEL:'old-env'}),catalog:()=>c.list()});
 assert.equal(gateway.config.model,'deepseek-v4-flash');
 assert.ok(c.rates(gateway.config.model,llmRatesFromEnv()).inputMicroPerToken>0);
 c.save([...c.get().items,row('new-model')],c.get().version);
 assert.equal(c.get().items.find(i=>i.id==='new-model').testedAt,null);
 c.recordTest('deepseek-v4-flash',c.get().version,false);
 assert.deepEqual(c.list(),[]);
});
test('seeded DeepSeek models default to official peak prices and other models keep the configured price',()=>{
 const c=fixture(),base=llmRatesFromEnv();
 c.seed([{id:'deepseek-v4-pro'},{id:'deepseek-flash'},{id:'deepseek-v4-flash'},{id:'other-model'}],base);
 const price=id=>{const {inputYuanPerMillion,outputYuanPerMillion,cacheReadYuanPerMillion,cacheCreationYuanPerMillion}=c.get().items.find(i=>i.id===id);return {inputYuanPerMillion,outputYuanPerMillion,cacheReadYuanPerMillion,cacheCreationYuanPerMillion};};
 assert.deepEqual(price('deepseek-v4-pro'),{inputYuanPerMillion:9,outputYuanPerMillion:27,cacheReadYuanPerMillion:0.3,cacheCreationYuanPerMillion:9});
 assert.deepEqual(price('deepseek-flash'),{inputYuanPerMillion:2,outputYuanPerMillion:8,cacheReadYuanPerMillion:0.04,cacheCreationYuanPerMillion:2});
 assert.deepEqual(price('deepseek-v4-flash'),price('deepseek-flash'));
 assert.deepEqual(price('other-model'),{inputYuanPerMillion:base.inputYuanPerMillion,outputYuanPerMillion:base.outputYuanPerMillion,cacheReadYuanPerMillion:base.cacheReadYuanPerMillion,cacheCreationYuanPerMillion:base.cacheCreationYuanPerMillion});
 assert.ok(Object.isFrozen(OFFICIAL_TEXT_MODEL_PRICES));
 assert.ok(c.rates('deepseek-flash',base).cacheReadMicroPerToken>0);
});
test('gateway uses the admin catalog and applies live order, availability and context without env model discovery',async()=>{
 const c=fixture();c.save([row('gpt-4o')],0);
 c.recordTest('gpt-4o',c.get().version,true);
 const gateway=createAgentGateway({config:agentConfig({AGENT_MODEL:'old-env'}),catalog:()=>c.list(),fetchImpl:async()=>{throw new Error('must not discover env models');}});
 assert.equal(gateway.config.model,'gpt-4o');assert.equal(await gateway.contextWindow('gpt-4o'),256000);
 c.save([row('deepseek-v4-pro',{contextWindow:512000}),row('gpt-4o',{enabled:false})],c.get().version);
 c.recordTest('deepseek-v4-pro',c.get().version,true);
 assert.equal(gateway.config.model,'deepseek-v4-pro');assert.equal(await gateway.contextWindow('deepseek-v4-pro'),512000);
 await assert.rejects(gateway.contextWindow('gpt-4o'),/不可用/);
});
test('per-model prices include fractional and free rates and preserve the captured quote across updates',()=>{
 const c=fixture(),base=llmRatesFromEnv();
 c.save([row('gpt-4o',{inputYuanPerMillion:.01,outputYuanPerMillion:0,cacheReadYuanPerMillion:0})],0);
 const captured=c.rates('gpt-4o',base);
 assert.equal(llmCostMicro(1000000,1000000,captured),100000);
 c.save([row('gpt-4o',{inputYuanPerMillion:10})],1);
 assert.equal(llmCostMicro(1000000,1000000,captured),100000);
 assert.notEqual(c.rates('gpt-4o',base).inputMicroPerToken,captured.inputMicroPerToken);
});
test('brand names remain readable and matching logos exist with safe fallback',()=>{
 assert.equal(textModelName('gpt-4o-mini'),'GPT 4o Mini');
 assert.equal(textModelName('deepseek-v4-pro'),'DeepSeek V4 Pro');
 for(const id of ['deepseek-v4-pro','claude-sonnet','gpt-4o','gemini-flash','qwen-3','grok','minimax','kimi','glm']){
  const icon=textModelIcon(id);assert.ok(icon,id);for(const suffix of ['', '-dark'])assert.ok(existsSync(new URL(`../public/icons/models/${icon}${suffix}.svg`,import.meta.url)),icon);
 }
 assert.match(textModelLogoMarkup('unknown'),/<svg/);
 assert.doesNotMatch(textModelLogoMarkup('<script>'),/<script>/);
});

test('text-model frontend cache chains include their versioned imports and admin entry',async()=>{
 const {readFile}=await import('node:fs/promises');
 const read=name=>readFile(new URL('../public/'+name,import.meta.url),'utf8');
 assert.match(await read('guguadmin.html'),/guguadmin.js\?v=78/);
 assert.match(await read('guguadmin.html'),/guguadmin.css\?v=39/);
 assert.match(await read('guguadmin.js'),/features\/admin\/text-models.js\?v=5/);
 assert.match(await read('features/admin/text-models.js'),/text-models.js\?v=2/);
 assert.match(await read('features/assistant/model-picker.js'),/text-models.js\?v=2/);
 assert.match(await read('features/drama/director-workspace.js'),/text-models.js\?v=2/);
});

test('text models use the original colored brand assets in both themes',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const [id,color] of [['deepseek','#4D6BFE'],['claude','#D97757'],['kimi','#1783FF'],['glm','#3859FF']]){
  const key=textModelIcon(id);
  assert.ok(key.endsWith('-color'));
  for(const suffix of ['', '-dark']){
   const svg=await readFile(new URL(`../public/icons/models/${key}${suffix}.svg`,import.meta.url),'utf8');
   assert.ok(svg.toLowerCase().includes(color.toLowerCase()),id);
  }
 }
 assert.equal(textModelIcon('gpt-4o'),'openai');
 assert.equal(textModelIcon('grok'),'grok');
});

test('one successful test immediately makes an enabled model available without trusting submitted status',()=>{
 const c=fixture();
 c.save([row('model',{testedAt:'forged',confirmedAt:'forged'})],0);
 assert.deepEqual(c.list(),[]);
 c.recordTest('model',1,true);
 assert.equal(c.list().length,1);
 c.save([row('model',{label:'新名称',sortOrder:10,inputYuanPerMillion:4})],2);
 assert.equal(c.list().length,1);
 c.save([row('renamed-model',{testedAt:'forged'})],3);
 assert.deepEqual(c.list(),[]);
 c.recordTest('renamed-model',4,true);
 c.recordTest('renamed-model',5,false);
 assert.deepEqual(c.list(),[]);
 assert.throws(()=>c.recordTest('renamed-model',5,true),{statusCode:409});
 c.recordTest('renamed-model',6,true);
 c.save([row('renamed-model',{enabled:false})],7);
 assert.deepEqual(c.list(),[]);
 c.save([row('renamed-model')],8);
 assert.equal(c.list().length,1);
 c.save([],9);c.save([row('renamed-model')],10);
 assert.deepEqual(c.list(),[]);
});
