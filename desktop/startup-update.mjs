// Only the initial metadata check has a deadline. Once an update is offered,
// keep the startup surface until the user installs it or chooses to continue.
export function createStartupUpdateGate({ timeoutMs = 1_500, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let resolve;
  let finished = false;
  let offered = false;
  const ready = new Promise(done => { resolve = done; });
  const finish = () => {
    if (finished) return;
    finished = true;
    cancel(timer);
    resolve();
  };
  const timer = schedule(finish, timeoutMs);
  return {
    ready,
    finish,
    get finished() { return finished; },
    onStatus(status) {
      if (finished) return;
      if (['available', 'downloading', 'downloaded'].includes(status)) {
        offered = true;
        cancel(timer);
      } else if (['current', 'unconfigured'].includes(status) || (status === 'error' && !offered)) {
        finish();
      }
    },
  };
}
