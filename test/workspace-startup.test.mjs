import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('video model initialization preserves valid choices and excludes coming-soon defaults', () => {
  const select = { value:'existing' };
  const widget = { dataset:{} };
  let synced = 0;
  const context = vm.createContext({
    $: selector => selector === '#videoModel' ? select : widget,
    videoModelOptions: () => [{ id:'soon', availability:'coming-soon' }, { id:'first' }, { id:'existing' }],
    esc: String, refreshProductSelect: () => {}, syncVideoModelParameters: () => synced++,
  });
  vm.runInContext(extract('function syncVideoModelOptions()', 'function syncImageModelParameters()'), context);
  vm.runInContext('syncVideoModelOptions()', context);
  assert.equal(select.value, 'existing');
  select.value = 'removed';
  vm.runInContext('syncVideoModelOptions()', context);
  assert.equal(select.value, 'first');
  assert.equal(synced, 2);
});

test('late startup completions cannot overwrite a startup failure', async () => {
  let finishOthers;
  const pending = new Promise(resolve => { finishOthers = resolve; });
  const updates = [];
  const context = vm.createContext({
    loginReturnDestination: () => '', activateDesktopAccount: async () => {},
    state: {}, accountLifecycle: { snapshot: () => 1, isCurrent: () => true },
    sessionStorage: { getItem: () => '' }, alipayOrderStorageKey: () => '',
    showBoot: () => {}, updateAccountIdentity: () => {}, setCreditBalance: () => {},
    claimLegacyWorkspace: async () => {}, navigate: () => {}, routeFromPath: () => 'image',
    window: { location: { pathname:'/image' } },
    loadConfig: async () => { throw new Error('config failed'); },
    loadCredits: () => pending, loadNotifications: () => pending,
    loadFiles: () => pending, loadTasks: () => pending,
    updateBootCopy: (...args) => updates.push(args), setBootProgress: (...args) => updates.push(args),
  });
  vm.runInContext(extract('async function enterApp(user)', 'let accountSettingsRestoreFocus'), context);
  await assert.rejects(vm.runInContext('enterApp({})', context), /config failed/);
  const count = updates.length;
  finishOthers();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, count);
});
