#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { closeDatabase, openDatabase, sql, tx } from '../lib/db.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { appendAuditEvent } from '../lib/audit.mjs';
import { adjustCredits } from '../lib/ledger.mjs';
import { findUserByUsername, insertUser } from '../lib/store.mjs';

const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');
const openingCredits = Number(process.env.ADMIN_CREDITS || 0);

if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error('ADMIN_USERNAME 格式无效');
if (password.length < 12 || password.length > 128) throw new Error('ADMIN_PASSWORD 需为 12–128 位');
if (!Number.isSafeInteger(openingCredits) || openingCredits < 0) throw new Error('ADMIN_CREDITS 必须是非负整数');

async function main() {
  openDatabase({ verbose: true });
  try {
    const existing = findUserByUsername(username);
    if (existing && process.env.ADMIN_PROMOTE_EXISTING !== '1') throw new Error(`账号 ${username} 已存在；如需明确晋升已有账号，请设置 ADMIN_PROMOTE_EXISTING=1`);

    const createdAt = new Date().toISOString();
    let user;
    if (existing) {
      user = tx(() => {
        const updatedAt = new Date().toISOString();
        sql(`UPDATE users SET role = 'admin', status = 'active', updated_at = :updatedAt WHERE id = :id`).run({ id: existing.id, updatedAt });
        appendAuditEvent({ actorUserId: existing.id, action: 'admin.bootstrap_promote', targetType: 'user', targetId: existing.id, before: { role: existing.role, status: existing.status }, after: { role: 'admin', status: 'active' } });
        return { ...existing, role: 'admin', status: 'active' };
      });
    } else {
      const passwordHash = await hashPassword(password);
      user = { id: randomUUID(), username, role: 'admin', status: 'active', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, passwordHash, inviteCode: null, createdAt, updatedAt: createdAt };
      tx(() => {
        insertUser(user);
        appendAuditEvent({ actorUserId: user.id, action: 'admin.bootstrap_create', targetType: 'user', targetId: user.id, after: { username, role: 'admin', status: 'active' } });
      });
    }

    if (openingCredits > 0) {
      await adjustCredits(user.id, Math.round(openingCredits * 1_000_000), {
        actorUserId: user.id,
        idempotencyKey: `admin-opening-${user.id}`,
        reasonCode: 'admin_opening_balance',
        note: '管理员初始化积分',
        onAudit: ({ before, after, entry }) => appendAuditEvent({ actorUserId: user.id, action: 'admin.opening_balance', targetType: 'user', targetId: user.id, before, after: { ...after, entryId: entry.id } }),
      });
    }
    console.log(JSON.stringify({ username: user.username, role: 'admin', status: 'active', openingCredits }));
  } finally {
    closeDatabase({ checkpoint: false });
  }
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
