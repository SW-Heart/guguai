export function recordSignature(record, fields) {
  return fields.map(field => `${field}:${JSON.stringify(record?.[field] ?? null)}`).join('|');
}

export function listSignature(records, fields) {
  return records.map(record => recordSignature(record, fields)).join('\n');
}

export function changedRecordIds(previous, next, fields) {
  const before = new Map(previous.map(record => [record.id, recordSignature(record, fields)]));
  const after = new Map(next.map(record => [record.id, recordSignature(record, fields)]));
  const changed = [];
  for (const record of next) if (before.get(record.id) !== after.get(record.id)) changed.push(record.id);
  for (const record of previous) if (!after.has(record.id)) changed.push(record.id);
  return changed;
}

export function mergeTransientFields(previous, next, fields) {
  const before = new Map(previous.map(record => [record.id, record]));
  return next.map(record => {
    const existing = before.get(record.id);
    if (!existing) return record;
    const transient = Object.fromEntries(fields.filter(field => record[field] == null && existing[field] != null).map(field => [field, existing[field]]));
    return Object.keys(transient).length ? { ...record, ...transient } : record;
  });
}
