import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
function fixture() {
  let config;
  const state = { logCategory:'generations', filters:{ logs:{ from:'', to:'' } } };
  const fields = { from:{ value:'' }, to:{ value:'' } };
  const buttons = ['today', '7d', '30d', ''].map(value => ({ dataset:{ value }, attributes:{}, setAttribute(key, value) { this.attributes[key] = value; } }));
  const error = { textContent:'' };
  const context = vm.createContext({ state, logFilterSpec:{ generations:{ taskId:true, modelId:true } },
    esc:String, icon:() => '<svg></svg>', adminDialogFieldsMarkup:() => '<div>date fields</div>',
    showAdminDialog:options => { config = options; return null; },
    $:selector => selector.includes('"from"') ? fields.from : selector.includes('"to"') ? fields.to : error,
    $$:() => buttons,
  });
  vm.runInContext(source.slice(source.indexOf('  const pad ='), source.indexOf('  const statusLabels =')), context);
  vm.runInContext(source.slice(source.indexOf('  function quickRangeChips('), source.indexOf('  async function loadOrders(')), context);
  vm.runInContext(source.slice(source.indexOf('  function logTimeRangeLabel('), source.indexOf('  async function loadLogs(')), context);
  return { context, state, fields, buttons, error, dialog:() => config };
}

test('log toolbar has one time range control and no separate date fields or quick ranges', () => {
  const { context } = fixture();
  const markup = context.logFiltersMarkup();
  assert.match(markup, /id="logTimeRange"[^>]*aria-haspopup="dialog"/);
  assert.match(markup, /全部时间/);
  assert.doesNotMatch(markup, /datetime-local|logFrom|logTo|logQuickRange|data-quick-range/);
  assert.match(markup, /class="log-filter-row"/);
});

test('time range dialog validates order and supports open ended ranges', () => {
  const f = fixture();
  f.context.selectLogTimeRange(f.state.filters.logs);
  const config = f.dialog();
  assert.equal(config.submit, '应用');
  assert.equal(config.cancel, '取消');
  assert.deepEqual(Array.from(config.fields, field => field.name), ['from', 'to']);
  assert.equal(config.validate({ from:'', to:'' }), null);
  assert.equal(config.validate({ from:'2026-10-01T00:00', to:'' }), null);
  assert.equal(config.validate({ from:'', to:'2026-10-28T12:00' }), null);
  assert.equal(config.validate({ from:'2026-10-01T00:00', to:'2026-10-28T12:00' }), null);
  assert.match(config.validate({ from:'2026-10-28T12:00', to:'2026-10-01T00:00' }), /结束时间需晚于/);
  assert.match(config.validate({ from:'2026-10-28T12:00', to:'2026-10-28T12:00' }), /结束时间需晚于/);
  assert.match(config.validate({ from:'invalid', to:'' }), /有效的日期/);
});

test('quick ranges edit the dialog draft without changing the applied filter', () => {
  const f = fixture();
  f.state.filters.logs.from = '2026-10-01T00:00';
  f.context.selectLogTimeRange(f.state.filters.logs);
  f.dialog().onRender({});
  for (const button of f.buttons) {
    button.onclick();
    assert.equal(f.fields.to.value, '');
    assert.equal(Boolean(f.fields.from.value), Boolean(button.dataset.value));
    assert.equal(button.attributes['aria-pressed'], 'true');
    assert.equal(f.state.filters.logs.from, '2026-10-01T00:00');
  }
  f.fields.from.value = '2026-10-10T10:00';
  f.fields.to.value = '2026-10-11T10:00';
  f.fields.from.oninput();
  assert.ok(f.buttons.every(button => button.attributes['aria-pressed'] === 'false'));
});

test('range control summarizes custom dates and current entries have fresh caches', () => {
  const { context } = fixture();
  assert.equal(context.logTimeRangeLabel({ from:'2026-10-01T09:30', to:'2026-10-02T12:00' }), '2026/10/01 09:30 至 2026/10/02 12:00');
  const html = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.match(html, /\/guguadmin\.js\?v=79"/);
  assert.match(html, /\/guguadmin\.css\?v=39"/);
});
