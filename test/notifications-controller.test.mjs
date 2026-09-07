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
