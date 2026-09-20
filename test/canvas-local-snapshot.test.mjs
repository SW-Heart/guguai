import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasSnapshotKey, readCanvasSnapshot, writeCanvasSnapshot, deleteCanvasSnapshot } from '../public/features/drama/local-snapshot.js';

test('canvas snapshots stay inside their account and desktop workspace', () => {
  const scope={userId:'u1',deviceId:'d1',workspaceId:'w1',projectId:'p1',kind:'project'};
  const key=canvasSnapshotKey(scope);
  assert.ok(key);
  assert.notEqual(key,canvasSnapshotKey({...scope,userId:'u2'}));
  assert.notEqual(key,canvasSnapshotKey({...scope,workspaceId:'w2'}));
  assert.notEqual(key,canvasSnapshotKey({...scope,kind:'agent'}));
  assert.equal(canvasSnapshotKey({...scope,userId:''}),'');
});

test('snapshot storage degrades safely when IndexedDB is unavailable', async () => {
  const key=canvasSnapshotKey({userId:'u',deviceId:'d',workspaceId:'w',projectId:'p',kind:'project'});
  assert.equal(await readCanvasSnapshot(key),null);
  assert.equal(await writeCanvasSnapshot(key,{revision:1}),false);
  assert.equal(await deleteCanvasSnapshot(key),false);
});

test('saved canvas snapshots read locally in write order and can be removed', async () => {
  const original=globalThis.indexedDB;
  const records=new Map();
  globalThis.indexedDB={open(){
    const db={objectStoreNames:{contains:()=>false},createObjectStore(){},transaction(){
      const tx={objectStore:()=>({
        get:key=>{const request={};queueMicrotask(()=>{request.result=records.get(key);request.onsuccess?.();});return request;},
        put:(value,key)=>queueMicrotask(()=>{records.set(key,value);tx.oncomplete?.();}),
        delete:key=>queueMicrotask(()=>{records.delete(key);tx.oncomplete?.()}),
      })};
      return tx;
    }};
    const request={result:db};
    queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});
    return request;
  }};
  try {
    const key=canvasSnapshotKey({userId:'u',deviceId:'d',workspaceId:'w',projectId:'p',kind:'project'});
    const first={revision:1},second={revision:2};
    const writes=[writeCanvasSnapshot(key,first),writeCanvasSnapshot(key,second)];
    second.revision=99;
    assert.deepEqual(await Promise.all(writes),[true,true]);
    assert.deepEqual(await readCanvasSnapshot(key),{revision:2});
    assert.equal(await deleteCanvasSnapshot(key),true);
    assert.equal(await readCanvasSnapshot(key),null);
  } finally { globalThis.indexedDB=original; }
});
