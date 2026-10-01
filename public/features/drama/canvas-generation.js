import { modelLogoUrl } from '../../components/model-logo.js?v=1';
import { defaultVideoDuration } from '../generation/video-defaults.js?v=1';
const imageRatios=['1:1','3:4','4:3','9:16','16:9','3:2','2:3','1:2','2:1','5:4','4:5'];
const tuziDimensions={
  '1:1':['1024x1024','2048x2048','2880x2880'],'2:3':['816x1232','1360x2048','2352x3520'],
  '3:2':['1232x816','2048x1360','3520x2352'],'3:4':['880x1184','1552x2080','2336x3120'],
  '4:3':['1184x880','2080x1552','3120x2336'],'16:9':['1360x768','2048x1152','3536x1984'],
  '9:16':['768x1360','1152x2048','1984x3536'],'1:2':['720x1440','1024x2048','1920x3840'],
  '2:1':['1440x720','2048x1024','3840x1920'],'5:4':['1120x896','1920x1536','3200x2560'],
  '4:5':['896x1120','1536x1920','2560x3200'],
};
const fallbackImageModels=[{id:'gpt-image-2.5',label:'GPT Image 2.5'},{id:'gpt-image-2',label:'GPT-Image-2'},{id:'midjourney',label:'Midjourney'}];
const videoOrder=['minimax-h3-15s','seedance-2.0','seedance-2.5','oai','veo-31','grok','veo'];
export const canvasGenerationModeLabels={TEXT:'文生视频',REFERENCE:'参考素材','FIRST&LAST':'首尾帧'};
export const canvasGenerationModeDescriptions={TEXT:'只用文字描述生成视频',REFERENCE:'用图片、视频或音频作为参考','FIRST&LAST':'指定开始和结束的画面'};
export const canvasGenerationRatios=imageRatios;
// Same local, theme-aware brand icon set used by the workbench model pickers.
export function canvasGenerationModelIcon(modelId,iconKey=''){
  return modelLogoUrl(modelId,iconKey);
}
export function canvasGenerationQualityLabel(draft,value){
  if(draft?.type==='image'&&draft.modelId==='midjourney')return `质量 ${value}`;
  return ({low:'低画质',medium:'中画质',high:'高画质'})[value]||String(value??'').toUpperCase();
}
export function canvasGenerationFrameSize(type,aspect){
  const [wide,tall]=String(aspect||'1:1').split(':').map(Number),ratio=wide>0&&tall>0?wide/tall:1;
  const side=type==='image'?280:320;
  return ratio>=1?{width:side,height:Math.round(side/ratio)}:{width:Math.round(side*ratio),height:side};
}

export function canvasGenerationModels(type,config={}){
  if(type==='image')return (Array.isArray(config.imageModels)?config.imageModels:fallbackImageModels).filter(model=>model.enabled!==false&&model.availability!=='coming-soon');
  return (config.videoCapabilities?.models||[]).filter(model=>!['minimax-h3','seedance-2.0-fast'].includes(model.id)&&model.enabled!==false&&model.availability!=='coming-soon').map(model=>model.id==='grok'?{...model,modes:model.modes?.map(mode=>({...mode,durations:mode.durations?.filter(value=>Number(value)!==30)}))}:model).sort((a,b)=>(videoOrder.indexOf(a.id)<0?99:videoOrder.indexOf(a.id))-(videoOrder.indexOf(b.id)<0?99:videoOrder.indexOf(b.id)));
}

export function createCanvasGenerationDraft(type,config={}){
  const model=canvasGenerationModels(type,config).find(item=>item.availability!=='coming-soon');
  const mode=type==='video'?(model?.modes?.find(item=>item.generationType==='TEXT')||model?.modes?.[0]):null;
  const draft={id:`canvas-gen-${crypto.randomUUID()}`,type,prompt:'',modelId:model?.id||'',aspect:type==='image'?'1:1':mode?.aspectRatios?.includes('16:9')?'16:9':mode?.aspectRatios?.[0]||'',quality:type==='image'?'1k':mode?.qualityOptions?.[0]||'',mode:mode?.generationType||'',duration:0,quantity:1,attachments:[],midjourney:{version:'8.2',stylize:100,chaos:0,weird:0,seed:'',negativePrompt:'',imageWeight:1,raw:false,tile:false,draft:false},taskId:'',status:''};
  return type==='video'?reconcileCanvasGenerationDraft(draft,config,{resetDuration:true}):draft;
}

export function canvasGenerationOptions(draft,config={}){
  const model=canvasGenerationModels(draft.type,config).find(item=>item.id===draft.modelId);
  if(draft.type==='image')return {model,modes:[],parameters:null,aspects:imageRatios,qualities:draft.modelId==='midjourney'?['0.25','0.5','1','2','4']:draft.modelId==='gpt-image-2.5'?['1k','2k','4k']:['low','medium','high']};
  const modes=model?.modes||[];
  const base=modes.find(item=>item.generationType===draft.mode)||modes[0]||null;
  const quality=base?.qualityOptions?.includes(draft.quality)?draft.quality:base?.qualityOptions?.[0];
  const aspect=base?.aspectRatios?.includes(draft.aspect)?draft.aspect:base?.aspectRatios?.[0];
  const parameters=base?{...base,durations:base.durationsByQuality?.[quality]?.[aspect]||base.durations}:null;
  return {model,modes,parameters,aspects:parameters?.aspectRatios||[],qualities:parameters?.qualityOptions||[]};
}

export function reconcileCanvasGenerationDraft(draft,config={}, {resetDuration=false}={}){
  const previousModelId=draft.modelId;
  const models=canvasGenerationModels(draft.type,config);
  if(!models.some(item=>item.id===draft.modelId&&item.availability!=='coming-soon'))draft.modelId=models.find(item=>item.availability!=='coming-soon')?.id||'';
  const options=canvasGenerationOptions(draft,config);
  if(draft.type==='image'){
    if(!imageRatios.includes(draft.aspect))draft.aspect='1:1';
    if(!options.qualities.includes(draft.quality))draft.quality=options.qualities.includes('medium')?'medium':options.qualities.includes('1k')?'1k':'1';
    const midjourney=draft.modelId==='midjourney';
    draft.quantity=midjourney?(Number(draft.quantity)>=8?8:4):Math.max(1,Math.min(10,Math.round(Number(draft.quantity)||1)));
  }else{
    if(!options.modes.some(item=>item.generationType===draft.mode))draft.mode=options.modes.find(item=>item.generationType==='TEXT')?.generationType||options.modes[0]?.generationType||'';
    const mode=canvasGenerationOptions(draft,config).parameters;
    if(!mode?.aspectRatios?.includes(draft.aspect))draft.aspect=mode?.aspectRatios?.includes('16:9')?'16:9':mode?.aspectRatios?.[0]||'';
    if(resetDuration||draft.modelId!==previousModelId||!mode?.durations?.includes(Number(draft.duration)))draft.duration=defaultVideoDuration(draft.modelId,mode?.durations);
    if(!mode?.qualityOptions?.includes(draft.quality))draft.quality=mode?.qualityOptions?.[0]||'';
  }
  return draft;
}

export function canvasGenerationPayload(draft,config={}){
  reconcileCanvasGenerationDraft(draft,config);
  const prompt=String(draft.prompt||'').trim();
  if(!prompt)throw new Error('请填写画面描述');
  const limit=draft.type==='image'?5000:draft.modelId==='minimax-h3-15s'?10000:4096;
  if(Array.from(prompt).length>limit)throw new Error(`画面描述不能超过 ${limit} 个字符`);
  if(!draft.modelId)throw new Error('请先选择模型');
  const referenceAssetIds=draft.attachments.map(file=>file.id);
  if(draft.type==='image'){
    if(referenceAssetIds.length>7)throw new Error('参考图片最多添加 7 张');
    if(draft.modelId==='midjourney'){
      const options={...draft.midjourney,aspectRatio:draft.aspect,quality:draft.quality};
      return {type:'image',modelId:draft.modelId,prompt,size:draft.aspect,quality:draft.quality,quantity:draft.quantity,referenceAssetIds,midjourneyOptions:options};
    }
    const quality=draft.quality;
    const size=draft.modelId==='gpt-image-2.5'?tuziDimensions[draft.aspect]?.[['1k','2k','4k'].indexOf(quality)]:draft.aspect;
    return {type:'image',modelId:draft.modelId,prompt,size,quality,quantity:draft.quantity,referenceAssetIds};
  }
  const {parameters}=canvasGenerationOptions(draft,config);
  if(!parameters?.qualityOptions?.length)throw new Error('当前模型暂不可用，请选择其他模型');
  if(draft.mode==='TEXT'&&referenceAssetIds.length)throw new Error('文生视频不能添加参考素材');
  if(draft.mode==='REFERENCE'&&!referenceAssetIds.length)throw new Error('请添加参考素材');
  if(draft.mode==='REFERENCE'&&draft.attachments.filter(file=>file.kind==='image').length<Number(parameters.minImages||0))throw new Error('请添加参考图片');
  if(draft.mode==='FIRST&LAST'&&(!referenceAssetIds.length||draft.attachments.some(file=>file.kind!=='image')))throw new Error('首尾帧只能使用图片，请添加首帧图片');
  if(draft.mode==='FIRST&LAST'&&referenceAssetIds.length>2)throw new Error('首尾帧最多添加两张图片');
  const limits=parameters.referenceLimits||{};
  if(referenceAssetIds.length>Number(limits.total??parameters.maxImages??0))throw new Error('参考素材数量超过模型支持范围');
  for(const kind of ['image','video','audio'])if(draft.attachments.filter(file=>file.kind===kind).length>Number(limits[kind]??(kind==='image'?parameters.maxImages:0)))throw new Error(`${kind==='image'?'图片':kind==='video'?'视频':'音频'}参考素材数量超过模型支持范围`);
  return {type:'video',modelId:draft.modelId,prompt,aspectRatio:draft.aspect,duration:Number(draft.duration),quality:draft.quality,generationType:draft.mode,referenceAssetIds};
}
