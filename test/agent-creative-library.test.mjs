import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentSkills} from '../lib/agent/skills.mjs';

const skills = createAgentSkills({roots: [new URL('../agent-skills/', import.meta.url).pathname]});

test('creative library lists the ten built-in skills in display order', async () => {
  assert.deepEqual((await skills.search()).map(({name, title}) => [name, title]), [
    ['prompt-optimization', '提示词优化'],
    ['image-design', '图像创作'],
    ['video-production', '视频创作'],
    ['short-drama', '短剧创作'],
    ['script-writing', '剧本创作'],
    ['video-replication', '视频复刻'],
    ['creative-review', '作品检查'],
    ['seedance-creation-bible', 'Seedance 创作圣经'],
    ['minimax-creation-bible', 'MiniMax 创作圣经'],
    ['character-design', '角色设计'],
  ]);
});

test('prompt, script and character requests find their specialized creative methods', async () => {
  for (const [query, expected] of [
    ['优化视频提示词', 'prompt-optimization'],
    ['精简画面描述', 'prompt-optimization'],
    ['提示词被拒怎么改', 'prompt-optimization'],
    ['创作电影剧本', 'script-writing'],
    ['修改舞台剧对白', 'script-writing'],
    ['设计角色三视图', 'character-design'],
    ['原创角色设定', 'character-design'],
    ['写短剧分集方案', 'short-drama'],
    ['Seedance 2.5 提示词优化', 'seedance-creation-bible'],
    ['MiniMax H3', 'minimax-creation-bible'],
    ['minimax-h3-15s 视频提示词', 'minimax-creation-bible'],
    ['MiniMax 创作圣经', 'minimax-creation-bible'],
    ['海螺 H3 声画描述', 'minimax-creation-bible'],
    ['Hailuo H3 video', 'minimax-creation-bible'],
    ['H3 视频运镜', 'minimax-creation-bible'],
  ]) {
    assert.equal((await skills.search(query))[0]?.name, expected, query);
  }
  for (const query of ['你好', '设计数据库索引', '计算 18 × 24']) {
    const results = await skills.search(query);
    assert.ok(!results.some(({name}) => ['prompt-optimization', 'script-writing', 'character-design'].includes(name)), query);
  }
});
