import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
const start = source.indexOf('  function generationElapsedSeconds(');
const end = source.indexOf('  function bindLogDetails(', start);
const helpers = source.slice(start, end);
const createdAt = '2026-10-24T01:00:00.000Z';

function elapsed(item, at) {
  return runInNewContext(`${helpers}\ngenerationElapsedText(item, at)`, { item, at }).replace(/<[^>]+>/g, '');
}

test('generation elapsed time runs from creation to completion, including failed tasks', () => {
  for (const status of ['completed', 'failed']) {
    assert.equal(elapsed({ status, createdAt, updatedAt: '2026-10-24T02:00:00Z', details: { finishedAt: '2026-10-24T01:01:05.400Z', duration: 10 } }), '65 秒');
  }
  assert.equal(elapsed({ status: 'completed', createdAt, updatedAt: '2026-10-24T01:02:00Z' }), '120 秒');
  assert.equal(elapsed({ status: 'running', createdAt }, Date.parse(createdAt) + 5999), '5 秒');
  assert.equal(elapsed({ status: 'completed', createdAt, details: { finishedAt: createdAt } }), '0 秒');
});

test('active tasks use current time and invalid timestamps remain unavailable', () => {
  for (const status of ['queued', 'running']) {
    assert.equal(elapsed({ status, createdAt, updatedAt: createdAt }, Date.parse(createdAt) + 5000), '5 秒');
  }
  for (const item of [
    { status: 'completed', createdAt },
    { status: 'failed', createdAt: 'invalid', updatedAt: createdAt },
    { status: 'completed', createdAt, details: { finishedAt: 'invalid' } },
    { status: 'failed', createdAt, updatedAt: '2026-10-24T00:59:00Z' },
  ]) assert.equal(elapsed(item), '—');
});

test('generation log places elapsed time after model and keeps detail rows aligned', () => {
  const markup = runInNewContext(`${helpers}\nrenderLogRows('generations', [item])`, {
    item: { status: 'completed', createdAt, updatedAt: '2026-10-24T01:00:12Z', creditCost: 5 },
    esc: value => value, date: value => value, badge: value => value,
    userCell: () => '用户', logModelName: () => '模型名称', money: value => value,
    generationActionsOverlay: () => '',
    logRow: (item, category, index, cells, colspan, trailing) => `<tr>${cells}${trailing}</tr><tr><td colspan="${colspan}">详情</td></tr>`,
  });
  assert.match(markup, /<th>模型<\/th><th class="is-num">耗时<\/th>/);
  assert.match(markup, /<td>模型名称<\/td><td class="is-num" data-log-elapsed><span class="log-elapsed is-deep-green">12 秒<\/span><\/td>/);
  assert.equal((markup.match(/<col style=/g) || []).length, 6);
  assert.match(markup, /colspan="6"/);
  assert.doesNotMatch(markup, /<th>操作<\/th>/);
});

test('admin entry uses the fresh script cache key', () => {
  const entry = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.ok(entry.includes('/guguadmin.js?v=79'));
  assert.ok(entry.includes('/guguadmin.css?v=39'));
  assert.ok(!entry.includes('/guguadmin.js?v=61'));
});

test('elapsed colors cover every threshold for active and finished tasks', () => {
  for (const [seconds, tone] of [[0, 'deep-green'], [199.9, 'deep-green'], [200, 'green'], [499.9, 'green'], [500, 'yellow'], [1000, 'yellow'], [1000.1, 'red']]) {
    for (const status of ['running', 'completed']) {
      const at = Date.parse(createdAt) + seconds * 1000;
      const item = { status, createdAt, details: { finishedAt: new Date(at).toISOString() } };
      const markup = runInNewContext(`${helpers}\ngenerationElapsedText(item, at)`, { item, at });
      assert.ok(markup.includes(`is-${tone}`), `${status}: ${seconds}`);
    }
  }
});

test('log refresh waits five seconds and stops when leaving generation logs', () => {
  const timerSource = source.slice(source.indexOf('  let logRefreshTimer;'), source.indexOf('  async function fetchLogs('));
  const state = { view: 'logs', logCategory: 'generations' };
  let callback;
  let delay;
  let calls = 0;
  const context = { state, clearTimeout() {}, setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, fetchLogs(options) { assert.equal(options.background, true); calls++; } };
  runInNewContext(`${timerSource}\nscheduleLogRefresh();`, context);
  assert.equal(delay, 5000);
  callback();
  assert.equal(calls, 1);
  state.logCategory = 'credits';
  callback();
  state.view = 'overview';
  state.logCategory = 'generations';
  callback();
  assert.equal(calls, 1);
});
