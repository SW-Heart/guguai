import { agentConfig } from './agent/gateway.mjs';

function replyText(choice) {
  const content=choice?.message?.content??choice?.delta?.content;
  if(typeof content==='string')return content;
  if(Array.isArray(content))return content.map(part=>typeof part?.text==='string'?part.text:'').join('');
  return '';
}

// Availability is determined by an actual reply. Billing metadata is checked by
// the conversation gateway and is not a requirement for this short admin test.
export async function testTextModel(item, { config = agentConfig(), fetchImpl = fetch } = {}) {
  if (!config.apiKey || config.baseUrl === '/v1') return { passed:false, message:'测试失败：请先配置对话服务地址和密钥' };
  let status;
  try {
    const response=await fetchImpl(`${config.baseUrl}/chat/completions`,{
      method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:item.id,messages:[{role:'user',content:'请直接简短回复：你好。'}],max_tokens:2048,stream:false}),
      signal:AbortSignal.timeout(60000),
    });
    status=response.status;
    if(!response.ok)throw new Error('HTTP_ERROR');
    const raw=(await response.text()).trim();
    let content='';
    // Some compatible services return SSE even when stream:false is requested.
    if(raw.startsWith('data:')||raw.startsWith(':')||(response.headers.get('content-type')||'').includes('text/event-stream')){
      for(const line of raw.split(/\r?\n/)){
        if(!line.startsWith('data:'))continue;
        const data=line.slice(5).trim();
        if(!data||data==='[DONE]')continue;
        const chunk=JSON.parse(data);
        if(chunk.error)throw new Error('MODEL_ERROR');
        content+=replyText(chunk.choices?.[0]);
      }
    }else{
      const data=JSON.parse(raw);
      if(data.error)throw new Error('MODEL_ERROR');
      content=replyText(data.choices?.[0]);
    }
    if(!content.trim())return {passed:false,message:'测试失败：模型没有返回文字回复，请重试'};
    return {passed:true,message:item.enabled?'测试成功，模型已可用':'测试成功，启用后即可展示'};
  } catch(error) {
    const statuses={400:'模型不接受测试请求，请检查模型 ID 或服务配置',401:'密钥验证失败，请检查对话服务密钥',403:'当前密钥无权使用此模型',404:'未找到模型或对话接口，请检查模型 ID 和服务地址',429:'请求受限或额度不足，请检查服务额度后重试'};
    let reason=statuses[status];
    if(!reason&&status>=500)reason=`对话服务暂时不可用（${status}），请稍后重试`;
    const codes=[error.name,error.cause?.name,error.cause?.code,error.cause?.cause?.code];
    if(!reason&&codes.some(code=>['TimeoutError','AbortError','UND_ERR_CONNECT_TIMEOUT'].includes(code)))reason='等待模型回复超时，请稍后重试';
    if(!reason&&codes.includes('ENOTFOUND'))reason='无法解析对话服务地址，请检查地址和网络';
    if(!reason&&error instanceof SyntaxError)reason='对话服务没有返回有效的回复，请检查服务地址后重试';
    if(!reason&&error.message==='MODEL_ERROR')reason='对话服务拒绝了此次请求，请检查模型权限和服务额度';
    return {passed:false,message:`测试失败：${reason||'无法连接对话服务，请检查网络后重试'}`};
  }
}
