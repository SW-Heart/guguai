import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('admin offers empty 1080p groups for Seedance 2.0 text and image routes', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function renderRoutePanel(data) {');
  const end = source.indexOf('  async function checkRoutes(', start);
  assert.ok(start >= 0 && end > start);
  const root = { innerHTML:'', querySelectorAll:() => [] };
  runInNewContext(`${source.slice(start, end)}\nrenderRoutePanel({items:[]});`, {
    $: selector => selector === '#routePanel' ? root : null,
    esc: value => String(value),
    routeModelLabels: { 'seedance-2.0-text':'Seedance 2.0 文生视频', 'seedance-2.0-img':'Seedance 2.0 图生视频', 'seedance-2.5':'Seedance 2.5' },
  });
  for (const modelId of ['seedance-2.0-text', 'seedance-2.0-img', 'seedance-2.5']) {
    assert.ok(root.innerHTML.includes(`data-add-route="${modelId}:1080p"`));
    assert.ok(root.innerHTML.includes(`data-route-policy="${modelId}:1080p"`));
  }
});

test('admin HTML loads the updated model configuration script cache key', () => {
  const html = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.match(html, /\/guguadmin\.js\?v=27\b/);
  assert.doesNotMatch(html, /\/guguadmin\.js\?v=26\b/);
});
