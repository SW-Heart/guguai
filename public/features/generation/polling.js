export function createTaskPoller({
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  isHidden = () => false,
  getUser = () => null,
  getActiveIds = () => [],
  loadActiveTasks = async () => {},
  loadNotifications = async () => {},
  activeDelay = 6_000,
  notificationDelay = 60_000,
} = {}) {
  let taskTimer = 0;
  let notificationTimer = 0;
  let taskRun = 0;
  let notificationRun = 0;
  function stop() {
    taskRun += 1;
    notificationRun += 1;
    clearTimeoutFn(taskTimer);
    clearTimeoutFn(notificationTimer);
    taskTimer = 0;
    notificationTimer = 0;
  }
  function scheduleTaskPollForRun(delay, run) {
    clearTimeoutFn(taskTimer);
    taskTimer = 0;
    if (!getUser() || isHidden() || !getActiveIds().length) return;
    taskTimer = setTimeoutFn(async () => {
      if (run !== taskRun) return;
      try { await loadActiveTasks(); } catch {}
      if (run === taskRun) scheduleTaskPollForRun(activeDelay, run);
    }, Math.max(0, Number(delay) || activeDelay));
  }
  function scheduleTaskPoll(delay = activeDelay) {
    taskRun += 1;
    scheduleTaskPollForRun(delay, taskRun);
  }
  function scheduleNotificationPollForRun(delay, run) {
    clearTimeoutFn(notificationTimer);
    notificationTimer = 0;
    if (!getUser() || isHidden()) return;
    notificationTimer = setTimeoutFn(async () => {
      if (run !== notificationRun) return;
      try { await loadNotifications(); } catch {}
      if (run === notificationRun) scheduleNotificationPollForRun(notificationDelay, run);
    }, Math.max(0, Number(delay) || notificationDelay));
  }
  function scheduleNotificationPoll(delay = notificationDelay) {
    notificationRun += 1;
    scheduleNotificationPollForRun(delay, notificationRun);
  }
  return { scheduleTaskPoll, scheduleNotificationPoll, stop };
}
