import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness() {
  const item = { id: 'running-task', status: 'running', type: 'video', creditCost: 0, details: { routeId: 'route-a' } };
  const detail = { hidden: false, scrollTop: 230, pre: { textContent: 'selected log content' } };
  const wrap = { scrollLeft: 150 };
  const cells = { '[data-log-elapsed]': { innerHTML: 'old elapsed' }, '[data-log-status]': { innerHTML: 'running' }, '[data-log-credit]': { textContent: '0' } };
  let overlayRemoved = false;
  const overlay = { remove() { overlayRemoved = true; } };
  const row = { dataset: { logId: item.id }, detail, _generationLogItem: item };
  // Whole-row/list replacements must fail instead of silently losing UI state.
  Object.defineProperty(row, 'innerHTML', { set() { assert.fail('row was replaced'); } });
  const root = { wrap, row, scrollTop: 640 };
  Object.defineProperty(root, 'innerHTML', { set() { assert.fail('list was replaced'); } });
  const inserted = [];
  const anchor = { insertAdjacentHTML(position, html) { inserted.push(html); } };
  const button = { closest: () => row };
  const requests = [];
  const state = { view: 'logs', logCategory: 'generations', filters: { logs: { status: 'running' } } };
  let responses = [{ items: [{ ...item, details: { routeId: 'route-b' }, elapsed: 35 }] }];
  let scheduled = 0;
  let selectedItem;
  const context = createContext({
    state, URLSearchParams, logRefreshTimer: null, clearTimeout() {},
    $: (selector, parent) => {
      if (selector === '#logTable') return root;
      if (selector === '.table-wrap') return wrap;
      if (parent === row) return cells[selector] || (selector === '.log-actions-overlay' ? overlay : selector === '.log-actions-anchor' ? anchor : null);
      return null;
    },
    $$: (selector, parent) => {
      if (selector === '[data-log-expand]') return parent === root ? [row] : [];
      if (selector === '[data-generation-switch]') return overlayRemoved ? [] : [button];
      return [];
    },
    logFilterSpec: { generations: { status: { param: 'status' } } },
    nextRequest: () => 1, isStale: () => false, currentCursor: () => null,
    api: async path => { requests.push(path); return responses.shift(); },
    scheduleLogRefresh: () => scheduled++,
    generationElapsedText: item => `elapsed:${item.elapsed ?? 0}`,
    badge: value => value, money: value => String(value),
    generationActionsOverlay: () => '',
    switchGenerationRoute: item => { selectedItem = item; },
    stopGeneration() {},
    markLoading() { assert.fail('background loading altered the UI'); },
    doneLoading() { assert.fail('background loading altered the UI'); },
  });
  runInContext(extract('  function generationControls(', '  function generationActionsOverlay('), context);
  runInContext(extract('  function updateGenerationLogRows(', '  async function switchGenerationRoute('), context);
  runInContext(extract('  async function fetchLogs(', '  const switchRouteStates ='), context);
  context.bindGenerationControls(root, [item]);
  return { context, root, row, detail, cells, wrap, button, requests, inserted, state,
    respond: data => { responses = data; }, scheduled: () => scheduled,
    overlayRemoved: () => overlayRemoved, selectedItem: () => selectedItem,
    refresh: () => context.fetchLogs({ background: true }),
  };
}

test('five-second refresh keeps the list, expanded details, scroll and focused action nodes intact', async () => {
  const h = harness();
  const originalHandler = h.button.onclick;
  const detailContent = h.detail.pre;
  await h.refresh();
  assert.equal(h.cells['[data-log-elapsed]'].innerHTML, 'elapsed:35');
  assert.equal(h.root.row, h.row);
  assert.equal(h.row.detail, h.detail);
  assert.equal(h.detail.pre, detailContent);
  assert.equal(h.detail.pre.textContent, 'selected log content');
  assert.equal(h.detail.hidden, false);
  assert.equal(h.detail.scrollTop, 230);
  assert.equal(h.root.scrollTop, 640);
  assert.equal(h.wrap.scrollLeft, 150);
  assert.equal(h.button.onclick, originalHandler);
  assert.equal(h.overlayRemoved(), false);
  h.button.onclick();
  assert.equal(h.selectedItem().details.routeId, 'route-b');
  assert.equal(h.scheduled(), 1);
});

test('a job omitted by the active-status filter is checked by ID and finishes in place', async () => {
  const h = harness();
  h.respond([{ items: [{ id: 'new-task', status: 'running' }] }, { items: [{ ...h.row._generationLogItem, status: 'completed', elapsed: 42 }] }]);
  await h.refresh();
  assert.equal(h.requests.length, 2);
  const lookup = new URL(h.requests[1], 'http://localhost');
  assert.equal(lookup.searchParams.get('taskId'), 'running-task');
  assert.equal(lookup.searchParams.has('status'), false);
  assert.equal(h.cells['[data-log-elapsed]'].innerHTML, 'elapsed:42');
  assert.equal(h.cells['[data-log-status]'].innerHTML, 'completed');
  assert.equal(h.overlayRemoved(), true);
  assert.equal(h.detail.scrollTop, 230);
  assert.equal(h.scheduled(), 0);
});

test('late responses do not alter another page or rearm its timer', async () => {
  const h = harness();
  const pending = h.refresh();
  h.state.view = 'users';
  await pending;
  assert.equal(h.cells['[data-log-elapsed]'].innerHTML, 'old elapsed');
  assert.equal(h.scheduled(), 0);
});

test('a failed background request keeps the current details and retries quietly', async () => {
  const h = harness();
  h.respond([]);
  await h.refresh();
  assert.equal(h.cells['[data-log-elapsed]'].innerHTML, 'old elapsed');
  assert.equal(h.detail.scrollTop, 230);
  assert.equal(h.scheduled(), 1);
});
