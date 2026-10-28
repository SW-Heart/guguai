import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
const generateSource = source.slice(source.indexOf('  async function generateProfessionalVideo(){'), source.indexOf('  async function selectProfessionalVideo('));

for (const modelId of ['seedance-2.0', 'minimax-h3-15s']) {
  test(`${modelId}: save selection changes and quote edits cannot mix shot inputs`, async () => {
    const shots = [1, 2].map(n => ({ id:`shot-${n}`, script:`分镜${n}内容`, duration:15, aspectRatio:'9:16', generation:{ modelId, type:'REFERENCE', quality:'720p', count:1 }, refs:[`image-${n}`] }));
    let selected = shots[1];
    let submitted;
    const context = {
      projectBaseSnapshot:null, promptPrecheck:{check:async({prompts})=>({action:'submit',prompts,fields:{}})}, project:{ id:'project', shots }, professionalGenerationPending:new Map(),professionalGenerationChecking:new Set(),refreshProfessionalPrices:()=>Promise.resolve(),
      currentProfessionalShot:() => selected, projectRequest:() => ({}),
      ensureProfessionalVideoSettings:() => {}, professionalProductionWarning:() => '', shotGenerationReady:() => true,
      render:() => {}, flushSave:async () => { selected = shots[0]; },
      isProjectRequestCurrent:() => true, cloneProjectValue:structuredClone,
      shotGenerationAssetIds:shot => shot.refs, videoRequestShot:shot => shot,
      shotVideoPrompt:shot => shot.script,
      ensureCloudReferenceIds:async refs => { shots[1].script='异步期间修改'; shots[1].generation.quality='480p'; return refs; },
      professionalVideoUsesDynamicQuote:() => modelId === 'seedance-2.0',
      requestProfessionalVideoQuote:async shot => { assert.equal(shot.id, 'shot-2'); assert.equal(shot.generation.quality, '720p'); return { priceVersion:'quote-2' }; },
      api:async (_url, options) => { submitted=JSON.parse(options.body); return { id:'task-2', balance:100 }; },
      setCreditBalance:() => {}, state:{ tasks:[] }, scheduleTaskPoll:() => {}, loadTasks:async () => {},
      toast:() => {}, loadCredits:async () => {},
    };
    vm.createContext(context);
    vm.runInContext(generateSource, context);
    await context.generateProfessionalVideo();
    assert.ok(submitted);
    assert.equal(submitted.dramaShotId, 'shot-2');
    assert.equal(submitted.prompt, '分镜2内容');
    assert.equal(submitted.modelId, modelId);
    assert.equal(submitted.quality, '720p');
    assert.deepEqual(submitted.referenceAssetIds, ['image-2']);
    assert.equal(context.professionalGenerationPending.size, 0);
  });
}

test('a shot can be generated again while the previous click is still being submitted', async () => {
  const shot = { id:'shot-1', script:'分镜内容', duration:15, aspectRatio:'9:16', generation:{ modelId:'seedance-2.0', type:'REFERENCE', quality:'720p', count:2 }, refs:[] };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const submissions = [];
  const context = {
    projectBaseSnapshot:null, promptPrecheck:{ check:async ({ prompts }) => ({ action:'submit', prompts, fields:{} }) }, project:{ id:'project', shots:[shot] },
    professionalGenerationPending:new Map(), professionalGenerationChecking:new Set(), refreshProfessionalPrices:() => Promise.resolve(),
    currentProfessionalShot:() => shot, projectRequest:() => ({}), ensureProfessionalVideoSettings:() => {}, professionalProductionWarning:() => '', shotGenerationReady:() => true,
    render:() => {}, flushSave:async () => {}, isProjectRequestCurrent:() => true, cloneProjectValue:structuredClone,
    shotGenerationAssetIds:item => item.refs, videoRequestShot:item => item, shotVideoPrompt:item => item.script, ensureCloudReferenceIds:async refs => refs,
    api:async (_url, options) => { submissions.push(JSON.parse(options.body)); await gate; return { id:`task-${submissions.length}`, balance:100 }; },
    setCreditBalance:() => {}, state:{ tasks:[] }, scheduleTaskPoll:() => {}, toast:() => {}, loadCredits:async () => {},
  };
  vm.createContext(context);
  vm.runInContext(generateSource, context);
  const first = context.generateProfessionalVideo();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.professionalGenerationChecking.size, 0, 'the click is released once the request is on its way');
  const second = context.generateProfessionalVideo();
  assert.equal(context.professionalGenerationPending.get('shot-1'), 4, 'each click shows its own pending versions');
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(submissions.length, 2);
  assert.equal(context.professionalGenerationPending.size, 0);
});
