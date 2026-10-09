import test from 'node:test';
import assert from 'node:assert/strict';
import { createDramaStyleDialog } from '../public/features/drama/style-dialog.js';

function harness(t, { onCreate = async () => true, onChange = async () => true, emptyCatalog = false } = {}) {
  const dialogs = [], messages = [], request = { projectId:'current' };
  let current = true;
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; });
  globalThis.document = {
    body:{ append() {} },
    createElement() {
      const dialog = {
        open:false, buttons:[], selection:{},
        setAttribute() {}, addEventListener() {},
        showModal() { this.open = true; }, close() { this.open = false; },
        set innerHTML(value) {
          this.buttons = [...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, textContent]) => ({
            attributes, textContent, disabled:/\bdisabled\b/.test(attributes),
          }));
        },
        querySelectorAll(selector) {
          return selector === 'button' ? this.buttons : this.buttons.filter(button => button.attributes.includes(selector.slice(1, -1)));
        },
        querySelector(selector) {
          return selector === '[data-selection]' ? this.selection : this.querySelectorAll(selector)[0] || null;
        },
      };
      dialogs.push(dialog);
      return dialog;
    },
  };
  const preset = { id:'live-action', name:'真人影视', description:'自然画面', coverUrl:'/cover.png' };
  const controller = createDramaStyleDialog({
    api:async () => ({ styles:emptyCatalog ? [] : [preset] }), esc:String, toast:message => messages.push(message),
    onCreate, onChange, isCurrent:value => current && value === request,
  });
  return { controller, request, preset, messages, picker:() => dialogs[0], stale:() => { current = false; } };
}

test('skip creates without a style even with the default preset selected', async t => {
  const calls = [];
  const h = harness(t, { onCreate:async (...args) => { calls.push(args); return true; } });
  await h.controller.open({ request:h.request });
  assert.equal(h.picker().querySelector('[data-skip]').textContent, '暂不选择直接进入');
  await h.picker().querySelector('[data-skip]').onclick();
  assert.deepEqual(calls, [[null, h.request]]);
  assert.equal(h.picker().open, false);
});

test('regular creation keeps the chosen style and editing offers no skip action', async t => {
  const created = [], changed = [];
  const h = harness(t, {
    onCreate:async style => { created.push(style); return true; },
    onChange:async style => { changed.push(style); return true; },
  });
  await h.controller.open({ request:h.request });
  await h.picker().querySelector('[data-submit]').onclick();
  assert.deepEqual(created, [h.preset]);
  await h.controller.open({ style:h.preset, edit:true, request:h.request });
  assert.equal(h.picker().querySelector('[data-skip]'), null);
  await h.picker().querySelector('[data-submit]').onclick();
  assert.deepEqual(changed, [h.preset]);
});

test('skip disables actions while creating and a failure allows retry', async t => {
  let finish, calls = 0;
  const h = harness(t, { onCreate:() => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await h.controller.open({ request:h.request });
  const skip = h.picker().querySelector('[data-skip]');
  const pending = skip.onclick();
  assert.equal(skip.textContent, '正在创建…');
  assert.ok(h.picker().buttons.every(button => button.disabled));
  await skip.onclick();
  assert.equal(calls, 1);
  finish(false);
  await pending;
  assert.equal(h.picker().open, true);
  assert.equal(h.picker().querySelector('[data-skip]').disabled, false);
  const retry = h.picker().querySelector('[data-skip]').onclick();
  finish(true);
  await retry;
  assert.equal(calls, 2);
  assert.equal(h.picker().open, false);
});

test('skip works without available presets and ignores an outdated project request', async t => {
  let calls = 0;
  const h = harness(t, { emptyCatalog:true, onCreate:async style => { assert.equal(style, null); calls++; return true; } });
  await h.controller.open({ request:h.request });
  assert.equal(h.picker().querySelector('[data-submit]').disabled, true);
  await h.picker().querySelector('[data-skip]').onclick();
  assert.equal(calls, 1);
  await h.controller.open({ request:h.request });
  h.stale();
  await h.picker().querySelector('[data-skip]').onclick();
  assert.equal(calls, 1);
});
