import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
function harness(items, channels = []) {
  const data = { items, channels };
  const root = { dataset: {}, innerHTML: '', querySelectorAll: () => [] };
  const context = createContext({
    state: { routeData: data }, status: value => ({ missing: '目录缺失' }[value] || value),
    $: selector => selector === '#routePanel' ? root : null,
    routeModelQualities: {}, routeModelLabels: {}, routeRowMarkup: () => '',
    esc: String, money: String,
  });
  runInContext(source.slice(source.indexOf('  function routeIdsForModel('), source.indexOf('  function modelCheckMarkup(')), context);
  runInContext(source.slice(source.indexOf('  function renderRoutePanel('), source.indexOf('  async function checkRoutes(')), context);
  return {
    status: () => runInContext("modelCheckStatus('seedance-2.0')", context),
    render: () => { runInContext('renderRoutePanel(state.routeData)', context); return root.innerHTML; },
  };
}
const route = (id, catalogStatus, extra = {}) => ({ id, logicalModelId: 'seedance-2.0', quality: '720p', credentialId: 'enabled', upstreamModelId: id, adminEnabled: true, catalogStatus, ...extra });

test('model status reflects available active routes instead of one failed channel', () => {
  assert.equal(harness([route('a', 'available'), route('b', 'missing')]).status().label, '部分可用');
  assert.equal(harness([route('a', 'available'), route('b', 'missing', { adminEnabled: false })]).status().label, '全部可用');
  assert.equal(harness([route('a', 'available'), route('b', 'credential_error', { credentialId: 'disabled' })], [{ id: 'disabled', enabled: false }]).status().label, '全部可用');
});

test('disabled routes and channels are excluded from attention and available counts', () => {
  const html = harness([
    route('a', 'available'), route('b', 'missing'),
    route('c', 'missing', { adminEnabled: false }),
    route('d', 'probe_error', { adminEnabled: false, autoDisabled: true }),
    route('e', 'credential_error', { credentialId: 'disabled' }),
    route('f', 'available', { credentialId: 'disabled' }),
  ], [{ id: 'disabled', enabled: false }]).render();
  assert.match(html, /共 6 条线路 · 1 条可用/);
  assert.match(html, /1 条需要处理/);
  assert.match(html, /6 条线路 · 1 条可用/);
  assert.doesNotMatch(harness([route('a', 'missing', { adminEnabled: false })]).render(), /需要处理/);
});

test('model status distinguishes disabled, unchecked and fully unavailable routes', () => {
  assert.equal(harness([]).status().kind, 'none');
  assert.equal(harness([route('a', 'missing', { adminEnabled: false })]).status().label, '已停用');
  assert.equal(harness([route('a', 'missing'), route('b', 'missing')]).status().label, '目录缺失');
  assert.equal(harness([route('a', 'missing'), route('b', 'unknown')]).status().label, '待检查');
  assert.equal(harness([route('a', 'missing'), route('b', 'credential_error')]).status().label, '暂无可用线路');
});

test('admin entry loads the updated route status logic', () => {
  assert.match(readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8'), /\/guguadmin\.js\?v=79"/);
});
