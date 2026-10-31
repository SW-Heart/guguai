import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testTextModel } from '../lib/text-model-test.mjs';
const config={baseUrl:'https://example.invalid/v1',apiKey:'private-key',configured:true,maxTokens:64000};
const item={id:'test-model',enabled:true};
const reply=(overrides={})=>new Response(JSON.stringify({choices:[{message:{content:'你好'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8},...overrides}),{headers:{'content-type':'application/json'}});
test('tests an unpublished model with a larger reply budget using the configured service',async()=>{
 let request;
 const result=await testTextModel(item,{config,fetchImpl:async(url,options)=>{request={url,...options};return reply();}});
 assert.equal(result.passed,true);
 assert.equal(request.url,config.baseUrl+'/chat/completions');
 const body=JSON.parse(request.body);
 assert.equal(body.model,item.id);assert.equal(body.max_tokens,2048);assert.equal(body.stream,false);assert.equal(body.stream_options,undefined);
});
test('reports actionable failures without exposing service responses or secrets',async()=>{
 for(const [status,reason] of [[400,'模型不接受'],[401,'密钥验证失败'],[403,'无权'],[404,'未找到'],[429,'额度'],[503,'503']]){
  const result=await testTextModel(item,{config,fetchImpl:async()=>new Response('private-key https://secret.invalid',{status})});
  assert.equal(result.passed,false);assert.ok(result.message.includes(reason));assert.doesNotMatch(result.message,/private-key|secret.invalid/);
 }
 for(const [error,reason] of [[Object.assign(new Error(),{name:'TimeoutError'}),'超时'],[Object.assign(new Error(),{cause:{code:'ENOTFOUND'}}),'无法解析']]){
  const result=await testTextModel(item,{config,fetchImpl:async()=>{throw error;}});assert.ok(result.message.includes(reason));
 }
});
test('accepts a real reply without billing usage, including compatible SSE responses',async()=>{
 const json=await testTextModel(item,{config,fetchImpl:async()=>reply({usage:null})});
 assert.equal(json.passed,true);assert.equal(json.message,'测试成功，模型已可用');
 for(const headers of [{'content-type':'text/event-stream'},{}]){
  const result=await testTextModel(item,{config,fetchImpl:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'思考'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:'你好'}}]})+'\n\ndata: [DONE]\n', {headers})});
  assert.equal(result.passed,true);
 }
});
test('missing configuration, empty replies, HTML and provider errors cannot pass',async()=>{
 assert.equal((await testTextModel(item,{config:{...config,apiKey:''}})).passed,false);
 for(const body of ['<html>error</html>',JSON.stringify({choices:[]}),JSON.stringify({error:{message:'private-key'}})]){
  const result=await testTextModel(item,{config,fetchImpl:async()=>new Response(body)});
  assert.equal(result.passed,false);assert.doesNotMatch(result.message,/private-key/);
 }
});
test('admin waits longer than the server probe deadline',async()=>{
 const source=await readFile(new URL('../public/features/admin/text-models.js',import.meta.url),'utf8');
 assert.match(source,/timeout:75000/);
});

test('admin has one test action and no second confirmation step',async()=>{
 const source=await readFile(new URL('../public/features/admin/text-models.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/data-text-confirm|确认可用|待确认|正在确认/);
});
