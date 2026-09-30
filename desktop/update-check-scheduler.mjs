export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;

const busyStatuses = new Set(['checking', 'available', 'downloading', 'downloaded', 'installing']);

export function createUpdateCheckScheduler({
  check,
  getStatus,
  canCheck = () => true,
  onError = () => {},
  now = Date.now,
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  let timer;
  let started = false;
  let pending = false;
  let lastCheckAt = 0;

  function recordCheck() {
    lastCheckAt = now();
    if (!started) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { void checkIfDue(); }, UPDATE_CHECK_INTERVAL_MS);
    timer?.unref?.();
  }

  async function checkIfDue() {
    if (!started || pending || !canCheck() || busyStatuses.has(getStatus())
      || now() - lastCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
    pending = true;
    recordCheck();
    try { await check(); }
    catch (error) { onError(error); }
    finally { pending = false; }
  }

  return {
    start() {
      if (started) return;
      started = true;
      recordCheck();
    },
    // Resume uses the same deadline and lock as the regular timer.
    checkIfDue,
    recordCheck,
    stop() {
      if (!started) return;
      started = false;
      cancel(timer);
      timer = undefined;
    },
  };
}
