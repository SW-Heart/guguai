import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { openDatabase, closeDatabase, resetForTests, sql } from '../lib/db.mjs';
import { modelControl, validateControlledVideoRequest, publicVideoCapabilitiesWithControls } from '../lib/model-controls.mjs';
import { createModelRoute, updateModelRoute, modelRoute, selectModelRoute, ensureDefaultModelRoutes, modelRouteSettings } from '../lib/model-routes.mjs';

test('channel model capabilities persist independently and control route selection', () => {
  resetForTests();
  openDatabase({ file: ':memory:' });
  const originalKey = process.env.DIW_KEY;
  process.env.DIW_KEY = 'route-settings-test';
  try {
    ensureDefaultModelRoutes();
    sql('UPDATE model_routes SET admin_enabled=0').run();
    const input = { logicalModelId: 'seedance-2.0', quality: '720p', credentialId: 'diw-main', upstreamModelId: 'channel-model-a', priority: 1, costYuan: 1, salePriceYuan: 2, durations: [5, 15], aspectRatios: ['4:3', '21:9'], referenceLimits: { image: 0, video: 2, audio: 0 } };
    const first = createModelRoute(input);
    const second = createModelRoute({ ...input, upstreamModelId: 'channel-model-b', priority: 2, aspectRatios: ['16:9'], referenceLimits: { image: 3, video: 0, audio: 1 } });
    sql("UPDATE model_routes SET catalog_status='available' WHERE admin_enabled=1").run();
    assert.deepEqual(modelRoute(first.id).capabilities.ratios, ['4:3', '21:9']);
    assert.equal(modelRoute(first.id).capabilities.image, 0);
    const request = { logicalModelId: 'seedance-2.0', quality: '720p', aspectRatio: '21:9', referenceCounts: { video: 2 } };
    assert.equal(selectModelRoute(request)?.id, first.id);
    const mode = publicVideoCapabilitiesWithControls().models.find(model => model.id === 'seedance-2.0').modes.find(mode => mode.generationType === 'REFERENCE');
    assert.deepEqual(mode.durationsByQuality['720p']['21:9'], [5, 15]);
    assert.ok(mode.aspectRatios.includes('21:9'));
    assert.equal(validateControlledVideoRequest({ modelId: 'seedance-2.0', quality: '720p', aspectRatio: '21:9' }).aspectRatio, '21:9');
    assert.equal(selectModelRoute({ ...request, referenceCounts: { image: 1 } }), null);
    assert.equal(selectModelRoute({ ...request, referenceCounts: { video: 3 } }), null);
    assert.equal(selectModelRoute({ ...request, aspectRatio: '16:9', referenceCounts: { image: 3 } })?.id, second.id);
    const updated = updateModelRoute(first.id, { aspectRatios: ['9:16', '1:1'], referenceLimits: { image: 1, video: 0, audio: 0 } }, { expectedVersion: first.version });
    assert.deepEqual(modelRoute(second.id).capabilities.ratios, ['16:9']);
    assert.equal(modelRoute(second.id).capabilities.image, 3);
    assert.deepEqual(updated.capabilities.ratios, ['9:16', '1:1']);
    assert.equal(selectModelRoute(request), null);
    updateModelRoute(first.id, { costYuan: 3 });
    assert.equal(modelRoute(first.id).capabilities.video, 0);
    assert.deepEqual(modelRoute(first.id).capabilities.ratios, ['9:16', '1:1']);
    assert.throws(() => updateModelRoute(first.id, { aspectRatios: ['4:3'] }, { expectedVersion: first.version }), /刷新/);
    for (const patch of [
      { aspectRatios: [] }, { aspectRatios: ['2:3'] }, { aspectRatios: '16:9' },
      { referenceLimits: null }, { referenceLimits: { image: -1, video: 0, audio: 0 } },
      { referenceLimits: { image: 1.5, video: 0, audio: 0 } },
      { referenceLimits: { image: '0', video: 0, audio: 0 } },
      { referenceLimits: { image: 0, video: 0 } },
    ]) assert.throws(() => updateModelRoute(first.id, patch), error => error.statusCode === 400);
    assert.throws(() => createModelRoute({ ...input, upstreamModelId: 'invalid', aspectRatios: [] }), error => error.statusCode === 400);
    assert.ok(!('referenceLimits' in modelControl('seedance-2.0')));
    assert.ok(!('aspectRatios' in modelControl('seedance-2.0')));
    const task = validateControlledVideoRequest({ modelId: 'seedance-2.0', generationType: 'REFERENCE', aspectRatio: '9:16', quality: '720p', duration: 15 }, 1);
    assert.equal(task.aspectRatio, '9:16');
    assert.deepEqual(modelRouteSettings('seedance-2.0').aspectRatios, ['16:9', '9:16', '1:1']);
  } finally {
    closeDatabase({ checkpoint: false });
    if (originalKey === undefined) delete process.env.DIW_KEY;
    else process.env.DIW_KEY = originalKey;
  }
});

test('new and edit route forms submit ratios and zero reference counts; model control has no capability fields', async () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  let dialog;
  let payload;
  const context = createContext({
    showAdminDialog: async value => { dialog = value; },
    api: async (url, options) => { payload = JSON.parse(options.body); return { route: { displayName: '测试线路' } }; },
    toast() {}, state: {}, loadModels: async () => {}, routeModelLabels: {},
  });
  const start = source.indexOf('  function channelDialogOptions(');
  runInContext(source.slice(start, source.indexOf('  /* ---------- 日志', start)), context);
  const values = { credentialId: 'diw-main', upstreamModelId: 'test-model', priority: '1', durations: '5,15', billingUnit: 'second', costYuan: '1', salePriceYuan: '2', aspectRatios: ['16:9', '1:1'], imageReferenceCount: '0', videoReferenceCount: '2', audioReferenceCount: '0', adminEnabled: true };
  await runInContext("addModelRoute('seedance-2.0', '720p', {items: [], channels: []})", context);
  assert.deepEqual(Array.from(dialog.fields.find(field => field.name === 'aspectRatios').options), ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
  assert.equal(dialog.validate(values), null);
  assert.ok(dialog.validate({ ...values, aspectRatios: [] }));
  for (const count of ['', '-1', '1.5']) assert.ok(dialog.validate({ ...values, imageReferenceCount: count }));
  await dialog.onSubmit(values);
  assert.deepEqual(payload.aspectRatios, ['16:9', '1:1']);
  assert.deepEqual(payload.referenceLimits, { image: 0, video: 2, audio: 0 });
  await runInContext("editRoute({ id: 'route-a', logicalModelId: 'seedance-2.0', displayName: '线路 A', version: 2, capabilities: {ratios: ['21:9'], image: 0, video: 2, audio: 0} })", context);
  assert.deepEqual(Array.from(dialog.fields.find(field => field.name === 'aspectRatios').value), ['21:9']);
  assert.equal(dialog.fields.find(field => field.name === 'imageReferenceCount').value, 0);
  await dialog.onSubmit(values);
  assert.deepEqual(payload.referenceLimits, { image: 0, video: 2, audio: 0 });
  assert.equal(payload.expectedVersion, 2);
  await runInContext("editModel({ kind: 'video', modelId: 'seedance-2.0', sortOrder: 1, version: 2 })", context);
  assert.ok(!dialog.fields.some(field => field.name === 'aspectRatios' || field.name.endsWith('ReferenceCount')));
});

test('ratio dropdown updates its summary and closes on Escape or focus leaving the control', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const summary = { getAttribute: () => 'false', focus() { this.focused = true; } };
  const value = { textContent: '16:9' };
  const outside = {};
  const dropdown = { open: true, contains: node => node === summary };
  let selected = [{ value: '16:9' }, { value: '1:1' }];
  const context = createContext({
    esc: value => String(value),
    $: selector => selector === 'summary' ? summary : value,
    $$: selector => selector === '[data-admin-multiselect]' ? [dropdown] : selected,
  });
  const start = source.indexOf('  function adminDialogFieldMarkup(');
  runInContext(source.slice(start, source.indexOf('  function setAdminDialogBusy(', start)), context);
  runInContext('bindAdminMultiselects({})', context);
  dropdown.onchange();
  assert.equal(value.textContent, '16:9、1:1');
  assert.equal(dropdown.open, true);
  selected = [];
  dropdown.onchange();
  assert.equal(value.textContent, '请选择画面比例');
  const event = { key: 'Escape', preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  dropdown.onkeydown(event);
  assert.equal(dropdown.open, false);
  assert.ok(event.prevented && event.stopped && summary.focused);
  dropdown.open = true;
  dropdown.onfocusout({ relatedTarget: summary });
  assert.equal(dropdown.open, true);
  dropdown.onfocusout({ relatedTarget: outside });
  assert.equal(dropdown.open, false);
});

test('route fields render a single collapsed dropdown and one row of three reference inputs', () => {
  const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const context = createContext({ esc: value => String(value), channelDialogOptions: () => [] });
  let start = source.indexOf('  function adminDialogFieldMarkup(');
  runInContext(source.slice(start, source.indexOf('  function setAdminDialogBusy(', start)), context);
  start = source.indexOf('  function routeDialogFields(');
  runInContext(source.slice(start, source.indexOf('  function bindRouteBillingUnit(', start)), context);
  const html = runInContext("adminDialogFieldsMarkup(routeDialogFields({logicalModelId: 'seedance-2.0'}))", context);
  assert.equal((html.match(/<details /g) || []).length, 1);
  assert.match(html, /<summary[^>]*>.*16:9、9:16、1:1/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  const row = html.match(/<div class="admin-dialog-number-row">(.*?)<\/div>/s)?.[1];
  assert.ok(row);
  for (const kind of ['image', 'video', 'audio']) assert.ok(row.includes(`data-admin-dialog-field="${kind}ReferenceCount"`));
  assert.equal((row.match(/type="number"/g) || []).length, 3);
  assert.equal((html.match(/0 表示不支持/g) || []).length, 1);
  const css = readFileSync(new URL('../public/guguadmin.css', import.meta.url), 'utf8');
  assert.match(css, /\.admin-dialog-number-row\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
  const entry = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.ok(entry.includes('/guguadmin.js?v=53'));
  assert.ok(entry.includes('/guguadmin.css?v=24'));
});
