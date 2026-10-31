import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationController } from '../public/features/notifications/controller.js';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.classList = {
      toggle: (name, force) => { this.className = force ? `${this.className} ${name}`.trim() : this.className.split(/\s+/).filter(value => value && value !== name).join(' '); },
    };
    this.isConnected = true;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  querySelectorAll() { return []; }

  matches() { return false; }

  showModal() { this.open = true; }

  close() {
    this.open = false;
    this.dispatch('close', { target:this, currentTarget:this });
  }
}

class FakeNotificationButton extends FakeElement {
  constructor(id) {
    super();
    this.dataset.notificationId = id;
  }

  closest(selector) { return selector === '[data-notification-id]' ? this : null; }

  focus() {}
}

class FakeNotificationList extends FakeElement {
  set innerHTML(value) {
    this.markup = String(value);
    const match = this.markup.match(/data-notification-id="([^"]+)"/);
    this.button = match ? new FakeNotificationButton(match[1]) : null;
  }

  get innerHTML() { return this.markup || ''; }

  querySelectorAll() { return this.button ? [this.button] : []; }
}

function createFakeDocument() {
  const elements = new Map([
    ['#notificationCount', new FakeElement('notificationCount')],
    ['#avatarNotificationBadge', new FakeElement('avatarNotificationBadge')],
    ['#notificationSummary', new FakeElement('notificationSummary')],
    ['#notificationList', new FakeNotificationList('notificationList')],
    ['#markAllNotifications', new FakeElement('markAllNotifications')],
    ['#notificationPanel', new FakeElement('notificationPanel')],
    ['#notificationMenuButton', new FakeElement('notificationMenuButton')],
    ['#notificationDialog', new FakeElement('notificationDialog')],
    ['#notificationDialogTitle', new FakeElement('notificationDialogTitle')],
    ['#notificationDialogTime', new FakeElement('notificationDialogTime')],
    ['#notificationDialogBody', new FakeElement('notificationDialogBody')],
    ['#closeNotificationDialog', new FakeElement('closeNotificationDialog')],
    ['#notificationDialogDone', new FakeElement('notificationDialogDone')],
    ['#notificationDialogStep', new FakeElement('notificationDialogStep')],
    ['#notificationDialogLater', new FakeElement('notificationDialogLater')],
  ]);
  elements.set('.notification-menu-item', new FakeElement('notification-menu-item'));
  return {
    activeElement: null,
    querySelector(selector) { return elements.get(selector) || null; },
  };
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousRequestAnimationFrame = globalThis.requestAnimationFrame;

afterEach(() => {
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
});

test('notification item click opens the full-view dialog and marks it read', async () => {
  globalThis.document = createFakeDocument();
  globalThis.window = { clearTimeout, setTimeout };
  globalThis.requestAnimationFrame = callback => callback();
  const state = {
    notifications: [{ id:'notice-1', title:'服务通知', content:'第一行\n第二行\n第三行', contentText:'第一行\n第二行\n第三行', contentHtml:'<p>第一行</p><p>第二行</p><p>第三行</p>', publishedAt:'2026-09-06T12:34:56.000Z', isRead:false }],
    unreadNotifications: 1,
  };
  const controller = createNotificationController({
    state,
    api: async () => ({ ok:true }),
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character])),
    toast: () => {},
    accountSnapshot: () => ({}),
    isAccountCurrent: () => true,
  });

  controller.render();
  const list = globalThis.document.querySelector('#notificationList');
  const button = list.querySelectorAll('[data-notification-id]')[0];
  // Mouse-down focuses the notification before mouse-up dispatches click.
  // The ancestor's focusin handler asks to open the panel again.
  controller.setPanelOpen(true);
  controller.setPanelOpen(true);
  assert.equal(list.querySelectorAll('[data-notification-id]')[0], button,
    'opening/focusing the panel must preserve the pressed notification button');
  list.dispatch('click', {
    target:button,
    currentTarget:list,
    preventDefault() {},
    stopPropagation() {},
  });
  await new Promise(resolve => setImmediate(resolve));

  const dialog = globalThis.document.querySelector('#notificationDialog');
  assert.equal(dialog.open, true);
  assert.equal(globalThis.document.querySelector('#notificationDialogTitle').textContent, '服务通知');
  assert.match(globalThis.document.querySelector('#notificationDialogBody').innerHTML, /第三行/);
  assert.equal(state.notifications[0].isRead, true);
  assert.equal(state.unreadNotifications, 0);
});

function startupHarness(items, { failRead = false } = {}) {
  globalThis.document = createFakeDocument();
  globalThis.window = { clearTimeout, setTimeout };
  globalThis.requestAnimationFrame = callback => callback();
  const state = { notifications:[], unreadNotifications:0 };
  const calls = [];
  const toasts = [];
  const controller = createNotificationController({
    state,
    api: async (url, options) => {
      calls.push({ url, options });
      const detail = url.match(/^\/api\/notifications\/([^/?]+)$/);
      if (detail && !options) return { item:{ ...items.find(item => item.id === decodeURIComponent(detail[1])), contentHtml:'<p>完整图文</p>', summary:false } };
      if (!options) return { items:structuredClone(items), unreadCount:items.filter(item => !item.isRead).length };
      if (failRead) throw new Error('offline');
      return { ok:true };
    },
    esc:String, toast:message => toasts.push(message),
    accountSnapshot:() => ({}), isAccountCurrent:() => true,
  });
  return { state, calls, toasts, controller };
}

test('startup opens the newest unread full message and leaves older messages unread', async () => {
  const { state, calls, controller } = startupHarness([
    { id:'read', title:'已读', isRead:true },
    { id:'latest', title:'最新公告', contentHtml:'<p>完整内容</p>', isRead:false },
    { id:'older', title:'旧公告', isRead:false },
  ]);
  await controller.load();
  const dialog = globalThis.document.querySelector('#notificationDialog');
  assert.equal(dialog.open, false, 'loading and polling alone must not open a dialog');
  assert.equal(controller.openLatestUnread(), true);
  assert.equal(globalThis.document.querySelector('#notificationDialogTitle').textContent, '最新公告');
  assert.equal(globalThis.document.querySelector('#notificationDialogBody').innerHTML, '<p>完整内容</p>');
  assert.equal(state.notifications[1].isRead, true);
  assert.equal(state.notifications[2].isRead, false);
  assert.equal(state.unreadNotifications, 1);
  assert.equal(controller.openLatestUnread(), false, 'an open message must not be replaced');
  assert.deepEqual(calls.filter(call => call.options).map(call => call.url), ['/api/notifications/latest/read']);
});

test('startup does not open or send a read receipt when there are no unread messages', async () => {
  for (const items of [[], [{ id:'read', isRead:true }]]) {
    const { controller, calls } = startupHarness(items);
    await controller.load();
    assert.equal(controller.openLatestUnread(), false);
    assert.equal(globalThis.document.querySelector('#notificationDialog').open, false);
    assert.equal(calls.length, 1);
  }
});

test('an unavailable message dialog preserves unread state', async () => {
  const { state, controller, calls } = startupHarness([{ id:'notice', isRead:false }]);
  await controller.load();
  globalThis.document = { querySelector:() => null };
  assert.equal(controller.openLatestUnread(), false);
  assert.equal(state.unreadNotifications, 1);
  assert.equal(state.notifications[0].isRead, false);
  assert.equal(calls.filter(call => call.options).length, 0);
});

test('a failed startup read receipt restores unread state for the next launch', async () => {
  const { state, controller, toasts } = startupHarness([{ id:'notice', isRead:false }], { failRead:true });
  await controller.load();
  assert.equal(controller.openLatestUnread(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.notifications[0].isRead, false);
  assert.equal(state.unreadNotifications, 1);
  assert.equal(toasts.length, 1);
});

test('opening a summarized message fetches its full body once', async () => {
  const items = [{ id:'summary', title:'图文公告', contentText:'预览', summary:true, updatedAt:'v1', isRead:false }];
  const { state, calls, controller } = startupHarness(items);
  const api = calls;
  await controller.load();
  assert.equal(api[0].url, '/api/notifications?limit=200&view=summary');
  assert.equal(controller.openLatestUnread(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(api.some(call => call.url === '/api/notifications/summary' && !call.options));
  assert.equal(globalThis.document.querySelector('#notificationDialogBody').innerHTML, '<p>完整图文</p>');
  assert.equal(state.notifications[0].contentHtml, '<p>完整图文</p>');
  await controller.load();
  assert.equal(state.notifications[0].contentHtml, '<p>完整图文</p>', 'a later summary refresh keeps the loaded body');
});

test('unread summarized messages are fetched in full before their dialog opens', async () => {
  const items = [
    { id:'unread', title:'图文公告', contentText:'预览', summary:true, updatedAt:'v1', isRead:false },
    { id:'read', title:'已读公告', contentText:'旧预览', summary:true, updatedAt:'v1', isRead:true },
  ];
  const { state, calls, controller } = startupHarness(items);
  await controller.load();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => !call.options).map(call => call.url), ['/api/notifications?limit=200&view=summary', '/api/notifications/unread']);
  assert.equal(state.notifications[0].contentHtml, '<p>完整图文</p>');
  assert.equal(controller.openLatestUnread(), true);
  assert.equal(globalThis.document.querySelector('#notificationDialogBody').innerHTML, '<p>完整图文</p>');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.url === '/api/notifications/unread').length, 1, 'the full body is fetched only once');
});

test('a summarized message shows its preview text while the full body loads', async () => {
  const items = [{ id:'slow', title:'图文公告', contentText:'预览第一行\n第二行', summary:true, updatedAt:'v1', isRead:true }];
  const { controller } = startupHarness(items);
  await controller.load();
  controller.openNotification(items[0]);
  assert.equal(globalThis.document.querySelector('#notificationDialogBody').innerHTML, '<p>预览第一行<br>第二行</p>');
});

test('messages arriving while the app is open wait for the next page switch', async () => {
  const items = [{ id:'old', title:'旧公告', isRead:false }];
  const { state, controller } = startupHarness(items);
  await controller.load();
  const dialog = globalThis.document.querySelector('#notificationDialog');
  assert.equal(controller.openArrivedUnread(), false, 'messages present at startup are not treated as new');

  items.unshift({ id:'fresh', title:'新公告', isRead:false });
  await controller.load();
  assert.equal(dialog.open, false, 'polling must not interrupt the current page');
  assert.equal(controller.openArrivedUnread(), true);
  assert.equal(globalThis.document.querySelector('#notificationDialogTitle').textContent, '新公告');
  assert.equal(state.notifications.find(item => item.id === 'old').isRead, false);
  dialog.close();
  assert.equal(controller.openArrivedUnread(), false, 'each new message pops up only once');
});

test('a new message already read elsewhere does not pop up on page switch', async () => {
  const items = [];
  const { controller } = startupHarness(items);
  await controller.load();
  items.unshift({ id:'fresh', title:'新公告', isRead:false });
  await controller.load();
  items[0].isRead = true;
  await controller.load();
  assert.equal(controller.openArrivedUnread(), false);
});

test('several unread messages page through one dialog, capped at four', async () => {
  const items = Array.from({ length:6 }, (_, index) => ({ id:`n${index + 1}`, title:`公告${index + 1}`, isRead:false }));
  const { state, controller } = startupHarness(items);
  await controller.load();
  const $ = selector => globalThis.document.querySelector(selector);
  assert.equal(controller.openLatestUnread(), true);
  assert.equal($('#notificationDialogTitle').textContent, '公告1');
  assert.equal($('#notificationDialogStep').textContent, '1 / 4');
  assert.equal($('#notificationDialogStep').hidden, false);
  assert.equal($('#notificationDialogDone').textContent, '下一条');
  assert.equal($('#notificationDialogLater').hidden, false);
  for (const index of [2, 3, 4]) {
    $('#notificationDialogDone').dispatch('click');
    assert.equal($('#notificationDialogTitle').textContent, `公告${index}`);
    assert.equal($('#notificationDialogStep').textContent, `${index} / 4`);
  }
  assert.equal($('#notificationDialogDone').textContent, '知道了');
  assert.equal($('#notificationDialogLater').hidden, true);
  $('#notificationDialogDone').dispatch('click');
  assert.equal($('#notificationDialog').open, false);
  assert.deepEqual(state.notifications.map(item => item.isRead), [true, true, true, true, false, false]);
  assert.equal(state.unreadNotifications, 2);
});

test('closing early leaves the remaining messages unread', async () => {
  const { state, controller } = startupHarness([
    { id:'a', title:'公告A', isRead:false },
    { id:'b', title:'公告B', isRead:false },
  ]);
  await controller.load();
  const $ = selector => globalThis.document.querySelector(selector);
  assert.equal(controller.openLatestUnread(), true);
  $('#notificationDialogLater').dispatch('click');
  assert.equal($('#notificationDialog').open, false);
  assert.deepEqual(state.notifications.map(item => item.isRead), [true, false]);

  state.notifications[1].isRead = true;
  const list = $('#notificationList');
  controller.render();
  list.dispatch('click', { target:list.querySelectorAll()[0], currentTarget:list, preventDefault() {}, stopPropagation() {} });
  assert.equal($('#notificationDialogStep').hidden, true, 'a single message opened from the list shows no pager');
  assert.equal($('#notificationDialogDone').textContent, '知道了');
});

test('several messages arriving while open page through on the next page switch', async () => {
  const items = [];
  const { controller } = startupHarness(items);
  await controller.load();
  items.unshift({ id:'x', title:'新公告X', isRead:false }, { id:'y', title:'新公告Y', isRead:false });
  await controller.load();
  assert.equal(controller.openArrivedUnread(), true);
  assert.equal(globalThis.document.querySelector('#notificationDialogStep').textContent, '1 / 2');
});
