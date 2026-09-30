import assert from 'node:assert/strict';
import test from 'node:test';
import { createCreditPresentation } from '../public/features/credits/presentation.js';
import { createGenerationPresentation } from '../public/features/generation/presentation.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

test('credit presentation keeps wallet units and task-derived labels deterministic', () => {
  const state = {
    tasks: [{ id: 'generation-1', type: 'image', status: 'completed' }],
    config: { videoCapabilities: { models: [{ id: 'video-model', label: '视频模型' }] } },
  };
  const presentation = createCreditPresentation({ getState: () => state, escapeHtml, formatFullDate: value => `FULL:${value}` });
  assert.equal(presentation.creditEntryAmount({ amountMicro: 1_250_000 }), 1.25);
  assert.equal(presentation.creditGenerationType({ generationId: 'generation-1' }), '图像生成');
  assert.equal(presentation.creditModelName({ modelId: 'video-model' }), '视频模型');
  assert.equal(presentation.creditDateText('invalid'), '—');
  assert.match(presentation.renderCreditRows([{ amount: -1.25, generationId: 'generation-1', createdAt: '2026-01-02' }], 'spend'), /-1\.25/);
});

test('compact credit text fits the sidebar and never rounds up', () => {
  const { compactCreditText } = createCreditPresentation();
  assert.equal(compactCreditText(9812.6268), '9812');
  assert.equal(compactCreditText(99.99), '99.9');
  assert.equal(compactCreditText(0.04), '0');
  assert.equal(compactCreditText(-0.04), '0');
  assert.equal(compactCreditText(-12.5), '-12.5');
  assert.equal(compactCreditText(12_999), '1.2万');
  assert.equal(compactCreditText(1_239_999), '123万');
  assert.equal(compactCreditText(250_000_000), '2.5亿');
  assert.equal(compactCreditText('bad'), '0');
});

test('account controls live in the sidebar dock instead of the topbar', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  const rail = html.slice(html.indexOf('<nav id="appRail"'), html.indexOf('<aside id="agentHistory"'));
  for (const id of ['modelPriceButton', 'creditControl', 'creditBalance', 'creditAmount', 'creditDetailPopover', 'creditPurchaseButton', 'accountButton', 'accountMenu', 'serviceState']) {
    assert.ok(!topbar.includes(`id="${id}"`), `${id} left the topbar`);
    assert.ok(rail.includes(`id="${id}"`), `${id} is in the sidebar`);
  }
  // A single copy of the credit tables remains, inside the detail dialog.
  assert.equal(html.match(/id="creditSpendBody"/g).length, 1);
});

test('generation presentation only renders valid active progress', () => {
  const presentation = createGenerationPresentation({ escapeHtml });
  assert.equal(presentation.taskProgress({ progress: 101 }), null);
  assert.equal(presentation.taskProgress({ progress: 42.4 }), 42);
  assert.equal(presentation.videoProgressMarkup({ type: 'video', status: 'running', progress: 42, progressStage: 'provider_processing' }).includes('42%'), true);
  assert.match(presentation.videoProgressMarkup({ type: 'video', status: 'running', progress: 42, progressStage: 'polling_retry' }), /正在重试获取进度/);
  assert.equal(presentation.videoProgressMarkup({ type: 'image', status: 'running', progress: 42 }), '');
  assert.match(presentation.generationPreparationMarkup({ localPreparation: true, progressStage: 'submitting' }), /正在准备生成/);
});
