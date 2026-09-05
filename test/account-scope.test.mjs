import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationController } from '../public/features/notifications/controller.js';
import { createAccountScope } from '../public/state/account-scope.js';
import { createMediaController } from '../public/features/media/controller.js';

for (const method of ['markRead', 'markAllRead']) {
  for (const refresh of [false, true]) {
    test(`notification ${method} failure ${refresh ? 'preserves a refreshed list' : 'rolls back its own list'}`, async () => {
      let rejectMutation;
      const state = {
        notifications:[{ id:'first', isRead:false }, { id:'second', isRead:true }],
        unreadNotifications:1,
      };
      const scope = createAccountScope({ getUser: () => ({ id:'account-a' }) });
      const refreshed = [{ id:'second', isRead:true }, { id:'new', isRead:false }, { id:'first', isRead:true }];
      const controller = createNotificationController({
        state,
        api: (path, options) => options?.method === 'POST'
          ? new Promise((resolve, reject) => { rejectMutation = reject; })
          : Promise.resolve({ items:refreshed, unreadCount:1 }),
        esc: String,
        toast: () => {},
        accountSnapshot: scope.snapshot,
        isAccountCurrent: scope.isCurrent,
        render: () => {},
      });
      const mutation = controller[method]('first');
      assert.equal(state.unreadNotifications, 0);
      if (refresh) await controller.load();
      rejectMutation(new Error('request failed'));
      await mutation;
      assert.deepEqual(state.notifications, refresh
        ? [{ id:'second', isRead:true }, { id:'new', isRead:false }, { id:'first', isRead:true }]
        : [{ id:'first', isRead:false }, { id:'second', isRead:true }]);
      assert.equal(state.unreadNotifications, 1);
    });
  }
}

test('account scope accepts the current account request', () => {
  let user = { id:'account-a' };
  const scope = createAccountScope({ getUser: () => user });
  scope.advance();
  const request = scope.snapshot();
  assert.equal(scope.isCurrent(request), true);
});

test('account scope rejects a response after switching accounts', () => {
  let user = { id:'account-a' };
  const scope = createAccountScope({ getUser: () => user });
  scope.advance();
  const request = scope.snapshot();
  user = { id:'account-b' };
  scope.advance();
  assert.equal(scope.isCurrent(request), false);
});

test('account scope rejects a response after logout even when the next account id matches', () => {
  let user = { id:'account-a' };
  const scope = createAccountScope({ getUser: () => user });
  scope.advance();
  const request = scope.snapshot();
  user = null;
  scope.advance();
  user = { id:'account-a' };
  assert.equal(scope.isCurrent(request), false);
});

test('notification loader ignores a response returned for the previous account', async () => {
  let user = { id:'account-a' };
  let resolveNotifications;
  const state = { notifications:[], unreadNotifications:0 };
  const scope = createAccountScope({ getUser: () => user });
  const controller = createNotificationController({
    state,
    api: () => new Promise(resolve => { resolveNotifications = resolve; }),
    esc: value => String(value),
    toast: () => {},
    accountSnapshot: scope.snapshot,
    isAccountCurrent: scope.isCurrent,
    render: () => {},
  });
  scope.advance();
  const request = controller.load();
  user = { id:'account-b' };
  scope.advance();
  resolveNotifications({ items:[{ id:'account-a-private' }], unreadCount:1 });
  await request;
  assert.deepEqual(state, { notifications:[], unreadNotifications:0 });
});

test('desktop hydration ignores a delayed response after account and workspace change', async () => {
  let user = { id:'account-a' };
  let epoch = 1;
  const scope = createAccountScope({ getUser: () => user });
  scope.advance();
  let resolveDownload;
  const effects = [];
  const windowObject = { guguDesktop:{ media:{ downloadRemote:() => new Promise(resolve => { resolveDownload = resolve; }) } } };
  const state = { files:[], route:'files', initialSyncReady:true, fileKind:'all' };
  const controller = createMediaController({
    state,
    api: async path => { if (path.endsWith('/local-ready')) effects.push('acknowledge'); return {}; },
    desktopScope: { localAsset: item => item },
    recordIndexes: { invalidateFiles() {} },
    fileById: id => state.files.find(file => file.id === id),
    accountSnapshot: scope.snapshot,
    isAccountCurrent: scope.isCurrent,
    getAccountEpoch: () => epoch,
    getDesktopSyncInfo: () => ({ deviceId:'device-a', workspaceId:'workspace-a' }),
    getWindow: () => windowObject,
  });
  const request = controller.hydrateDesktopAsset({ id:'asset-a' });
  user = { id:'account-b' };
  scope.advance();
  epoch = 2;
  resolveDownload({ id:'local-a' });
  assert.equal(await request, null);
  assert.deepEqual(effects, []);
});
