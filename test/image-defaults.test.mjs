import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

// A <select> stand-in: value only accepts one of its current options.
function fakeSelect(values = [], selected = '') {
  let options = [...values], value = selected;
  return {
    get options() { return options.map(item => ({ value:item })); },
    set innerHTML(markup) { options = [...markup.matchAll(/value="([^"]*)"/g)].map(match => match[1]); value = options[0] || ''; },
    get value() { return value; },
    set value(next) { value = options.includes(next) ? next : ''; },
  };
}

function imageControls(models) {
  const elements = {
    '#imageModel': fakeSelect(),
    '.product-select[data-for="imageModel"]': { dataset:{} },
    '#imageQuality': fakeSelect(['low', 'medium', 'high'], 'medium'),
    '.segmented[data-select="imageQuality"]': {
      querySelectorAll:() => [0, 1, 2].map(() => ({ dataset:{} })),
      parentElement:{ querySelector:() => ({}) },
    },
  };
  const toggle = { classList:{ toggle:() => {} } };
  const context = vm.createContext({
    $:selector => elements[selector] || toggle,
    esc:value => String(value),
    imageModelOptions:() => models,
    refreshProductSelect:() => {}, syncImageSizeChoices:() => {}, syncSegmentedControl:() => {},
    syncTuziImageParameters:() => {}, syncImageQuantityControl:() => {}, syncImagePromptState:() => {}, updateImageCost:() => {},
  });
  vm.runInContext(extract('function syncImageModelOptions()', 'function syncVideoModelOptions()'), context);
  vm.runInContext(extract('// A new model starts at its lowest resolution', 'function currentMidjourneyOptions()'), context);
  return { context, model:elements['#imageModel'], quality:elements['#imageQuality'] };
}

test('the image page has no built-in default model', () => {
  assert.match(html, /<select id="imageModel" class="native-hidden"><\/select>/);
});

test('the image page selects the first model in the configured order', () => {
  const { context, model } = imageControls([{ id:'seedream-5.5' }, { id:'gpt-image-2.5' }, { id:'midjourney' }]);
  context.syncImageModelOptions();
  assert.equal(model.value, 'seedream-5.5');
  model.value = 'midjourney';
  context.syncImageModelOptions();
  assert.equal(model.value, 'midjourney', 'a model the user picked stays selected when the list refreshes');
});

test('a resolution-based image model starts at its lowest resolution', () => {
  const { context, model, quality } = imageControls([{ id:'seedream-5.0' }, { id:'seedream-5.5' }, { id:'nano-banana-2.1' }]);
  context.syncImageModelOptions();
  assert.equal(quality.value, '2k', 'Seedream 5.0 starts at 2K, its lowest');
  model.value = 'seedream-5.5';
  context.syncImageModelParameters();
  assert.equal(quality.value, '1k', 'switching from Seedream 5.0 at 2K does not carry 2K over');
  quality.value = '1.5k';
  context.syncImageModelParameters();
  assert.equal(quality.value, '1.5k', 'refreshing the same model keeps the chosen resolution');
  model.value = 'nano-banana-2.1';
  context.syncImageModelParameters();
  assert.equal(quality.value, '1k');
});
