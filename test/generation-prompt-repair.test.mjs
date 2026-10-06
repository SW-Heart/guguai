import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyPromptRepair, collectPromptRepairCues, isPromptRejection, loadPromptRepairGuidance, repairGenerationPrompt } from '../services/generation-prompt-repair.mjs';
import { prepareGenerationRetry } from '../services/generation-retry.mjs';

const prompt = '夜晚，摄影师拍摄街头的人群，暖色灯光，固定机位。';
const result = { text: JSON.stringify({ meaningPreserved: true, replacements: [{ start: 6, before: '拍摄', after: '用相机记录' }] }), usage: { inputTokens: 100, outputTokens: 30 }, model: 'test', providerRequestId: 'request-1' };
const rejection = new Error('输入的提示词包含违禁词');

test('any Chinese prompt mention triggers repair alongside existing explicit rejections', () => {
  for (const message of ['上游拒绝生成,请修改提示词后重试', '提示词过长', '参考图审核拒绝，请调整提示词', '输入的提示词包含违禁词', '包含违禁词', 'banned keywords detected', 'prompt rejected by safety filter', 'sensitive prompt blocked']) assert.equal(isPromptRejection(new Error(message)), true, message);
  for (const message of ['content_policy_violation', 'content review failed', 'The generated images appear to be unsafe', '视频内容审核未通过', 'prompt too long', '503 service unavailable']) assert.equal(isPromptRejection(new Error(message)), false, message);
});

test('real rejection skill documents are fully loaded, including Seedance guidance', async () => {
  const docs = await loadPromptRepairGuidance({ videoModelId: 'seedance-2.5' });
  assert.deepEqual(docs.map(doc => doc.resource), ['SKILL.md', 'references/rejection-and-clarification.md', 'references/content-risk-reference.md', 'references/rejection-and-clarification.md', 'references/moderation-vocabulary.md', 'references/moderation-cues.json']);
  assert.ok(docs.every(doc => doc.text.length > 100));
  assert.match(docs[1].text, /不要用拼写/);
});

test('Seedance 2.0 and 2.5 load vocabulary even behind a logical model alias', async () => {
  for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628']) {
    const docs = await loadPromptRepairGuidance({ videoModelId: 'logical-video-model', model });
    const vocabulary = JSON.parse(docs.find(doc => doc.resource === 'references/moderation-cues.json').text);
    assert.equal(vocabulary.sources.length, 5);
    const sourceIds = new Set(vocabulary.sources.map(source => source.id));
    assert.ok(vocabulary.classes.every(group => group.sourceIds.every(id => sourceIds.has(id))));
    const text = '律师查看合同，爵士钢琴音乐，江湖人士在远处，UE5 渲染。';
    const matches = collectPromptRepairCues(text, docs);
    for (const term of ['律师', '合同', '爵士钢琴', '江湖人士', 'UE5']) {
      const hit = matches.find(match => match.term === term);
      assert.ok(hit, term);
      assert.equal(text.slice(hit.start, hit.start + term.length), term);
      assert.ok(hit.sourceIds.length);
    }
    assert.equal(collectPromptRepairCues('screenshot drugstore bloodless flagpole', docs).length, 0);
  }
  const docs = await loadPromptRepairGuidance({ videoModelId: 'other-video-model' });
  assert.equal(collectPromptRepairCues('律师查看合同', docs).length, 0);
});

test('Seedance vocabulary and actual cue locations reach the optimizer in both rounds', async () => {
  const task = { type: 'video', model: 'doubao-seedance-2-5-260628', prompt: '律师查看合同，远处响起爵士钢琴音乐。', generationRetryCount: 1 };
  let calls = 0;
  const deps = { save: async () => {}, callLlm: async args => {
    const input = JSON.parse(args.prompt);
    calls++;
    assert.equal(input.attempt, calls);
    assert.ok(input.guidance.some(doc => doc.resource === 'references/moderation-cues.json'));
    for (const term of ['律师', '合同', '爵士钢琴']) assert.ok(input.candidateCueMatches.some(match => match.term === term));
    // Matching ordinary words must not force a content change.
    return { text: '{"meaningPreserved":false,"replacements":[]}' };
  } };
  await repairGenerationPrompt(task, rejection, deps);
  task.generationRetryCount++;
  await repairGenerationPrompt(task, rejection, deps);
  assert.equal(calls, 2);
  assert.equal(task.prompt, '律师查看合同，远处响起爵士钢琴音乐。');
});

test('patching leaves every other character intact', () => {
  assert.equal(applyPromptRepair(prompt, result.text), prompt.replace('拍摄', '用相机记录'));
  assert.equal(applyPromptRepair(prompt, '{"meaningPreserved":false,"replacements":[]}'), null);
});

test('reject full rewrites, wrong offsets, overlapping edits and protected text', () => {
  const encode = replacements => JSON.stringify({ meaningPreserved: true, replacements });
  for (const edits of [
    [{ start: 0, before: prompt, after: '摄影师用相机记录人群' }],
    [{ start: 0, before: '拍摄', after: '记录' }],
    [{ start: 6, before: '拍摄', after: '记录' }, { start: 6, before: '拍摄', after: '录制' }],
  ]) assert.throws(() => applyPromptRepair(prompt, encode(edits)));
  for (const text of ['“拍摄”', '"拍摄"', '@拍摄', 'https://example.com/拍摄']) {
    assert.throws(() => applyPromptRepair(text, encode([{ start: text.indexOf('拍摄'), before: '拍摄', after: '记录' }])));
  }
});

for (const type of ['image', 'video']) test(`${type}: two platform-paid repairs require separate failures and persist across restarts`, async () => {
  let calls = 0;
  const saves = [];
  let task = { type, prompt, creditStatus: 'charged', creditCostMicro: 1230000, pricingSnapshot: { totalMicro: 1230000 }, generationRetryCount: 1 };
  const deps = {
    callLlm: async args => {
      calls++;
      assert.equal(saves.at(-1).promptRepair.status, 'attempted');
      assert.equal(saves.at(-1).promptRepair.attemptCount, calls);
      const input = JSON.parse(args.prompt);
      assert.ok(input.guidance.some(doc => doc.resource === 'references/content-risk-reference.md'));
      if (calls === 1) return result;
      assert.equal(input.originalPrompt, prompt);
      assert.equal(input.prompt, prompt.replace('拍摄', '用相机记录'));
      assert.equal(input.previousAttempts[0].repairedPrompt, input.prompt);
      assert.equal(input.rejection, '上游拒绝生成,请修改提示词后重试');
      return { ...result, text: JSON.stringify({ meaningPreserved: true, replacements: [{ start: 6, before: '用相机记录', after: '通过相机记录' }] }) };
    },
    save: async task => saves.push(structuredClone(task)),
  };
  assert.equal(await repairGenerationPrompt(task, rejection, deps), true);
  assert.equal(task.prompt, prompt.replace('拍摄', '用相机记录'));
  assert.equal(task.originalPrompt, prompt);
  assert.equal(task.promptRepair.payer, 'platform');
  assert.deepEqual(task.promptRepair.usage, result.usage);
  assert.equal(task.creditCostMicro, 1230000);
  assert.equal(task.creditStatus, 'charged');
  assert.deepEqual(task.pricingSnapshot, { totalMicro: 1230000 });
  assert.equal(await repairGenerationPrompt(JSON.parse(JSON.stringify(task)), rejection, deps), false);
  assert.equal(calls, 1);
  task = JSON.parse(JSON.stringify(task));
  task.generationRetryCount = 2;
  assert.equal(await repairGenerationPrompt(task, new Error('503 service unavailable'), deps), false);
  assert.equal(calls, 1);
  assert.equal(await repairGenerationPrompt(task, new Error('上游拒绝生成,请修改提示词后重试'), deps), true);
  assert.equal(task.prompt, prompt.replace('拍摄', '通过相机记录'));
  assert.equal(task.originalPrompt, prompt);
  assert.equal(task.promptRepair.attemptCount, 2);
  assert.equal(task.promptRepair.attempts.length, 2);
  assert.equal(task.creditCostMicro, 1230000);
  task = JSON.parse(JSON.stringify(task));
  task.generationRetryCount = 3;
  assert.equal(await repairGenerationPrompt(task, rejection, deps), false);
  assert.equal(calls, 2);
});

test('missing guidance and failed LLM consume at most two attempts without same-failure repeats', async () => {
  for (const guidanceFails of [true, false]) {
    let calls = 0;
    const task = { type: 'image', prompt };
    const deps = { save: async () => {}, guidance: async () => { if (guidanceFails) throw new Error('missing skill'); return []; }, callLlm: async () => { calls++; throw new Error('unavailable'); } };
    assert.equal(await repairGenerationPrompt(task, rejection, deps), false);
    assert.equal(task.prompt, prompt);
    assert.equal(task.promptRepair.status, 'failed');
    await repairGenerationPrompt(task, rejection, deps);
    assert.equal(calls, guidanceFails ? 0 : 1);
    task.generationRetryCount = 1;
    await repairGenerationPrompt(task, rejection, deps);
    task.generationRetryCount = 2;
    await repairGenerationPrompt(task, rejection, deps);
    assert.equal(task.promptRepair.attemptCount, 2);
    assert.equal(calls, guidanceFails ? 0 : 2);
  }
});

test('persisted attempt claim prevents another request after a crash', async () => {
  const task = { type: 'video', prompt, promptRepair: { status: 'attempted', payer: 'platform' } };
  assert.equal(await repairGenerationPrompt(task, rejection, { save: () => assert.fail(), callLlm: () => assert.fail() }), false);
});

test('a saved current-round claim survives crash while a later failure may claim round two', async () => {
  const task = { type: 'video', prompt, generationRetryCount: 1 };
  let persisted;
  await assert.rejects(repairGenerationPrompt(task, rejection, { save: async value => { persisted = structuredClone(value); throw new Error('crash'); }, callLlm: () => assert.fail() }), /crash/);
  const restored = JSON.parse(JSON.stringify(persisted));
  assert.equal(await repairGenerationPrompt(restored, rejection, { save: () => assert.fail(), callLlm: () => assert.fail() }), false);
  restored.generationRetryCount = 2;
  assert.equal(await repairGenerationPrompt(restored, rejection, { save: async () => {}, guidance: async () => [], callLlm: async () => result }), true);
  assert.equal(restored.promptRepair.attemptCount, 2);
});

test('legacy completed repair counts as round one and retains the original prompt', async () => {
  const task = { type: 'image', prompt: prompt.replace('拍摄', '用相机记录'), originalPrompt: prompt,
    generationRetryCount: 2, promptRepair: { status: 'applied', payer: 'platform' } };
  assert.equal(await repairGenerationPrompt(task, rejection, { save: async () => {}, guidance: async () => [],
    callLlm: async () => ({ text: '{"meaningPreserved":false,"replacements":[]}' }) }), false);
  assert.equal(task.promptRepair.attemptCount, 2);
  assert.equal(task.promptRepair.status, 'unchanged');
  assert.equal(task.originalPrompt, prompt);
  task.generationRetryCount = 3;
  assert.equal(await repairGenerationPrompt(task, rejection, { save: () => assert.fail(), callLlm: () => assert.fail() }), false);
});

test('shared retry sequence runs repair twice only on matching upstream failures', async () => {
  let task = { type: 'video', prompt, creditStatus: 'charged' }, calls = 0;
  for (const message of ['上游拒绝生成,请修改提示词后重试', '上游拒绝生成,请修改提示词后重试', '上游拒绝生成,请修改提示词后重试']) {
    const error = Object.assign(new Error(message), { upstreamTerminal: true });
    assert.equal(prepareGenerationRetry(task, error), true);
    await repairGenerationPrompt(task, error, { save: async () => {}, guidance: async () => [], callLlm: async () => { calls++; return { text: '{"meaningPreserved":false,"replacements":[]}' }; } });
    task = JSON.parse(JSON.stringify(task));
  }
  assert.equal(calls, 2);
  assert.equal(task.creditStatus, 'charged');
  assert.equal(prepareGenerationRetry(task, { upstreamTerminal: true }), false);
});

test('non-prompt failures and other media types never call the LLM', async () => {
  for (const task of [{ type: 'audio', prompt }, { type: 'image', prompt: '' }, { type: 'video', prompt }]) {
    assert.equal(await repairGenerationPrompt(task, new Error('content review failed'), { save: () => assert.fail(), callLlm: () => assert.fail() }), false);
  }
});

test('generation retry wires repair into the shared failure path without customer LLM billing', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = server.indexOf('if (prepareGenerationRetry(task, error))');
  const end = server.indexOf("task.status = 'failed'", start);
  assert.match(server.slice(start, end), /await repairGenerationPrompt\(task, error/);
  assert.doesNotMatch(server.slice(start, end), /reserveLlmCredits|settleLlmCredits/);
});
