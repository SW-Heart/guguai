export function createRuntimeLifecycle({ now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let state = 'running';
  const inFlight = new Set();
  const settled = new Set();
  const closers = new Set();
  const timers = new Set();

  function track(value) {
    const promise = Promise.resolve(value);
    inFlight.add(promise);
    promise.finally(() => {
      settled.add(promise);
      inFlight.delete(promise);
    }).catch(() => {});
    return promise;
  }

  function registerCloser(closer) {
    if (typeof closer !== 'function') throw new TypeError('生命周期关闭器必须是函数');
    closers.add(closer);
    return () => closers.delete(closer);
  }

  function registerTimer(timer) {
    if (timer) timers.add(timer);
    return timer;
  }

  async function drain({ timeoutMs = 15_000 } = {}) {
    if (state === 'closed') return { state, timedOut:false, pending:0 };
    state = 'draining';
    const budget = Math.max(0, Number(timeoutMs) || 0);
    const deadline = now() + budget;
    const pendingBefore = inFlight.size;
    let timedOut = false;
    const pendingWork = Promise.allSettled([...inFlight]);
    let deadlineTimer = null;
    if (budget) {
      await Promise.race([
        pendingWork,
        new Promise(resolve => { deadlineTimer = setTimeoutFn(resolve, budget); }),
      ]);
      timedOut = inFlight.size > 0 && now() >= deadline;
    } else {
      timedOut = inFlight.size > 0;
    }
    if (deadlineTimer) clearTimeoutFn(deadlineTimer);
    for (const timer of timers) clearTimeoutFn(timer);
    timers.clear();
    for (const closer of [...closers]) {
      try { await closer({ timedOut, deadline }); }
      catch { /* shutdown continues; the caller records resource-specific errors */ }
    }
    state = 'closed';
    const pending = [...inFlight].filter(promise => !settled.has(promise)).length;
    return { state, timedOut, pending:pending || (timedOut ? pendingBefore : 0) };
  }

  return Object.freeze({
    get state() { return state; },
    track,
    registerCloser,
    registerTimer,
    drain,
  });
}
