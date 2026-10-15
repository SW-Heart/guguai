// One refresh path for startup, background checks and the price dialog.
// The server answers `unchanged` when the version we already hold is current,
// so frequent background checks stay tiny.
export function createConfigSync({ fetchConfig, getConfig, applyConfig, accountScope }) {
  let pending = null;
  return async function refreshConfig() {
    if (pending && accountScope.isCurrent(pending.account)) return pending.promise;
    const request = { account: accountScope.snapshot() };
    request.promise = (async () => {
      const knownVersion = String(getConfig()?.configVersion || '');
      const config = await fetchConfig({ knownVersion });
      if (!accountScope.isCurrent(request.account)) return null;
      if (config?.unchanged && knownVersion && config.configVersion === knownVersion) return getConfig();
      if (JSON.stringify(config) !== JSON.stringify(getConfig())) applyConfig(config);
      return config;
    })().finally(() => { if (pending === request) pending = null; });
    pending = request;
    return request.promise;
  };
}
