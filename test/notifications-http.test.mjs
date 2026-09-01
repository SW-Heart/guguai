import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { hashPassword } from '../lib/auth.mjs';
import { closeDatabase, openDatabase, resetForTests } from '../lib/db.mjs';
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
  const call = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const requestHeaders = { ...headers, ...(cookie ? { Cookie: cookie } : {}) };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetch(base + pathname, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await response.json(); } catch {}
    return { response, data };
  };
  return { call };
}

test('announcement HTTP workflow respects admin permissions and user read state', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'notifications-http-'));
  const port = await freePort();
  const adminPassword = 'notification-admin-password-123';
  const userPassword = 'notification-user-password-123';
  resetForTests();
  openDatabase({ file: path.join(dataDir, 'studio.db') });
  const createdAt = new Date().toISOString();
  insertUser({ id:'notification-http-admin', username:'notification_http_admin', role:'admin', status:'active', passwordHash:await hashPassword(adminPassword), credits:0, creditBalanceMicro:0, creditHeldMicro:0, createdAt, updatedAt:createdAt });
  insertUser({ id:'notification-http-user', username:'notification_http_user', role:'user', status:'active', passwordHash:await hashPassword(userPassword), credits:0, creditBalanceMicro:0, creditHeldMicro:0, createdAt, updatedAt:createdAt });
  closeDatabase({ checkpoint:false });

  const child = spawn(process.execPath, ['server.mjs'], { cwd:path.resolve(new URL('..', import.meta.url).pathname), env:{ ...process.env, NODE_ENV:'development', GUGU_TEST_ALLOW_BROWSER_WORKSPACE:'1', DATA_DIR:dataDir, PORT:String(port) }, stdio:['ignore','pipe','pipe'] });
  t.after(() => { child.kill('SIGTERM'); rmSync(dataDir, { recursive:true, force:true }); });
  const base = await waitForServer(child, port);
  const admin = client(base);
  const user = client(base);

  const adminLogin = await admin.call('/api/admin/auth/login', { method:'POST', headers:{ Origin:base }, body:{ username:'notification_http_admin', password:adminPassword } });
  assert.equal(adminLogin.response.status, 200);
  const announcement = await admin.call('/api/admin/announcements', { method:'POST', headers:{ Origin:base, 'X-CSRF-Token':adminLogin.data.csrfToken }, body:{ title:'维护通知', content:'今晚 23:00 进行服务维护。', status:'published' } });
  assert.equal(announcement.response.status, 201);
  assert.equal((await admin.call('/api/admin/announcements')).data.items.length, 1);

  const userLogin = await user.call('/api/auth/login', { method:'POST', body:{ username:'notification_http_user', password:userPassword } });
  assert.equal(userLogin.response.status, 200);
  let notifications = await user.call('/api/notifications');
  assert.equal(notifications.response.status, 200);
  assert.equal(notifications.data.unreadCount, 1);
  assert.equal(notifications.data.items[0].title, '维护通知');
  notifications = await user.call(`/api/notifications/${announcement.data.announcement.id}/read`, { method:'POST', body:{} });
  assert.equal(notifications.data.unreadCount, 0);

  await admin.call('/api/admin/announcements', { method:'POST', headers:{ Origin:base, 'X-CSRF-Token':adminLogin.data.csrfToken }, body:{ title:'第二条消息', content:'内容', status:'published' } });
  notifications = await user.call('/api/notifications');
  assert.equal(notifications.data.unreadCount, 1);
  notifications = await user.call('/api/notifications/read-all', { method:'POST', body:{} });
  assert.equal(notifications.data.unreadCount, 0);
});
