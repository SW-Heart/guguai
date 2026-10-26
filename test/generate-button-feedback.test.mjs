import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const start = app.indexOf('async function submitGeneration(');
const source = app.slice(start, app.indexOf("$('#imageModel').addEventListener", start));

function feedbackContext(check) {
  const button = { dataset:{}, attributes:{}, classes:new Set(), label:{ textContent:'生成视频' },
    classList:{ add(name) { button.classes.add(name); }, remove(name) { button.classes.delete(name); } },
    querySelector:selector => selector === 'span:first-child' ? button.label : null,
    setAttribute(name, value) { button.attributes[name] = value; }, removeAttribute(name) { delete button.attributes[name]; } };
  const form = { querySelector:selector => selector === '.generate' ? button : null };
  const state = { generationPreparations:[] };
  const messages = [];
  const context = vm.createContext({ state, generationSubmissionForms:new Set(), renderTasks:() => {}, toast:message => messages.push(message),
    crypto:{ randomUUID:() => 'group-1' }, setTimeout:() => 0, clearTimeout:() => {}, promptPrecheck:{ check } });
  vm.runInContext(source, context);
  return { context, state, button, form, messages };
}

test('clicking generate shows a busy button and a progress card before the prompt check returns', async () => {
  let finishCheck;
  const { context, state, button, form } = feedbackContext(() => new Promise(resolve => { finishCheck = resolve; }));
  const preparation = context.startGenerationPreparation('video', form, { prompt:'视频' });
  const pending = context.checkPromptBeforeGeneration(preparation, { prompts:['视频'] });
  assert.equal(state.generationPreparations.length, 1);
  assert.equal(state.generationPreparations[0].progressStage, 'submitting');
  assert.equal(button.attributes['aria-busy'], 'true');
  assert.ok(button.classes.has('is-pressed'));
  assert.equal(button.label.textContent, '生成中…');
  assert.ok(context.generationSubmissionForms.has(form));
  finishCheck({ action:'submit', prompts:['视频'], fields:{} });
  assert.equal((await pending).action, 'submit');
  assert.equal(state.generationPreparations.length, 1);
});

test('cancelling the prompt check removes the progress card and restores the button', async () => {
  const { context, state, button, form } = feedbackContext(async () => ({ action:'cancel' }));
  const preparation = context.startGenerationPreparation('image', form, { prompt:'图片', count:2 });
  assert.equal(state.generationPreparations.length, 2);
  assert.equal(await context.checkPromptBeforeGeneration(preparation, { prompts:['图片'] }), null);
  assert.equal(state.generationPreparations.length, 0);
  assert.equal(button.attributes['aria-busy'], undefined);
  assert.equal(button.label.textContent, '生成视频');
  assert.equal(context.generationSubmissionForms.has(form), false);
});

test('generate button sinks like a pressed key', () => {
  assert.match(css, /\.gradient-button\.generate:active:not\(:disabled\), \.gradient-button\.generate\.is-pressed \{ transform: translateY\(4px\)/);
  assert.match(css, /\.gradient-button\.generate \{ --generate-edge:[^}]*box-shadow: 0 4px 0 var\(--generate-edge\)/);
});
