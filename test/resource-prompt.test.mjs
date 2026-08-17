import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResourceImagePrompt } from '../public/resource-prompt.js';

test('character resource prompt compiles every visible bible field', () => {
  const prompt=buildResourceImagePrompt({type:'character',name:'修仙女侠',description:'闭关三百年的白衣女侠',bible:{identity:'性格活泼天真',appearance:'杏眼含笑，长发及腰',costume:'白色仙侠长袍',canonicalViews:'正面全身、侧面御剑姿势',stateNotes:'发簪始终为银色'}},{aspectRatio:'9:16'});
  for(const expected of ['修仙女侠','闭关三百年的白衣女侠','性格活泼天真','杏眼含笑，长发及腰','白色仙侠长袍','正面全身、侧面御剑姿势','发簪始终为银色','9:16'])assert.match(prompt,new RegExp(expected));
  assert.match(prompt,/角色视觉圣经图/);
  assert.match(prompt,/不加入其他人物/);
});

test('location and prop prompts prevent people from contaminating reusable references', () => {
  assert.match(buildResourceImagePrompt({type:'location',name:'仙山',bible:{}}),/场景中不出现人物/);
  assert.match(buildResourceImagePrompt({type:'prop',name:'长剑',bible:{}}),/不出现人物或手持动作/);
});
