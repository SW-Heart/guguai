const requiredMethods = ['validate', 'submit', 'poll', 'lookup'];

export function createProviderAdapterRegistry(adapters = {}) {
  const entries = Object.entries(adapters).map(([name, adapter]) => {
    if (!adapter || typeof adapter !== 'object') throw new Error(`供应商适配器 ${name} 无效`);
    for (const method of requiredMethods) {
      if (typeof adapter[method] !== 'function') throw new Error(`供应商适配器 ${name} 缺少 ${method}`);
    }
    return [name, Object.freeze({ name, ...adapter })];
  });
  const registry = new Map(entries);
  return Object.freeze({
    get(name) { return registry.get(String(name || '')) || null; },
    forTask(task) { return registry.get(task?.routeId ? 'route' : String(task?.provider || '')) || null; },
    names: Object.freeze(entries.map(([name]) => name)),
  });
}
