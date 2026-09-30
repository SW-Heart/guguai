// One refresh path for startup, background checks and the price dialog.
export function createConfigSync({ fetchConfig, getConfig, applyConfig, accountScope }) {
  let pending = null;
  return async function refreshConfig() {
    if (pending && accountScope.isCurrent(pending.account)) return pending.promise;
    const request = { account: accountScope.snapshot() };
    request.promise = (async () => {
      const config = await fetchConfig();
      if (!accountScope.isCurrent(request.account)) return null;
      if (JSON.stringify(config) !== JSON.stringify(getConfig())) applyConfig(config);
      return config;
    })().finally(() => { if (pending === request) pending = null; });
    pending = request;
    return request.promise;
  };
}
