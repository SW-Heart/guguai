import assert from 'node:assert/strict';
import test from 'node:test';
import { runDesktopAction, sendToWindow } from '../desktop/window-events.mjs';

test('late progress events do not send to destroyed windows or web contents', () => {
  for (const [windowDestroyed, contentsDestroyed] of [[true, false], [false, true]]) {
    let sent = false;
    const window = { isDestroyed:() => windowDestroyed, webContents:{ isDestroyed:() => contentsDestroyed, send:() => { sent = true; } } };
    assert.equal(sendToWindow(window, 'progress', {}), false);
    assert.equal(sent, false);
  }
  assert.equal(sendToWindow(null, 'progress', {}), false);
});

test('window send failures and native action rejections stay inside their callback', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const window = { isDestroyed:() => false, webContents:{ isDestroyed:() => false, send:() => { throw new Error('destroyed'); } } };
  assert.equal(sendToWindow(window, 'progress', {}), false);
  assert.equal(await runDesktopAction('打开外部链接', () => Promise.reject(new Error('OS rejected'))), false);
  assert.equal(await runDesktopAction('打开窗口', () => { throw new Error('load failed'); }), false);
  assert.equal(warnings.length, 3);
  assert.equal(await runDesktopAction('打开窗口', () => true), true);
});

test('native actions start immediately so repeated tray clicks see the window being created', async () => {
  let created = false;
  const pending = runDesktopAction('打开窗口', () => { created = true; return Promise.resolve(true); });
  assert.equal(created, true);
  assert.equal(await pending, true);
});
