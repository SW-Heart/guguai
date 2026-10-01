import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness({ initial = false } = {}) {
  const scroller = { scrollTop: 1600, scrollLeft: 12 };
  const table = (label, left = 0) => ({ label, scrollTop: 0, scrollLeft: left });
  const tabs = ['routes', 'models', 'pricing'].map(tab => ({ dataset: { tab }, setAttribute() {} }));
  const panels = Object.fromEntries(['routePanel', 'modelPanel', 'pricingPanel'].map(id => [id, { id, dataset: {}, innerHTML: 'existing content' }]));
  panels.routePanel.dataset.routeFilter = 'seedance-2.0-img';
  const refresh = {};
  let mounted = !initial;
  let shellWrites = 0;
  let wraps = [table('seedance-2.0-img 720p', 240)];
  const root = {
    set innerHTML(value) { shellWrites++; mounted = true; scroller.scrollTop = 0; this.markup = value; },
  };
  const requests = [];
  const renders = [];
  const errors = [];
  const state = { modelsTab: 'routes', modelItems: [], routeData: initial ? null : { items: [] }, requestSeq: {} };
  const context = createContext({
    state,
    document: { scrollingElement: scroller },
    $: (selector, parent) => {
      if (selector === '#view-models') return root;
      if (selector === 'table') return { getAttribute: () => parent.label };
      if (selector === '[data-refresh="models"]') return refresh;
      return mounted ? panels[selector.slice(1)] : null;
    },
    $$: selector => selector === '.table-wrap' ? wraps : selector.includes('[role="tab"]') ? tabs : [],
    pageHead: () => '', refreshButton: () => '', skeletonMarkup: () => 'loading',
    setButtonBusy: (button, busy) => { button.disabled = busy; },
    nextRequest: key => state.requestSeq[key] = (state.requestSeq[key] || 0) + 1,
    isStale: (key, token) => state.requestSeq[key] !== token,
    api: async (path, options) => {
      requests.push({ path, options });
      if (options) return { route: { displayName: 'new route' } };
      if (path.endsWith('/models')) return { items: [{ modelId: 'updated-model' }] };
      if (path.endsWith('/model-routes')) return { items: [{ id: 'updated-route' }] };
      return { current: { version: 2 } };
    },
    renderRoutePanel: () => {
      renders.push('routes');
      panels.routePanel.innerHTML = 'updated routes';
      // Replacing a list can clamp document scroll and resets table scroll.
      scroller.scrollTop = 0;
      wraps = [table('new group'), table('seedance-2.0-img 720p')];
    },
    renderModelPanel: () => { renders.push('models'); panels.modelPanel.innerHTML = 'updated models'; },
    renderPricingPanel: () => { renders.push('pricing'); panels.pricingPanel.innerHTML = 'updated pricing'; },
    toastError: error => errors.push(error.message),
    errorMarkup: message => message, bindRetry() {},
    toast() {}, routeModelLabels: {}, routeDialogFields: () => [], validateRouteDialog() {},
    showAdminDialog: async dialog => dialog.onSubmit({ credentialId: 'channel', upstreamModelId: 'upstream', priority: 1, durations: '5', costYuan: 1, salePriceYuan: 2, adminEnabled: true, sortOrder: 3 }),
  });
  runInContext(extract('  const modelTabs =', '  function renderPricingPanel('), context);
  runInContext(extract('  async function addModelRoute(', '\n  /* ---------- 日志'), context);
  return { context, state, panels, root, refresh, scroller, requests, renders, errors, tabs, wraps: () => wraps, shellWrites: () => shellWrites };
}

for (const [name, action, method] of [
  ['adding a route', "addModelRoute('seedance-2.0-img', '720p', { items: [], channels: [] })", 'POST'],
  ['editing a route', "editRoute({ id: 'route', displayName: 'Route', version: 1 })", 'PATCH'],
  ['editing model visibility', "editModel({ modelId: 'model', sortOrder: 1, version: 1 })", 'PATCH'],
]) {
  test(`${name} refreshes data while preserving the page, filter, price draft and scroll`, async () => {
    const h = harness();
    const panel = h.panels.routePanel;
    h.panels.pricingPanel.innerHTML = 'unsaved price draft';
    await runInContext(action, h.context);
    assert.equal(h.requests[0].options.method, method);
    assert.equal(h.shellWrites(), 0);
    assert.equal(h.panels.routePanel, panel);
    assert.equal(panel.dataset.routeFilter, 'seedance-2.0-img');
    assert.equal(h.state.modelsTab, name === 'editing model visibility' ? 'models' : 'routes');
    assert.equal(h.state.modelItems[0].modelId, 'updated-model');
    assert.equal(h.state.routeData.items[0].id, 'updated-route');
    assert.deepEqual(h.renders, ['routes', 'models']);
    assert.equal(h.panels.pricingPanel.innerHTML, 'unsaved price draft');
    assert.ok(!h.requests.some(request => request.path.endsWith('/pricing')));
    assert.deepEqual(h.scroller, { scrollTop: 1600, scrollLeft: 12 });
    assert.equal(h.wraps()[1].scrollLeft, 240);
    assert.equal(h.refresh.disabled, false);
  });
}

test('first visit builds the page and loads all panels; manual refresh retains its shell', async () => {
  const h = harness({ initial: true });
  await runInContext('loadModels()', h.context);
  assert.equal(h.shellWrites(), 1);
  assert.deepEqual(h.renders, ['routes', 'models', 'pricing']);
  h.scroller.scrollTop = 900;
  await h.refresh.onclick({ type: 'click' });
  assert.equal(h.shellWrites(), 1);
  assert.deepEqual(h.renders, ['routes', 'models', 'pricing', 'routes', 'models', 'pricing']);
  assert.equal(h.scroller.scrollTop, 900);
});

test('failed refresh leaves current data and scroll intact and reports the error', async () => {
  const h = harness();
  h.context.api = async () => { throw new Error('refresh failed'); };
  await runInContext('loadModels({ refreshPricing: false })', h.context);
  assert.equal(h.shellWrites(), 0);
  assert.deepEqual(h.renders, []);
  assert.equal(h.panels.routePanel.innerHTML, 'existing content');
  assert.equal(h.scroller.scrollTop, 1600);
  assert.deepEqual(h.errors, ['refresh failed']);
  assert.equal(h.refresh.disabled, false);
});

test('refresh respects scrolling during the request and ignores outdated responses', async () => {
  const h = harness();
  const pending = [];
  h.context.api = path => new Promise(resolve => pending.push({ path, resolve }));
  const first = runInContext('loadModels({ refreshPricing: false })', h.context);
  const second = runInContext('loadModels({ refreshPricing: false })', h.context);
  h.scroller.scrollTop = 2200;
  const resolveRequest = (request, id) => request.resolve({ items: [{ id, modelId: id }] });
  pending.slice(2).forEach(request => resolveRequest(request, 'new'));
  await second;
  pending.slice(0, 2).forEach(request => resolveRequest(request, 'old'));
  await first;
  assert.equal(h.state.modelItems[0].modelId, 'new');
  assert.equal(h.state.routeData.items[0].id, 'new');
  assert.deepEqual(h.renders, ['routes', 'models']);
  assert.equal(h.scroller.scrollTop, 2200);
});
