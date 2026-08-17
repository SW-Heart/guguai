import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase, closeDatabase, sql, resetForTests } from '../lib/db.mjs';
import { llmRatesFromEnv, creditsToMicro, microToCredits } from '../lib/billing.mjs';
import {
  configureLedger, chargeGeneration, refundGeneration,
  reserveLlmCredits, settleLlmCredits, releaseLlmCredits,
  markLlmBillingReconcile, grantSignupBonus, walletOf, recentCreditEntries,
} from '../lib/ledger.mjs';
import { withUserLock, lockStats, UserLockReentryError } from '../lib/user-lock.mjs';

const rates = llmRatesFromEnv({
  YUAN_PER_CREDIT: '0.1',
  LLM_INPUT_PRICE_YUAN_PER_MILLION: '3',
  LLM_OUTPUT_PRICE_YUAN_PER_MILLION: '6',
});

let workDir;

function freshDb() {
  resetForTests();
  workDir = mkdtempSync(path.join(tmpdir(), 'ledger-'));
  openDatabase({ file: path.join(workDir, 'studio.db') });
  configureLedger({ llmRates: rates, llmProtocol: 'openai-compatible', llmModel: 'test-model' });
}

function cleanupDb() {
  closeDatabase({ checkpoint: false });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
}

/**
 * Creates a user whose opening balance is backed by a ledger entry, matching
 * how production seeds accounts (signup bonus / admin opening balance). Seeding
 * the balance column directly would violate the conservation invariant by
 * construction.
 */
function makeUser(credits = 100) {
  const id = randomUUID();
  sql(`INSERT INTO users(id, username, password_hash, role, credit_balance_micro,
                         credit_held_micro, created_at, doc_json)
       VALUES(:id, :username, 'scrypt:x:y', 'user', 0, 0, :createdAt, :docJson)`)
    .run({
      id, username: `u_${id.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      docJson: JSON.stringify({ id, creditBalanceMicro: 0, creditHeldMicro: 0 }),
    });
  if (credits > 0) grantSignupBonus(id, credits);
  return id;
}

/** The two invariants db:check enforces in production. */
function assertInvariants(userId, label = '') {
  const row = sql(`
    SELECT u.credit_balance_micro AS balanceMicro, u.credit_held_micro AS heldMicro,
           COALESCE((SELECT SUM(amount_micro) FROM credit_entries c WHERE c.user_id = u.id), 0) AS ledgerMicro,
           COALESCE((SELECT SUM(reserved_micro) FROM billing_holds h
                     WHERE h.user_id = u.id AND h.status = 'held'), 0) AS heldSumMicro
    FROM users u WHERE u.id = :userId`).get({ userId });
  assert.equal(row.balanceMicro, row.ledgerMicro, `余额守恒 ${label}`);
  assert.equal(row.heldMicro, row.heldSumMicro, `冻结守恒 ${label}`);
  assert.ok(row.balanceMicro >= 0, `余额非负 ${label}`);
  assert.ok(row.heldMicro >= 0 && row.heldMicro <= row.balanceMicro, `冻结上界 ${label}`);
}

const chargeEntries = userId =>
  recentCreditEntries(userId, 1000).filter(entry => entry.type === 'generation_charge');

const llmResult = (inputTokens, outputTokens) => ({
  usage: { inputTokens, outputTokens },
  model: 'test-model',
  providerRequestId: 'req_1',
});

test('ledger', async t => {
  t.beforeEach(freshDb);
  t.afterEach(cleanupDb);

  await t.test('signup bonus, charge and refund keep balance == sum(entries)', async () => {
    const userId = makeUser(50);
    assertInvariants(userId, 'after bonus');
    assert.equal(walletOf(userId).balance, 50);

    const charged = await chargeGeneration(userId, 'gen-1', 10);
    assert.equal(charged.balance, 40);
    assertInvariants(userId, 'after charge');

    await refundGeneration(userId, 'gen-1', 10);
    assert.equal(walletOf(userId).balance, 50);
    assertInvariants(userId, 'after refund');
  });

  await t.test('insufficient balance returns 402 and writes nothing', async () => {
    const userId = makeUser(5);
    const result = await chargeGeneration(userId, 'gen-x', 10);
    assert.equal(result.status, 402);
    assert.match(result.error, /积分不足/);
    assert.equal(walletOf(userId).balance, 5);
    assert.equal(chargeEntries(userId).length, 0);
    assertInvariants(userId, 'after rejected charge');
  });

  await t.test('replaying the same charge key never double-charges', async () => {
    const userId = makeUser(100);
    for (let i = 0; i < 5; i++) await chargeGeneration(userId, 'gen-dup', 10);
    assert.equal(walletOf(userId).balance, 90);
    assert.equal(chargeEntries(userId).length, 1);
    assertInvariants(userId, 'after charge replay');
  });

  await t.test('replaying the same refund key never double-pays', async () => {
    const userId = makeUser(100);
    await chargeGeneration(userId, 'gen-r', 30);
    for (let i = 0; i < 5; i++) await refundGeneration(userId, 'gen-r', 30);
    assert.equal(walletOf(userId).balance, 100);
    const refunds = recentCreditEntries(userId, 100).filter(e => e.type === 'generation_refund');
    assert.equal(refunds.length, 1);
    assertInvariants(userId, 'after refund replay');
  });

  await t.test('hold then settle charges only the actual token cost', async () => {
    const userId = makeUser(100);
    const reserved = await reserveLlmCredits(userId, 'req-1', 605_760, { skillName: 'test' });
    assert.equal(reserved.status, 'held');
    assert.equal(walletOf(userId).heldMicro, 605_760);
    assert.equal(walletOf(userId).available, 100 - 0.60576);
    assertInvariants(userId, 'after reserve');

    const settled = await settleLlmCredits(userId, 'req-1', llmResult(10_000, 3_000));
    assert.equal(settled.chargedMicro, 480_000);
    assert.equal(settled.chargedCredits, 0.48);
    assert.equal(settled.wallet.heldMicro, 0);
    assert.equal(settled.wallet.balance, microToCredits(creditsToMicro(100) - 480_000));
    assertInvariants(userId, 'after settle');
  });

  await t.test('release returns the frozen amount without charging', async () => {
    const userId = makeUser(100);
    await reserveLlmCredits(userId, 'req-2', 500_000);
    const released = await releaseLlmCredits(userId, 'req-2', '调用超时');
    assert.equal(released.status, 'released');
    assert.equal(walletOf(userId).balance, 100);
    assert.equal(walletOf(userId).heldMicro, 0);
    assertInvariants(userId, 'after release');
  });

  await t.test('overspend settle refuses to charge and parks for reconciliation', async () => {
    const userId = makeUser(100);
    await reserveLlmCredits(userId, 'req-3', 1_000);
    await assert.rejects(
      () => settleLlmCredits(userId, 'req-3', llmResult(10_000, 3_000)),
      error => error.billingReconcileRequired === true,
    );
    // Balance untouched, and the frozen amount must not stay stuck.
    assert.equal(walletOf(userId).balance, 100);
    const marked = await markLlmBillingReconcile(userId, 'req-3', new Error('超出预授权'));
    assert.equal(marked.status, 'billing_reconcile_required');
    assert.equal(walletOf(userId).heldMicro, 0);
    assert.equal(walletOf(userId).balance, 100);
    assertInvariants(userId, 'after reconcile mark');
  });

  await t.test('settle is idempotent on replay', async () => {
    const userId = makeUser(100);
    await reserveLlmCredits(userId, 'req-4', 605_760);
    const first = await settleLlmCredits(userId, 'req-4', llmResult(10_000, 3_000));
    const second = await settleLlmCredits(userId, 'req-4', llmResult(10_000, 3_000));
    assert.equal(second.chargedMicro, first.chargedMicro);
    assert.equal(walletOf(userId).balance, microToCredits(creditsToMicro(100) - 480_000));
    assertInvariants(userId, 'after settle replay');
  });

  await t.test('concurrent charges with ample balance all succeed', async () => {
    const userId = makeUser(100);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => chargeGeneration(userId, `c-${i}`, 1)),
    );
    assert.equal(results.filter(r => r.status === 402).length, 0);
    assert.equal(walletOf(userId).balance, 80);
    assert.equal(chargeEntries(userId).length, 20);
    assertInvariants(userId, 'after 20 concurrent charges');
  });

  await t.test('concurrent overspend lets exactly M succeed and never goes negative', async () => {
    const userId = makeUser(7);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => chargeGeneration(userId, `o-${i}`, 1)),
    );
    const ok = results.filter(r => r.status !== 402);
    const rejected = results.filter(r => r.status === 402);
    assert.equal(ok.length, 7);
    assert.equal(rejected.length, 13);
    assert.equal(walletOf(userId).balance, 0);
    assertInvariants(userId, 'after concurrent overspend');
  });

  await t.test('a thrown operation still releases the user lock', async () => {
    const userId = makeUser(10);
    await assert.rejects(() => withUserLock(userId, async () => { throw new Error('boom'); }));
    const after = await chargeGeneration(userId, 'gen-after-throw', 1);
    assert.equal(after.balance, 9);
    assertInvariants(userId, 'after throwing op');
  });

  await t.test('different users are not serialised behind each other', async () => {
    const a = makeUser(10);
    const b = makeUser(10);
    const order = [];
    let unblockA;
    const gateA = new Promise(resolve => { unblockA = resolve; });

    const slowA = withUserLock(a, async () => { await gateA; order.push('a'); });
    const fastB = withUserLock(b, async () => { order.push('b'); });

    await fastB;
    assert.deepEqual(order, ['b'], 'B 不应被 A 阻塞');
    unblockA();
    await slowA;
    assert.deepEqual(order, ['b', 'a']);
  });

  await t.test('re-entering the same user lock is rejected instead of deadlocking', async () => {
    const userId = makeUser(10);
    await assert.rejects(
      () => withUserLock(userId, () => withUserLock(userId, async () => 'nested')),
      UserLockReentryError,
    );
  });

  await t.test('lock table does not grow once users go idle', async () => {
    const ids = Array.from({ length: 10 }, () => makeUser(10));
    await Promise.all(ids.map(id => chargeGeneration(id, 'g', 1)));
    assert.equal(lockStats().users, 0, '空闲后锁表应清空');
  });

  await t.test('a failing transaction body leaves no partial write', async () => {
    const userId = makeUser(100);
    // charge succeeds, then force a failure in the same user's next operation
    await chargeGeneration(userId, 'ok-1', 10);
    const before = walletOf(userId);
    await assert.rejects(() => refundGeneration(userId, 'gen-missing', Number.NaN));
    const after = walletOf(userId);
    assert.deepEqual(after, before, '失败操作不得改变钱包');
    assertInvariants(userId, 'after failed op');
  });

  await t.test('mixed random operation sequences preserve every invariant', async () => {
    const userId = makeUser(1000);
    for (let i = 0; i < 60; i++) {
      const pick = i % 5;
      const tag = `mix-${i}`;
      if (pick === 0) await chargeGeneration(userId, tag, 3);
      else if (pick === 1) await refundGeneration(userId, `mix-${i - 1}`, 3).catch(() => {});
      else if (pick === 2) await reserveLlmCredits(userId, tag, 300_000);
      else if (pick === 3) await settleLlmCredits(userId, `mix-${i - 1}`, llmResult(1_000, 500)).catch(() => {});
      else await releaseLlmCredits(userId, `mix-${i - 2}`, 'cleanup').catch(() => {});
      assertInvariants(userId, `step ${i}`);
    }
  });
});
