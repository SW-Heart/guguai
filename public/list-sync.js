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

// Keep records inserted locally while a server list request is in flight. The
// server response can legitimately predate those inserts, especially when a
// batch creates several records concurrently.
export function mergeRecordsAddedDuringRequest(requestSnapshot, current, response) {
  const requestedIds = new Set(requestSnapshot.map(record => record?.id));
  const responseIds = new Set(response.map(record => record?.id));
  const added = current.filter(record => record?.id != null && !requestedIds.has(record.id) && !responseIds.has(record.id));
  return [...added, ...response];
}

// Targeted generation polling returns only the requested active records. Keep
// every non-active record already rendered in the gallery while replacing the
// active snapshots with their latest server state. A missing requested ID is
// treated as removed, while records returned for an active task that was only
// present in the history list are appended to the in-memory gallery.
export function mergeActiveRecords(current = [], refreshed = [], activeIds = []) {
  const active = new Set(activeIds.map(value => String(value ?? '')).filter(Boolean));
  const refreshedById = new Map(refreshed
    .filter(record => record?.id != null)
    .map(record => [String(record.id), record]));
  const merged = [];
  const seen = new Set();
  for (const record of current) {
    const id = String(record?.id ?? '');
    if (!id) {
      merged.push(record);
      continue;
    }
    if (seen.has(id)) continue;
    if (active.has(id)) {
      const latest = refreshedById.get(id);
      if (!latest) continue;
      merged.push(latest);
    } else {
      merged.push(record);
    }
    seen.add(id);
  }
  for (const record of refreshed) {
    const id = String(record?.id ?? '');
    if (!id || seen.has(id)) continue;
    merged.push(record);
    seen.add(id);
  }
  return merged;
}
