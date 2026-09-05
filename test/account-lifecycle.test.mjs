import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountLifecycle } from '../public/state/account-lifecycle.js';

test('account lifecycle invalidates scope before clearing state', () => {
  let scopeEpoch = 0;
  let stateEpoch = 0;
  let user = { id:'account-a' };
  const scope = {
    advance: () => { scopeEpoch += 1; },
    snapshot: () => ({ epoch:scopeEpoch, userId:user?.id || '' }),
    isCurrent: request => request?.epoch === scopeEpoch && request?.userId === (user?.id || ''),
  };
  const lifecycle = createAccountLifecycle({
    advanceScope:scope.advance,
    snapshotScope:scope.snapshot,
    isScopeCurrent:scope.isCurrent,
    resetState:epoch => { stateEpoch = epoch; },
  });

  const request = lifecycle.snapshot();
  lifecycle.reset();
  assert.equal(lifecycle.isCurrent(request), false);
  assert.equal(scopeEpoch, 1);
  assert.equal(stateEpoch, 1);
});

test('account activation discards a result invalidated during workspace activation', async () => {
  let resolveWorkspace;
  const lifecycle = createAccountLifecycle({
    advanceScope:() => {},
    resetState:() => {},
  });
  const activation = lifecycle.activate({ id:'account-b' }, () => new Promise(resolve => { resolveWorkspace = resolve; }));
  lifecycle.invalidate();
  resolveWorkspace({ workspaceId:'stale' });
  assert.equal(await activation, null);
});
