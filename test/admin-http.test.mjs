import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { insertUser } from '../lib/store.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitForServer(child, port) {
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(`GuGu AI: ${base}`)) { clearTimeout(timer); resolve(base); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}：${output}`)); });
  });
}

function client(base) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (cookie) requestHeaders.Cookie = cookie;
    const response = await fetch(base + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await response.json(); } catch {}
    return { response, data, cookie };
  };
  return { call, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

test('admin HTTP permissions and core workflows', async t => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'admin-http-'));
  const port = await freePort();
  const adminId = randomUUID();
  const adminPassword = 'admin-http-password-123';
  resetForTests();
  openDatabase({ file: path.join(workDir, 'studio.db') });
  const createdAt = new Date().toISOString();
  insertUser({ id: adminId, username: 'http_admin', role: 'admin', status: 'active', passwordHash: await hashPassword(adminPassword), credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, createdAt, updatedAt: createdAt });
  closeDatabase({ checkpoint: false });

  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env: { ...process.env, NODE_ENV: 'development', DATA_DIR: workDir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); rmSync(workDir, { recursive: true, force: true }); });
  const base = await waitForServer(child, port);
  const admin = client(base);
  const unauth = await admin.call('/api/admin/auth/session');
  assert.equal(unauth.response.status, 401);
  const page = await fetch(`${base}/guguadmin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /管理后台/);

  const login = await admin.call('/api/admin/auth/login', { method: 'POST', headers: { Origin: base }, body: { username: 'http_admin', password: adminPassword } });
  assert.equal(login.response.status, 200);
  assert.ok(login.data.csrfToken);
  const csrf = login.data.csrfToken;

  const models = await admin.call('/api/admin/models');
  assert.equal(models.response.status, 200);
  assert.ok(models.data.items.some(item => item.modelId === 'grok'));
  const noCsrf = await admin.call('/api/admin/pricing', { method: 'POST', headers: { Origin: base }, body: { imagePerRequest: '1.5', videoPerSecond: '0.8', expectedVersion: 1 } });
  assert.equal(noCsrf.response.status, 403);
  const pricing = await admin.call('/api/admin/pricing', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { imagePerRequest: '1.5', videoPerSecond: '0.8', expectedVersion: 1 } });
  assert.equal(pricing.response.status, 201);
  assert.equal(pricing.data.pricing.videoPerSecond, 0.8);

  const invite = await admin.call('/api/admin/invite-codes', { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { code: 'HTTP-TEST-01', maxUses: 1, signupBonus: '4.5' } });
  assert.equal(invite.response.status, 201);
  const userResponse = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'http_user', password: 'user-password-123', inviteCode: 'HTTP-TEST-01' }) });
  const userData = await userResponse.json();
  assert.equal(userResponse.status, 201);
  assert.equal(userData.user.credits, 4.5);
  const userCookie = userResponse.headers.get('set-cookie').split(';')[0];

  const userClient = client(base); userClient.cookie = userCookie;
  const forbidden = await userClient.call('/api/admin/overview');
  assert.equal(forbidden.response.status, 401);
  const userLoginAsAdmin = await admin.call('/api/admin/auth/login', { method: 'POST', headers: { Origin: base }, body: { username: 'http_user', password: 'user-password-123' } });
  assert.equal(userLoginAsAdmin.response.status, 401);

  const users = await admin.call('/api/admin/users?query=http_user');
  assert.equal(users.data.items.length, 1);
  const target = users.data.items[0];
  const adjustment = await admin.call(`/api/admin/users/${target.id}/credit-adjustments`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { amount: '-1.25', reasonCode: 'customer_service', note: 'http test', idempotencyKey: 'http-adjust-1' } });
  assert.equal(adjustment.response.status, 200);
  assert.equal(adjustment.data.balance, 3.25);
  const replay = await admin.call(`/api/admin/users/${target.id}/credit-adjustments`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: { amount: '-1.25', reasonCode: 'customer_service', note: 'http test', idempotencyKey: 'http-adjust-1' } });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replay, true);
  const audit = await admin.call('/api/admin/logs/audit?limit=100');
  assert.ok(audit.data.items.some(item => item.action === 'user.credit_adjustment'));

  const disabled = await admin.call(`/api/admin/users/${target.id}/disable`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf }, body: {} });
  assert.equal(disabled.response.status, 200);
  const disabledLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'http_user', password: 'user-password-123' }) });
  assert.equal(disabledLogin.status, 401);
  assert.equal(disabledLogin.headers.get('set-cookie'), null);
});
