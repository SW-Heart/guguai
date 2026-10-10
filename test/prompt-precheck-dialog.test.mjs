import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countMarks, createPromptPrecheck, markedHtml, shiftMarks, statusText, submissionFields } from '../public/features/prompt-precheck/guard.js';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('marks follow edits made before them and drop when their text is touched', () => {
  const hits = [{ start:2, end:4, level:'suspect' }, { start:8, end:10, level:'banned' }];
  assert.deepEqual(shiftMarks(hits, '0123456789', 'xx0123456789'), [{ start:4, end:6, level:'suspect' }, { start:10, end:12, level:'banned' }]);
  assert.deepEqual(shiftMarks(hits, '0123456789', '01234567'), [{ start:2, end:4, level:'suspect' }]);
  assert.deepEqual(shiftMarks(hits, '0123456789', '0156789'), [{ start:5, end:7, level:'banned' }]);
  assert.equal(shiftMarks(hits, 'same', 'same'), hits);
});

test('the mirror escapes text, wraps marks and keeps a trailing line', () => {
  const html = markedHtml('<b>斩首\n', [{ start:3, end:5, level:'banned' }]);
  assert.equal(html, '&lt;b&gt;<mark class="precheck-mark is-banned">斩首</mark>\n​');
  assert.equal(markedHtml('ab', [{ start:0, end:9, level:'suspect' }]), 'ab​');
});

test('status copy and submission fields stay in plain user language', () => {
  assert.deepEqual(countMarks([{ level:'banned' }, { level:'suspect' }, { level:'suspect' }]), { banned:1, suspect:2 });
  assert.equal(statusText({ banned:1, suspect:2 }), '1 处很可能导致失败 · 2 处可能被拦截');
  assert.equal(statusText({ banned:0, suspect:0 }), '未发现可能导致失败的内容');
  assert.deepEqual(submissionFields({ source:'image', hadMarks:false }), { precheckSource:'image' });
  assert.deepEqual(submissionFields({ source:'video', hadMarks:true, edited:true }), { precheckSource:'video', precheckOutcome:'edited' });
  assert.deepEqual(submissionFields({ source:'video', hadMarks:true }), { precheckSource:'video', precheckOutcome:'submitted_as_is' });
  assert.deepEqual(submissionFields({ source:'drama', hadMarks:true, edited:true, confirmed:true }), { precheckSource:'drama', precheckOutcome:'confirmed_banned', precheckConfirmed:true });
});

test('the check never blocks when it cannot or should not show the dialog', async () => {
  const cases = [
    async () => { throw new Error('timeout'); },
    async () => ({ mode:'shadow', results:[{ hits:[{ start:0, end:2, level:'banned', label:'x' }] }] }),
    async () => ({ mode:'enforce', results:[{ hits:[] }] }),
  ];
  for (const api of cases) {
    const guard = createPromptPrecheck({ api, documentRef:null });
    assert.deepEqual(await guard.check({ prompts:['夜晚街头'], source:'image' }), { action:'submit', prompts:['夜晚街头'], fields:{ precheckSource:'image' } });
  }
});

test('a second check while one is running is ignored', async () => {
  let release;
  const guard = createPromptPrecheck({ api:() => new Promise(resolve => { release = () => resolve({ mode:'off', results:[{ hits:[] }] }); }), documentRef:null });
  const first = guard.check({ prompts:['a'], source:'image' });
  assert.deepEqual(await guard.check({ prompts:['a'], source:'image' }), { action:'cancel' });
  release();
  assert.equal((await first).action, 'submit');
});

test('editing and Chinese composition update marks immediately and submit the edited text', async () => {
  // Minimal DOM double exercises the dialog's actual input listeners without opening a client.
  const elements = [];
  const createElement = () => {
    const children = new Map(), listeners = new Map();
    const element = {
      hidden:false, open:false, scrollTop:0, classList:{ toggle() {} },
      setAttribute() {}, append() {}, focus() {}, setSelectionRange() {},
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, createElement());
        return children.get(selector);
      },
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
      emit(name, event = {}) { listeners.get(name)?.(event); },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
    elements.push(element);
    return element;
  };
  let scans = 0;
  const guard = createPromptPrecheck({
    documentRef:{ createElement, body:{ append() {} } }, delay:60_000,
    api:async () => {
      scans++;
      return { mode:'enforce', results:[{ hits:[{ start:0, end:3, level:'suspect', label:'未成年人' }] }] };
    },
  });
  const result = guard.check({ prompts:['16岁的角色'], source:'image' });
  await new Promise(resolve => setImmediate(resolve));
  const root = elements[0];
  const section = elements.find(element => element.className === 'prompt-precheck-item');
  const textarea = section.querySelector('textarea'), mirror = section.querySelector('.prompt-precheck-mirror');
  textarea.value = '成年角色';
  textarea.scrollTop = 24;
  textarea.emit('input');
  assert.equal(mirror.innerHTML, '成年角色​');
  assert.equal(mirror.scrollTop, 24);
  textarea.emit('compositionstart');
  textarea.value = '成年角色站在街头';
  textarea.emit('input');
  assert.equal(mirror.innerHTML, '成年角色站在街头​');
  assert.equal(scans, 1);
  textarea.emit('compositionend');
  root.emit('click', { target:{ closest:selector => selector === '[data-precheck-submit]' } });
  assert.deepEqual(await result, { action:'submit', prompts:['成年角色站在街头'], fields:{ precheckSource:'image', precheckOutcome:'edited' } });
  assert.equal(root.open, false);
});

test('confirming red marks opens a separate dialog above the editor', async () => {
  const elements = [];
  const createElement = () => {
    const children = new Map(), listeners = new Map();
    const element = {
      hidden:false, open:false, scrollTop:0, classList:{ toggle() {} },
      setAttribute() {}, append() {}, focus() {}, setSelectionRange() {},
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, createElement());
        return children.get(selector);
      },
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
      emit(name, event = {}) { listeners.get(name)?.(event); },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
    elements.push(element);
    return element;
  };
  const guard = createPromptPrecheck({
    documentRef:{ createElement, body:{ append() {} } }, delay:60_000,
    api:async () => ({ mode:'enforce', results:[{ hits:[{ start:0, end:2, level:'banned', label:'暴力' }] }] }),
  });
  const result = guard.check({ prompts:['斩首场景'], source:'image' });
  await new Promise(resolve => setImmediate(resolve));
  const root = elements.find(element => element.className === 'desktop-restart-dialog prompt-precheck-dialog');
  const confirm = elements.find(element => element.className === 'desktop-restart-dialog prompt-precheck-confirm-dialog');
  const click = (target, selector) => target.emit('click', { target:{ closest:match => match === selector } });
  click(root, '[data-precheck-submit]');
  assert.equal(confirm.open, true);
  assert.equal(root.open, true);
  assert.match(confirm.querySelector('#promptPrecheckConfirmText').textContent, /1 处内容很可能导致生成失败/);
  click(confirm, '[data-precheck-back]');
  assert.equal(confirm.open, false);
  assert.equal(root.open, true);
  click(root, '[data-precheck-submit]');
  click(confirm, '[data-precheck-anyway]');
  assert.deepEqual(await result, { action:'submit', prompts:['斩首场景'], fields:{ precheckSource:'image', precheckOutcome:'confirmed_banned', precheckConfirmed:true } });
  assert.equal(root.open, false);
  assert.equal(confirm.open, false);
});

test('every submit entry passes through the check and versioned URLs are bumped together', () => {
  const app = read('app.js'), drama = read('drama-studio.js'), director = read('features/drama/director-workspace.js'), html = read('index.html');
  assert.match(app, /from '\.\/features\/prompt-precheck\/guard\.js\?v=3'/);
  assert.match(html, /\/app\.js\?v=508"/);
  assert.match(html, /\/styles\.css\?v=373"/);
  assert.match(app, /\.\/drama-studio\.js\?v=240'/);
  assert.match(app, /\.\/features\/agent\/workspace\.js\?v=100'/);
  assert.match(drama, /director-workspace\.js\?v=135'/);
  assert.match(read('features/agent/workspace.js'), /director-workspace\.js\?v=135'/);
  // Every manual generation request in the app and the drama studio is preceded by a check.
  for (const [name, source] of [['app.js', app], ['drama-studio.js', drama]]) {
    const submits = source.match(/api\('\/api\/generations',\s*\{\s*method:'POST'/g) || [];
    const checks = source.match(/promptPrecheck\.check\(/g) || [];
    assert.ok(checks.length >= submits.length - (name === 'drama-studio.js' ? 1 : 0), `${name}: ${checks.length} checks for ${submits.length} submits`);
  }
  // Smart-director and Agent submissions are marked so the server never stops them for confirmation.
  assert.match(drama, /action\.requestBody \|\|= \{\.\.\.body,precheckSource:'agent'/);
  assert.match(director, /precheckSource:'agent',requestId/);
});
