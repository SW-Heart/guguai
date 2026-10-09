import test from 'node:test';
import assert from 'node:assert/strict';
import {addGenerationReference} from '../public/features/drama/canvas-generation-references.js';
import {canvasGenerationPayload} from '../public/features/drama/canvas-generation.js';

const config = {videoCapabilities:{models:[{id:'video',modes:[
  {generationType:'TEXT',aspectRatios:['16:9'],durations:[5],qualityOptions:['720p'],referenceLimits:{image:0,total:0}},
  {generationType:'REFERENCE',aspectRatios:['16:9'],durations:[5],qualityOptions:['720p'],referenceLimits:{image:3,video:1,audio:1,total:3}},
  {generationType:'FIRST&LAST',aspectRatios:['16:9'],durations:[5],qualityOptions:['720p'],referenceLimits:{image:2,total:2}},
]}]}};
const draft = mode => ({id:'draft',type:'video',modelId:'video',mode,aspect:'16:9',quality:'720p',duration:5,prompt:'镜头缓慢推进',attachments:[]});
test('canvas references respect video modes, first/last order and attachment limits', () => {
  const video = draft('TEXT');
  addGenerationReference(video, {id:'one',kind:'image'}, config);
  assert.equal(video.mode, 'REFERENCE');
  const frames = draft('FIRST&LAST');
  addGenerationReference(frames, {id:'first',kind:'image'}, config);
  addGenerationReference(frames, {id:'last',kind:'image'}, config);
  assert.deepEqual(canvasGenerationPayload(frames, config).referenceAssetIds, ['first','last']);
  assert.throws(() => addGenerationReference(frames, {id:'third',kind:'image'}, config), /最多添加两张/);
  assert.throws(() => addGenerationReference(draft('FIRST&LAST'), {id:'video',kind:'video'}, config), /只能添加图片/);
  const full = draft('REFERENCE');
  full.attachments = ['a','b','c'].map(id => ({id,kind:'image'}));
  assert.throws(() => addGenerationReference(full, {id:'d',kind:'image'}, config), /数量超过/);
  const imageDraft = {type:'image',attachments:Array.from({length:7}, (_,id) => ({id:String(id),kind:'image'}))};
  assert.throws(() => addGenerationReference(imageDraft, {id:'eighth',kind:'image'}, config), /最多添加 7 张/);
});
