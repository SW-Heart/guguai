import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { openDatabase, closeDatabase, resetForTests } from '../lib/db.mjs';
import { listModelControls, isImageModelAvailable, withModelDescriptions, updateModelControl } from '../lib/model-controls.mjs';
import { canvasGenerationModels } from '../public/features/drama/canvas-generation.js';

const server = readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const app = readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('image pickers preserve backend sort numbers and follow subsequent admin reordering', () => {
  resetForTests(); openDatabase({file:':memory:'});
  try {
    const catalog = ['nano-banana-2.1','midjourney','gpt-image-2.5','gpt-image-2'].map(id => ({id}));
    const before = structuredClone(catalog);
    const context = vm.createContext({imageModelCatalog:catalog,listModelControls,withModelDescriptions,isImageModelAvailable:id => isImageModelAvailable(id,{DUOMI_API_KEY:'test',TUZI_DEFAULT_API_KEY:'test'})});
    vm.runInContext(server.slice(server.indexOf('function availableImageModels()'),server.indexOf('const invitationCodes')),context);
    const menu = vm.createContext({state:{config:{}}});
    vm.runInContext(app.slice(app.indexOf('function imageModelOptions()'),app.indexOf('function imageModelPromo()')),menu);
    const verify = expected => {
      const models = context.availableImageModels();
      assert.deepEqual(Array.from(models,m => m.id),expected);
      menu.state.config.imageModels = models;
      assert.deepEqual(Array.from(menu.imageModelOptions(),m => m.id),expected);
      assert.deepEqual(Array.from(canvasGenerationModels('image',{imageModels:models}),m => m.id),expected);
    };
    verify(['gpt-image-2','gpt-image-2.5','midjourney','nano-banana-2.1']);
    updateModelControl('nano-banana-2.1',{sortOrder:0},{actorUserId:null});
    verify(['nano-banana-2.1','gpt-image-2','gpt-image-2.5','midjourney']);
    updateModelControl('gpt-image-2',{userVisible:false},{actorUserId:null});
    verify(['nano-banana-2.1','gpt-image-2.5','midjourney']);
    assert.deepEqual(catalog,before);
  } finally {closeDatabase({checkpoint:false});resetForTests();}
});
