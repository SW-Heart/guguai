import test from 'node:test';
import assert from 'node:assert/strict';
import { changedRecordIds, listSignature, mergeActiveRecords, mergeRecordsAddedDuringRequest, mergeTransientFields, recordSignature } from '../public/list-sync.js';

const taskFields = ['id','status','assetId','updatedAt'];

test('unchanged list responses retain the same display signature', () => {
  const tasks = [{ id:'a', status:'running', assetId:'', updatedAt:'2026-08-15T01:00:00Z' }];
  assert.equal(listSignature(tasks, taskFields), listSignature(structuredClone(tasks), taskFields));
  assert.deepEqual(changedRecordIds(tasks, structuredClone(tasks), taskFields), []);
});

test('only the task whose visible status changed is reported', () => {
  const previous = [
    { id:'a', status:'running', assetId:'', updatedAt:'1' },
    { id:'b', status:'completed', assetId:'asset-b', updatedAt:'1' },
  ];
  const next = [
    { id:'a', status:'completed', assetId:'asset-a', updatedAt:'2' },
    structuredClone(previous[1]),
  ];
  assert.deepEqual(changedRecordIds(previous, next, taskFields), ['a']);
});

test('insertions and removals are reported in server list order', () => {
  const previous = [{ id:'old', status:'completed' }, { id:'keep', status:'completed' }];
  const next = [{ id:'new', status:'queued' }, { id:'keep', status:'completed' }];
  assert.deepEqual(changedRecordIds(previous, next, ['id','status']), ['new','old']);
});

test('record signatures ignore object identity but include requested fields', () => {
  const left = { id:'a', status:'running', localOnly:'first' };
  const right = { id:'a', status:'running', localOnly:'second' };
  assert.equal(recordSignature(left, ['id','status']), recordSignature(right, ['id','status']));
  assert.notEqual(recordSignature(left, ['id','localOnly']), recordSignature(right, ['id','localOnly']));
});

test('server refresh preserves locally measured media dimensions', () => {
  const previous = [{ id:'asset-a', name:'image.png', width:1200, height:1600 }];
  const refreshed = [{ id:'asset-a', name:'renamed.png' }, { id:'asset-b', name:'video.mp4' }];
  assert.deepEqual(mergeTransientFields(previous, refreshed, ['width','height']), [
    { id:'asset-a', name:'renamed.png', width:1200, height:1600 },
    { id:'asset-b', name:'video.mp4' },
  ]);
});

test('server refresh preserves records added while the request was in flight', () => {
  const snapshot = [{ id:'existing', status:'completed' }];
  const current = [{ id:'new-2', status:'queued' }, { id:'new-1', status:'queued' }, ...snapshot];
  const response = [{ id:'new-1', status:'running' }, ...snapshot];

  assert.deepEqual(mergeRecordsAddedDuringRequest(snapshot, current, response), [
    { id:'new-2', status:'queued' },
    { id:'new-1', status:'running' },
    { id:'existing', status:'completed' },
  ]);
});

test('targeted generation refresh updates active records without dropping works', () => {
  const current = [
    { id:'completed', status:'completed', assetId:'asset-1' },
    { id:'running', status:'running' },
    { id:'failed', status:'failed' },
  ];
  const refreshed = [
    { id:'running', status:'completed', assetId:'asset-2' },
    { id:'history-only', status:'running' },
  ];

  assert.deepEqual(mergeActiveRecords(current, refreshed, ['running', 'history-only']), [
    { id:'completed', status:'completed', assetId:'asset-1' },
    { id:'running', status:'completed', assetId:'asset-2' },
    { id:'failed', status:'failed' },
    { id:'history-only', status:'running' },
  ]);
});

test('targeted generation refresh removes an active record missing from the response', () => {
  assert.deepEqual(mergeActiveRecords([
    { id:'keep', status:'completed' },
    { id:'gone', status:'running' },
  ], [], ['gone']), [{ id:'keep', status:'completed' }]);
});
