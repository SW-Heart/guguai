function accountIdentity(user) {
  return String(user?.id || user?.username || '');
}

export function createAccountScope({ getUser = () => null } = {}) {
  let epoch = 0;

  function advance() {
    epoch += 1;
    return epoch;
  }

  function snapshot() {
    return { epoch, userId: accountIdentity(getUser()) };
  }

  function isCurrent(request) {
    return Boolean(request)
      && request.epoch === epoch
      && request.userId === accountIdentity(getUser());
  }

  return { advance, snapshot, isCurrent };
}
