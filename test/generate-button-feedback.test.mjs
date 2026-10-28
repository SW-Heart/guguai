import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const start = app.indexOf('async function submitGeneration(');
const source = app.slice(start, app.indexOf("$('#imageModel').addEventListener", start));

function feedbackContext(check, { cost = '12', credits = 100 } = {}) {
  const button = { dataset:{}, attributes:{}, classes:new Set(), label:{ textContent:'生成视频' },
    classList:{ add(name) { button.classes.add(name); }, remove(name) { button.classes.delete(name); } },
    querySelector:selector => selector === 'span:first-child' ? button.label : null,
    setAttribute(name, value) { button.attributes[name] = value; }, removeAttribute(name) { delete button.attributes[name]; } };
  const form = { querySelector:selector => selector === '.generate' ? button : null };
  const editors = { image:{ innerHTML:'', dispatchEvent() {} }, video:{ innerHTML:'', dispatchEvent() {} } };
  const state = { generationPreparations:[], credits, refs:{ image:[], video:[] }, videoFrames:{ first:'', last:'' }, imagePromptMentions:[], videoPromptMentions:[], files:[], tasks:[] };
  const messages = [];
  const context = vm.createContext({ state, generationSubmissionForms:new Set(), renderTasks:() => {}, toast:message => messages.push(message),
    crypto:{ randomUUID:() => 'group-1' }, setTimeout:() => 0, clearTimeout:() => {}, promptPrecheck:{ check },
    $:selector => (selector === '#imageCost' || selector === '#videoCost' ? { textContent:cost } : null),
    setCreditBalance:value => { state.credits = value; }, pendingReferenceJob:() => null, removeUploadJob() {}, renderReferences() {},
    Event:class {}, imagePromptEditor:() => editors.image, videoPromptEditor:() => editors.video,
    imagePromptText:() => editors.image.innerHTML, videoPromptText:() => editors.video.innerHTML,
    setImagePromptText:value => { editors.image.innerHTML = value; state.imagePromptMentions = []; },
    setVideoPromptText:value => { editors.video.innerHTML = value; state.videoPromptMentions = []; } });
  vm.runInContext(source, context);
  return { context, state, button, form, messages, editors };
}

test('clicking generate only presses the button and adds a progress card', async () => {
  let finishCheck;
  const { context, state, button, form } = feedbackContext(() => new Promise(resolve => { finishCheck = resolve; }));
  const preparation = context.startGenerationPreparation('video', form, { prompt:'视频' });
  const pending = context.checkPromptBeforeGeneration(preparation, { prompts:['视频'] });
  assert.equal(state.generationPreparations.length, 1);
  assert.ok(button.classes.has('is-pressed'));
  assert.equal(button.attributes['aria-busy'], undefined, 'the button never shows a busy state');
  assert.equal(button.label.textContent, '生成视频');
  assert.ok(context.generationSubmissionForms.has(form), 'one click submits once while the prompt check runs');
  finishCheck({ action:'submit', prompts:['视频'], fields:{} });
  assert.equal((await pending).action, 'submit');
  assert.equal(state.generationPreparations.length, 1);
});

test('the prompt, references and credits change the moment generate is pressed', () => {
  const { context, state, form, editors } = feedbackContext(async () => ({ action:'submit' }));
  editors.image.innerHTML = '一只猫';
  state.refs.image = ['ref-1'];
  context.startGenerationPreparation('image', form, { prompt:'一只猫', referenceIds:state.refs.image });
  assert.equal(editors.image.innerHTML, '');
  assert.equal(state.refs.image.length, 0);
  assert.equal(state.credits, 88);
});

test('a video whose route quote failed is charged at its configured price right away', () => {
  const { context, state, form, editors } = feedbackContext(async () => ({ action:'submit' }), { cost:'暂不可用' });
  Object.assign(context, { currentVideoQuoteInput:() => ({ modelId:'seedance-2.0', duration:10 }), configuredVideoCredits:input => input.duration * 3 });
  editors.video.innerHTML = '视频';
  context.startGenerationPreparation('video', form, { prompt:'视频' });
  assert.equal(state.credits, 70);
});

test('while a route quote is pending the button shows the configured price instead of waiting', () => {
  const start = app.indexOf('function updateVideoCost(');
  const cost = { textContent:'' };
  const timers = [];
  const context = vm.createContext({ $:selector => selector === '#videoCost' ? cost : {}, videoQuoteTimer:0, videoQuoteSequence:0, state:{ modelQuote:null, pricing:{} },
    clearTimeout() {}, setTimeout:callback => timers.push(callback), creditText:String,
    currentVideoQuoteInput:() => ({ modelId:'kling-4.0', duration:5 }), videoModelParameters:() => ({}), videoPricingFor:() => ({ unit:'second', amount:4 }) });
  vm.runInContext(app.slice(start, app.indexOf("$('#videoModel').onchange", start)), context);
  context.updateVideoCost();
  assert.equal(cost.textContent, '20');
  assert.equal(timers.length, 1, 'the route quote still follows');
});

test('cancelling the prompt check returns the prompt, references and credits', async () => {
  const { context, state, button, form, editors } = feedbackContext(async () => ({ action:'cancel' }));
  editors.image.innerHTML = '图片';
  state.refs.image = ['ref-1'];
  const preparation = context.startGenerationPreparation('image', form, { prompt:'图片', count:2, referenceIds:state.refs.image });
  assert.equal(state.generationPreparations.length, 2);
  assert.equal(await context.checkPromptBeforeGeneration(preparation, { prompts:['图片'] }), null);
  assert.equal(state.generationPreparations.length, 0);
  assert.equal(button.label.textContent, '生成视频');
  assert.equal(context.generationSubmissionForms.has(form), false);
  assert.equal(editors.image.innerHTML, '图片');
  assert.deepEqual(Array.from(state.refs.image), ['ref-1']);
  assert.equal(state.credits, 100);
});

function submissionFixture(api) {
  let finishUpload;
  const f = feedbackContext(async () => ({ action:'submit' }));
  Object.assign(f.context, {
    accountScope:{ snapshot:() => ({}), isCurrent:() => true }, needsReferenceUpload:() => false,
    resolveReferenceAssetIds:() => new Promise(resolve => { finishUpload = resolve; }), referenceCountsForIds:() => ({}),
    api, mergeTasksIntoLoadedHistory() {}, creditText:String, loadTasks:async () => {}, loadCredits:async () => {},
    syncImagePromptState() {}, updateImageCost() {}, console,
  });
  f.editors.image.innerHTML = '第一条';
  f.state.refs.image = ['ref-1'];
  const preparation = f.context.startGenerationPreparation('image', f.form, { prompt:'第一条', referenceIds:f.state.refs.image });
  const submitted = f.context.submitGeneration('image', f.form, { prompt:'第一条' }, preparation);
  return { ...f, submitted, finishUpload:ids => finishUpload(ids) };
}

test('the form is free for the next generation while references upload and the request runs', async () => {
  const f = submissionFixture(async () => ({ id:'task-1', creditCost:12, balance:88 }));
  assert.equal(f.context.generationSubmissionForms.has(f.form), false, 'a second generation can start before the first returns');
  f.editors.image.innerHTML = '第二条';
  f.finishUpload(['cloud-1']);
  await f.submitted;
  assert.equal(f.editors.image.innerHTML, '第二条', 'a prompt written for the next generation is kept');
  assert.equal(f.state.credits, 88);
});

test('a generation that cannot start refunds the shown credits and returns the composer', async () => {
  const f = submissionFixture(async () => { throw new Error('积分不足'); });
  assert.equal(f.state.credits, 88);
  f.finishUpload(['cloud-1']);
  await f.submitted;
  assert.equal(f.state.credits, 100);
  assert.equal(f.editors.image.innerHTML, '第一条');
  assert.deepEqual(Array.from(f.state.refs.image), ['ref-1']);
  assert.deepEqual(f.messages, ['积分不足']);
});

test('generate button sinks like a pressed key', () => {
  assert.match(css, /\.gradient-button\.generate:active:not\(:disabled\), \.gradient-button\.generate\.is-pressed \{ transform: translateY\(4px\)/);
  assert.match(css, /\.gradient-button\.generate \{ --generate-edge:[^}]*box-shadow: 0 4px 0 var\(--generate-edge\)/);
});
