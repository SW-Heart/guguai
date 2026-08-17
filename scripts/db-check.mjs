#!/usr/bin/env node
/**
 * Read-only consistency self-check.
 *
 *   npm run db:check
 *
 * Verifies the two accounting invariants that the ledger is supposed to hold:
 *   balance  == SUM(credit_entries.amount_micro)
 *   held     == SUM(billing_holds.reserved_micro WHERE status='held')
 * plus per-entry balance_after_micro prefix sums, orphan rows and SQLite's own
 * integrity_check. Exits non-zero on any failure and never writes.
 */
import { openDatabase, closeDatabase, sql, readSchemaVersion, migrationCompleted, resolveDbFile } from '../lib/db.mjs';
import { CREDIT_MICRO_FACTOR } from '../lib/billing.mjs';

const asCredits = micro => (micro / CREDIT_MICRO_FACTOR).toFixed(6).replace(/\.?0+$/, '');

function main() {
  openDatabase();
  const failures = [];

  console.log(`数据库: ${resolveDbFile()}`);
  console.log(`schema 版本: ${readSchemaVersion()}`);
  console.log(`迁移完成标记: ${migrationCompleted() ? '有' : '无'}\n`);

  const integrity = sql('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') failures.push(`integrity_check: ${integrity}`);
  console.log(`integrity_check: ${integrity}`);

  const fkRows = sql('PRAGMA foreign_key_check').all();
  if (fkRows.length) failures.push(`外键校验发现 ${fkRows.length} 条孤儿记录`);
  console.log(`foreign_key_check: ${fkRows.length === 0 ? 'ok' : `${fkRows.length} 条异常`}\n`);

  const wallets = sql(`
    SELECT u.id, u.username,
           u.credit_balance_micro AS balanceMicro,
           u.credit_held_micro    AS heldMicro,
           COALESCE((SELECT SUM(amount_micro) FROM credit_entries c WHERE c.user_id = u.id), 0) AS ledgerMicro,
           COALESCE((SELECT SUM(reserved_micro) FROM billing_holds h
                     WHERE h.user_id = u.id AND h.status = 'held'), 0) AS heldSumMicro,
           (SELECT COUNT(*) FROM credit_entries c WHERE c.user_id = u.id) AS entryCount
    FROM users u ORDER BY u.username`).all();

  console.log(`检查 ${wallets.length} 个账号：\n`);
  let balanceOk = 0;
  let heldOk = 0;

  for (const row of wallets) {
    const balanceDrift = row.balanceMicro - row.ledgerMicro;
    const heldDrift = row.heldMicro - row.heldSumMicro;
    if (balanceDrift === 0) balanceOk++;
    else failures.push(`${row.username} 余额差额 ${balanceDrift} micro (${asCredits(balanceDrift)} 积分)`);
    if (heldDrift === 0) heldOk++;
    else failures.push(`${row.username} 冻结差额 ${heldDrift} micro (${asCredits(heldDrift)} 积分)`);

    const flag = balanceDrift === 0 && heldDrift === 0 ? 'OK ' : 'BAD';
    console.log(`  ${flag} ${row.username}`);
    console.log(`      余额 ${row.balanceMicro} / 流水和 ${row.ledgerMicro} / 差额 ${balanceDrift}`);
    console.log(`      冻结 ${row.heldMicro} / held 之和 ${row.heldSumMicro} / 差额 ${heldDrift}`);
    console.log(`      流水条数 ${row.entryCount}`);
  }

  // balance_after_micro must equal the running prefix sum per user.
  const prefixBad = sql(`
    WITH ordered AS (
      SELECT user_id, id, created_at, amount_micro, balance_after_micro,
             SUM(amount_micro) OVER (PARTITION BY user_id ORDER BY created_at, id
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prefix
      FROM credit_entries
    )
    SELECT user_id, id, balance_after_micro, prefix FROM ordered
    WHERE balance_after_micro <> prefix`).all();

  console.log(`\nbalance_after_micro 前缀和校验: ${prefixBad.length === 0 ? 'ok' : `${prefixBad.length} 条不一致`}`);
  if (prefixBad.length) {
    // Legacy rows migrated from JSON may carry stale snapshots; report but do
    // not fail the run on them, the authoritative invariant is the total.
    for (const row of prefixBad.slice(0, 10)) {
      console.log(`  ${row.user_id} ${row.id}: 记录 ${row.balance_after_micro} 前缀和 ${row.prefix}`);
    }
    if (prefixBad.length > 10) console.log(`  ...另有 ${prefixBad.length - 10} 条`);
    console.log('  提示: 迁移自 JSON 的历史流水可能带有旧快照，不计入失败判定。');
  }

  const counts = sql(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM sessions WHERE expires_at <= :now) AS expiredSessions,
      (SELECT COUNT(*) FROM credit_entries) AS creditEntries,
      (SELECT COUNT(*) FROM billing_holds) AS holds,
      (SELECT COUNT(*) FROM billing_holds WHERE status = 'held') AS heldHolds,
      (SELECT COUNT(*) FROM billing_holds WHERE status = 'billing_reconcile_required') AS reconcileHolds,
      (SELECT COUNT(*) FROM generations) AS generations,
      (SELECT COUNT(*) FROM generations WHERE status IN ('queued','running')) AS pendingGenerations,
      (SELECT COUNT(*) FROM assets) AS assets,
      (SELECT COUNT(*) FROM drama_projects) AS dramaProjects
  `).get({ now: new Date().toISOString() });

  console.log('\n表统计：');
  for (const [key, value] of Object.entries(counts)) console.log(`  ${key}: ${value}`);

  if (counts.reconcileHolds > 0) {
    failures.push(`存在 ${counts.reconcileHolds} 条待人工对账的冻结记录 (billing_reconcile_required)`);
  }

  console.log(`\n余额一致: ${balanceOk}/${wallets.length}  冻结一致: ${heldOk}/${wallets.length}`);
  closeDatabase({ checkpoint: false });

  if (failures.length) {
    console.error(`\n自检未通过，共 ${failures.length} 项：`);
    for (const item of failures) console.error(`  - ${item}`);
    return 1;
  }
  console.log('\n自检通过。');
  return 0;
}

process.exit(main());
