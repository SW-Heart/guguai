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
  assert.ok(context.videoModelOptions().length > 0);
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

test('storyboard menu does not reinsert an unavailable saved model', () => {
  const context = vm.createContext({ esc:String, professionalSelectIcon:() => '' });
  vm.runInContext(extract(drama, 'const professionalModelIsAvailable=', 'function professionalModelIcon('), context);
  vm.runInContext(extract(drama, 'function professionalSelectMarkup(', 'function closeProfessionalVideoSelects('), context);
  const markup = context.professionalSelectMarkup('modelId', 'model', models.map(model => ({ ...model, value:model.id })), 'veo');
  assert.match(markup, /data-value="veo-31"/);
  assert.doesNotMatch(markup, /即将上线|data-value="(?:veo|soon-enabled|disabled)"/);
});

test('canvas catalogs and restored selections contain only available models', () => {
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
    ['index.html', ['/app.js?v=471']],
    ['app.js', ['./drama-studio.js?v=212', './features/agent/workspace.js?v=82']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=118']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=118', './model-preference-picker.js?v=5']],
    ['features/drama/director-workspace.js', ['./canvas-generation.js?v=6', '../agent/model-preference-picker.js?v=5']],
    ['features/agent/model-preference-picker.js', ['../drama/canvas-generation.js?v=6']],
  ];
  for (const [file, urls] of entries) {
    const source = read(file);
    for (const url of urls) assert.ok(source.includes(url), `${file}: ${url}`);
  }
  assert.doesNotMatch(read('index.html'), /即将上线|data-availability="coming-soon"/);
});
