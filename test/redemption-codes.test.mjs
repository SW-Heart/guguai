import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeDatabase, openDatabase, sql } from '../lib/db.mjs';
import { insertUser } from '../lib/store.mjs';
import { redeemCreditCode, walletOf } from '../lib/ledger.mjs';
import { createAccountRouteHandler } from '../server/routes/account.mjs';

function setup(t) {
  openDatabase({ file:':memory:' });
  t.after(() => closeDatabase({ checkpoint:false }));
  const users = ['first', 'second', 'third'].map(username => ({ id:randomUUID(), username, role:'user', status:'active', passwordHash:'scrypt:x:y', credits:0, creditBalanceMicro:0, creditHeldMicro:0, createdAt:new Date().toISOString() }));
  users.forEach(insertUser);
  const code = 'GUGU-REDEEM-TEST';
  sql(`INSERT INTO redemption_codes(code, max_uses, credits_micro, created_at, updated_at) VALUES(:code, 2, 1234567, :at, :at)`).run({ code, at:new Date().toISOString() });
  return { users, code };
}

test('redemption grants exact credits once per user and records the ledger', async t => {
  const { users, code } = setup(t);
  const result = await redeemCreditCode(users[0].id, ` ${code.toLowerCase()} `);
  assert.equal(result.credits, 1.234567);
  assert.equal(result.balance, 1.234567);
  await assert.rejects(redeemCreditCode(users[0].id, code), /已使用/);
  assert.equal(sql('SELECT used_count FROM redemption_codes').get().used_count, 1);
  assert.equal(sql('SELECT COUNT(*) AS n FROM redemption_code_uses').get().n, 1);
  assert.equal(sql("SELECT SUM(amount_micro) AS n FROM credit_entries WHERE type = 'code_redemption'").get().n, 1234567);
  assert.equal(walletOf(users[0].id).balanceMicro, 1234567);
});

test('concurrent users cannot exceed remaining uses and duplicate requests cannot double credit', async t => {
  const { users, code } = setup(t);
  const results = await Promise.allSettled(users.map(user => redeemCreditCode(user.id, code)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(sql('SELECT used_count FROM redemption_codes').get().used_count, 2);
  const repeated = await Promise.allSettled([redeemCreditCode(users[0].id, code), redeemCreditCode(users[0].id, code)]);
  assert.ok(repeated.every(result => result.status === 'rejected'));
  assert.equal(walletOf(users[0].id).balanceMicro, 1234567);
});

test('invalid, disabled, expired, exhausted and legacy invite codes never grant credits', async t => {
  const { users, code } = setup(t);
  assert.throws(() => redeemCreditCode(users[0].id, '<invalid>'), /有效/);
  await assert.rejects(redeemCreditCode(users[0].id, 'UNKNOWN-CODE'), /无效/);
  sql('UPDATE redemption_codes SET enabled = 0').run();
  await assert.rejects(redeemCreditCode(users[0].id, code), /停用/);
  sql("UPDATE redemption_codes SET enabled = 1, expires_at = '2000-01-01T00:00:00.000Z'").run();
  await assert.rejects(redeemCreditCode(users[0].id, code), /过期/);
  sql('UPDATE redemption_codes SET expires_at = NULL, used_count = max_uses').run();
  await assert.rejects(redeemCreditCode(users[0].id, code), /兑完/);
  const legacy = sql('SELECT code FROM invite_codes LIMIT 1').get();
  if (legacy) await assert.rejects(redeemCreditCode(users[0].id, legacy.code), /无效/);
  assert.equal(walletOf(users[0].id).balance, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM redemption_code_uses').get().n, 0);
});

test('ledger failure rolls back use count, use record and wallet', async t => {
  const { users, code } = setup(t);
  sql(`CREATE TRIGGER reject_redemption BEFORE INSERT ON credit_entries BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END`).run();
  await assert.rejects(redeemCreditCode(users[0].id, code), /test ledger failure/);
  assert.equal(walletOf(users[0].id).balance, 0);
  assert.equal(sql('SELECT used_count FROM redemption_codes').get().used_count, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM redemption_code_uses').get().n, 0);
});

test('redeem route requires a user and limits failed attempts', async t => {
  const { users } = setup(t);
  const url = new URL('https://example.com/api/credits/redeem');
  const denied = createAccountRouteHandler({ requireUser:() => null });
  assert.equal(await denied({ method:'POST' }, {}, url), true);
  let response;
  const handler = createAccountRouteHandler({ requireUser:() => users[0], bodyJson:async () => ({ code:'UNKNOWN-CODE' }), sendJson:(_res, status, data) => { response = { status, data }; } });
  const req = { method:'POST', headers:{}, socket:{ remoteAddress:'127.0.0.1' } };
  for (let i = 0; i < 10; i++) await assert.rejects(handler(req, {}, url), /无效/);
  await handler(req, {}, url);
  assert.equal(response.status, 429);
});
