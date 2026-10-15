import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('workspace paints behind the loading surface before the startup handoff', async () => {
  const frames = [];
  const element = (...initial) => {
    const classes = new Set(initial);
    return { inert:false, classList:{
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: (value, force) => force ? classes.add(value) : classes.delete(value),
    } };
  };
  const boot = element();
  const app = element('hidden');
  const auth = element('hidden');
  let current = true;
  const surfaces = [];
  const context = vm.createContext({
    $: selector => ({ '#bootView':boot, '#appView':app, '#authView':auth })[selector],
    toggleClass:(node, name, force) => node.classList.toggle(name, force),
    setDesktopSurface:value => surfaces.push(value),
    requestAnimationFrame:callback => frames.push(callback), isCurrent:() => current,
  });
  vm.runInContext(extract('async function showApp(', 'function loginReturnDestination()'), context);
  const handoff = vm.runInContext('showApp(isCurrent)', context);
  assert.equal(app.classList.contains('hidden'), false);
  assert.equal(app.inert, true);
  assert.equal(boot.classList.contains('is-revealing'), true);
  frames.shift()();
  assert.equal(boot.classList.contains('hidden'), false);
  assert.deepEqual(surfaces, []);
  frames.shift()();
  await handoff;
  assert.equal(app.inert, false);
  assert.equal(boot.classList.contains('hidden'), true);
  assert.equal(boot.classList.contains('is-revealing'), false);
  assert.deepEqual(surfaces, ['app']);

  // A logout during those frames must retain the newly shown login surface.
  boot.classList.remove('hidden');
  auth.classList.remove('hidden');
  const cancelled = vm.runInContext('showApp(isCurrent)', context);
  current = false;
  app.classList.add('hidden');
  frames.shift()(); frames.shift()();
  await cancelled;
  assert.equal(auth.classList.contains('hidden'), false);
  assert.equal(app.classList.contains('hidden'), true);
  assert.equal(boot.classList.contains('hidden'), false);
  assert.deepEqual(surfaces, ['app']);
});

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

test('the workspace opens after configuration while other data loads, and messages wait for that data', async () => {
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
  assert.deepEqual(events, ['workspace'], 'the workspace must not wait for messages, files or history');
  finishNotifications();
  await startup;
  assert.deepEqual(events, ['workspace', 'dialogs']);
});

test('notification startup changes update both the module and HTML cache keys', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(source.includes('./features/notifications/controller.js?v=8'));
  assert.ok(html.includes('/app.js?v=589'));
  assert.doesNotMatch(source, /notifications\/controller\.js\?v=[67]\b/);
  assert.doesNotMatch(html, /app\.js\?v=467\b/);
});

test('canvas shares its React hook dispatcher with the project components',()=>{
  const canvas=readFileSync(new URL('../public/vendor/director/reference-canvas.js',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../public/vendor/ui/create-project.js',import.meta.url),'utf8');
  const runtimeUrl = /["'](\.\.\/react\/runtime-[a-f0-9]+\.js\?v=[a-f0-9]+)["']/;
  const canvasUrl=canvas.match(runtimeUrl)?.[1];
  assert.ok(canvasUrl, 'canvas must import the shared runtime');
  assert.equal(ui.match(runtimeUrl)?.[1], canvasUrl);
  assert.doesNotMatch(canvas, /\.useRef=function\(/);
  assert.doesNotMatch(ui, /\.useRef=function\(/);
  const runtime=readFileSync(new URL(canvasUrl, new URL('../public/vendor/director/reference-canvas.js',import.meta.url)),'utf8');
  assert.equal([...runtime.matchAll(/\.useRef=function\(/g)].length,1);
});

test('background data starts with the configuration and marks the workspace ready only when it settles', async () => {
  let finishConfig, finishFiles;
  const config = new Promise(resolve => { finishConfig = resolve; });
  const files = new Promise(resolve => { finishFiles = resolve; });
  const events = [];
  const context = vm.createContext({
    loginReturnDestination:() => '', activateDesktopAccount:async () => {},
    state:{}, accountLifecycle:{ snapshot:() => 1, isCurrent:() => true },
    sessionStorage:{ getItem:() => '' }, alipayOrderStorageKey:() => '',
    showBoot:() => {}, updateAccountIdentity:() => {}, setCreditBalance:() => {},
    claimLegacyWorkspace:async () => {}, navigate:() => {}, routeFromPath:() => 'image',
    window:{ location:{ pathname:'/image' } },
    loadConfig:() => { events.push('config'); return config; },
    loadCredits:async () => { events.push('credits'); }, loadNotifications:async () => { events.push('notifications'); },
    loadFiles:() => { events.push('files'); return files; },
    loadTasks:async () => { events.push('tasks'); throw new Error('history offline'); },
    updateBootCopy:() => {}, setBootProgress:() => {},
    finishInitialWorkspaceSync:() => events.push('ready'),
    showApp:() => events.push('workspace'), syncDesktopDeliveries:async () => {},
    scheduleStartupDialogs:() => events.push('dialogs'),
  });
  vm.runInContext(extract('async function enterApp(user)', 'let accountSettingsRestoreFocus'), context);
  const startup = vm.runInContext('enterApp({})', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.slice().sort(), ['config', 'credits', 'files', 'notifications', 'tasks'], 'all requests start together');
  finishConfig();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1), 'workspace');
  finishFiles();
  await startup;
  assert.deepEqual(events.slice(-3), ['workspace', 'ready', 'dialogs'], 'a failed background load still lets the workspace finish');
});
