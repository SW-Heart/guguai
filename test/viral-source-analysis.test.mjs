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
