import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultVideoDuration } from '../public/features/generation/video-defaults.js';
import { normalizeShotVideoParameters } from '../public/features/drama/pure.js';
import { createCanvasGenerationDraft, reconcileCanvasGenerationDraft } from '../public/features/drama/canvas-generation.js';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const extract = (source, start, end) => {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, start);
  const until = source.indexOf(end, offset);
  assert.ok(until > offset, end);
  return source.slice(offset, until);
};
const defaults = [['minimax-h3-15s', 10], ['seedance-2.0', 15], ['seedance-2.5', 30]];
const config = { videoCapabilities:{ models:defaults.map(([id, max]) => ({
  id, availability:'available', modes:['TEXT', 'REFERENCE'].map(generationType => ({
    generationType, aspectRatios:['16:9', '9:16'], qualityOptions:['720p', '480p'],
    durations:Array.from({ length:id === 'minimax-h3-15s' ? 15 : max }, (_, i) => i + 1),
  })),
})) } };

test('video creation model changes select defaults and preserve subsequent manual choices', () => {
  const source = read('app.js');
  const selects = Object.fromEntries(['videoModel', 'videoDuration', 'videoResolution', 'videoAspect'].map(id => [id, { value:'' }]));
  const context = vm.createContext({
    $: selector => selects[selector.slice(1)], defaultVideoDuration,
    state:{ videoGenerationType:'TEXT', refs:{ video:[] }, videoFrames:{ first:'', last:'' } },
    videoModelModes: id => config.videoCapabilities.models.find(model => model.id === id).modes,
    videoGenerationParameters: id => ({ parameters:config.videoCapabilities.models.find(model => model.id === id).modes[0] }),
    supportsVideoMode: () => true, supportsVideoFirstLast: () => false,
    normalizeVideoReferenceIds: ids => ids,
    renderReferences() {}, renderVideoGenerationMode() {}, setProductSelectEnabled() {}, syncVideoPromptState() {}, updateVideoCost() {},
    setVideoSelectOptions(id, values, label, preferred, { preserveCurrent }) {
      const select = selects[id];
      select.value = String(preserveCurrent && values.map(String).includes(select.value) ? select.value : preferred);
    },
  });
  vm.runInContext(extract(source, 'function syncVideoModelParameters(', 'function closeProductSelects('), context);
  vm.runInContext(extract(source, "$('#videoModel').onchange =", "$('#videoDuration').onchange ="), context);
  for (const [modelId, duration] of [...defaults, ...defaults.slice().reverse()]) {
    selects.videoModel.value = modelId;
    selects.videoDuration.value = '5';
    selects.videoModel.onchange();
    assert.equal(selects.videoDuration.value, String(duration));
    selects.videoDuration.value = '5';
    context.syncVideoModelParameters();
    assert.equal(selects.videoDuration.value, '5');
  }
  assert.match(read('index.html'), /<option value="10" selected>10 秒<\/option>/);
});

test('short-drama workbench model changes replace compatible old durations with model defaults', () => {
  const source = read('drama-studio.js');
  for (const type of ['TEXT', 'REFERENCE']) {
    const shot = { id:'shot', duration:5, aspectRatio:'9:16', generation:{ type, modelId:'seedance-2.5', quality:'480p' } };
    const context = vm.createContext({
      state:{ config }, project:{ shots:[shot] }, defaultVideoDuration, normalizeShotVideoParameters,
      professionalVideoModels: () => config.videoCapabilities.models,
      professionalModelIsAvailable: () => true,
      invalidateProfessionalShot() {}, queueProfessionalSave() {}, toast: message => assert.fail(message),
    });
    vm.runInContext(extract(source, '  function ensureProfessionalVideoSettings(', '  function videoReferencePicker('), context);
    vm.runInContext(extract(source, '  const updateWorkbenchShot=', '  function bindWorkbenchShotSettings('), context);
    for (const [modelId, duration] of [...defaults, ...defaults.slice().reverse().slice(1)]) {
      shot.duration = 5;
      vm.runInContext(`updateWorkbenchShot('shot','generation.modelId','${modelId}')`, context);
      assert.equal(shot.duration, duration);
      assert.equal(shot.aspectRatio, '9:16');
      assert.equal(shot.generation.quality, '480p');
      shot.duration = 5;
      context.ensureProfessionalVideoSettings(shot);
      assert.equal(shot.duration, 5);
    }
  }
});

test('short-drama canvas creation and model changes select the same defaults', () => {
  const source = read('features/drama/director-workspace.js');
  const context = vm.createContext({
    reconcileCanvasGenerationDraft, generationConfig: () => config,
    fitGenerationAttachments() {}, resizeGenerationArea() {}, scheduleCanvasSave() {}, renderGenerationComposer() {},
  });
  vm.runInContext(extract(source, '  function applyGenerationField(', '  function renderGenerationComposer('), context);
  for (const [modelId, duration] of defaults) {
    const draft = createCanvasGenerationDraft('video', { videoCapabilities:{ models:config.videoCapabilities.models.filter(model => model.id === modelId) } });
    assert.equal(draft.duration, duration);
    draft.modelId = 'veo-31';
    draft.duration = 5;
    context.applyGenerationField(draft, 'modelId', modelId);
    assert.equal(draft.duration, duration);
    context.applyGenerationField(draft, 'duration', 5);
    reconcileCanvasGenerationDraft(draft, config);
    assert.equal(draft.duration, 5);
  }
});

test('defaults respect quality-specific duration limits and fixed-duration models', () => {
  assert.equal(defaultVideoDuration('seedance-2.5', [5, 7]), 5);
  assert.equal(defaultVideoDuration('veo-31', [8]), 8);
  assert.equal(defaultVideoDuration('minimax-h3-15s', []), 0);
});

test('video defaults refresh every versioned entry and shared import', () => {
  for (const [file, urls] of [
    ['index.html', ['/app.js?v=508']],
    ['app.js', ['./features/generation/video-defaults.js?v=2', './drama-studio.js?v=240', './features/agent/workspace.js?v=100']],
    ['drama-studio.js', ['./features/generation/video-defaults.js?v=2', './features/drama/director-workspace.js?v=135']],
    ['features/drama/canvas-generation.js', ['../generation/video-defaults.js?v=2']],
    ['features/drama/director-workspace.js', ['./canvas-generation.js?v=13', '../agent/model-preference-picker.js?v=11']],
    ['features/agent/model-preference-picker.js', ['../drama/canvas-generation.js?v=13']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=135', './model-preference-picker.js?v=11']],
  ]) for (const url of urls) assert.ok(read(file).includes(url), `${file}: ${url}`);
});
