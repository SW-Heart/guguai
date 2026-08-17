import test from 'node:test';
import assert from 'node:assert/strict';
import { changedRecordIds, listSignature, mergeTransientFields, recordSignature } from '../public/list-sync.js';

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
