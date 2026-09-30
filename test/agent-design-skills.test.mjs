import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAgentSkills } from '../lib/agent/skills.mjs';
import { buildAgentMessages, modelFacingMessage } from '../lib/agent/context.mjs';

const skills = createAgentSkills({ roots: [fileURLToPath(new URL('../agent-skills/', import.meta.url))] });

test('visual design methods are discoverable across deliverables without attracting software architecture', async () => {
  for (const query of [
    '帮茶饮做品牌视觉', '咖啡 logo', '包装设计方案', '优化电商主图',
    '中文排版', '字体搭配', '配色', '诊所预约界面设计', '信息图',
    'poster', 'typography', 'color palette', 'visual design', 'brand identity', 'UI design',
  ]) {
    assert.equal((await skills.search(query))[0]?.name, 'image-design', query);
  }
  for (const query of ['设计数据库索引', '设计 API 重试机制', '算一下 18 × 24', '你好']) {
    assert.ok(!(await skills.search(query)).some(skill => skill.name === 'image-design'), query);
  }
});

test('all design reference links resolve and remain readable without tool-output truncation', async () => {
  const entry = await skills.read('image-design');
  const resources = [...entry.text.matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1]);
  assert.ok(resources.length > 0);
  for (const resource of ['SKILL.md', ...resources]) {
    const result = await skills.read('image-design', resource);
    assert.ok(result.text.trim());
    const message = { role: 'tool', tool_call_id: resource, content: JSON.stringify(result) };
    assert.equal(modelFacingMessage(message), message, `${resource} should fit in one model-facing result`);
  }
});

test('design references are available on demand and removed from later-turn model history only', async () => {
  const resource = 'references/visual-foundations.md';
  const result = await skills.read('image-design', resource);
  const history = [
    { role: 'user', content: '请帮茶饮设计一套品牌视觉方案' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'design-read', type: 'function', function: {
      name: 'skills_read', arguments: JSON.stringify({ name: 'image-design', resource }),
    } }] },
    { role: 'tool', tool_call_id: 'design-read', content: JSON.stringify(result) },
  ];
  const context = { skills: (await skills.search()).map(({ name, description }) => ({ name, description })) };
  const initial = buildAgentMessages({ messages: history.slice(0, 1) }, context, 'test instructions');
  assert.ok(!JSON.stringify(initial).includes(result.text));
  const current = buildAgentMessages({ messages: history }, context, 'test instructions');
  assert.deepEqual(JSON.parse(current.find(message => message.role === 'tool').content), result);
  const later = buildAgentMessages({ messages: [...history,
    { role: 'assistant', content: '方案已完成。' }, { role: 'user', content: '算一下 18 × 24' },
  ] }, context, 'test instructions');
  assert.equal(JSON.parse(later.find(message => message.role === 'tool').content).status, 'previous_turn_skill_read');
  assert.equal(JSON.parse(history[2].content).text, result.text, 'stored history must remain intact');
});

test('all built-in creative skill entries and linked resources fit model tool results', async () => {
  for (const skill of await skills.search()) {
    const entry = await skills.read(skill.name);
    const resources = [...entry.text.matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1]);
    for (const resource of ['SKILL.md', ...resources]) {
      const result = await skills.read(skill.name, resource);
      assert.ok(result.text.trim(), `${skill.name}/${resource}`);
      const message = { role: 'tool', tool_call_id: `${skill.name}/${resource}`, content: JSON.stringify(result) };
      assert.equal(modelFacingMessage(message), message, `${skill.name}/${resource} must remain readable`);
    }
  }
  // Cross-skill references use the owning skill, as required by the resource reader.
  for (const resource of ['references/camera-and-blocking.md', 'references/sequence-design.md']) {
    assert.ok((await skills.read('video-production', resource)).text.trim());
    await assert.rejects(skills.read('short-drama', `../video-production/${resource}`));
  }
});
