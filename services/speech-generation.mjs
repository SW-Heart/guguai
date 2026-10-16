import { getMinimaxSystemVoices } from '../providers/minimax-speech.mjs';
import { creditsToMicro } from '../lib/billing.mjs';
import { modelPrice } from '../lib/pricing.mjs';
import { speechModels,speechDesignModel,speechPreviewModel,speechEmotions,systemVoices,speechCharacters } from '../public/features/speech/catalog.js';
const bad=message=>Object.assign(new Error(message),{statusCode:400});
export function validateSpeechInput(input) {
  const speechMode=input.speechMode||'tts';
  if(!['tts','design'].includes(speechMode))throw bad('请选择文字配音或音色设计');
  const modelId=String(input.modelId||'');
  if(speechMode==='design'?modelId!==speechDesignModel.id:!speechModels.some(model=>model.id===modelId))throw bad('请选择可用的语音模型');
  const prompt=String(input.prompt||'').trim();
  if(!prompt||Array.from(prompt).length>(speechMode==='design'?2000:4000))throw bad(speechMode==='design'?'请填写声音描述，最多 2000 字':'请填写配音文本，最多 4000 字');
  const previewText=String(input.previewText||'').trim();
  if(speechMode==='design'&&(!previewText||previewText.length>500))throw bad('请填写试听文本，最多 500 个字符');
  const speed=Number(input.speed??1),emotion=String(input.emotion||'auto');
  if(!Number.isFinite(speed)||speed<.5||speed>2)throw bad('语速需在 0.5 到 2 之间');
  if(!Object.hasOwn(speechEmotions,emotion))throw bad('请选择支持的情绪');
  if(input.referenceAssetIds?.length)throw bad('语音生成暂不支持参考录音');
  return {speechMode,modelId,prompt,previewText,speed,emotion,voiceId:String(input.voiceId||''),voiceName:String(input.voiceName||'我的音色').trim().slice(0,40)||'我的音色'};
}
export function speechQuote(input,pricing,{activateVoice=false}={}) {
  const request=validateSpeechInput(input),design=request.speechMode==='design';
  const model=design?speechPreviewModel:speechModels.find(model=>model.id===request.modelId);
  const characters=speechCharacters(design?request.previewText:request.prompt);
  const unitMicro=creditsToMicro(modelPrice(pricing,model.id,'标准',model.creditsPerTenThousand));
  const textCostMicro=Math.round(unitMicro*characters/10000);
  const voiceCostMicro=activateVoice?creditsToMicro(modelPrice(pricing,speechDesignModel.id,'标准',speechDesignModel.creditsPerVoice)):0;
  const costMicro=textCostMicro+voiceCostMicro;
  return {request,characters,credits:costMicro/1e6,costMicro,textCredits:textCostMicro/1e6,voiceCredits:voiceCostMicro/1e6,activateVoice,priceVersion:`speech-${pricing.version}-${model.id}-${unitMicro}-${voiceCostMicro}`,snapshot:{version:pricing.version,contentType:'audio',billingUnit:'character',unitPriceMicro:unitMicro,unitPrice:unitMicro/1e6,quantity:characters,characters,textCostMicro,voiceCostMicro,totalMicro:costMicro,total:costMicro/1e6}};
}
export function createSpeechService({sql,currentPricing,configured=()=>Boolean(process.env.MINIMAX_API_KEY),designEnabled=()=>false,loadSystemVoices=getMinimaxSystemVoices,clock=Date.now}) {
  let availableSystemVoices=systemVoices,refreshedAt=-Infinity,refreshing=null;
  async function refreshVoices(){
    if(clock()-refreshedAt<15*60*1000)return;
    if(!refreshing)refreshing=(async()=>{try{const rows=await loadSystemVoices();if(rows?.length)availableSystemVoices=rows;}catch{/* The bundled official catalog keeps voices usable when refresh fails. */}finally{refreshedAt=clock();refreshing=null;}})();
    await refreshing;
  }
  const ownVoice=(userId,id)=>sql('SELECT * FROM speech_voices WHERE user_id=:userId AND id=:id').get({userId,id});
  function voice(userId,id) {const system=availableSystemVoices.find(v=>v.id===id);if(system)return system.id;const row=ownVoice(userId,id);if(!row)throw bad('这个音色不可用，请重新选择');return row.provider_voice_id;}
  function voices(userId) {return [...availableSystemVoices,...sql('SELECT id,name,description,activated_at FROM speech_voices WHERE user_id=:userId ORDER BY created_at DESC').all({userId}).map(({activated_at,...row})=>({...row,type:'custom',activated:Boolean(activated_at)}))];}
  function quote(userId,input) {
    if(!configured())throw Object.assign(new Error('语音服务暂不可用，请稍后重试'),{statusCode:503});
    if(input.speechMode==='design'&&!designEnabled())throw Object.assign(new Error('音色设计暂未开放'),{statusCode:403});
    const request=validateSpeechInput(input);let activateVoice=false;
    if(request.speechMode==='tts'){
      voice(userId,request.voiceId);const row=ownVoice(userId,request.voiceId);
      if(row&&!row.activated_at){
        if(row.activation_generation_id&&row.activation_generation_id!==input.requestId)throw Object.assign(new Error('这个音色正在首次使用，请完成后再试'),{statusCode:409});
        activateVoice=true;
      }
    }
    return speechQuote(input,currentPricing(),{activateVoice});
  }
  function reserveVoice(userId,task) {
    if(!task.activateVoice)return;
    const result=sql("UPDATE speech_voices SET activation_generation_id=:generationId WHERE id=:id AND user_id=:userId AND activated_at IS NULL AND (activation_generation_id IS NULL OR activation_generation_id=:generationId)").run({id:task.voiceId,userId,generationId:task.id});
    if(result.changes!==1)throw Object.assign(new Error('音色费用已变化，请重新确认后生成'),{statusCode:409});
  }
  function activateVoice(userId,task) {if(task.speechMode==='tts')sql('UPDATE speech_voices SET activated_at=COALESCE(activated_at,:at),activation_generation_id=NULL WHERE id=:id AND user_id=:userId').run({id:task.voiceId,userId,at:new Date().toISOString()});}
  function releaseVoice(userId,task) {sql('UPDATE speech_voices SET activation_generation_id=NULL WHERE id=:id AND user_id=:userId AND activation_generation_id=:generationId AND activated_at IS NULL').run({id:task.voiceId||'',userId,generationId:task.id});}
  function saveVoice(userId,task,providerVoiceId) {const id=`voice-${task.id}`;sql(`INSERT INTO speech_voices(id,user_id,provider_voice_id,name,description,generation_id,created_at) VALUES(:id,:userId,:providerVoiceId,:name,:description,:generationId,:createdAt) ON CONFLICT(generation_id) DO NOTHING`).run({id,userId,providerVoiceId,name:task.voiceName,description:task.prompt,generationId:task.id,createdAt:task.createdAt});return id;}
  return {voice,voices,refreshVoices,quote,saveVoice,reserveVoice,activateVoice,releaseVoice};
}
