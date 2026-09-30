import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamPacer } from '../public/features/agent/stream-pacer.js';
import { closeStreamingMarkdown, renderMarkdownBlocks, renderMarkdown } from '../public/features/agent/markdown.js';

function simulate({ chunk = 24, gap = 600, chunks = 8 } = {}) {
  let clock = 0, text = '';
  const pacer = createStreamPacer({ now: () => clock });
  const perFrame = [];
  for (let i = 0; i < chunks; i++) {
    text += '字'.repeat(chunk);
    pacer.update(text);
    for (let t = 0; t < gap; t += 16) {
      const before = pacer.text.length;
      pacer.advance(16); clock += 16;
      perFrame.push(pacer.text.length - before);
    }
  }
  return { pacer, text, perFrame };
}

test('bursty updates are revealed at a steady pace without long stalls', () => {
  const { perFrame } = simulate();
  // Skip the warm-up of the first two bursts, then check the steady state.
  const steady = perFrame.slice(Math.ceil(1200 / 16));
  const idleFrames = steady.filter(count => count === 0).length;
  const longestIdle = steady.reduce((acc, count) => count ? { run: 0, max: acc.max } : { run: acc.run + 1, max: Math.max(acc.max, acc.run + 1) }, { run: 0, max: 0 }).max;
  assert.ok(Math.max(...steady) <= 3, `no frame reveals a large jump (max ${Math.max(...steady)})`);
  assert.ok(longestIdle <= 4, `text keeps flowing between bursts (idle run ${longestIdle})`);
  assert.ok(idleFrames / steady.length < 0.6);
});

test('the tail is revealed promptly once the reply ends', () => {
  let clock = 0;
  const pacer = createStreamPacer({ now: () => clock });
  pacer.update('开始');
  const final = '开始' + '尾'.repeat(200);
  pacer.update(final, { done: true });
  let elapsed = 0;
  while (!pacer.caughtUp && elapsed < 2000) { pacer.advance(16); elapsed += 16; clock += 16; }
  assert.equal(pacer.text, final);
  assert.ok(elapsed <= 900, `finished in ${elapsed}ms`);
});

test('immediate updates, rewrites and resets keep the visible text consistent', () => {
  const pacer = createStreamPacer({ now: () => 0 });
  pacer.update('已保存的内容', { immediate: true });
  assert.equal(pacer.text, '已保存的内容'); assert.ok(pacer.caughtUp);
  pacer.update('全新的回复');
  assert.equal(pacer.text, '');
  pacer.advance(64);
  assert.ok('全新的回复'.startsWith(pacer.text));
  pacer.update('');
  assert.equal(pacer.text, ''); assert.equal(pacer.target, '');
});

test('emoji and other multi-unit characters are never split', () => {
  const pacer = createStreamPacer({ now: () => 0 });
  pacer.update('😀😀😀😀', { done: true });
  while (!pacer.caughtUp) { pacer.advance(16); assert.ok(!/[\uD800-\uDBFF]$/.test(pacer.text)); }
});

test('streaming markdown hides markers that are still being typed', () => {
  assert.equal(closeStreamingMarkdown('这是**重点'), '这是**重点**');
  assert.equal(closeStreamingMarkdown('这是**'), '这是');
  assert.equal(closeStreamingMarkdown('这是*'), '这是');
  assert.equal(closeStreamingMarkdown('调用 `render'), '调用 `render`');
  assert.equal(closeStreamingMarkdown('**完成** 与 *斜体*'), '**完成** 与 *斜体*');
  assert.equal(closeStreamingMarkdown('```js\nconst a = **b'), '```js\nconst a = **b');
  assert.equal(closeStreamingMarkdown('第一行 **旧\n第二行'), '第一行 **旧\n第二行');
});

test('markdown blocks match the full render so finished blocks can stay mounted', () => {
  const source = '# 标题\n\n段落 **重点**\n\n- 一\n- 二\n\n```\ncode\n```';
  const blocks = renderMarkdownBlocks(source);
  assert.equal(blocks.length, 4);
  assert.equal(blocks.join(''), renderMarkdown(source));
  assert.deepEqual(renderMarkdownBlocks(source + '\n\n新段落').slice(0, 4), blocks);
});
