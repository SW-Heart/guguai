const ignoredProjectKeys = new Set(['revision', 'updatedAt']);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function equal(left, right) {
  return stable(left) === stable(right);
}

function conflictRecord(path, base, local, remote) {
  return { path, baseValue:clone(base), localValue:clone(local), remoteValue:clone(remote) };
}

function mergeArray(base, local, remote, path, conflicts, choices) {
  const keyed = [base, local, remote].every(value => Array.isArray(value) && value.every(item => item && typeof item === 'object' && item.id));
  if (!keyed) {
    if (equal(local, base)) return clone(remote);
    if (equal(remote, base) || equal(local, remote)) return clone(local);
    const choice = choices[path];
    conflicts.push(conflictRecord(path, base, local, remote));
    return clone(choice === 'local' ? local : remote);
  }
  const baseById = new Map(base.map(item => [String(item.id), item]));
  const localById = new Map(local.map(item => [String(item.id), item]));
  const remoteById = new Map(remote.map(item => [String(item.id), item]));
  const order = [...remote.map(item => String(item.id)), ...local.map(item => String(item.id))].filter((id, index, values) => values.indexOf(id) === index);
  return order.map(id => mergeNode(baseById.get(id), localById.get(id), remoteById.get(id), `${path}[${id}]`, conflicts, choices)).filter(value => value !== undefined);
}

function mergeNode(base, local, remote, path, conflicts, choices) {
  if (equal(local, base)) return clone(remote);
  if (equal(remote, base) || equal(local, remote)) return clone(local);
  if (Array.isArray(local) && Array.isArray(remote)) return mergeArray(Array.isArray(base) ? base : [], local, remote, path, conflicts, choices);
  if (local && remote && typeof local === 'object' && typeof remote === 'object' && !Array.isArray(local) && !Array.isArray(remote)) {
    const merged = {};
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      if (path === '' && ignoredProjectKeys.has(key)) {
        merged[key] = clone(remote[key] ?? local[key] ?? base?.[key]);
        continue;
      }
      const value = mergeNode(base?.[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts, choices);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  const choice = choices[path];
  conflicts.push(conflictRecord(path, base, local, remote));
  return clone(choice === 'local' ? local : remote);
}

export function mergeProjectThreeWay({ base, local, remote, choices = {} } = {}) {
  const conflicts = [];
  const project = mergeNode(base || {}, local || {}, remote || {}, '', conflicts, choices) || {};
  project.revision = Number(remote?.revision) || Number(base?.revision) || 1;
  project.updatedAt = remote?.updatedAt || base?.updatedAt || project.updatedAt;
  return { project, conflicts };
}

export function projectConflictChoiceMap(conflicts, choice = 'remote') {
  return Object.fromEntries((Array.isArray(conflicts) ? conflicts : []).map(conflict => [conflict.path, choice]));
}
