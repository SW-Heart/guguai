export function decodeSpeechAudio(value) {
  if (typeof value !== 'string' || !value.length || value.length > 80_000_000 || value.length % 2 || !/^[a-f0-9]+$/i.test(value)) throw new Error('语音生成未返回可播放的音频，请重试');
  return Buffer.from(value,'hex');
}
export async function minimaxSpeechRequest(endpoint, payload, {apiKey=process.env.MINIMAX_API_KEY,fetchImpl=fetch}={}) {
  if (!apiKey) throw new Error('语音服务暂不可用，请稍后重试');
  const response=await fetchImpl(`https://api.minimax.cn/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(180000)});
  if(!response.ok) throw new Error('语音服务暂时繁忙，请稍后重试');
  const data=await response.json();
  if(data.base_resp?.status_code!==0) throw new Error('语音未能生成，请检查文本或更换音色后重试');
  return data;
}
export async function generateMinimaxSpeech(task,providerVoiceId,options={}) {
  if(task.speechMode==='design') {
    const data=await minimaxSpeechRequest('voice_design',{prompt:task.prompt,preview_text:task.previewText,voice_id:`gugu-${task.id}`},options);
    if(!data.voice_id) throw new Error('音色未能生成，请重试');
    return {data:decodeSpeechAudio(data.trial_audio),providerVoiceId:data.voice_id,format:'mp3'};
  }
  const voice_setting={voice_id:providerVoiceId,speed:task.speed,vol:1,pitch:0};
  if(task.emotion!=='auto') voice_setting.emotion=task.emotion;
  const data=await minimaxSpeechRequest('t2a_v2',{model:task.modelId,text:task.prompt,stream:false,voice_setting,audio_setting:{format:'wav',sample_rate:32000,channel:1},output_format:'hex',language_boost:'auto'},options);
  return {data:decodeSpeechAudio(data.data?.audio),format:'wav',durationSeconds:Number(data.extra_info?.audio_length)/1000||0,usageCharacters:Number(data.extra_info?.usage_characters)||0};
}

export function normalizeSystemVoices(rows) {
  const voices=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    const id=typeof row?.voice_id==='string'?row.voice_id.trim():'';
    if(!id||id.length>256||voices.has(id))continue;
    voices.set(id,{id,name:String(row.voice_name||id).slice(0,200),description:(Array.isArray(row.description)?row.description.filter(item=>typeof item==='string').join('；'):String(row.description||'')).slice(0,1000),type:'system'});
  }
  return [...voices.values()];
}
export async function getMinimaxSystemVoices({apiKey=process.env.MINIMAX_API_KEY,fetchImpl=fetch}={}) {
  if(!apiKey)return [];
  const response=await fetchImpl('https://api.minimax.cn/v1/get_voice',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({voice_type:'system'}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('音色列表暂时无法更新');
  const data=await response.json();
  if(data.base_resp?.status_code!==0)throw new Error('音色列表暂时无法更新');
  const voices=normalizeSystemVoices(data.system_voice);
  if(!voices.length)throw new Error('音色列表暂时无法更新');
  return voices;
}
