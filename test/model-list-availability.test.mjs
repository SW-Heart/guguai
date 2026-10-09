import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canvasGenerationModels, reconcileCanvasGenerationDraft } from '../public/features/drama/canvas-generation.js';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const app = read('app.js');
const drama = read('drama-studio.js');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const mode = { generationType:'TEXT', aspectRatios:['16:9'], durations:[8], qualityOptions:['720p'] };
const models = [
  { id:'veo', label:'即将上线模型', enabled:false, availability:'coming-soon', modes:[mode] },
  { id:'soon-enabled', enabled:true, availability:'coming-soon', modes:[mode] },
  { id:'disabled', enabled:false, modes:[mode] },
  { id:'empty', modes:[{...mode, qualityOptions:[]}] },
  { id:'failed', availability:'unavailable', modes:[mode] },
  { id:'veo-31', label:'Veo 3.1', enabled:true, availability:'available', modes:[mode] },
];
const config = { videoCapabilities:{ models }, imageModels:[
  { id:'gpt-image-2', enabled:false },
  { id:'soon-image', availability:'coming-soon' },
  { id:'gpt-image-2.5', enabled:true },
] };

test('workbench model catalogs hide coming-soon and disabled models, including fallback entries', () => {
  const context = vm.createContext({ state:{ config } });
  vm.runInContext(extract(app, 'const fallbackVideoModels =', 'const modelIconUrls ='), context);
  assert.deepEqual(Array.from(context.videoModelOptions(), model => model.id), ['veo-31']);
  assert.deepEqual(Array.from(context.imageModelOptions(), model => model.id), ['gpt-image-2.5']);
  context.state.config = {};
  assert.equal(context.videoModelOptions().length, 0);
  assert.ok(context.videoModelOptions().every(model => model.availability !== 'coming-soon'));
  context.state.config = { videoCapabilities:{ models:[] }, imageModels:[] };
  assert.equal(context.videoModelOptions().length, 0);
  assert.equal(context.imageModelOptions().length, 0);
});

test('storyboard models require availability and a compatible generation mode', () => {
  const context = vm.createContext({ state:{ config } });
  vm.runInContext(extract(drama, 'const professionalModelIsAvailable=', 'function professionalModelIcon('), context);
  vm.runInContext(extract(drama, 'function professionalVideoModels(', 'function professionalVideoParameters('), context);
  assert.deepEqual(Array.from(context.professionalVideoModels({ generation:{ type:'TEXT' } }), model => model.id), ['veo-31']);
  assert.equal(context.professionalVideoModels({ generation:{ type:'FIRST&LAST' } }).length, 0);
});

test('video menus preserve backend ordering across catalog refreshes without mutating it', () => {
  const grokMode = { ...mode, durations:[8, 30] };
  const catalog = [
    { id:'grok', modes:[grokMode] },
    { id:'new-model', modes:[mode] },
    { id:'disabled', enabled:false, modes:[mode] },
    { id:'seedance-2.0', modes:[mode] },
    { id:'minimax-h3-15s', modes:[mode] },
  ];
  const config = { videoCapabilities:{ models:catalog } };
  const context = vm.createContext({ state:{ config } });
  vm.runInContext(extract(app, 'const fallbackVideoModels =', 'const modelIconUrls ='), context);
  vm.runInContext(extract(drama, 'const professionalModelIsAvailable=', 'function professionalModelIcon('), context);
  vm.runInContext(extract(drama, 'function professionalVideoModels(', 'function professionalVideoParameters('), context);
  const snapshot = structuredClone(catalog);
  for (const ids of [
    ['grok', 'new-model', 'seedance-2.0', 'minimax-h3-15s'],
    ['minimax-h3-15s', 'seedance-2.0', 'new-model', 'grok'],
  ]) {
    config.videoCapabilities.models = ids.map(id => catalog.find(model => model.id === id));
    config.videoCapabilities.models.splice(1, 0, catalog.find(model => model.id === 'disabled'));
    const menus = [context.videoModelOptions(), context.professionalVideoModels({ generation:{ type:'TEXT' } }), canvasGenerationModels('video', config)];
    for (const menu of menus) {
      assert.deepEqual(Array.from(menu, model => model.id), ids);
      assert.deepEqual(Array.from(menu.find(model => model.id === 'grok').modes[0].durations), [8]);
    }
  }
  assert.deepEqual(catalog, snapshot);
});

test('storyboard menu does not reinsert an unavailable saved model', () => {
  const context = vm.createContext({ esc:String, professionalSelectIcon:() => '' });
  vm.runInContext(extract(drama, 'const professionalModelIsAvailable=', 'function professionalModelIcon('), context);
  vm.runInContext(extract(drama, 'function professionalSelectMarkup(', 'function closeProfessionalVideoSelects('), context);
  const markup = context.professionalSelectMarkup('modelId', 'model', models.map(model => ({ ...model, value:model.id })), 'veo');
  assert.match(markup, /data-value="veo-31"/);
  assert.doesNotMatch(markup, /即将上线|data-value="(?:veo|soon-enabled|disabled)"/);
});

test('canvas catalogs and restored selections contain only available models', () => {
  assert.deepEqual(canvasGenerationModels('image', {}), []);
  assert.deepEqual(canvasGenerationModels('video', {}), []);
  assert.deepEqual(canvasGenerationModels('video', config).map(model => model.id), ['veo-31']);
  assert.deepEqual(canvasGenerationModels('image', config).map(model => model.id), ['gpt-image-2.5']);
  const draft = { type:'video', modelId:'veo', mode:'TEXT', aspect:'16:9', quality:'720p', duration:8 };
  reconcileCanvasGenerationDraft(draft, config);
  assert.equal(draft.modelId, 'veo-31');
  reconcileCanvasGenerationDraft(draft, { videoCapabilities:{ models:models.slice(0, 3) } });
  assert.equal(draft.modelId, '');
});

test('model list changes have refreshed cache keys through every importing entry', () => {
  const entries = [
    ['index.html', ['/app.js?v=504']],
    ['app.js', ['./drama-studio.js?v=239', './features/agent/workspace.js?v=99']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=134']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=134', './model-preference-picker.js?v=11']],
    ['features/drama/director-workspace.js', ['./canvas-generation.js?v=13', '../agent/model-preference-picker.js?v=11']],
    ['features/agent/model-preference-picker.js', ['../drama/canvas-generation.js?v=13']],
  ];
  for (const [file, urls] of entries) {
    const source = read(file);
    for (const url of urls) assert.ok(source.includes(url), `${file}: ${url}`);
  }
  assert.doesNotMatch(read('index.html'), /即将上线|data-availability="coming-soon"/);
});

test('Seedance 2.0 Fast can be selected in the workbench, storyboard and canvas', () => {
  const config = { videoCapabilities:{ models:[{ id:'seedance-2.0-fast', enabled:true, modes:[mode] }] } };
  const context = vm.createContext({ state:{ config } });
  vm.runInContext(extract(app, 'const fallbackVideoModels =', 'const modelIconUrls ='), context);
  assert.deepEqual(Array.from(context.videoModelOptions(), model => model.id), ['seedance-2.0-fast']);
  vm.runInContext(extract(drama, 'const professionalModelIsAvailable=', 'function professionalModelIcon('), context);
  vm.runInContext(extract(drama, 'function professionalVideoModels(', 'function professionalVideoParameters('), context);
  assert.deepEqual(Array.from(context.professionalVideoModels({ generation:{ type:'TEXT' } }), model => model.id), ['seedance-2.0-fast']);
  assert.deepEqual(canvasGenerationModels('video', config).map(model => model.id), ['seedance-2.0-fast']);
  config.videoCapabilities.models[0].enabled = false;
  assert.equal(context.videoModelOptions().length, 0);
  assert.equal(context.professionalVideoModels({ generation:{ type:'TEXT' } }).length, 0);
  assert.equal(canvasGenerationModels('video', config).length, 0);
});

test('Seedance 2.0 Mini can be selected in the workbench, storyboard and canvas', () => {
  const config = { videoCapabilities:{ models:[{ id:'seedance-2.0-mini', enabled:true, modes:[mode] }] } };
  const context = vm.createContext({ state:{ config } });
  vm.runInContext(extract(app, 'const fallbackVideoModels =', 'const modelIconUrls ='), context);
  assert.deepEqual(Array.from(context.videoModelOptions(), model => model.id), ['seedance-2.0-mini']);
  vm.runInContext(extract(drama, 'const professionalModelIsAvailable=', 'function professionalModelIcon('), context);
  vm.runInContext(extract(drama, 'function professionalVideoModels(', 'function professionalVideoParameters('), context);
  assert.deepEqual(Array.from(context.professionalVideoModels({ generation:{ type:'TEXT' } }), model => model.id), ['seedance-2.0-mini']);
  assert.deepEqual(canvasGenerationModels('video', config).map(model => model.id), ['seedance-2.0-mini']);
  config.videoCapabilities.models[0].enabled = false;
  assert.equal(context.videoModelOptions().length, 0);
  assert.equal(context.professionalVideoModels({ generation:{ type:'TEXT' } }).length, 0);
  assert.equal(canvasGenerationModels('video', config).length, 0);
});
