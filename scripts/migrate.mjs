#!/usr/bin/env node
/**
 * One-shot migration of the legacy JSON metadata store into SQLite.
 *
 *   npm run migrate -- --dry-run   report only, no database writes
 *   npm run migrate                migrate inside a single transaction
 *   npm run migrate -- --verify    re-read every row and diff against JSON
 *
 * The legacy JSON files are never modified, so reverting is just a matter of
 * pointing the server back at them.
 */
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openDatabase, closeDatabase, database, sql, tx,
  resolveDataDir, resolveDbFile, writeMeta, readMeta, MIGRATION_DONE_KEY,
} from '../lib/db.mjs';
import { CREDIT_MICRO_FACTOR } from '../lib/billing.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const verify = args.has('--verify');

const dataDir = resolveDataDir();
const usersFile = path.join(dataDir, 'users.json');
const inviteUsesFile = path.join(dataDir, 'invite-uses.json');
const sessionsDir = path.join(dataDir, 'sessions');
const userDataDir = path.join(dataDir, 'users');

const COLLECTIONS = [
  'users', 'sessions', 'invite_uses', 'credit_entries',
  'billing_holds', 'llm_usage', 'generations', 'assets', 'drama_projects',
];

const report = {
  startedAt: new Date().toISOString(),
  mode: dryRun ? 'dry-run' : (verify ? 'migrate+verify' : 'migrate'),
  dataDir,
  dbFile: resolveDbFile(),
  collections: Object.fromEntries(COLLECTIONS.map(name => [name, { source: 0, inserted: 0, skipped: 0 }])),
  skipped: [],
  wallets: [],
  verify: null,
  backup: null,
  result: 'pending',
};

function tally(collection, field, n = 1) { report.collections[collection][field] += n; }
function skip(collection, file, reason, detail = {}) {
  report.collections[collection].skipped++;
  report.skipped.push({ collection, file, reason, ...detail });
}

function readJsonFile(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort();
}
function relative(file) { return path.relative(dataDir, file); }

/**
 * Legacy ledger entries written by older builds carry only `amount` (credits)
 * with no `amountMicro`. The admin opening-balance entry is exactly this shape,
 * so without the fallback reconciliation would under-count by 10,000 credits
 * and abort a perfectly healthy migration.
 */
function entryAmountMicro(entry) {
  if (Number.isSafeInteger(entry.amountMicro)) return entry.amountMicro;
  const credits = Number(entry.amount);
  if (!Number.isFinite(credits)) return null;
  const micro = Math.round(credits * CREDIT_MICRO_FACTOR);
  return Number.isSafeInteger(micro) ? micro : null;
}

function walletFromLegacyUser(user) {
  if (Number.isSafeInteger(user.creditBalanceMicro) && user.creditBalanceMicro >= 0) {
    const balance = user.creditBalanceMicro;
    let heldRaw = Number.isSafeInteger(user.creditHeldMicro) && user.creditHeldMicro >= 0 ? user.creditHeldMicro : 0;
    return { balanceMicro: balance, heldMicro: Math.min(heldRaw, balance) };
  }
  const legacyCredits = Number(user.credits);
  const balance = Number.isFinite(legacyCredits) && legacyCredits >= 0
    ? Math.round(legacyCredits * CREDIT_MICRO_FACTOR)
    : 0;
  return { balanceMicro: balance, heldMicro: 0 };
}

// ---------------------------------------------------------------- collect

function collectUsers() {
  if (!existsSync(usersFile)) return [];
  let raw;
  try { raw = readJsonFile(usersFile); } catch (error) {
    skip('users', relative(usersFile), 'parse-failed', { message: error.message });
    return [];
  }
  if (!Array.isArray(raw)) {
    skip('users', relative(usersFile), 'not-an-array');
    return [];
  }
  const out = [];
  for (const user of raw) {
    tally('users', 'source');
    if (!user?.id || !user?.username || !user?.passwordHash || !user?.createdAt) {
      skip('users', relative(usersFile), 'missing-required-field', { id: user?.id ?? null });
      continue;
    }
    out.push(user);
  }
  return out;
}

function collectSessions(validUserIds) {
  const out = [];
  for (const name of listJson(sessionsDir)) {
    tally('sessions', 'source');
    const file = path.join(sessionsDir, name);
    let record;
    try { record = readJsonFile(file); } catch (error) {
      skip('sessions', relative(file), 'parse-failed', { message: error.message });
      continue;
    }
    const tokenHash = name.replace(/\.json$/, '');
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
      skip('sessions', relative(file), 'bad-token-hash');
      continue;
    }
    if (!record?.userId || !record?.expiresAt || !record?.createdAt) {
      skip('sessions', relative(file), 'missing-required-field');
      continue;
    }
    if (!validUserIds.has(record.userId)) {
      skip('sessions', relative(file), 'orphan-record', { userId: record.userId });
      continue;
    }
    out.push({ tokenHash, ...record });
  }
  return out;
}

function collectInviteUses(validUserIds) {
  if (!existsSync(inviteUsesFile)) return [];
  let raw;
  try { raw = readJsonFile(inviteUsesFile); } catch (error) {
    skip('invite_uses', relative(inviteUsesFile), 'parse-failed', { message: error.message });
    return [];
  }
  const out = [];
  for (const [code, use] of Object.entries(raw ?? {})) {
    tally('invite_uses', 'source');
    if (!use?.usedAt) {
      skip('invite_uses', relative(inviteUsesFile), 'missing-required-field', { code });
      continue;
    }
    // A used code whose account was deleted still has to stay burnt, so an
    // unknown userId is kept (nulled) rather than skipped.
    const userId = use.userId && validUserIds.has(use.userId) ? use.userId : null;
    out.push({ code, userId, username: use.username ?? null, usedAt: use.usedAt });
  }
  return out;
}

function collectPerUser(userId, dirName, collection, idFrom) {
  const dir = path.join(userDataDir, userId, dirName);
  const out = [];
  for (const name of listJson(dir)) {
    tally(collection, 'source');
    const file = path.join(dir, name);
    let record;
    try { record = readJsonFile(file); } catch (error) {
      skip(collection, relative(file), 'parse-failed', { message: error.message });
      continue;
    }
    const id = idFrom(record, name);
    if (!id || !record?.createdAt) {
      skip(collection, relative(file), 'missing-required-field', { id: id ?? null });
      continue;
    }
    out.push({ id, file, record });
  }
  return out;
}

// ---------------------------------------------------------------- write

const insertUser = () => sql(`
  INSERT INTO users(id, username, password_hash, role, invite_code,
                    credit_balance_micro, credit_held_micro, created_at, doc_json)
  VALUES(:id, :username, :passwordHash, :role, :inviteCode,
         :balanceMicro, :heldMicro, :createdAt, :docJson)
  ON CONFLICT(id) DO NOTHING`);

const insertSession = () => sql(`
  INSERT INTO sessions(token_hash, user_id, expires_at, created_at)
  VALUES(:tokenHash, :userId, :expiresAt, :createdAt)
  ON CONFLICT(token_hash) DO NOTHING`);

const insertInvite = () => sql(`
  INSERT INTO invite_uses(code, user_id, username, used_at)
  VALUES(:code, :userId, :username, :usedAt)
  ON CONFLICT(code) DO NOTHING`);

const insertCredit = () => sql(`
  INSERT INTO credit_entries(id, user_id, idempotency_key, type, amount_micro,
                             balance_after_micro, generation_id, request_id, created_at, doc_json)
  VALUES(:id, :userId, :idempotencyKey, :type, :amountMicro,
         :balanceAfterMicro, :generationId, :requestId, :createdAt, :docJson)
  ON CONFLICT(user_id, idempotency_key) DO NOTHING`);

const insertHold = () => sql(`
  INSERT INTO billing_holds(id, user_id, type, status, reserved_micro, charged_micro,
                            created_at, updated_at, doc_json)
  VALUES(:id, :userId, :type, :status, :reservedMicro, :chargedMicro,
         :createdAt, :updatedAt, :docJson)
  ON CONFLICT(user_id, id) DO NOTHING`);

const insertLlmUsage = () => sql(`
  INSERT INTO llm_usage(id, user_id, status, model, input_tokens, output_tokens,
                        charged_micro, created_at, doc_json)
  VALUES(:id, :userId, :status, :model, :inputTokens, :outputTokens,
         :chargedMicro, :createdAt, :docJson)
  ON CONFLICT(user_id, id) DO NOTHING`);

const insertGeneration = () => sql(`
  INSERT INTO generations(id, user_id, type, status, credit_cost, credit_status,
                          asset_id, provider_task_id, created_at, updated_at, doc_json)
  VALUES(:id, :userId, :type, :status, :creditCost, :creditStatus,
         :assetId, :providerTaskId, :createdAt, :updatedAt, :docJson)
  ON CONFLICT(id) DO NOTHING`);

const insertAsset = () => sql(`
  INSERT INTO assets(id, user_id, kind, name, oss_key, created_at, updated_at, doc_json)
  VALUES(:id, :userId, :kind, :name, :ossKey, :createdAt, :updatedAt, :docJson)
  ON CONFLICT(id) DO NOTHING`);

const insertDrama = () => sql(`
  INSERT INTO drama_projects(id, user_id, title, step, status, created_at, updated_at, doc_json)
  VALUES(:id, :userId, :title, :step, :status, :createdAt, :updatedAt, :docJson)
  ON CONFLICT(id) DO NOTHING`);

function idempotencyKeyOf(record, fileName) {
  return fileName.replace(/\.json$/, '');
}

function migrateAll(legacyUsers) {
  const validUserIds = new Set(legacyUsers.map(user => user.id));

  for (const user of legacyUsers) {
    const wallet = walletFromLegacyUser(user);
    const changes = insertUser().run({
      id: user.id,
      username: String(user.username).toLowerCase(),
      passwordHash: user.passwordHash,
      role: user.role ?? 'user',
      inviteCode: user.inviteCode ?? null,
      balanceMicro: wallet.balanceMicro,
      heldMicro: wallet.heldMicro,
      createdAt: user.createdAt,
      docJson: JSON.stringify(user),
    }).changes;
    if (changes) tally('users', 'inserted'); else tally('users', 'skipped');
  }

  for (const session of collectSessions(validUserIds)) {
    const changes = insertSession().run({
      tokenHash: session.tokenHash,
      userId: session.userId,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
    }).changes;
    if (changes) tally('sessions', 'inserted'); else tally('sessions', 'skipped');
  }

  for (const invite of collectInviteUses(validUserIds)) {
    const changes = insertInvite().run(invite).changes;
    if (changes) tally('invite_uses', 'inserted'); else tally('invite_uses', 'skipped');
  }

  for (const userId of existsSync(userDataDir) ? readdirSync(userDataDir) : []) {
    if (!validUserIds.has(userId)) {
      if (statSync(path.join(userDataDir, userId)).isDirectory()) {
        report.skipped.push({ collection: 'users', file: `users/${userId}`, reason: 'orphan-user-directory' });
      }
      continue;
    }

    for (const { id, record, file } of collectPerUser(userId, 'credits', 'credit_entries', r => r.id ?? randomUUID())) {
      const amountMicro = entryAmountMicro(record);
      if (amountMicro === null) {
        skip('credit_entries', relative(file), 'unreadable-amount');
        continue;
      }
      const balanceAfterMicro = Number.isSafeInteger(record.balanceAfterMicro)
        ? record.balanceAfterMicro
        : Math.round(Number(record.balanceAfter ?? 0) * CREDIT_MICRO_FACTOR);
      const changes = insertCredit().run({
        id,
        userId,
        idempotencyKey: idempotencyKeyOf(record, path.basename(file)),
        type: record.type ?? 'unknown',
        amountMicro,
        balanceAfterMicro: Number.isSafeInteger(balanceAfterMicro) ? balanceAfterMicro : 0,
        generationId: record.generationId ?? null,
        requestId: record.requestId ?? null,
        createdAt: record.createdAt,
        docJson: JSON.stringify({ ...record, amountMicro }),
      }).changes;
      if (changes) tally('credit_entries', 'inserted'); else tally('credit_entries', 'skipped');
    }

    for (const { id, record } of collectPerUser(userId, 'billing-holds', 'billing_holds', r => r.id)) {
      const changes = insertHold().run({
        id,
        userId,
        type: record.type ?? 'llm',
        status: record.status ?? 'held',
        reservedMicro: Number.isSafeInteger(record.reservedMicro) ? record.reservedMicro : 0,
        chargedMicro: Number.isSafeInteger(record.chargedMicro) ? record.chargedMicro : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? record.createdAt,
        docJson: JSON.stringify(record),
      }).changes;
      if (changes) tally('billing_holds', 'inserted'); else tally('billing_holds', 'skipped');
    }

    for (const { id, record } of collectPerUser(userId, 'llm-usage', 'llm_usage', r => r.id)) {
      const changes = insertLlmUsage().run({
        id,
        userId,
        status: record.status ?? null,
        model: record.model ?? record.configuredModel ?? null,
        inputTokens: Number.isSafeInteger(record.inputTokens) ? record.inputTokens : null,
        outputTokens: Number.isSafeInteger(record.outputTokens) ? record.outputTokens : null,
        chargedMicro: Number.isSafeInteger(record.chargedMicro) ? record.chargedMicro : null,
        createdAt: record.createdAt,
        docJson: JSON.stringify(record),
      }).changes;
      if (changes) tally('llm_usage', 'inserted'); else tally('llm_usage', 'skipped');
    }

    for (const { id, record } of collectPerUser(userId, 'generations', 'generations', r => r.id)) {
      const changes = insertGeneration().run({
        id,
        userId,
        type: record.type ?? 'image',
        status: record.status ?? 'failed',
        creditCost: Number.isFinite(Number(record.creditCost)) ? Number(record.creditCost) : 0,
        creditStatus: record.creditStatus ?? null,
        assetId: record.assetId || null,
        providerTaskId: record.providerTaskId || null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? record.createdAt,
        docJson: JSON.stringify(record),
      }).changes;
      if (changes) tally('generations', 'inserted'); else tally('generations', 'skipped');
    }

    for (const { id, record } of collectPerUser(userId, 'assets', 'assets', r => r.id)) {
      const changes = insertAsset().run({
        id,
        userId,
        kind: record.kind ?? 'image',
        name: record.name ?? id,
        ossKey: record.ossKey ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? record.createdAt,
        docJson: JSON.stringify(record),
      }).changes;
      if (changes) tally('assets', 'inserted'); else tally('assets', 'skipped');
    }

    for (const { id, record } of collectPerUser(userId, 'drama-projects', 'drama_projects', r => r.id)) {
      const changes = insertDrama().run({
        id,
        userId,
        title: record.title ?? null,
        step: record.step ?? null,
        status: record.status ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? record.createdAt,
        docJson: JSON.stringify(record),
      }).changes;
      if (changes) tally('drama_projects', 'inserted'); else tally('drama_projects', 'skipped');
    }
  }
}

// ---------------------------------------------------------------- reconcile

function reconcileWallets() {
  const rows = sql(`
    SELECT u.id, u.username, u.credit_balance_micro AS balanceMicro, u.credit_held_micro AS heldMicro,
           COALESCE((SELECT SUM(amount_micro) FROM credit_entries c WHERE c.user_id = u.id), 0) AS ledgerMicro,
           COALESCE((SELECT SUM(reserved_micro) FROM billing_holds h
                     WHERE h.user_id = u.id AND h.status = 'held'), 0) AS heldSumMicro
    FROM users u ORDER BY u.username`).all();

  let ok = true;
  for (const row of rows) {
    const balanceDrift = row.balanceMicro - row.ledgerMicro;
    const heldDrift = row.heldMicro - row.heldSumMicro;
    if (balanceDrift !== 0 || heldDrift !== 0) ok = false;
    report.wallets.push({
      userId: row.id,
      username: row.username,
      balanceMicro: row.balanceMicro,
      ledgerSumMicro: row.ledgerMicro,
      balanceDriftMicro: balanceDrift,
      heldMicro: row.heldMicro,
      heldSumMicro: row.heldSumMicro,
      heldDriftMicro: heldDrift,
      ok: balanceDrift === 0 && heldDrift === 0,
    });
  }
  return ok;
}

// ---------------------------------------------------------------- verify

function runVerify(legacyUsers) {
  const mismatches = [];
  let checked = 0;

  const compare = (collection, id, expected, actualJson) => {
    checked++;
    let actual;
    try { actual = JSON.parse(actualJson); } catch { mismatches.push({ collection, id, fields: ['doc_json'] }); return; }
    const fields = [];
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) fields.push(key);
    }
    if (fields.length) mismatches.push({ collection, id, fields });
  };

  for (const user of legacyUsers) {
    const row = sql('SELECT doc_json FROM users WHERE id = :id').get({ id: user.id });
    if (!row) { mismatches.push({ collection: 'users', id: user.id, fields: ['<missing row>'] }); continue; }
    compare('users', user.id, user, row.doc_json);
  }

  const perUser = [
    ['credits', 'credit_entries'], ['billing-holds', 'billing_holds'], ['llm-usage', 'llm_usage'],
    ['generations', 'generations'], ['assets', 'assets'], ['drama-projects', 'drama_projects'],
  ];
  for (const user of legacyUsers) {
    for (const [dirName, table] of perUser) {
      const dir = path.join(userDataDir, user.id, dirName);
      for (const name of listJson(dir)) {
        let record;
        try { record = readJsonFile(path.join(dir, name)); } catch { continue; }
        if (!record?.id) continue;
        const row = table === 'credit_entries'
          ? sql(`SELECT doc_json FROM credit_entries WHERE user_id = :userId AND idempotency_key = :key`)
              .get({ userId: user.id, key: name.replace(/\.json$/, '') })
          : sql(`SELECT doc_json FROM ${table} WHERE id = :id`).get({ id: record.id });
        if (!row) { mismatches.push({ collection: table, id: record.id, fields: ['<missing row>'] }); continue; }
        // credit_entries gets a normalised amountMicro, so that field is expected to differ.
        const expected = table === 'credit_entries'
          ? { ...record, amountMicro: entryAmountMicro(record) }
          : record;
        compare(table, record.id, expected, row.doc_json);
      }
    }
  }

  report.verify = { checked, passed: checked - mismatches.length, mismatches };
  return mismatches.length === 0;
}

// ---------------------------------------------------------------- main

function writeReport() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const file = path.join(dataDir, `migration-report-${stamp}.json`);
  report.finishedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

function summarise() {
  const pad = name => name.padEnd(15);
  console.log(`\n模式: ${report.mode}`);
  console.log(`数据目录: ${dataDir}`);
  console.log(`数据库: ${report.dbFile}\n`);
  console.log(`${pad('集合')}  源  入库  跳过`);
  for (const name of COLLECTIONS) {
    const c = report.collections[name];
    console.log(`${pad(name)}${String(c.source).padStart(4)}${String(c.inserted).padStart(6)}${String(c.skipped).padStart(6)}`);
  }
  if (report.skipped.length) {
    console.log(`\n跳过 ${report.skipped.length} 条：`);
    for (const item of report.skipped.slice(0, 20)) {
      console.log(`  [${item.reason}] ${item.collection} ${item.file}`);
    }
    if (report.skipped.length > 20) console.log(`  ...另有 ${report.skipped.length - 20} 条，详见报告文件`);
  }
  console.log('\n钱包对账：');
  for (const w of report.wallets) {
    const flag = w.ok ? 'OK ' : 'BAD';
    console.log(`  ${flag} ${w.username}  余额 ${w.balanceMicro}  流水和 ${w.ledgerSumMicro}  差额 ${w.balanceDriftMicro}  冻结差额 ${w.heldDriftMicro}`);
  }
  if (report.verify) {
    console.log(`\n逐字段校验: 检查 ${report.verify.checked} 条，通过 ${report.verify.passed} 条，不一致 ${report.verify.mismatches.length} 条`);
    for (const m of report.verify.mismatches.slice(0, 20)) {
      console.log(`  ${m.collection} ${m.id} -> ${m.fields.join(', ')}`);
    }
  }
}

function main() {
  const dbFile = resolveDbFile();

  // Back up any pre-existing database before the first write.
  if (!dryRun && existsSync(dbFile)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
    const backup = `${dbFile}.bak-${stamp}`;
    const probe = openDatabase();
    probe.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    closeDatabase();
    report.backup = backup;
    console.log(`已备份现有数据库 -> ${path.basename(backup)}`);
  }

  openDatabase({ verbose: true });

  const legacyUsers = collectUsers();
  if (!legacyUsers.length) {
    report.result = 'nothing-to-migrate';
    if (!dryRun) writeMeta(MIGRATION_DONE_KEY, JSON.stringify({ finishedAt: new Date().toISOString(), collections: report.collections }));
    const file = writeReport();
    summarise();
    console.log(`\n未发现可迁移的用户记录。报告: ${path.basename(file)}`);
    closeDatabase();
    return 0;
  }

  let reconciled = false;
  let verified = true;

  try {
    tx(() => {
      migrateAll(legacyUsers);
      reconciled = reconcileWallets();
      if (!reconciled) throw new Error('钱包对账未通过，已回滚全部写入');
      if (verify) {
        verified = runVerify(legacyUsers);
        if (!verified) throw new Error('逐字段校验发现不一致，已回滚全部写入');
      }
      if (dryRun) throw new DryRunAbort();
      writeMeta(MIGRATION_DONE_KEY, JSON.stringify({
        finishedAt: new Date().toISOString(),
        collections: report.collections,
      }));
    });
    report.result = 'ok';
  } catch (error) {
    if (error instanceof DryRunAbort) {
      report.result = 'dry-run-rolled-back';
    } else {
      report.result = 'failed';
      report.error = error.message;
      const file = writeReport();
      summarise();
      console.error(`\n迁移失败并已回滚：${error.message}`);
      console.error(`报告: ${path.basename(file)}`);
      closeDatabase();
      return 1;
    }
  }

  const file = writeReport();
  summarise();
  console.log(`\n结果: ${report.result}`);
  console.log(`报告: ${path.basename(file)}`);
  closeDatabase();
  return 0;
}

class DryRunAbort extends Error {}

process.exit(main());
