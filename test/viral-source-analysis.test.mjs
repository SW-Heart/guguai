import test from 'node:test';
import assert from 'node:assert/strict';
import { compileReplicaPrompt, normalizeReplicaPlan, normalizeSourceObservation, sourceAnalysisFingerprint, splitSourceTimeline } from '../services/viral-source-analysis.mjs';

const observation = normalizeSourceObservation({
  summary: '先展示问题，再用商品完成演示。',
  timeline: [
    { start_seconds:0, end_seconds:4.2, visual_action:'人物拿起商品看向镜头', spoken_content:'先看这里', speaker_mode:'in_frame_sync', story_function:'hook', evidence_frames:['0.0s'] },
    { start_seconds:4.2, end_seconds:11.5, visual_action:'手部完成使用动作', spoken_content:'使用后更方便', speaker_mode:'voiceover', story_function:'demonstration', evidence_frames:['5.0s'] },
  ],
  uncertainties: ['背景音乐歌词无法确认'],
}, { sourceHash:'a'.repeat(64), durationSeconds:12 });

test('源片观察归一化并保留证据、说话模式和源 hash', () => {
  assert.equal(observation.durationSeconds, 12);
  assert.equal(observation.timeline[1].speakerMode, 'voiceover');
  assert.deepEqual(observation.timeline[0].evidenceFrames, ['0.0s']);
  assert.equal(observation.sourceHash, 'a'.repeat(64));
  assert.equal(sourceAnalysisFingerprint(observation).length, 64);
});

test('时间线按模型时长切段，编译结果包含源视频和素材职责', () => {
  const project = { sourceAssetId:'source-video', productName:'新商品', materials:[{ assetId:'product', role:'product', label:'商品图' }], units:[] };
  const units = splitSourceTimeline(observation, { modelId:'seedance-2.0', materials:project.materials });
  assert.equal(units.length, 1);
  const plan = normalizeReplicaPlan({ ...project, units }, observation, { units });
  assert.match(plan[0].prompt, /@视频1/);
  assert.match(plan[0].prompt, /@图片1/);
  assert.match(plan[0].prompt, /先看这里/);
  assert.deepEqual(plan[0].sourceRange, { startSeconds:0, endSeconds:12 });
  assert.equal(plan[0].duration, 15);
});

test('2.5 编译器不会把源片原话拆成残句', () => {
  const project = { sourceAssetId:'source-video', productName:'新商品', materials:[{ assetId:'product', role:'product', label:'商品图' }] };
  const unit = { ...splitSourceTimeline(observation, { modelId:'seedance-2.5', materials:project.materials })[0], referenceAssetIds:['product'] };
  const prompt = compileReplicaPrompt(project, observation, unit);
  assert.match(prompt, /【生成目标】/);
  assert.match(prompt, /【事件脚本】/);
  assert.match(prompt, /画外音：\{使用后更方便\}/);
});

test('跨段台词只出现一次，后续视频使用从零开始的段内时间', () => {
  const source = normalizeSourceObservation({ timeline:[
    { start_seconds:0, end_seconds:25, visual_action:'开场' },
    { start_seconds:25, end_seconds:35, visual_action:'展示', spoken_content:'完整的一句话', speaker_mode:'voiceover' },
    { start_seconds:35, end_seconds:60, visual_action:'结尾' },
  ] }, { durationSeconds:60 });
  const project = { sourceAssetId:'video', materials:[{assetId:'p',role:'product'}] };
  const units = splitSourceTimeline(source, { materials:project.materials });
  assert.equal(units[1].sourceRange.startSeconds,25);
  assert.equal(units.at(-1).sourceRange.endSeconds,60);
  const prompts = units.map(unit => compileReplicaPrompt(project,source,unit));
  assert.equal(prompts.join('\n').split('完整的一句话').length - 1,1);
  assert.match(prompts[1],/阶段1（0\.000–10\.000秒）/);
  for (const unit of units) assert.ok(unit.sourceRange.endSeconds-unit.sourceRange.startSeconds <= unit.duration);
});

test('素材编号遵循实际提交顺序，超长观察不会重复口播', () => {
  const source = normalizeSourceObservation({timeline:[{start_seconds:0,end_seconds:65,visual_action:'展示',spoken_content:'仅说一次'}]});
  const project = { materials:[{assetId:'a',label:'甲图'},{assetId:'b',label:'乙图'}] };
  const units = splitSourceTimeline(source,{materials:project.materials}).map(unit=>({...unit,referenceAssetIds:['b','a']}));
  const prompts = units.map(unit=>compileReplicaPrompt(project,source,unit));
  assert.match(prompts[0],/@图片1负责乙图/);
  assert.equal(prompts.join('').split('仅说一次').length-1,1);
});
