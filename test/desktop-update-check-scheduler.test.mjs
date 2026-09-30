import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateCheckScheduler, UPDATE_CHECK_INTERVAL_MS } from '../desktop/update-check-scheduler.mjs';

function setup(check = async () => {}) {
  const state = { time: 0, status: 'current', allowed: true, checks: 0, errors: [], schedules: 0, cancelled: [] };
  const scheduler = createUpdateCheckScheduler({
    check: async () => { state.checks++; await check(); },
    getStatus: () => state.status,
    canCheck: () => state.allowed,
    onError: error => state.errors.push(error),
    now: () => state.time,
    schedule: (callback, interval) => {
      state.schedules++;
      state.tick = callback;
      state.interval = interval;
      return 42;
    },
    cancel: timer => state.cancelled.push(timer),
  });
  scheduler.start();
  return { state, scheduler };
}

test('first and subsequent checks wait 30 minutes, including resume calls', async () => {
  const { state, scheduler } = setup();
  assert.equal(state.interval, 30 * 60 * 1_000);
  scheduler.start();
  assert.equal(state.schedules, 1);
  assert.equal(state.checks, 0);
  state.time = UPDATE_CHECK_INTERVAL_MS - 1;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 0);
  state.time++;
  state.tick();
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
  state.time += UPDATE_CHECK_INTERVAL_MS - 1;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
  state.time++;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 2);
});

for (const status of ['checking', 'available', 'downloading', 'downloaded', 'installing']) {
  test(`background checks preserve ${status} updates`, async () => {
    const { state, scheduler } = setup();
    state.time = UPDATE_CHECK_INTERVAL_MS * 2;
    state.status = status;
    await scheduler.checkIfDue();
    assert.equal(state.checks, 0);
    state.status = 'current';
    await scheduler.checkIfDue();
    assert.equal(state.checks, 1);
  });
}

test('ineligible clients and other active update operations skip checks', async () => {
  const { state, scheduler } = setup();
  state.time = UPDATE_CHECK_INTERVAL_MS;
  state.allowed = false;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 0);
  state.allowed = true;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
});

test('timer and resume cannot overlap a slow check', async () => {
  let finish;
  const { state, scheduler } = setup(() => new Promise(resolve => { finish = resolve; }));
  state.time = UPDATE_CHECK_INTERVAL_MS;
  const pending = scheduler.checkIfDue();
  state.time += UPDATE_CHECK_INTERVAL_MS;
  state.tick();
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
  finish();
  await pending;
});

test('a failed check releases the lock and retries at the next interval', async () => {
  const failure = new Error('offline');
  const { state, scheduler } = setup(async () => { throw failure; });
  state.status = 'error';
  state.time = UPDATE_CHECK_INTERVAL_MS;
  await scheduler.checkIfDue();
  assert.deepEqual(state.errors, [failure]);
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
  state.time += UPDATE_CHECK_INTERVAL_MS;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 2);
});

test('manual checks reset the deadline for background and resume checks', async () => {
  const { state, scheduler } = setup();
  state.time = UPDATE_CHECK_INTERVAL_MS - 1;
  scheduler.recordCheck();
  assert.equal(state.schedules, 2, 'the timer restarts from the actual check time');
  assert.deepEqual(state.cancelled, [42]);
  state.time++;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 0);
  state.time += UPDATE_CHECK_INTERVAL_MS - 1;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
});

test('a late resume check restarts the timer so the next check is 30 minutes later', async () => {
  const { state, scheduler } = setup();
  state.time = UPDATE_CHECK_INTERVAL_MS * 1.5;
  await scheduler.checkIfDue();
  assert.equal(state.checks, 1);
  assert.equal(state.schedules, 2);
  assert.deepEqual(state.cancelled, [42]);
  state.time += UPDATE_CHECK_INTERVAL_MS;
  state.tick();
  await scheduler.checkIfDue();
  assert.equal(state.checks, 2);
});

test('quit cancels the timer and queued timer or resume calls cannot check', async () => {
  const { state, scheduler } = setup();
  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(state.cancelled, [42]);
  state.time = UPDATE_CHECK_INTERVAL_MS;
  state.tick();
  await scheduler.checkIfDue();
  assert.equal(state.checks, 0);
});
