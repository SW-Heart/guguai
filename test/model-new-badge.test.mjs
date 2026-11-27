import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { openDatabase, closeDatabase, sql } from '../lib/db.mjs';
import { listModelControls, modelControl, updateModelControl, withModelDescriptions } from '../lib/model-controls.mjs';

openDatabase({ file:':memory:' });
after(() => closeDatabase());

const source = path => readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
const badge = '<em class="model-new-badge">New</em>';

test('every model starts without the New badge', () => {
  assert.ok(sql("SELECT 1 FROM pragma_table_info('model_controls') WHERE name = 'is_new'").get());
  const controls = listModelControls();
  assert.ok(controls.length > 0);
  assert.ok(controls.every(control => control.isNew === false));
});

test('admins turn the New badge on and off without touching other settings', () => {
  const before = modelControl('seedream-5.5');
  const on = updateModelControl('seedream-5.5', { isNew:true }, { expectedVersion:before.version });
  assert.equal(on.isNew, true);
  assert.equal(on.version, before.version + 1);
  assert.deepEqual([on.userVisible, on.enabled, on.sortOrder, on.description], [before.userVisible, before.enabled, before.sortOrder, before.description]);
  assert.equal(updateModelControl('seedream-5.5', { description:'新的描述' }).isNew, true, 'saving other fields keeps the badge');
  assert.equal(updateModelControl('seedream-5.5', { isNew:false }).isNew, false);
  assert.throws(() => updateModelControl('seedream-5.5', { isNew:'yes' }), error => error.statusCode === 400);
});

test('public model lists carry the badge setting', () => {
  updateModelControl('seedream-5.5', { isNew:true });
  const models = withModelDescriptions([{ id:'seedream-5.5', label:'Seedream 5.5' }, { id:'seedream-5.0', label:'Seedream 5.0' }]);
  assert.deepEqual(models.map(model => [model.id, model.isNew]), [['seedream-5.5', true], ['seedream-5.0', false]]);
});

test('the image and video pickers show New after the model name only when it is on', async () => {
  const app = await source('app.js');
  const body = app.slice(app.indexOf('function modelTitleMarkup('), app.indexOf('function productSelectMarkup('));
  const context = vm.createContext({
    esc:value => String(value),
    imageModelPromo:() => '', videoModelPromo:() => '',
    selectModelOptions:() => [{ id:'seedream-5.5', isNew:true }, { id:'seedream-5.0', isNew:false }],
  });
  vm.runInContext(body, context);
  const widget = { dataset:{ model:'true', imageModel:'true' } };
  assert.equal(context.modelTitleMarkup(widget, { value:'seedream-5.5', textContent:'Seedream 5.5' }), `<span class="select-model-title"><b>Seedream 5.5</b>${badge}</span>`);
  assert.equal(context.modelTitleMarkup(widget, { value:'seedream-5.0', textContent:'Seedream 5.0' }), '<span class="select-model-title"><b>Seedream 5.0</b></span>');
});

test('canvas, short drama, model preference and admin lists read the same setting', async () => {
  const [canvas, drama, picker, admin] = await Promise.all(['features/drama/director-workspace.js', 'drama-studio.js', 'features/agent/model-preference-picker.js', 'guguadmin.js'].map(source));
  assert.ok(canvas.includes(`\${model.isNew?'${badge}':''}`));
  assert.ok(drama.includes(`\${option.isNew?'data-new="true"':''}`));
  assert.ok(drama.includes(`\${kind==='model'&&option.dataset.new?'${badge}':''}`));
  assert.ok(drama.includes(`\${kind==='model'&&option.isNew?'${badge}':''}`));
  assert.ok(picker.includes(`\${model.isNew ? '${badge}' : ''}`));
  assert.match(admin, /name: 'isNew', type: 'checkbox', label: '显示 New 标签'/);
  assert.match(admin, /isNew: Boolean\(values\.isNew\)/);
  const styles = await source('styles.css');
  assert.match(styles, /\.model-new-badge\{[^}]*color:#4f46e5/);
});
