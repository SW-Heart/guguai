import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProjectThreeWay, projectConflictChoiceMap } from '../public/features/drama/merge.js';

test('three-way project merge keeps independent edits and reports same-field conflicts', () => {
  const base = { revision:1, title:'原项目', settings:{ aspectRatio:'9:16' }, shots:[{ id:'shot-a', title:'原分镜', action:'原动作' }] };
  const local = { ...base, title:'本地标题', settings:{ aspectRatio:'16:9' }, shots:[{ id:'shot-a', title:'本地分镜', action:'原动作' }] };
  const remote = { ...base, title:'服务器标题', settings:{ aspectRatio:'9:16' }, shots:[{ id:'shot-a', title:'服务器分镜', action:'服务器动作' }], revision:2 };
  const merged = mergeProjectThreeWay({ base, local, remote });
  assert.equal(merged.project.title, '服务器标题');
  assert.equal(merged.project.settings.aspectRatio, '16:9');
  assert.equal(merged.project.shots[0].action, '服务器动作');
  assert.deepEqual(merged.conflicts.map(conflict => conflict.path), ['title', 'shots[shot-a].title']);
  const resolved = mergeProjectThreeWay({ base, local, remote, choices:projectConflictChoiceMap(merged.conflicts, 'local') });
  assert.equal(resolved.project.title, '本地标题');
  assert.equal(resolved.project.shots[0].title, '本地分镜');
  assert.equal(resolved.project.revision, 2);
});

test('three-way project merge preserves additions from either editor', () => {
  const base = { revision:4, shots:[] };
  const local = { ...base, shots:[{ id:'local-shot', title:'本地新增' }] };
  const remote = { ...base, revision:5, shots:[{ id:'remote-shot', title:'服务器新增' }] };
  const result = mergeProjectThreeWay({ base, local, remote });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.project.shots.map(shot => shot.id).sort(), ['local-shot', 'remote-shot']);
});
