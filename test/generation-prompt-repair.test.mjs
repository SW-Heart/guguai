import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyPromptRepair, isPromptRejection, loadPromptRepairGuidance, repairGenerationPrompt } from '../services/generation-prompt-repair.mjs';

const prompt = '夜晚，摄影师拍摄街头的人群，暖色灯光，固定机位。';
const result = { text: JSON.stringify({ meaningPreserved: true, replacements: [{ start: 6, before: '拍摄', after: '用相机记录' }] }), usage: { inputTokens: 100, outputTokens: 30 }, model: 'test', providerRequestId: 'request-1' };
const rejection = new Error('输入的提示词包含违禁词');

test('only explicit input text rejections trigger repair', () => {
  for (const message of ['输入的提示词包含违禁词', '包含违禁词', 'banned keywords detected', 'prompt rejected by safety filter', 'sensitive prompt blocked']) assert.equal(isPromptRejection(new Error(message)), true, message);
  for (const message of ['content_policy_violation', 'content review failed', 'The generated images appear to be unsafe', '视频内容审核未通过', '参考图审核拒绝，请调整提示词', 'prompt too long', '503 service unavailable']) assert.equal(isPromptRejection(new Error(message)), false, message);
});

test('real rejection skill documents are fully loaded, including Seedance guidance', async () => {
  const docs = await loadPromptRepairGuidance({ videoModelId: 'seedance-2.5' });
  assert.deepEqual(docs.map(doc => doc.resource), ['SKILL.md', 'references/rejection-and-clarification.md', 'references/rejection-and-clarification.md']);
  assert.ok(docs.every(doc => doc.text.length > 100));
  assert.match(docs[1].text, /不要用拼写/);
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

for (const type of ['image', 'video']) test(`${type}: one platform-paid repair persists across retries and restarts`, async () => {
  let calls = 0;
  const saves = [];
  const task = { type, prompt, creditStatus: 'charged', creditCostMicro: 1230000, pricingSnapshot: { totalMicro: 1230000 }, generationRetryCount: 1 };
  const deps = {
    callLlm: async args => { calls++; assert.equal(saves[0].promptRepair.status, 'attempted'); assert.match(args.prompt, /rejection-and-clarification/); return result; },
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
});

test('missing guidance and failed LLM do not alter the prompt or repeat requests', async () => {
  for (const guidanceFails of [true, false]) {
    let calls = 0;
    const task = { type: 'image', prompt };
    const deps = { save: async () => {}, guidance: async () => { if (guidanceFails) throw new Error('missing skill'); return []; }, callLlm: async () => { calls++; throw new Error('unavailable'); } };
    assert.equal(await repairGenerationPrompt(task, rejection, deps), false);
    assert.equal(task.prompt, prompt);
    assert.equal(task.promptRepair.status, 'failed');
    await repairGenerationPrompt(task, rejection, deps);
    assert.equal(calls, guidanceFails ? 0 : 1);
  }
});

test('persisted attempt claim prevents another request after a crash', async () => {
  const task = { type: 'video', prompt, promptRepair: { status: 'attempted', payer: 'platform' } };
  assert.equal(await repairGenerationPrompt(task, rejection, { save: () => assert.fail(), callLlm: () => assert.fail() }), false);
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
