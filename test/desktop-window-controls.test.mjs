import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

function setup(platform = 'win32') {
  const calls = [];
  const permissions = { minimize: true, maximize: true, close: true };
  let maximized = false;
  const mainWindow = {
    isDestroyed: () => false,
    setMinimizable: value => { permissions.minimize = value; },
    setMaximizable: value => { permissions.maximize = value; },
    setClosable: value => { permissions.close = value; },
    isMinimizable: () => permissions.minimize,
    isMaximizable: () => permissions.maximize,
    isClosable: () => permissions.close,
    isMaximized: () => maximized,
    minimize: () => calls.push('minimize'),
    maximize: () => { maximized = true; calls.push('maximize'); },
    unmaximize: () => { maximized = false; calls.push('restore'); },
  };
  const handlers = new Map();
  const context = vm.createContext({
    mainWindow, process: { platform }, console, updateInstallStarted: false,
    isMainWindowEvent: event => event.trusted === true,
    closeMainWindow: () => { calls.push('close'); return true; },
    handle: (name, handler) => handlers.set(name, handler),
  });
  const modal = main.slice(main.indexOf('function setWindowsModalState('), main.indexOf('\nfunction trayAssetPath('));
  const commands = main.slice(main.indexOf("  handle('window:minimize'"), main.indexOf("  handle('updates:check'"));
  vm.runInContext(`${modal}\n${commands}`, context);
  const invoke = (name, trusted = true, ...args) => handlers.get(`window:${name}`)({ trusted }, ...args);
  return { calls, invoke };
}

test('custom window controls minimize, toggle maximize/restore and close', () => {
  const { calls, invoke } = setup();
  assert.equal(invoke('minimize'), true);
  assert.equal(invoke('toggle-maximize'), true);
  assert.equal(invoke('toggle-maximize'), false);
  assert.equal(invoke('close'), true);
  assert.deepEqual(calls, ['minimize', 'maximize', 'restore', 'close']);
});

test('Windows modal blocks caption commands and dismissal restores them', () => {
  const { calls, invoke } = setup();
  assert.equal(invoke('set-modal-state', true, true), true);
  for (const command of ['minimize', 'toggle-maximize', 'close']) assert.equal(invoke(command), false);
  assert.deepEqual(calls, []);
  assert.equal(invoke('set-modal-state', true, false), true);
  invoke('minimize');
  invoke('toggle-maximize');
  invoke('close');
  assert.deepEqual(calls, ['minimize', 'maximize', 'close']);
});

test('untrusted caption commands cannot act on the window', () => {
  const { calls, invoke } = setup();
  for (const command of ['minimize', 'toggle-maximize', 'close', 'set-modal-state']) assert.equal(invoke(command, false, true), false);
  assert.deepEqual(calls, []);
});

test('Windows caption styles ship through the updated stylesheet entry', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/styles/base.css?v=5'));
  assert.ok(!html.includes('/styles/base.css?v=4'));
});
