#!/usr/bin/env node
/**
 * Hot backup of the metadata database.
 *
 *   npm run db:backup
 *
 * Uses VACUUM INTO, which produces a self-contained snapshot of all committed
 * transactions. Plain file copies are unsafe here: in WAL mode the newest
 * committed data may still live in studio.db-wal, so copying only studio.db
 * silently loses it.
 *
 * Keeps the newest RETENTION backups and deletes older ones. Nothing else in
 * DATA_DIR is touched, including the legacy JSON files.
 */
import { existsSync, readdirSync, statSync, unlinkSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { openDatabase, closeDatabase, resolveDataDir, resolveDbFile } from '../lib/db.mjs';

const RETENTION = 7;
const TABLES = [
  'users', 'sessions', 'invite_uses', 'credit_entries',
  'billing_holds', 'llm_usage', 'generations', 'assets', 'drama_projects',
];

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function countRows(file) {
  const handle = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = handle.prepare('PRAGMA integrity_check').get().integrity_check;
    const counts = Object.fromEntries(
      TABLES.map(table => [table, handle.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c])
    );
    return { integrity, counts };
  } finally {
    handle.close();
  }
}

async function main() {
  const dbFile = resolveDbFile();
  if (!existsSync(dbFile)) {
    console.error(`数据库文件不存在: ${dbFile}`);
    return 1;
  }

  const dataDir = resolveDataDir();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const target = path.join(dataDir, `studio.db.bak-${stamp}`);

  const db = openDatabase();
  const sourceCounts = Object.fromEntries(
    TABLES.map(table => [table, db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c])
  );
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  closeDatabase({ checkpoint: false });

  // Validate the snapshot before trusting it.
  let verified;
  try {
    verified = countRows(target);
  } catch (error) {
    unlinkSync(target);
    console.error(`备份副本无法打开，已删除：${error.message}`);
    return 1;
  }

  const mismatched = TABLES.filter(table => verified.counts[table] !== sourceCounts[table]);
  if (verified.integrity !== 'ok' || mismatched.length) {
    unlinkSync(target);
    console.error(`备份副本校验失败，已删除。integrity=${verified.integrity} 记录数不一致的表: ${mismatched.join(', ') || '无'}`);
    return 1;
  }

  const digest = await sha256(target);
  const size = statSync(target).size;

  console.log(`备份完成: ${target}`);
  console.log(`字节数: ${size}`);
  console.log(`SHA-256: ${digest}`);
  console.log(`integrity_check: ${verified.integrity}`);
  console.log('记录数：');
  for (const table of TABLES) console.log(`  ${table}: ${verified.counts[table]}`);

  // Retention: keep the newest RETENTION snapshots.
  const existing = readdirSync(dataDir)
    .filter(name => /^studio\.db\.bak-/.test(name))
    .sort()
    .reverse();
  const stale = existing.slice(RETENTION);
  for (const name of stale) unlinkSync(path.join(dataDir, name));
  if (stale.length) console.log(`\n已清理 ${stale.length} 份过期备份，保留最近 ${RETENTION} 份。`);

  console.log('\n恢复方式: 停止服务后把该副本重命名为 studio.db，并删除同目录下的 studio.db-wal 与 studio.db-shm。');
  return 0;
}

process.exit(await main());
