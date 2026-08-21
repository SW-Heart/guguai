import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { configureCursors } from '../lib/store.mjs';
import { configureLedger, adjustCredits, grantSignupBonus, walletOf } from '../lib/ledger.mjs';
import { createPricingVersion, currentPricing, pricingSnapshot } from '../lib/pricing.mjs';
import { isModelEnabled, publicVideoCapabilitiesWithControls, updateModelControl } from '../lib/model-controls.mjs';
import { registerUser, insertUser } from '../lib/store.mjs';

let workDir;

function freshDb() {
  resetForTests();
  workDir = mkdtempSync(path.join(tmpdir(), 'admin-core-'));
  openDatabase({ file: path.join(workDir, 'studio.db') });
  configureCursors('admin-test-cursor-secret');
  configureLedger({ llmRates: { inputYuanPerMillion: 3, outputYuanPerMillion: 6, inputMicroPerToken: 3, outputMicroPerToken: 6 }, llmProtocol: 'test', llmModel: 'test-model' });
}

function cleanupDb() {
  closeDatabase({ checkpoint: false });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
}

function makeUser(username = `user_${randomUUID().slice(0, 8)}`, role = 'user') {
  const createdAt = new Date().toISOString();
  const user = { id: randomUUID(), username, role, status: 'active', passwordHash: 'scrypt:x:y', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt };
  insertUser(user);
  return user;
}

function assertWalletInvariant(userId) {
  const row = sql(`SELECT credit_balance_micro AS balance, credit_held_micro AS held,
    COALESCE((SELECT SUM(amount_micro) FROM credit_entries WHERE user_id = :userId), 0) AS ledger,
    COALESCE((SELECT SUM(reserved_micro) FROM billing_holds WHERE user_id = :userId AND status = 'held'), 0) AS heldSum
    FROM users WHERE id = :userId`).get({ userId });
  assert.equal(row.balance, row.ledger);
  assert.equal(row.held, row.heldSum);
  assert.ok(row.held <= row.balance);
}

test('admin core controls', async t => {
  t.beforeEach(freshDb);
  t.afterEach(cleanupDb);

  await t.test('global pricing creates immutable versions and exact snapshots', () => {
    const first = currentPricing();
    assert.equal(first.imagePerRequest, 1);
    assert.equal(first.videoPerSecond, 1);
    const admin = makeUser('admin_price', 'admin');
    const second = createPricingVersion({ imagePerRequest: '1.5', videoPerSecond: '0.8', actorUserId: admin.id, expectedVersion: first.version });
    assert.equal(second.imagePerRequestMicro, 1_500_000);
    assert.equal(second.videoPerSecondMicro, 800_000);
    assert.deepEqual(pricingSnapshot(second, 'image'), { version: second.version, billingUnit: 'request', unitPriceMicro: 1_500_000, unitPrice: 1.5, quantity: 1, totalMicro: 1_500_000, total: 1.5 });
    assert.equal(pricingSnapshot(second, 'video', 8).totalMicro, 6_400_000);
    assert.equal(currentPricing().version, second.version);
    assert.throws(() => createPricingVersion({ imagePerRequest: '2', videoPerSecond: '2', actorUserId: admin.id, expectedVersion: first.version }), /价格已被其他管理员修改/);
    assert.equal(sql('SELECT COUNT(*) AS count FROM audit_events WHERE action = \'pricing.create_version\'').get().count, 1);
  });

  await t.test('model controls affect public catalog and enforce disabled state', () => {
    assert.equal(isModelEnabled('grok'), true);
    const admin = makeUser('admin_model', 'admin');
    const before = sql('SELECT version FROM model_controls WHERE model_id = \'grok\'').get().version;
    updateModelControl('grok', { userVisible: false, enabled: false, sortOrder: 99 }, { actorUserId: admin.id, expectedVersion: before });
    assert.equal(isModelEnabled('grok'), false);
    assert.equal(publicVideoCapabilitiesWithControls().models.some(model => model.id === 'grok'), false);
    assert.equal(sql('SELECT COUNT(*) AS count FROM audit_events WHERE action = \'model.update_control\'').get().count, 1);
  });

  await t.test('manual adjustment is idempotent and preserves ledger invariants', async () => {
    const user = makeUser('adjust_target');
    grantSignupBonus(user.id, 20);
    const first = await adjustCredits(user.id, 1_500_000, { actorUserId: 'admin', idempotencyKey: 'adjust-1', reasonCode: 'promotion', note: 'test' });
    const replay = await adjustCredits(user.id, 1_500_000, { actorUserId: 'admin', idempotencyKey: 'adjust-1', reasonCode: 'promotion', note: 'test' });
    assert.equal(first.balance, 21.5);
    assert.equal(replay.replay, true);
    assert.equal(walletOf(user.id).balance, 21.5);
    assert.equal(sql('SELECT COUNT(*) AS count FROM credit_entries WHERE user_id = :id AND type = \'admin_credit_adjustment\'').get({ id: user.id }).count, 1);
    assertWalletInvariant(user.id);
    await assert.rejects(() => adjustCredits(user.id, -22_000_000, { actorUserId: 'admin', idempotencyKey: 'adjust-2', reasonCode: 'manual_deduction' }), /冻结积分|账号/);
    assertWalletInvariant(user.id);
  });

  await t.test('configured invite code consumes exactly its available uses in registration transaction', () => {
    const admin = makeUser('admin_invite', 'admin');
    const code = 'ADMIN-TEST-USES';
    sql(`INSERT INTO invite_codes(code, enabled, max_uses, used_count, signup_bonus_micro, created_by, created_at, updated_at)
         VALUES(:code, 1, 2, 0, 12_500_000, :admin, :time, :time)`).run({ code, admin: admin.id, time: new Date().toISOString() });
    const create = name => registerUser({ user: { id: randomUUID(), username: name, role: 'user', status: 'active', passwordHash: 'scrypt:x:y', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt: new Date().toISOString() }, inviteCode: code, grantBonus: grantSignupBonus });
    const a = create('invite_a');
    const b = create('invite_b');
    const c = create('invite_c');
    assert.equal(a.user.credits, 12.5);
    assert.equal(b.user.credits, 12.5);
    assert.equal(c.status, 409);
    assert.equal(sql('SELECT used_count FROM invite_codes WHERE code = :code').get({ code }).used_count, 2);
    assert.equal(sql('SELECT COUNT(*) AS count FROM invite_code_uses WHERE code = :code').get({ code }).count, 2);
    assert.equal(sql('SELECT COUNT(*) AS count FROM users WHERE username LIKE \'invite_%\'').get().count, 2);
  });
});


test('schema upgrades create a verified pre-upgrade snapshot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'schema-backup-'));
  const file = path.join(dir, 'studio.db');
  try {
    resetForTests();
    openDatabase({ file });
    closeDatabase({ checkpoint: false });

    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE schema_meta SET value = '1' WHERE key = 'schema_version'").run();
    raw.close();

    resetForTests();
    openDatabase({ file });
    assert.equal(sql("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, '4');
    closeDatabase({ checkpoint: false });

    const backupName = readdirSync(dir).find(name => name.startsWith('studio.db.pre-schema-1-to-4-'));
    assert.ok(backupName);
    const backup = new DatabaseSync(path.join(dir, backupName), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, '1');
    backup.close();
  } finally {
    resetForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
