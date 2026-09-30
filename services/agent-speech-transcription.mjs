const ENDPOINT='https://api.deepgram.com/v1/listen';
const MODEL='nova-3';

const rounded=value=>Math.round(value*1000)/1000;
const confidence=value=>Number.isFinite(value)?Math.max(0,Math.min(1,value)):null;
const wordText=word=>String(word.punctuated_word||word.word||'').trim().slice(0,120);

function captionText(words){
  let text='';
  for(const word of words){
    const value=word.text;
    text+=text&&/[A-Za-z0-9]$/.test(text)&&/^[A-Za-z0-9]/.test(value)?` ${value}`:value;
  }
  return text;
}

function captionCues(words){
  const cues=[];
  let group=[];
  const flush=()=>{
    if(!group.length)return;
    cues.push({startSeconds:group[0].startSeconds,endSeconds:group.at(-1).endSeconds,text:captionText(group),speaker:group[0].speaker});
    group=[];
  };
  for(const word of words){
    const previous=group.at(-1);
    if(previous&&(word.startSeconds-previous.endSeconds>0.75||word.speaker!==previous.speaker||word.endSeconds-group[0].startSeconds>4||captionText([...group,word]).length>32))flush();
    group.push(word);
    if(/[。！？!?]$/.test(word.text))flush();
  }
  flush();
  return cues.slice(0,500);
}

export async function transcribeDeepgramAudio(audio,{apiKey=process.env.DEEPGRAM_API_KEY,language='zh-CN'}={}){
  if(!apiKey)throw new Error('语音识别服务尚未配置');
  const url=new URL(ENDPOINT);
  for(const [key,value] of Object.entries({model:MODEL,language,smart_format:'true',utterances:'true',diarize_model:'latest'}))url.searchParams.set(key,value);
  let response;
  try{
    response=await fetch(url,{method:'POST',headers:{Authorization:`Token ${apiKey}`,'Content-Type':'audio/mpeg'},body:audio.data,signal:AbortSignal.timeout(300000)});
  }catch(error){throw new Error(error.name==='TimeoutError'?'语音识别超时，请缩短识别范围后重试':'语音识别服务暂时无法连接');}
  if(!response.ok){
    if([401,403].includes(response.status))throw new Error('语音识别服务密钥无效或没有使用权限');
    if(response.status===429)throw new Error('语音识别服务当前繁忙，请稍后重试');
    throw new Error(`语音识别暂时失败（${response.status}）`);
  }
  const body=await response.text();
  if(body.length>3_000_000)throw new Error('语音识别结果过长，请缩短识别范围');
  let result;
  try{result=JSON.parse(body);}catch{throw new Error('语音识别结果无法读取');}
  const alternative=result?.results?.channels?.[0]?.alternatives?.[0];
  if(!alternative||!Array.isArray(alternative.words))throw new Error('语音识别没有返回可用的时间信息');
  const words=alternative.words.slice(0,10000).map(item=>{
    const start=audio.startSeconds+Number(item.start),end=audio.startSeconds+Number(item.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||start<audio.startSeconds-0.1||start>audio.endSeconds||end>audio.endSeconds+1)return null;
    const text=wordText(item);
    if(!text)return null;
    return {text,startSeconds:rounded(Math.max(audio.startSeconds,start)),endSeconds:rounded(Math.min(audio.endSeconds,end)),confidence:confidence(item.confidence),speaker:Number.isInteger(item.speaker)?item.speaker:null,speakerConfidence:confidence(item.speaker_confidence)};
  }).filter(Boolean);
  const utterances=(Array.isArray(result.results.utterances)?result.results.utterances:[]).slice(0,1000).map(item=>({text:String(item.transcript||'').trim().slice(0,2000),startSeconds:rounded(audio.startSeconds+Number(item.start)),endSeconds:rounded(audio.startSeconds+Number(item.end)),speaker:Number.isInteger(item.speaker)?item.speaker:null,confidence:confidence(item.confidence)})).filter(item=>item.text&&Number.isFinite(item.startSeconds)&&Number.isFinite(item.endSeconds)&&item.endSeconds>=item.startSeconds);
  const text=String(alternative.transcript||'').trim().slice(0,100000);
  return {modelId:MODEL,language,requestId:String(result.metadata?.request_id||'').slice(0,100),startSeconds:audio.startSeconds,endSeconds:audio.endSeconds,durationSeconds:audio.durationSeconds,text,words,utterances,cues:captionCues(words),hasSpeech:Boolean(words.length||text)};
}
