import assert from 'node:assert/strict';
import test from 'node:test';
import { copyHelpText, initHelpCopies } from '../public/help-copy.js';

const text = '保留 @主角 的外观。\n第 2–6 秒显示「每日现磨」。\n不要字幕 & 不新增人物。';

test('copy keeps the complete example, including line breaks and literal characters', async () => {
  let written;
  await copyHelpText(text, { clipboard: { writeText: async value => { written = value; } }, document: {} });
  assert.equal(written, text);
});

function fallbackDocument(success) {
  const events = [];
  const originalRange = {};
  const selection = {
    rangeCount: 1,
    getRangeAt: () => ({ cloneRange: () => originalRange }),
    removeAllRanges: () => events.push('clear selection'),
    addRange: range => { assert.equal(range, originalRange); events.push('restore selection'); },
  };
  const field = {
    style: {}, setAttribute() {}, focus: () => events.push('focus field'),
    select: () => events.push('select'),
    setSelectionRange: (start, end) => assert.deepEqual([start, end], [0, text.length]),
    remove: () => events.push('remove field'),
  };
  const doc = {
    activeElement: { focus: () => events.push('restore focus') },
    getSelection: () => selection,
    createElement: tag => { assert.equal(tag, 'textarea'); return field; },
    body: { appendChild: node => assert.equal(node, field) },
    execCommand: command => {
      assert.equal(command, 'copy'); assert.equal(field.value, text);
      events.push('copy'); return success;
    },
  };
  return { doc, events };
}

test('copy falls back when the clipboard API is absent or denied and restores focus and selection', async () => {
  for (const clipboard of [null, { writeText: async () => { throw new Error('Denied'); } }]) {
    const { doc, events } = fallbackDocument(true);
    await copyHelpText(text, { document: doc, clipboard });
    assert.deepEqual(events, ['focus field', 'select', 'copy', 'remove field', 'restore focus', 'clear selection', 'restore selection']);
  }
});

test('a failed fallback still cleans up and reports failure', async () => {
  const { doc, events } = fallbackDocument(false);
  await assert.rejects(copyHelpText(text, { document: doc, clipboard: null }));
  assert.ok(events.includes('remove field'));
  assert.ok(events.includes('restore focus'));
  assert.ok(events.includes('restore selection'));
});

function copyHarness(copy) {
  const status = { textContent: '', setAttribute: () => { status.error = true; }, removeAttribute: () => { status.error = false; } };
  const button = {
    disabled: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute: () => 'example-1',
    closest: () => ({ querySelector: () => status }),
    addEventListener: (name, listener) => { assert.equal(name, 'click'); button.click = listener; },
  };
  const doc = {
    querySelectorAll: () => [button],
    getElementById: id => { assert.equal(id, 'example-1'); return { textContent: text }; },
    documentElement: { classList: { add() {} } },
  };
  initHelpCopies(doc, { copy });
  return { button, status };
}

test('buttons copy only their example and prevent duplicate clicks while copying', async () => {
  let finish;
  let calls = 0;
  const { button, status } = copyHarness(async value => {
    assert.equal(value, text); calls++;
    await new Promise(resolve => { finish = resolve; });
  });
  const pending = button.click();
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, '正在复制…');
  await button.click();
  assert.equal(calls, 1);
  finish(); await pending;
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, '已复制，可粘贴使用');
  assert.equal(button.attributes['data-copy-state'], 'copied');
  assert.equal(button.attributes.title, '已复制');
});

test('copy failure gives a manual option and the same button can be retried', async () => {
  let calls = 0;
  const { button, status } = copyHarness(async () => { if (!calls++) throw new Error('Unavailable'); });
  await button.click();
  assert.equal(button.disabled, false);
  assert.equal(status.error, true);
  assert.equal(button.attributes['data-copy-state'], 'idle');
  assert.ok(status.textContent.includes('手动复制'));
  await button.click();
  assert.equal(status.error, false);
  assert.equal(status.textContent, '已复制，可粘贴使用');
});
