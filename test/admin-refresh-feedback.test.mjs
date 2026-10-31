import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness({ errorState = false, fail = false } = {}) {
  const toasts = [];
  const busy = [];
  const view = { querySelector: selector => (selector === '.error-state' && errorState ? {} : null) };
  const button = { dataset: {}, isConnected: true, closest: () => view };
  let loads = 0;
  let release;
  const context = createContext({
    toast: (message, kind = 'success') => toasts.push([message, kind]),
    toastError: error => toasts.push([error.message, 'error']),
    setButtonBusy: (target, on) => { busy.push(on); if (on) target.dataset.busy = '1'; else delete target.dataset.busy; },
  });
  runInContext(extract('  function bindRefresh(', '  async function copyText('), context);
  const load = () => { loads++; return new Promise((resolve, reject) => { release = () => (fail ? reject(new Error('网络异常')) : resolve()); }); };
  context.bindRefresh(button, load);
  return { button, toasts, busy, loads: () => loads, release: () => release() };
}

test('manual refresh shows a loading button and confirms success even when nothing changed', async () => {
  const h = harness();
  const pending = h.button.onclick();
  assert.equal(h.button.dataset.busy, '1');
  h.button.onclick();
  assert.equal(h.loads(), 1, 'repeated clicks while loading do not start another request');
  h.release(); await pending;
  assert.deepEqual(h.toasts, [['已刷新', 'success']]);
  assert.deepEqual(h.busy, [true, false]);
});

test('manual refresh reports failure when the page shows a load error or the request throws', async () => {
  const shown = harness({ errorState: true });
  let pending = shown.button.onclick(); shown.release(); await pending;
  assert.deepEqual(shown.toasts, [['刷新失败，请稍后重试', 'error']]);
  const thrown = harness({ fail: true });
  pending = thrown.button.onclick(); thrown.release(); await pending;
  assert.deepEqual(thrown.toasts, [['网络异常', 'error']]);
  assert.equal(thrown.button.dataset.busy, undefined);
});

test('every list refresh button in the admin uses the shared feedback', () => {
  for (const key of ['overview', 'users', 'orders', 'precheck', 'invites', 'announcements', 'credentials', 'issues', 'logs']) {
    assert.ok(source.includes(`bindRefresh($('[data-refresh="${key}"]', root)`), key);
  }
  assert.ok(!/\[data-refresh="(?!models)\w+"\]', root\)\.onclick/.test(source));
});
