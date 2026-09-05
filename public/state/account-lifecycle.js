export function createAccountLifecycle({
  advanceScope = () => {},
  snapshotScope = () => null,
  isScopeCurrent = () => true,
  onInvalidate = () => {},
  resetState = () => {},
} = {}) {
  let epoch = 0;

  function invalidate() {
    epoch += 1;
    advanceScope();
    onInvalidate(epoch);
    return epoch;
  }

  function reset() {
    const nextEpoch = invalidate();
    resetState(nextEpoch);
    return nextEpoch;
  }

  function snapshot() {
    return { epoch, scope: snapshotScope() };
  }

  function isCurrent(request) {
    return Boolean(request)
      && request.epoch === epoch
      && isScopeCurrent(request.scope);
  }

  async function activate(account, activateWorkspace) {
    const activationEpoch = reset();
    const result = await activateWorkspace(account);
    return activationEpoch === epoch ? result : null;
  }

  return { invalidate, reset, snapshot, isCurrent, activate, get epoch() { return epoch; } };
}
