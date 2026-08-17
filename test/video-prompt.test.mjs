import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShotVideoPrompt } from '../public/video-prompt.js';

test('legacy video prompt is rebuilt from storyboard facts and ignores unsafe historical raw prompt', () => {
  const project = { title:'道友烧什么油', synopsis:'女侠遭遇现代战斗机。', resources:[{name:'修仙女侠'},{name:'战斗机'}] };
  const scene = { heading:'仙山之巅', location:'悬崖', timeOfDay:'白天', dramaticFunction:'建立反差', geography:'云海翻涌；战斗机将从左侧闯入', lighting:'柔和日光', continuityNotes:'长剑位置固定' };
  const shot = { shotNumber:1, title:'山巅吃瓜', narrativeFunction:'表现女侠悠闲', script:'女侠盘坐吃瓜，说：“真甜。”', action:'舀起一勺西瓜', startState:'盘坐持瓜', endState:'抬头听见轰鸣', shotSize:'中景', cameraMovement:'缓慢推进', duration:6, aspectRatio:'16:9', prompt:'白衣女侠位于画面中央，9:16 vertical', sound:'风声与远处引擎声', continuityNotes:'西瓜在左手', negativePrompt:'禁止出现其他人物', generation:{type:'REFERENCE'} };
  const resources = [{ type:'character', name:'修仙女侠', description:'闭关三百年的白衣女侠', bible:{ appearance:'杏眼长发', costume:'白色仙侠长袍', stateNotes:'发簪固定' } }];
  const prompt = buildShotVideoPrompt({ project, shot, scene, resources });
  for (const expected of ['盘坐持瓜','舀起一勺西瓜','抬头听见轰鸣','缓慢推进','风声与远处引擎声','修仙女侠','禁止出现其他人物']) assert.match(prompt, new RegExp(expected));
  assert.match(prompt, /参考图只锁定/);
  assert.match(prompt, /16:9/);
  assert.doesNotMatch(prompt, /白衣女侠位于画面中央/);
  assert.doesNotMatch(prompt, /战斗机将从左侧闯入/);
  assert.doesNotMatch(prompt, /9:16 vertical/);
  assert.ok(Array.from(prompt).length <= 4000);
});

test('a saved manual storyboard prompt is submitted verbatim instead of being recompiled', () => {
  const prompt = buildShotVideoPrompt({project:{workflowVersion:3},shot:{promptOverride:'0–1s：保持首帧\n1–6s：手动动作\n6s：定格尾帧'},scene:{},resources:[]});
  assert.equal(prompt, '0–1s：保持首帧\n1–6s：手动动作\n6s：定格尾帧');
});
