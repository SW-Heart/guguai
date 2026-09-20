const DATABASE = 'gugu-canvas-snapshots';
const STORE = 'snapshots';
const VERSION = 1;
let databasePromise;
const pendingWrites = new Map();

function database() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  databasePromise ||= new Promise(resolve => {
    try {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => { if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return databasePromise;
}

export function canvasSnapshotKey({ userId, deviceId, workspaceId, projectId, kind }) {
  if (![userId, deviceId, workspaceId, projectId, kind].every(Boolean)) return '';
  return JSON.stringify([String(userId), String(deviceId), String(workspaceId), String(projectId), String(kind)]);
}

export async function readCanvasSnapshot(key) {
  if (!key) return null;
  await pendingWrites.get(key);
  const db = await database();
  if (!db) return null;
  try {
    return await new Promise(resolve => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function writeCanvasSnapshot(key, value) {
  if (!key || !value) return false;
  let snapshot;
  try { snapshot = structuredClone(value); } catch { return false; }
  const previous = pendingWrites.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    const db = await database();
    if (!db) return false;
    try {
      return await new Promise(resolve => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(snapshot, key);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
        transaction.onabort = () => resolve(false);
      });
    } catch { return false; }
  });
  pendingWrites.set(key, next);
  void next.finally(() => { if (pendingWrites.get(key) === next) pendingWrites.delete(key); });
  return next;
}

export async function deleteCanvasSnapshot(key) {
  if (!key) return false;
  await pendingWrites.get(key);
  const db = await database();
  if (!db) return false;
  try {
    return await new Promise(resolve => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch { return false; }
}
