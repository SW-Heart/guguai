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

function startupDialogsHarness({ unread = true } = {}) {
  const timers = [];
  const events = [];
  let current = true;
  let activeDialog = null;
  const dialog = () => ({
    open:false,
    listeners:[],
    addEventListener(type, callback, options) {
      assert.equal(type, 'close');
      assert.equal(options.once, true);
      this.listeners.push(callback);
    },
    close() {
      this.open = false;
      activeDialog = null;
      this.listeners.splice(0).forEach(callback => callback());
    },
  });
  const notification = dialog();
  const context = vm.createContext({
    window:{ setTimeout:callback => timers.push(callback) },
    document:{ querySelector:() => activeDialog },
    $:() => notification,
    notificationController:{ openLatestUnread:() => {
      events.push('check-notification');
      if (unread) { notification.open = true; activeDialog = notification; }
      return unread;
    } },
    openModelPriceDialog:options => {
      assert.equal(options.auto, true);
      events.push('price');
    },
    isCurrent:() => current,
  });
  vm.runInContext(extract('function scheduleStartupDialogs(', 'async function enterApp(user)'), context);
  vm.runInContext('scheduleStartupDialogs(isCurrent)', context);
  return {
    events, notification, tick:() => timers.shift()?.(),
    invalidate:() => { current = false; },
    block:() => { const blocker = dialog(); blocker.open = true; activeDialog = blocker; return blocker; },
  };
}

test('startup shows unread messages before the daily price dialog', () => {
  const h = startupDialogsHarness();
  assert.deepEqual(h.events, []);
  h.tick();
  assert.equal(h.notification.open, true);
  assert.deepEqual(h.events, ['check-notification']);
  h.notification.close();
  h.tick();
  assert.deepEqual(h.events, ['check-notification', 'price']);
});

test('startup retains the price dialog when every notification is read', () => {
  const h = startupDialogsHarness({ unread:false });
  h.tick();
  assert.equal(h.notification.open, false);
  assert.deepEqual(h.events, ['check-notification', 'price']);
});

test('startup waits for an existing modal before opening messages or prices', () => {
  const h = startupDialogsHarness();
  const update = h.block();
  h.tick();
  assert.deepEqual(h.events, []);
  update.close();
  h.tick();
  assert.deepEqual(h.events, ['check-notification']);
  h.notification.close();
  // Keep another modal open when the deferred price callback runs.
  const blocker = h.block();
  h.tick();
  assert.deepEqual(h.events, ['check-notification']);
  blocker.close();
  h.tick();
  assert.deepEqual(h.events, ['check-notification', 'price']);
});

test('account changes cancel pending startup dialogs and deferred prices', () => {
  const pending = startupDialogsHarness();
  pending.invalidate();
  pending.tick();
  assert.deepEqual(pending.events, []);
  const opened = startupDialogsHarness();
  opened.tick();
  opened.invalidate();
  opened.notification.close();
  opened.tick();
  assert.deepEqual(opened.events, ['check-notification']);
});

test('messages are scheduled only after notification loading and workspace startup complete', async () => {
  let finishNotifications;
  const notifications = new Promise(resolve => { finishNotifications = resolve; });
  const events = [];
  const context = vm.createContext({
    loginReturnDestination:() => '', activateDesktopAccount:async () => {},
    state:{}, accountLifecycle:{ snapshot:() => 1, isCurrent:() => true },
    sessionStorage:{ getItem:() => '' }, alipayOrderStorageKey:() => '',
    showBoot:() => {}, updateAccountIdentity:() => {}, setCreditBalance:() => {},
    claimLegacyWorkspace:async () => {}, navigate:() => {}, routeFromPath:() => 'image',
    window:{ location:{ pathname:'/image' } },
    loadConfig:async () => {}, loadCredits:async () => {}, loadFiles:async () => {}, loadTasks:async () => {},
    loadNotifications:() => notifications,
    updateBootCopy:() => {}, setBootProgress:() => {}, finishInitialWorkspaceSync:() => {},
    showApp:() => events.push('workspace'), syncDesktopDeliveries:async () => {},
    scheduleStartupDialogs:isCurrent => { assert.equal(isCurrent(), true); events.push('dialogs'); },
  });
  vm.runInContext(extract('async function enterApp(user)', 'let accountSettingsRestoreFocus'), context);
  const startup = vm.runInContext('enterApp({})', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, []);
  finishNotifications();
  await startup;
  assert.deepEqual(events, ['workspace', 'dialogs']);
});

test('notification startup changes update both the module and HTML cache keys', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(source.includes('./features/notifications/controller.js?v=7'));
  assert.ok(html.includes('/app.js?v=487'));
  assert.doesNotMatch(source, /notifications\/controller\.js\?v=6\b/);
  assert.doesNotMatch(html, /app\.js\?v=467\b/);
});
