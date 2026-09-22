import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDesktopUpdateExit } from '../public/platform/desktop-update-exit.js';

test('dismissing an installing update cannot unlock the window or snooze the installer', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const close = source.slice(source.indexOf('function closeDesktopUpdateDialog('), source.indexOf('function openDesktopUpdateDialog('));
  let closed = false;
  for (const state of [{ pending: true, status: 'downloaded' }, { pending: false, status: 'installing' }]) {
    vm.runInNewContext(`${close}\ncloseDesktopUpdateDialog({ dismiss: true });`, {
      $: () => ({ open: true, close: () => { closed = true; } }),
      desktopUpdateExit: { pending: state.pending }, desktopUpdateState: { status: state.status },
      isMandatoryDesktopUpdate: () => false,
    });
    assert.equal(closed, false);
  }
  const startup = await readFile(new URL('../desktop/renderer/startup.html', import.meta.url), 'utf8');
  const startupClose = startup.slice(startup.indexOf('function closeUpdateDialog()'), startup.indexOf('function openUpdateDialog()'));
  vm.runInNewContext(`${startupClose}\ncloseUpdateDialog();`, { updateState: { status: 'installing' } });
});

test('updated entry loads the legacy exit fix with the current cache key', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=352'));
  assert.ok(source.includes('./platform/desktop-update-exit.js?v=2'));
  assert.doesNotMatch(source, /desktopUpdateExit\.resume/);
});

function setup({ platform = 'win32', version = '0.7.2', unlock = async () => true, install = async () => true } = {}) {
  const calls = [];
  const controller = createDesktopUpdateExit({
    getInfo: () => ({ platform, version }),
    getBridge: () => ({
      window: { setModalState: async active => { calls.push(['modal', active]); return unlock(); } },
      updates: { install: async () => { calls.push(['install']); return install(); } },
    }),
  });
  return { controller, calls };
}

test('old Windows install waits for native unlock and suppresses modal relocking while waiting', async () => {
  let acknowledge;
  const { controller, calls } = setup({ unlock: () => new Promise(resolve => { acknowledge = resolve; }) });
  const installing = controller.install();
  assert.equal(controller.pending, true);
  assert.deepEqual(calls, [['modal', false]]);
  await controller.install();
  assert.equal(calls.length, 1);
  acknowledge(true);
  await installing;
  assert.deepEqual(calls, [['modal', false], ['install']]);
});

test('failed native unlock does not start installer and permits retry', async () => {
  const { controller, calls } = setup({ unlock: async () => false });
  await assert.rejects(controller.install(), /暂时无法重启/);
  assert.equal(controller.pending, false);
  assert.deepEqual(calls, [['modal', false]]);
});

test('installer failure releases pending state so a subsequent click can retry', async () => {
  const { controller } = setup({ install: async () => false });
  await assert.rejects(controller.install(), /尚未准备好/);
  assert.equal(controller.pending, false);
});

test('version detection includes the affected 0.7.1 client', () => {
  assert.equal(setup({ version: '0.7.1' }).controller.isLegacyWindows(), true);
  assert.equal(setup({ version: '0.7.2' }).controller.isLegacyWindows(), true);
  assert.equal(setup({ version: '0.7.3' }).controller.isLegacyWindows(), false);
  assert.equal(setup({ platform: 'darwin' }).controller.isLegacyWindows(), false);
});

test('macOS install does not use Windows modal controls', async () => {
  const { controller, calls } = setup({ platform: 'darwin' });
  await controller.install();
  assert.deepEqual(calls, [['install']]);
});
