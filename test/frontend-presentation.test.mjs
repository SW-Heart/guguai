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

test('generation presentation only renders valid active progress', () => {
  const presentation = createGenerationPresentation({ escapeHtml });
  assert.equal(presentation.taskProgress({ progress: 101 }), null);
  assert.equal(presentation.taskProgress({ progress: 42.4 }), 42);
  assert.equal(presentation.videoProgressMarkup({ type: 'video', status: 'running', progress: 42, progressStage: 'provider_processing' }).includes('42%'), true);
  assert.match(presentation.videoProgressMarkup({ type: 'video', status: 'running', progress: 42, progressStage: 'polling_retry' }), /正在重试获取进度/);
  assert.equal(presentation.videoProgressMarkup({ type: 'image', status: 'running', progress: 42 }), '');
  assert.match(presentation.generationPreparationMarkup({ localPreparation: true, progressStage: 'submitting' }), /正在提交生成/);
});
