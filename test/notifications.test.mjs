import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
import { createAnnouncement, getNotification, listAdminAnnouncements, listNotifications, markAllNotificationsRead, markNotificationRead, unreadNotificationCount, updateAnnouncement } from '../lib/notifications.mjs';
import { insertUser } from '../lib/store.mjs';

const createdAt = new Date().toISOString();

beforeEach(() => {
  resetForTests();
  openDatabase({ file: ':memory:' });
  for (const [id, username, role] of [['notification-admin', 'notification_admin', 'admin'], ['notification-user-a', 'notification_user_a', 'user'], ['notification-user-b', 'notification_user_b', 'user']]) {
    insertUser({ id, username, role, status: 'active', passwordHash: 'test', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  }
});

afterEach(() => closeDatabase({ checkpoint: false }));

test('only published announcements are visible and unread state is isolated per user', () => {
  const draft = createAnnouncement({ title: '草稿', content: '不可见', status: 'draft' }, { actorUserId: 'notification-admin' });
  const published = createAnnouncement({ title: '上线通知', content: '第一行\n第二行', status: 'published' }, { actorUserId: 'notification-admin' });

  assert.deepEqual(new Set(listAdminAnnouncements().map(item => item.id)), new Set([published.id, draft.id]));
  assert.equal(listNotifications('notification-user-a').unreadCount, 1);
  assert.equal(listNotifications('notification-user-b').items[0].isRead, false);

  markNotificationRead('notification-user-a', published.id);
  assert.equal(listNotifications('notification-user-a').unreadCount, 0);
  assert.equal(listNotifications('notification-user-b').unreadCount, 1);
});

test('mark all read and publishing an existing draft update unread counts', () => {
  const draft = createAnnouncement({ title: '准备发布', content: '内容', status: 'draft' }, { actorUserId: 'notification-admin' });
  updateAnnouncement(draft.id, { status: 'published' }, { actorUserId: 'notification-admin', expectedVersion: draft.version });
  createAnnouncement({ title: '第二条', content: '更多内容', status: 'published' }, { actorUserId: 'notification-admin' });
  assert.equal(listNotifications('notification-user-a').unreadCount, 2);

  markAllNotificationsRead('notification-user-a');
  assert.equal(listNotifications('notification-user-a').unreadCount, 0);
  assert.equal(listNotifications('notification-user-a').items.length, 2);
});

test('announcement update uses optimistic version checking', () => {
  const announcement = createAnnouncement({ title: '原始标题', content: '内容', status: 'draft' }, { actorUserId: 'notification-admin' });
  updateAnnouncement(announcement.id, { title: '新标题' }, { actorUserId: 'notification-admin', expectedVersion: announcement.version });
  assert.throws(() => updateAnnouncement(announcement.id, { title: '过期修改' }, { actorUserId: 'notification-admin', expectedVersion: announcement.version }), /已被其他操作更新/);
});

test('rich announcement content is sanitized and exposes a plain-text preview', () => {
  const announcement = createAnnouncement({ title: '图文通知', content: '<p><strong>重点</strong><br><img src="https://example.com/banner.png" onerror="alert(1)"></p>', status: 'published' }, { actorUserId: 'notification-admin' });
  assert.match(announcement.contentHtml, /<strong>重点<\/strong>/);
  assert.match(announcement.contentHtml, /src="https:\/\/example\.com\/banner\.png"/);
  assert.doesNotMatch(announcement.contentHtml, /onerror/);
  assert.equal(announcement.contentText, '重点');
  assert.equal(listNotifications('notification-user-a').items[0].contentHtml, announcement.contentHtml);
  assert.equal(listNotifications('notification-user-a').items[0].contentText, '重点');
});

test('background summaries leave out full bodies and inline pictures', () => {
  const picture = `data:image/png;base64,${'A'.repeat(40_000)}`;
  const body = `<p>${'很长的公告内容'.repeat(80)}</p><img src="${picture}">`;
  const announcement = createAnnouncement({ title: '图文公告', content: body, status: 'published' }, { actorUserId: 'notification-admin' });
  const full = listNotifications('notification-user-a');
  assert.ok(JSON.stringify(full).includes(picture));
  assert.equal(Object.hasOwn(full.items[0], 'content'), false, 'the same markup is not sent twice');
  const summary = listNotifications('notification-user-a', { summary: true });
  assert.equal(summary.unreadCount, 1);
  assert.equal(summary.items[0].summary, true);
  assert.equal(summary.items[0].contentHtml, undefined);
  assert.ok(Array.from(summary.items[0].contentText).length <= 241);
  assert.ok(JSON.stringify(summary).length < 2_000);
  const detail = getNotification('notification-user-a', announcement.id);
  assert.equal(detail.contentHtml, full.items[0].contentHtml);
  assert.equal(detail.isRead, false);
  markNotificationRead('notification-user-a', announcement.id);
  assert.equal(unreadNotificationCount('notification-user-a'), 0);
  assert.equal(getNotification('notification-user-a', announcement.id).isRead, true);
  updateAnnouncement(announcement.id, { content: '<p>已更新</p>' }, { actorUserId: 'notification-admin' });
  assert.equal(getNotification('notification-user-a', announcement.id).contentHtml, '<p>已更新</p>', 'edited announcements are not served from the old cached body');
  assert.throws(() => getNotification('notification-user-a', 'missing'), /消息不存在/);
});
