import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeLifecycle } from '../services/runtime-lifecycle.mjs';

test('runtime lifecycle drains tracked work, timers, and closers once', async () => {
  let resolveWork;
  let timerCleared = false;
  let closed = 0;
  const lifecycle = createRuntimeLifecycle({
    setTimeoutFn: callback => { const timer = { callback }; setImmediate(callback); return timer; },
    clearTimeoutFn: timer => { if (timer) timerCleared = true; },
  });
  lifecycle.registerTimer({ id:'poller' });
  lifecycle.registerCloser(async () => { closed += 1; });
  const work = new Promise(resolve => { resolveWork = resolve; });
  lifecycle.track(work);
  const draining = lifecycle.drain({ timeoutMs:100 });
  resolveWork();
  assert.deepEqual(await draining, { state:'closed', timedOut:false, pending:0 });
  assert.equal(timerCleared, true);
  assert.equal(closed, 1);
  assert.deepEqual(await lifecycle.drain(), { state:'closed', timedOut:false, pending:0 });
  assert.equal(closed, 1);
});

test('runtime lifecycle reports work that exceeds the shutdown budget', async () => {
  const lifecycle = createRuntimeLifecycle();
  lifecycle.track(new Promise(() => {}));
  const result = await lifecycle.drain({ timeoutMs:1 });
  assert.equal(result.state, 'closed');
  assert.equal(result.timedOut, true);
  assert.equal(result.pending, 1);
});
