import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasGenerationFrameSize, canvasGenerationPayload, canvasGenerationOptions, reconcileCanvasGenerationDraft } from '../public/features/drama/canvas-generation.js';
import { normalizeDirectorWorkspace } from '../public/features/drama/director-actions.js';

const config={
  imageModels:[{id:'gpt-image-2.5',label:'GPT Image 2.5'},{id:'gpt-image-2',label:'GPT Image 2'},{id:'midjourney',label:'Midjourney'}],
  videoCapabilities:{models:[{id:'veo-31',label:'Veo 3.1',modes:[
    {generationType:'TEXT',aspectRatios:['16:9'],durations:[8],qualityOptions:['720p'],referenceLimits:{image:0,video:0,audio:0,total:0}},
    {generationType:'FIRST&LAST',aspectRatios:['16:9','9:16'],durations:[8],qualityOptions:['720p','1080p'],referenceLimits:{image:2,video:0,audio:0,total:2},maxImages:2},
  ]}]},
};

test('canvas image request keeps GPT Image 2.5 resolution and references',()=>{
  const draft={type:'image',modelId:'gpt-image-2.5',prompt:'一只站在雨中的猫',aspect:'9:16',quality:'4k',quantity:2,attachments:[{id:'ref-1',kind:'image'}]};
  assert.deepEqual(canvasGenerationPayload(draft,config),{type:'image',modelId:'gpt-image-2.5',prompt:'一只站在雨中的猫',size:'1984x3536',quality:'4k',quantity:2,referenceAssetIds:['ref-1']});
  draft.attachments=Array.from({length:8},(_,index)=>({id:`ref-${index}`,kind:'image'}));
  assert.throws(()=>canvasGenerationPayload(draft,config),/最多添加 7 张/);
});

test('canvas Midjourney request preserves advanced controls and batch size',()=>{
  const draft={type:'image',modelId:'midjourney',prompt:'电影感海岸',aspect:'16:9',quality:'2',quantity:8,attachments:[],midjourney:{version:'8.2',stylize:250,chaos:8,weird:13,seed:'42',negativePrompt:'文字',imageWeight:1.5,raw:true,tile:false,draft:true}};
  const payload=canvasGenerationPayload(draft,config);
  assert.equal(payload.quantity,8);
  assert.deepEqual(payload.midjourneyOptions,{...draft.midjourney,aspectRatio:'16:9',quality:'2'});
});

test('canvas video request follows the selected mode and checks its reference limit',()=>{
  const draft={type:'video',modelId:'veo-31',prompt:'镜头向前推进',mode:'FIRST&LAST',aspect:'9:16',quality:'1080p',duration:8,attachments:[{id:'first',kind:'image'},{id:'last',kind:'image'}]};
  assert.deepEqual(canvasGenerationPayload(draft,config),{type:'video',modelId:'veo-31',prompt:'镜头向前推进',aspectRatio:'9:16',duration:8,quality:'1080p',generationType:'FIRST&LAST',referenceAssetIds:['first','last']});
  draft.attachments.push({id:'third',kind:'image'});
  assert.throws(()=>canvasGenerationPayload(draft,config),/最多添加两张图片/);
});

test('pending canvas generation survives project normalization',()=>{
  const source={generationDrafts:[{id:'canvas-gen-test',type:'image',prompt:'夜色',modelId:'gpt-image-2',aspect:'1:1',quality:'medium',quantity:1,attachments:[{id:'ref-1',name:'参考图',kind:'image',url:'/ref.png'}],midjourney:{raw:true},taskId:''}]};
  const restored=normalizeDirectorWorkspace(source).generationDrafts[0];
  assert.equal(restored.prompt,'夜色');
  assert.deepEqual(restored.attachments,[{id:'ref-1',kind:'image',name:'参考图',url:'/ref.png'}]);
  assert.equal(restored.taskId,'');
});

test('canvas generation frame follows the selected output ratio',()=>{
  assert.deepEqual(canvasGenerationFrameSize('image','1:1'),{width:280,height:280});
  assert.deepEqual(canvasGenerationFrameSize('video','16:9'),{width:320,height:180});
  assert.deepEqual(canvasGenerationFrameSize('video','9:16'),{width:180,height:320});
});


test('canvas uses durations of the selected quality and resets unsupported choices',()=>{
  const config={videoCapabilities:{models:[{id:'seedance-2.5',modes:[{generationType:'TEXT',aspectRatios:['16:9'],qualityOptions:['480p','720p'],durations:[5,7,30],durationsByQuality:{'480p':{'16:9':[30]},'720p':{'16:9':[5,7]}}}]}]}};
  const draft={type:'video',modelId:'seedance-2.5',mode:'TEXT',aspect:'16:9',quality:'480p',duration:7};
  reconcileCanvasGenerationDraft(draft,config);
  assert.equal(draft.duration,30);
  assert.deepEqual(canvasGenerationOptions(draft,config).parameters.durations,[30]);
  draft.quality='720p';
  reconcileCanvasGenerationDraft(draft,config);
  assert.equal(draft.duration,5);
  assert.deepEqual(canvasGenerationOptions(draft,config).parameters.durations,[5,7]);
});
