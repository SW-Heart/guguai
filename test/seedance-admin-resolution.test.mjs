import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('admin offers empty 1080p groups for unified Seedance routes', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function renderRoutePanel(data) {');
  const end = source.indexOf('  async function checkRoutes(', start);
  assert.ok(start >= 0 && end > start);
  const root = { innerHTML:'', querySelectorAll:() => [] };
  runInNewContext(`${source.slice(start, end)}\nrenderRoutePanel({items:[]});`, {
    $: selector => selector === '#routePanel' ? root : null,
    esc: value => String(value),
    routeModelLabels: { 'seedance-2.0':'Seedance 2.0', 'seedance-2.5':'Seedance 2.5' },
  });
  for (const modelId of ['seedance-2.0', 'seedance-2.5', 'seedance-2.0-value', 'seedance-2.5-value']) {
    assert.ok(root.innerHTML.includes(`data-add-route="${modelId}:1080p"`));
    assert.ok(root.innerHTML.includes(`data-route-policy="${modelId}:1080p"`));
  }
  assert.ok(!root.innerHTML.includes('seedance-2.0-text'));
  assert.ok(!root.innerHTML.includes('seedance-2.0-img'));
});

test('historical route data renders only supported Seedance models and deduplicates rows', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function renderRoutePanel(data) {');
  const end = source.indexOf('  async function checkRoutes(', start);
  const root = { innerHTML:'', dataset:{routeFilter:'seedance-2.0-img'}, querySelectorAll:() => [] };
  const items = ['seedance-2.0-img', 'seedance-2.0-text', 'seedance-2.0', 'seedance-2.5', 'seedance-2.0-fast'].map((logicalModelId, index) => ({
    id:`route-${index}`, logicalModelId, quality:'720p', priority:1, credentialId:'diw',
    upstreamModelId:logicalModelId.startsWith('seedance-2.0') && !logicalModelId.endsWith('fast') ? 'shared' : logicalModelId,
    updatedAt:`2026-01-0${index + 1}`, adminEnabled:true, catalogStatus:'available',
  }));
  const rowIds = [];
  runInNewContext(`${source.slice(start, end)}\nrenderRoutePanel({items, policies:[{logicalModelId:'seedance-2.0-img',quality:'720p',forcedRouteId:'route-0'}]});`, {
    items, $: selector => selector === '#routePanel' ? root : null,
    esc: String, status:String, routeModelLabels: {'seedance-2.0':'Seedance 2.0','seedance-2.5':'Seedance 2.5','seedance-2.0-fast':'Seedance 2.0 Fast'},
    routeRowMarkup: (route, selected) => { rowIds.push([route.id, selected]); return ''; },
  });
  assert.deepEqual([...root.innerHTML.matchAll(/data-route-filter="([^"]*)"/g)].map(match => match[1]), ['', 'seedance-2.0', 'seedance-2.5', 'seedance-2.0-fast', 'seedance-2.0-value', 'seedance-2.5-value']);
  assert.ok(root.innerHTML.includes('全部 5'));
  assert.ok(!root.innerHTML.includes('seedance-2.0-img'));
  assert.ok(!root.innerHTML.includes('seedance-2.0-text'));
  assert.deepEqual(rowIds.map(([id]) => id), ['route-2', 'route-3', 'route-4']);
  assert.equal(rowIds[0][1], true);
  assert.equal(root.dataset.routeFilter, 'seedance-2.0');
});

test('Seedance route forms no longer require a creation type', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function routeDialogFields(');
  const end = source.indexOf('  function validateRouteDialog(', start);
  const fields = runInNewContext(`${source.slice(start, end)}\nrouteDialogFields({logicalModelId:'seedance-2.0'});`, { channelDialogOptions: () => [] });
  assert.ok(!fields.some(field => field.name === 'logicalModelId'));
  assert.ok(fields.some(field => field.name === 'credentialId'));
});

test('admin HTML loads the updated model configuration script cache key', () => {
  const html = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.match(html, /\/guguadmin\.js\?v=34\b/);
  assert.doesNotMatch(html, /\/guguadmin\.js\?v=26\b/);
});
