// Read-only live compatibility probe. Only synthetic prompts are sent; no user
// conversations or credentials are written into the report or console output.
import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {resolveDbFile} from '../../lib/db.mjs';
import {agentConfig,createAgentGateway} from '../../lib/agent/gateway.mjs';
const output=process.argv[2]||'/tmp/gugu-text-model-compatibility.json';
const db=new DatabaseSync(resolveDbFile(),{readOnly:true});
const catalog=JSON.parse(db.prepare('SELECT value FROM schema_meta WHERE key=?').get('text-model-catalog-v1').value);db.close();
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
const models=catalog.items.filter(m=>m.enabled&&(!only||only.split(',').includes(m.id)));
const config=agentConfig();config.configured=Boolean(config.apiKey&&config.baseUrl!=='/v1');
const report={startedAt:new Date().toISOString(),models:[],switches:[]};
if(process.argv.includes('--search-only')){
 const {searchAgentWeb}=await import('../../services/agent-web-search.mjs');
 try{const result=await searchAgentWeb({query:'人工智能 官方文档',maxResults:3});const check={checkedAt:new Date().toISOString(),passed:result.results.length>0,resultCount:result.results.length};await writeFile(output,JSON.stringify(check,null,2));console.log(JSON.stringify(check));process.exit(check.passed?0:1);}catch(error){const check={checkedAt:new Date().toISOString(),passed:false,error:error.message};await writeFile(output,JSON.stringify(check,null,2));console.log(JSON.stringify(check));process.exit(1);}
}

const probe={type:'function',function:{name:'compat_probe',description:'读取兼容性测试数字。用户要求时必须先调用此工具。',parameters:{type:'object',properties:{},required:[]}}};
let saveQueue=Promise.resolve();
const save=()=>{const body=JSON.stringify(report,null,2);saveQueue=saveQueue.then(()=>writeFile(output,body));return saveQueue;};
async function run(model,messages,tools=[probe]){
 const start=Date.now(),wires=[],diagnostics=[];
 const gateway=createAgentGateway({config:{...config},catalog:()=>models,fetchImpl:async(url,options)=>{
  const response=await fetch(url,{...options,...(process.argv.includes('--connection-close')?{headers:{...options.headers,Connection:'close'}}:{}),signal:AbortSignal.any([options.signal,AbortSignal.timeout(90000)])});
  const wire={status:response.status,contentType:response.headers.get('content-type')};wires.push(wire);
  diagnostics.push(response.clone().text().then(raw=>{
   const chunks=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')&&l.slice(5).trim()!=='[DONE]').flatMap(l=>{try{return [JSON.parse(l.slice(5))];}catch{return [];}});
   if(!chunks.length){try{chunks.push(JSON.parse(raw));}catch{}}
   Object.assign(wire,{done:raw.includes('[DONE]'),hasUsage:chunks.some(c=>c.usage),finishReasons:[...new Set(chunks.flatMap(c=>(c.choices||[]).map(x=>x.finish_reason).filter(Boolean)))],hasToolCalls:chunks.some(c=>c.choices?.some(x=>(x.delta||x.message)?.tool_calls?.length)),hasError:chunks.some(c=>Boolean(c.error)),errors:chunks.filter(c=>c.error).map(c=>({code:c.error.code,type:c.error.type,message:String(c.error.message||'').replaceAll(config.apiKey,'[redacted]').replace(/https?:\/\/\S+/g,'[service]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,300)}))});
  }).catch(()=>{}));return response;
 }});
 try{
  const result=await gateway.complete({model:model.id,messages,tools,maxTokens:Math.min(config.maxTokens,Math.floor(model.contextWindow/4))});
  await Promise.all(diagnostics);
  if(result.invalidOutput)throw new Error(result.invalidOutputReason);
  return {passed:true,elapsedMs:Date.now()-start,result,wires};
 }catch(error){await Promise.all(diagnostics);return {passed:false,elapsedMs:Date.now()-start,error:error.message,causeName:error.cause?.name,causeCode:error.cause?.cause?.code||error.cause?.code,wires};}
}
async function probeRun(...args){
 const attempts=[];
 for(let i=0;i<3;i++){
  const result=await run(...args);attempts.push({passed:result.passed,error:result.error,causeCode:result.causeCode});
  if(result.passed||result.wires.some(w=>[400,401,403,404,422].includes(w.status)))return {...result,attempts};
  if(i===2)return {...result,attempts};
 }
}
const summarize=result=>({attempts:result.attempts,passed:result.passed,elapsedMs:result.elapsedMs,error:result.error,causeName:result.causeName,causeCode:result.causeCode,wires:result.wires,usage:result.result?.usage});
async function checkModel(model){
 const entry={id:model.id,label:model.label,checks:{}};report.models.push(entry);
 const basic=await probeRun(model,[{role:'system',content:'这是兼容性测试，请简短作答，不输出思考过程。'},{role:'user',content:'请仅回复：OK。不要调用工具。'}],[]);entry.checks.stream=summarize(basic);if(basic.passed&&(!basic.result.message.content||basic.result.message.tool_calls?.length)){entry.checks.stream.passed=false;entry.checks.stream.error='未返回普通文字回复';}
 const tools=await probeRun(model,[{role:'user',content:'请先调用 compat_probe 工具获取数字，不要猜测数字。调用后等待结果。'}]);entry.checks.toolCall=summarize(tools);
 const calls=tools.result?.message.tool_calls;
 if(tools.passed&&calls?.length){
  const messages=[{role:'user',content:'请先调用 compat_probe 获取数字，然后简短复述结果。'},tools.result.message,...calls.map(call=>({role:'tool',tool_call_id:call.id,content:'{"number":37}'}))];
  const followup=await probeRun(model,messages);entry.checks.toolResult=summarize(followup);
  if(followup.passed&&followup.result.message.content&&!followup.result.message.tool_calls?.length)entry.switchHistory=[...messages,followup.result.message];
 }else if(tools.passed){entry.checks.toolCall.passed=false;entry.checks.toolCall.error='模型没有调用请求的工具';}
 console.log(JSON.stringify({model:model.id,checks:entry.checks}));await save();
}
for(let i=0;i<models.length;i+=2)await Promise.all(models.slice(i,i+2).map(checkModel));
const switches=report.models.flatMap((from,index)=>from.switchHistory?(process.argv.includes('--matrix')?models.filter(to=>to.id!==from.id):[models[(index+1)%models.length]].filter(to=>to.id!==from.id)).map(to=>({from,to})):[]);
async function checkSwitch({from,to}){
 const history=from.switchHistory.map(({reasoning_content,...message})=>message);
 const result=await probeRun(to,[...history,{role:'user',content:'上一段工具查询结果中的数字是什么？请仅回复数字。'}]);
 const correct=result.passed&&result.result.message.content?.includes('37');
 const entry={from:from.id,to:to.id,...summarize(result),passed:Boolean(correct),...(result.passed&&!correct?{error:'未正确承接工具历史'}:{})};
 report.switches.push(entry);console.log(JSON.stringify({switch:entry}));await save();
}
for(let i=0;i<switches.length;i+=2)await Promise.all(switches.slice(i,i+2).map(checkSwitch));
for(const entry of report.models)delete entry.switchHistory;
report.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({output,models:report.models.length,failed:report.models.filter(e=>Object.values(e.checks).some(c=>!c.passed)).map(e=>e.id),switches:report.switches.length,failedSwitches:report.switches.filter(e=>!e.passed).length}));
