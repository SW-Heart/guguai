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
  assert.ok(html.includes('/app.js?v=354'));
  assert.ok(source.includes('./platform/desktop-update-exit.js?v=3'));
  assert.doesNotMatch(source, /desktopUpdateExit\.resume/);
});

function setup({ platform = 'win32', version = '0.7.2', unlock = async () => true, install = async () => true, status = 'installing' } = {}) {
  const calls = [];
  const controller = createDesktopUpdateExit({
    getInfo: () => ({ platform, version }),
    getBridge: () => ({
      window: { setModalState: async active => { calls.push(['modal', active]); return unlock(); } },
      updates: {
        install: async () => { calls.push(['install']); return install(); },
        getStatus: async () => { calls.push(['status']); return { status }; },
      },
    }),
    closeWindow: () => calls.push(['close']),
  });
  return { controller, calls };
}

test('old Windows install waits for native unlock and suppresses modal relocking while waiting', async () => {
  let acknowledge;
  const { controller, calls } = setup({ unlock: () => acknowledge ? Promise.resolve(true) : new Promise(resolve => { acknowledge = resolve; }) });
  const installing = controller.install();
  assert.equal(controller.pending, true);
  assert.deepEqual(calls, [['modal', false]]);
  await controller.install();
  assert.equal(calls.length, 1);
  acknowledge(true);
  await installing;
  assert.deepEqual(calls, [['modal', false], ['install'], ['status'], ['modal', false], ['close']]);
});

test('0.7.1 retry closes the real window after the existing installer is acknowledged', async () => {
  let quitting = true;
  let exited = false;
  let closable = false;
  let launches = 1;
  const controller = createDesktopUpdateExit({
    getInfo: () => ({ platform: 'win32', version: '0.7.1' }),
    getBridge: () => ({
      window: { setModalState: async active => { closable = !active; return true; } },
      updates: {
        // 0.7.1 returns true immediately when its helper is already started.
        install: async () => { if (quitting) return true; launches++; quitting = true; return true; },
        getStatus: async () => ({ status: 'installing' }),
      },
    }),
    closeWindow: () => { exited = quitting && closable; },
  });
  assert.equal(exited, false);
  await controller.install();
  assert.equal(exited, true);
  assert.equal(launches, 1);
});

test('a stale or failed install cannot close the client', async () => {
  for (const status of ['downloaded', 'error', 'idle']) {
    const { controller, calls } = setup({ status });
    await assert.rejects(controller.install(), /更新尚未开始/);
    assert.equal(controller.pending, false);
    assert.ok(!calls.some(([call]) => call === 'close'));
  }
});

test('fixed Windows client leaves closing to its main process', async () => {
  const { controller, calls } = setup({ version: '0.7.3' });
  await controller.install();
  assert.deepEqual(calls, [['modal', false], ['install']]);
});

test('normal native window close still hides to tray; an explicit quit permits closing', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("  mainWindow.on('close', event => {");
  const end = source.indexOf("  mainWindow.on('closed'", start);
  assert.ok(start >= 0 && end > start);
  for (const isQuitting of [false, true]) {
    let handler;
    let hidden = false;
    let prevented = false;
    vm.runInNewContext(source.slice(start, end), {
      mainWindow: { on: (_event, callback) => { handler = callback; } },
      isQuitting,
      hideMainWindowToTray: () => { hidden = true; },
    });
    handler({ preventDefault: () => { prevented = true; } });
    assert.equal(hidden, !isQuitting);
    assert.equal(prevented, !isQuitting);
  }
});

test('snoozing cannot remove the legacy pending-install recovery entry', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const applyUpdateStatus = payload => {');
  const end = source.indexOf('desktopUpdateUnsubscribe?.();', start);
  for (const status of ['downloaded', 'installing']) {
    let visible = false;
    let opened = false;
    const updateButton = {};
    vm.runInNewContext(`${source.slice(start, end)}\napplyUpdateStatus({ status: '${status}', snoozed: true });`, {
      desktopUpdateState: {}, desktopUpdateReminderSnoozed: true,
      isMandatoryDesktopUpdate: () => false,
      hideUpdateButton: () => { visible = false; }, showUpdateButton: () => { visible = true; },
      closeDesktopUpdateDialog: () => {}, desktopUpdateExit: { isLegacyWindows: () => true },
      setUpdateState: () => {}, setUpdateLabel: () => {}, setUpdateTitle: () => {},
      updateButton, desktopUpdateDialogDismissed: true,
      renderDesktopUpdateDialog: (_payload, options) => { opened = options.open; },
    });
    assert.equal(visible, true);
    assert.equal(updateButton.disabled, false);
    assert.equal(opened, false);
    updateButton.onclick();
    assert.equal(opened, true);
  }
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
