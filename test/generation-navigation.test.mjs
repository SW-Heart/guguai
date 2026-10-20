import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture(route = 'image') {
  const image = { id:'image-a', type:'image', status:'completed', assetId:'asset-a' };
  const video = { id:'video-a', type:'video', status:'completed', assetId:'asset-b' };
  const grid = { children:[], dataset:{}, style:{ removeProperty() {} }, classList:{ remove() {} },
    insertBefore(node, before) {
      const previous = this.children.indexOf(node);
      if (previous >= 0) this.children.splice(previous, 1);
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
    },
    set innerHTML(value) { assert.fail('cached works must not be replaced by a loading shell'); },
  };
  const makeNode = id => ({ dataset:{ recordId:id, renderSignature:id },
    remove() { grid.children.splice(grid.children.indexOf(this), 1); },
  });
  const original = makeNode(image.id);
  grid.children.push(original);
  const events = [];
  const context = vm.createContext({
    state:{ route, generationTab:'works', initialSyncReady:true, tasks:[image, video], generationPreparations:[], files:[] },
    lastTaskRender:{}, $:() => grid, syncGenerationTab() {},
    fileById:() => ({ localStatus:'saved' }), transientFailureVisible:() => false,
    compareTasksByRecency:() => 0, emptyState:() => '', generationLoadingSkeleton:() => '',
    taskCard:task => task.id, taskRenderSignature:task => task.id, bindTaskCard() {},
    elementFromHtml:makeNode, scheduleGenerationLayout:() => events.push('schedule'),
    layoutGenerationMasonry:() => events.push('layout'), generationLayoutObserver:null,
  });
  for (const [start, end] of [
    ['function renderRouteLoadingShell(', 'function cancelRouteContentRender('],
    ['function reconcileCards(', 'function bindTaskCard('],
    ['function renderTasks()', "$$('.generation-tab').forEach"],
  ]) vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))), context);
  return { context, grid, original, events };
}

test('returning to works preserves the image node and lays out before the first paint', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.context.renderRouteLoadingShell('image');
  assert.equal(f.grid.children.length, 1);
  assert.equal(f.grid.children[0], f.original);
  assert.equal(f.events.filter(event => event === 'layout').length, 20);
});

test('switching image/video immediately selects the correct works before deferred loading', () => {
  const f = fixture('video');
  f.context.renderRouteLoadingShell('video');
  assert.deepEqual(f.grid.children.map(node => node.dataset.recordId), ['video-a']);
  f.context.state.route = 'image';
  f.context.renderRouteLoadingShell('image');
  assert.deepEqual(f.grid.children.map(node => node.dataset.recordId), ['image-a']);
});

test('returning to loaded history does not clear records or reset pagination', () => {
  const loads = [];
  const entry = { loaded:true, items:[{ id:'history-a' }], cursor:'next-page' };
  const context = vm.createContext({
    state:{ route:'image', generationTab:'history', generationHistory:{ image:entry } },
    routeRenderEpoch:0, cancelRouteContentRender() {},
    requestAnimationFrame:callback => { callback(); return 1; },
    window:{ setTimeout:callback => { callback(); return 1; } },
    renderTasks() {}, loadTasks() {}, loadGenerationHistory:options => loads.push(options),
  });
  vm.runInContext(app.slice(app.indexOf('function scheduleRouteContentRender('), app.indexOf('// Short-drama projects open inside the 项目 page')), context);
  context.scheduleRouteContentRender('image', true);
  assert.deepEqual(loads, []);
  assert.equal(entry.items[0].id, 'history-a');
  assert.equal(entry.cursor, 'next-page');
  entry.loaded = false;
  context.scheduleRouteContentRender('image', true);
  assert.equal(loads.length, 1);
});

test('generation navigation fix uses the current versioned application entry', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=600'));
  assert.ok(!html.includes('/app.js?v=512'));
});
