import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPoller } from '../public/features/generation/polling.js';

test('task poller schedules one active request and can stop both loops', async () => {
  const timers = [];
  const cleared = [];
  let user = true;
  let hidden = false;
  let taskPolls = 0;
  let notificationPolls = 0;
  const poller = createTaskPoller({
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { if (timer) cleared.push(timer); },
    getUser: () => user,
    isHidden: () => hidden,
    getActiveIds: () => ['task-1'],
    loadActiveTasks: async () => { taskPolls += 1; },
    loadNotifications: async () => { notificationPolls += 1; },
  });
  poller.scheduleTaskPoll(1);
  poller.scheduleNotificationPoll(2);
  assert.deepEqual(timers.map(item => item.delay), [1, 2]);
  await timers[0].callback();
  await timers[1].callback();
  assert.equal(taskPolls, 1);
  assert.equal(notificationPolls, 1);
  user = false;
  hidden = true;
  poller.scheduleTaskPoll();
  poller.scheduleNotificationPoll();
  poller.stop();
  assert.ok(cleared.length >= 2);
});

test('task poller does not resurrect a stopped loop after an in-flight request', async () => {
  const timers = [];
  let resolveActiveTasks;
  const activeTasksFinished = new Promise(resolve => { resolveActiveTasks = resolve; });
  const poller = createTaskPoller({
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutFn: () => {},
    getUser: () => true,
    getActiveIds: () => ['task-1'],
    loadActiveTasks: () => activeTasksFinished,
  });
  poller.scheduleTaskPoll(1);
  const request = timers.shift().callback();
  poller.stop();
  resolveActiveTasks();
  await request;
  assert.equal(timers.length, 0);
});

test('notification poller does not resurrect a stopped loop after an in-flight request', async () => {
  const timers = [];
  let resolveNotifications;
  const notificationsFinished = new Promise(resolve => { resolveNotifications = resolve; });
  const poller = createTaskPoller({
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutFn: () => {},
    getUser: () => true,
    loadNotifications: () => notificationsFinished,
  });
  poller.scheduleNotificationPoll(1);
  const request = timers.shift().callback();
  poller.stop();
  resolveNotifications();
  await request;
  assert.equal(timers.length, 0);
});

test('poller ignores a queued callback after stop and continues after a transient loader failure', async () => {
  const timers = [];
  const poller = createTaskPoller({
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    getUser: () => true,
    getActiveIds: () => ['task-1'],
    loadActiveTasks: async () => {},
  });
  poller.scheduleTaskPoll(1);
  const stale = timers.shift().callback();
  poller.stop();
  await stale;
  assert.equal(timers.length, 0);

  let failures = 0;
  const retryPoller = createTaskPoller({
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    getUser: () => true,
    getActiveIds: () => ['task-1'],
    loadActiveTasks: async () => { failures += 1; if (failures === 1) throw new Error('temporary'); },
  });
  retryPoller.scheduleTaskPoll(1);
  await timers.shift().callback();
  assert.deepEqual(timers.map(item => item.delay), [6000]);
});

for (const desktop of [false, true]) {
  test(`hidden ${desktop ? 'desktop continues tasks' : 'browser pauses tasks'} while notifications pause`, async () => {
    const timers = new Set();
    let hidden = false;
    let active = ['video'];
    let polls = 0;
    const poller = createTaskPoller({
      setTimeoutFn: callback => { timers.add(callback); return callback; },
      clearTimeoutFn: callback => timers.delete(callback),
      isHidden: () => hidden,
      canPollInBackground: () => desktop,
      getUser: () => true,
      getActiveIds: () => active,
      loadActiveTasks: async () => { polls += 1; if (polls === 2) active = []; },
    });
    poller.scheduleTaskPoll();
    poller.scheduleNotificationPoll();
    hidden = true;
    poller.onHidden();
    assert.equal(timers.size, desktop ? 1 : 0);
    if (desktop) {
      for (let i = 0; i < 2; i += 1) {
        const callback = [...timers][0];
        timers.delete(callback);
        await callback();
      }
      assert.equal(polls, 2);
      assert.equal(timers.size, 0, 'no polling after all tasks complete');
    } else {
      poller.scheduleTaskPoll();
      assert.equal(timers.size, 0);
      hidden = false;
      poller.scheduleTaskPoll();
      assert.equal(timers.size, 1);
    }
    poller.stop();
  });
}

test('hiding desktop during a request preserves the loop; logout still stops it', async () => {
  const timers = new Set();
  let finish;
  const poller = createTaskPoller({
    setTimeoutFn: callback => { timers.add(callback); return callback; },
    clearTimeoutFn: callback => timers.delete(callback),
    getUser: () => true,
    isHidden: () => true,
    canPollInBackground: () => true,
    getActiveIds: () => ['video'],
    loadActiveTasks: () => new Promise(resolve => { finish = resolve; }),
  });
  poller.scheduleTaskPoll();
  const callback = [...timers][0];
  timers.delete(callback);
  const request = callback();
  poller.onHidden();
  finish();
  await request;
  assert.equal(timers.size, 1);
  poller.stop();
  assert.equal(timers.size, 0);
});
