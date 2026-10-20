import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase, closeDatabase, sql, resetForTests } from '../lib/db.mjs';
import { adminInsights, modelPerformance, signupFunnel } from '../lib/admin-insights.mjs';

const NOW = '2026-10-20T00:00:00.000Z';

function seed() {
  const user = (id, createdAt, role = 'user') => sql(`INSERT INTO users(id, username, password_hash, role, created_at, doc_json)
    VALUES(:id, :id, 'scrypt:x:y', :role, :createdAt, '{}')`).run({ id, role, createdAt });
  const generation = (id, userId, { status = 'completed', createdAt, modelId = 'seedance-2.0', costMicro = 0, creditStatus = 'charged', costYuan = null, seconds = 60 }) => {
    const finishedAt = new Date(new Date(createdAt).getTime() + seconds * 1000).toISOString();
    sql(`INSERT INTO generations(id, user_id, type, status, credit_cost_micro, credit_status, pricing_snapshot_json, model_id, created_at, updated_at, doc_json)
      VALUES(:id, :userId, 'video', :status, :costMicro, :creditStatus, :snapshot, :modelId, :createdAt, :updatedAt, :doc)`).run({
      id, userId, status, costMicro, creditStatus, modelId, createdAt, updatedAt: finishedAt,
      snapshot: costYuan === null ? null : JSON.stringify({ costYuan }),
      doc: JSON.stringify(status === 'completed' ? { finishedAt } : {}),
    });
  };
  // a: signed up 10 days ago, generated, came back on day 3, paid by Alipay.
  user('a', '2026-10-10T00:00:00.000Z');
  generation('a1', 'a', { createdAt: '2026-10-10T01:00:00.000Z', costMicro: 100_000_000, costYuan: 6, seconds: 120 });
  generation('a2', 'a', { createdAt: '2026-10-13T00:00:00.000Z', status: 'failed', creditStatus: 'refunded', costMicro: 100_000_000, costYuan: 6 });
  sql(`INSERT INTO alipay_payment_orders(out_trade_no, user_id, status, subject, total_amount_fen, credits_micro, paid_at, created_at, updated_at, doc_json)
    VALUES('ALI-1', 'a', 'PAID', 'x', 1000, 100000000, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z', '{}')`).run();
  // b: signed up 9 days ago, only a failed generation, paid by WeChat.
  user('b', '2026-10-11T00:00:00.000Z');
  generation('b1', 'b', { createdAt: '2026-10-11T02:00:00.000Z', status: 'failed', creditStatus: 'refunded', modelId: 'gpt-image' });
  sql(`INSERT INTO wechat_payment_orders(out_trade_no, user_id, app_id, doc_json) VALUES('WX-1', 'b', 'app', :doc)`)
    .run({ doc: JSON.stringify({ status: 'PAID', paidAt: '2026-10-12T00:00:00.000Z' }) });
  // c: signed up 2 days ago (too new for the 7-day check), image without cost data.
  user('c', '2026-10-18T00:00:00.000Z');
  generation('c1', 'c', { createdAt: '2026-10-18T01:00:00.000Z', modelId: 'gpt-image', costMicro: 20_000_000, seconds: 30 });
  // d: signed up, never generated; unpaid WeChat order does not count.
  user('d', '2026-10-19T00:00:00.000Z');
  sql(`INSERT INTO wechat_payment_orders(out_trade_no, user_id, app_id, doc_json) VALUES('WX-2', 'd', 'app', :doc)`)
    .run({ doc: JSON.stringify({ status: 'PENDING_PAYMENT' }) });
  // Admin activity stays out of every number.
  user('admin', '2026-10-15T00:00:00.000Z', 'admin');
  generation('x1', 'admin', { createdAt: '2026-10-15T01:00:00.000Z', costMicro: 500_000_000, costYuan: 1 });
}

test('admin insights funnel and model performance', async t => {
  resetForTests();
  const workDir = mkdtempSync(path.join(tmpdir(), 'admin-insights-'));
  openDatabase({ file: path.join(workDir, 'studio.db') });
  t.after(() => { closeDatabase({ checkpoint: false }); rmSync(workDir, { recursive: true, force: true }); });
  seed();

  await t.test('funnel counts each step for people who signed up', () => {
    assert.deepEqual(signupFunnel({ now: NOW }), {
      registered: 4, generated: 3, succeeded: 2, paid: 2,
      generatedRate: 75, succeededRate: 50, paidRate: 50,
      returnEligible: 2, returned: 1, returnedRate: 50,
    });
  });

  await t.test('funnel only includes signups inside the range', () => {
    const funnel = signupFunnel({ from: '2026-10-17T00:00:00.000Z', to: NOW, now: NOW });
    assert.equal(funnel.registered, 2);
    assert.equal(funnel.succeeded, 1);
    assert.equal(funnel.returnEligible, 0);
    assert.equal(funnel.returnedRate, null);
  });

  await t.test('models report success rate, speed and margin', () => {
    const models = modelPerformance();
    const seedance = models.find(item => item.modelId === 'seedance-2.0');
    const image = models.find(item => item.modelId === 'gpt-image');
    assert.deepEqual(seedance, {
      modelId: 'seedance-2.0', type: 'video', total: 2, completed: 1, failed: 1, pending: 0,
      successRate: 50, avgSeconds: 120, revenueYuan: 10, costYuan: 6,
      grossProfitYuan: 4, grossMarginRate: 40, costCoverage: 100,
    });
    assert.equal(image.successRate, 50);
    assert.equal(image.revenueYuan, 2);
    assert.equal(image.costYuan, null);
    assert.equal(image.grossProfitYuan, null);
  });

  await t.test('model range filters by generation time', () => {
    const { models } = adminInsights({ from: '2026-10-18T00:00:00.000Z', to: NOW, now: NOW });
    assert.deepEqual(models.map(item => item.modelId), ['gpt-image']);
  });
});
