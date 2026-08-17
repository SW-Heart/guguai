#!/usr/bin/env node
/**
 * Throwaway benchmark: confirms the list queries stay flat as record counts
 * grow, and that the planner actually uses the intended indexes.
 *
 *   node scripts/bench-lists.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase, sql, database, tx } from '../lib/db.mjs';
import { configureCursors, listGenerations, listDramaProjects, latestDramaProject, listPendingGenerations } from '../lib/store.mjs';
import { configureLedger, recentCreditEntries } from '../lib/ledger.mjs';
import { llmRatesFromEnv } from '../lib/billing.mjs';

const workDir = mkdtempSync(path.join(tmpdir(), 'bench-'));
openDatabase({ file: path.join(workDir, 'studio.db') });
configureCursors('bench');
configureLedger({ llmRates: llmRatesFromEnv({ YUAN_PER_CREDIT: '0.1', LLM_INPUT_PRICE_YUAN_PER_MILLION: '3', LLM_OUTPUT_PRICE_YUAN_PER_MILLION: '6' }), llmProtocol: 'x', llmModel: 'y' });

const GENERATIONS = 20_000;
const LEDGER = 50_000;
const PROJECTS = 500;
const USERS = 100;

console.log(`播种 ${USERS} 用户 / ${GENERATIONS} 生成记录 / ${LEDGER} 流水 / ${PROJECTS} 项目 ...`);

const userIds = [];
tx(() => {
  for (let i = 0; i < USERS; i++) {
    const id = randomUUID();
    userIds.push(id);
    sql(`INSERT INTO users(id, username, password_hash, role, credit_balance_micro,
                           credit_held_micro, created_at, doc_json)
         VALUES(:id, :u, 'scrypt:x:y', 'user', 0, 0, :t, :d)`)
      .run({ id, u: `bench_${i}`, t: new Date().toISOString(), d: JSON.stringify({ id }) });
  }
});

const target = userIds[0];
const base = Date.UTC(2026, 0, 1);

tx(() => {
  const ins = sql(`INSERT INTO generations(id, user_id, type, status, credit_cost, credit_status,
                     asset_id, provider_task_id, created_at, updated_at, doc_json)
                   VALUES(:id,:u,:ty,:st,1,'charged',NULL,NULL,:c,:c,:d)`);
  for (let i = 0; i < GENERATIONS; i++) {
    const createdAt = new Date(base + i * 1000).toISOString();
    // Spread a slice across other users so the index has to discriminate.
    const owner = i % 10 === 0 ? userIds[1 + (i % (USERS - 1))] : target;
    ins.run({
      id: `g-${i}`, u: owner, ty: i % 3 === 0 ? 'video' : 'image', st: 'completed',
      c: createdAt,
      d: JSON.stringify({ id: `g-${i}`, type: i % 3 === 0 ? 'video' : 'image', status: 'completed', createdAt, updatedAt: createdAt }),
    });
  }
});

tx(() => {
  const ins = sql(`INSERT INTO credit_entries(id, user_id, idempotency_key, type, amount_micro,
                     balance_after_micro, generation_id, request_id, created_at, doc_json)
                   VALUES(:id,:u,:k,'generation_charge',-1000,0,NULL,NULL,:c,:d)`);
  for (let i = 0; i < LEDGER; i++) {
    const createdAt = new Date(base + i * 1000).toISOString();
    ins.run({ id: `c-${i}`, u: target, k: `key-${i}`, c: createdAt, d: JSON.stringify({ id: `c-${i}`, createdAt }) });
  }
});

tx(() => {
  const ins = sql(`INSERT INTO drama_projects(id, user_id, title, step, status, created_at, updated_at, doc_json)
                   VALUES(:id,:u,'t','script','draft',:c,:c,:d)`);
  for (let i = 0; i < PROJECTS; i++) {
    const createdAt = new Date(base + i * 1000).toISOString();
    ins.run({ id: `p-${i}`, u: target, c: createdAt, d: JSON.stringify({ id: `p-${i}`, createdAt }) });
  }
});

sql('ANALYZE').run?.();
try { database().exec('ANALYZE'); } catch { /* optional */ }

function bench(label, fn, runs = 20) {
  fn(); // warm
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  console.log(`  ${label.padEnd(46)} p50=${samples[Math.floor(runs / 2)].toFixed(2)}ms  p95=${p95.toFixed(2)}ms`);
  return p95;
}

console.log('\n查询耗时：');
const results = {
  credits: bench(`GET /api/credits (${LEDGER} 条流水中取 20)`, () => recentCreditEntries(target, 20)),
  generations: bench(`GET /api/generations 首页 (${GENERATIONS} 条)`, () => listGenerations(target, { limit: 100 })),
  generationsFiltered: bench('GET /api/generations?type=video 首页', () => listGenerations(target, { type: 'video', limit: 100 })),
  dramaLatest: bench('GET /api/drama/projects/latest', () => latestDramaProject(target)),
  dramaList: bench('GET /api/drama/projects 首页', () => listDramaProjects(target, { limit: 100 })),
  recovery: bench('启动恢复扫描 (0 条非终态)', () => listPendingGenerations()),
};

console.log('\n查询计划：');
const plans = [
  ['generations 首页', `SELECT id, created_at, doc_json FROM generations WHERE user_id='x' ORDER BY created_at DESC, id ASC LIMIT 100`],
  ['generations type 过滤', `SELECT id, created_at, doc_json FROM generations WHERE user_id='x' AND type='video' ORDER BY created_at DESC, id ASC LIMIT 100`],
  ['credits 取 20', `SELECT doc_json FROM credit_entries WHERE user_id='x' ORDER BY created_at DESC, id ASC LIMIT 20`],
  ['非终态扫描', `SELECT user_id, doc_json FROM generations WHERE status IN ('queued','running')`],
  ['drama latest', `SELECT doc_json FROM drama_projects WHERE user_id='x' ORDER BY updated_at DESC, id ASC LIMIT 1`],
];
for (const [label, query] of plans) {
  const rows = database().prepare(`EXPLAIN QUERY PLAN ${query}`).all();
  console.log(`  ${label}:`);
  for (const row of rows) console.log(`      ${row.detail}`);
}

const budget = 50;
const over = Object.entries(results).filter(([, p95]) => p95 > budget);
console.log(`\n预算 ${budget}ms: ${over.length === 0 ? '全部通过' : `超出 -> ${over.map(([k]) => k).join(', ')}`}`);

closeDatabase({ checkpoint: false });
rmSync(workDir, { recursive: true, force: true });
process.exit(over.length === 0 ? 0 : 1);
