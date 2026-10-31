import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
test('redemption creation asks only for credits and quantity and sends those values', async () => {
  let dialog;
  let request;
  const context = vm.createContext({
    showAdminDialog:async config => { dialog = config; return null; },
    api:async (url, options) => { request = { url, body:JSON.parse(options.body) }; },
  });
  vm.runInContext(source.slice(source.indexOf('  async function createInvite()'), source.indexOf('  async function fetchInvites()')), context);
  await context.createInvite();
  assert.deepEqual(Array.from(dialog.fields, field => field.name), ['credits', 'quantity']);
  assert.equal(dialog.validate({ credits:'50', quantity:'10' }), null);
  for (const quantity of ['0', '-1', '1.5', '1001', 'abc']) assert.ok(dialog.validate({ credits:'50', quantity }));
  for (const credits of ['0', '-1', '1.1234567', '1000001']) assert.ok(dialog.validate({ credits, quantity:'1' }));
  await dialog.onSubmit({ credits:' 12.5 ', quantity:'3' });
  assert.deepEqual(request, { url:'/api/admin/redemption-codes', body:{ credits:'12.5', quantity:3 } });
});

test('admin entry references the current bulk-creation script', () => {
  const html = readFileSync(new URL('../public/guguadmin.html', import.meta.url), 'utf8');
  assert.match(html, /\/guguadmin\.js\?v=79"/);
});
