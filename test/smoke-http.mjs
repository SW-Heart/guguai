/**
 * End-to-end smoke test against a real server process on an isolated DATA_DIR.
 * Covers the paths that do not call external providers: registration, login,
 * session handling, credits, drama project CRUD, list pagination and isolation.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, sql } from '../lib/db.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'smoke-'));
const inviteCreatedAt = new Date().toISOString();
openDatabase({ env: { DATA_DIR: dataDir } });
const insertInvite = sql(`
  INSERT INTO invite_codes(code, enabled, max_uses, used_count, signup_bonus_micro, created_at, updated_at, note)
  VALUES(:code, 1, 1, 0, 50000000, :createdAt, :createdAt, 'HTTP smoke test')
`);
for (const code of ['SMOKE-INVITE-A', 'SMOKE-INVITE-B']) insertInvite.run({ code, createdAt: inviteCreatedAt });
closeDatabase({ checkpoint: false });

const port = 4399 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    NODE_ENV: 'development',
    DUOMI_API_KEY: 'smoke-key',
    YUAN_PER_CREDIT: '0.1',
    LLM_INPUT_PRICE_YUAN_PER_MILLION: '3',
    LLM_OUTPUT_PRICE_YUAN_PER_MILLION: '6',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

const failures = [];
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (error) { failures.push(`${label}: ${error.message}`); console.log(`  FAIL ${label}\n       ${error.message}`); }
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/readyz`); return true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return false;
}

let cookie = '';
async function call(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const value of setCookie) {
    const token = value.split(';')[0];
    if (token.startsWith('studio_session=')) cookie = token;
  }
  let payload = null;
  const text = await res.text();
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: res.status, body: payload, headers: res.headers };
}

try {
  if (!await waitForServer()) throw new Error(`服务未启动:\n${serverLog}`);
  console.log('服务已启动\n');

  console.log('健康检查：');
  let r = await call('GET', '/healthz');
  check('/healthz 返回 ok', () => { assert.equal(r.status, 200); assert.equal(r.body.status, 'ok'); });
  r = await call('GET', '/readyz');
  check('/readyz 返回 ready', () => { assert.equal(r.status, 200); assert.equal(r.body.status, 'ready'); });

  console.log('\n认证：');
  r = await call('GET', '/api/auth/me');
  check('未登录访问 /api/auth/me 返回 401', () => assert.equal(r.status, 401));

  r = await call('POST', '/api/auth/register', { username: 'smoke_a', password: 'password1234', inviteCode: 'bad-code' });
  check('无效邀请码被拒', () => { assert.equal(r.status, 400); assert.match(r.body.error, /邀请码无效/); });

  r = await call('POST', '/api/auth/register', { username: 'smoke_a', password: 'password1234', inviteCode: 'SMOKE-INVITE-A' });
  check('注册成功返回 201', () => assert.equal(r.status, 201));
  check('新用户获得 50 赠送积分', () => assert.equal(r.body.user.credits, 50));
  check('响应不含 passwordHash', () => assert.equal(r.body.user.passwordHash, undefined));
  const userA = r.body.user.id;

  r = await call('POST', '/api/auth/register', { username: 'smoke_b', password: 'password1234', inviteCode: 'SMOKE-INVITE-A' });
  check('同一邀请码二次注册返回 409', () => { assert.equal(r.status, 409); assert.match(r.body.error, /邀请码/); });

  r = await call('GET', '/api/auth/me');
  check('注册后会话可用', () => { assert.equal(r.status, 200); assert.equal(r.body.user.id, userA); });

  console.log('\n积分：');
  r = await call('GET', '/api/credits');
  check('/api/credits 返回钱包字段', () => {
    for (const key of ['balance', 'held', 'available', 'balanceMicro', 'heldMicro', 'availableMicro', 'pricing', 'transactions']) {
      assert.ok(key in r.body, `缺少字段 ${key}`);
    }
  });
  check('余额为 50', () => assert.equal(r.body.balance, 50));
  check('transactions 是数组且含赠送流水', () => {
    assert.ok(Array.isArray(r.body.transactions));
    assert.equal(r.body.transactions.length, 1);
    assert.equal(r.body.transactions[0].type, 'signup_bonus');
  });
  check('pricing 保留原字段', () => {
    assert.equal(r.body.pricing.image, 1);
    assert.equal(r.body.pricing.videoPerSecond, 1);
    assert.equal(r.body.pricing.yuanPerCredit, 0.1);
  });

  console.log('\n列表接口形状：');
  r = await call('GET', '/api/generations');
  check('/api/generations 是裸数组', () => { assert.equal(r.status, 200); assert.ok(Array.isArray(r.body)); });
  check('空列表返回 [] 而非 null', () => assert.deepEqual(r.body, []));
  check('带 X-Total-Count 头', () => assert.equal(r.headers.get('x-total-count'), '0'));
  check('最后一页不带 X-Next-Cursor', () => assert.equal(r.headers.get('x-next-cursor'), null));

  r = await call('GET', '/api/files');
  check('/api/files 是裸数组', () => assert.ok(Array.isArray(r.body)));

  r = await call('GET', '/api/generations?limit=0');
  check('limit=0 返回 400', () => { assert.equal(r.status, 400); assert.match(r.body.error, /limit/); });
  r = await call('GET', '/api/generations?limit=999');
  check('limit=999 返回 400', () => assert.equal(r.status, 400));
  r = await call('GET', '/api/generations?limit=abc');
  check('limit=abc 返回 400', () => assert.equal(r.status, 400));
  r = await call('GET', '/api/generations?cursor=forged');
  check('伪造 cursor 返回 400', () => { assert.equal(r.status, 400); assert.match(r.body.error, /cursor/); });

  console.log('\n短剧项目：');
  r = await call('GET', '/api/drama/projects/latest');
  check('无项目时 latest 返回 404', () => assert.equal(r.status, 404));

  const created = [];
  for (let i = 0; i < 7; i++) {
    r = await call('POST', '/api/drama/projects', { title: `项目 ${i}`, mode: 'smart' });
    if (r.status !== 201) { failures.push(`创建项目 ${i} 失败: ${JSON.stringify(r.body)}`); break; }
    created.push(r.body.project.id);
  }
  check('创建 7 个项目', () => assert.equal(created.length, 7));
  await new Promise(resolve => setTimeout(resolve, 5));
  r = await call('PATCH', `/api/drama/projects/${created.at(-1)}`, { title: '最近更新项目' });
  check('更新最后一个项目', () => assert.equal(r.status, 200));

  r = await call('GET', '/api/drama/projects');
  check('projects 包在 { projects } 里', () => { assert.ok(Array.isArray(r.body.projects)); assert.equal(r.body.projects.length, 7); });
  check('项目对象不含 ownerId', () => assert.equal(r.body.projects[0].ownerId, undefined));
  check('normalizeDramaProject 字段齐全', () => {
    const p = r.body.projects[0];
    for (const key of ['schemaVersion', 'workflowVersion', 'settings', 'scenes', 'resources', 'shots', 'step', 'maxStep']) {
      assert.ok(key in p, `缺少 ${key}`);
    }
    assert.equal(p.schemaVersion, 5);
    assert.ok(Array.isArray(p.shots));
  });

  r = await call('GET', '/api/drama/projects/latest');
  check('latest 返回最近更新的项目', () => { assert.equal(r.status, 200); assert.equal(r.body.project.id, created.at(-1)); });

  // Drain pages of 2 and compare with the full list.
  const full = (await call('GET', '/api/drama/projects?limit=200')).body.projects.map(p => p.id);
  const paged = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard++) {
    const q = `/api/drama/projects?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await call('GET', q);
    paged.push(...page.body.projects.map(p => p.id));
    cursor = page.headers.get('x-next-cursor');
    if (!cursor) break;
  }
  check('翻页拼接等于全量', () => assert.deepEqual(paged, full));
  check('翻页无重复', () => assert.equal(new Set(paged).size, 7));

  console.log('\n跨用户隔离：');
  const cookieA = cookie;
  cookie = '';
  r = await call('POST', '/api/auth/register', { username: 'smoke_c', password: 'password1234', inviteCode: 'SMOKE-INVITE-B' });
  check('第二个账号注册成功', () => assert.equal(r.status, 201));
  const cookieB = cookie;

  r = await call('GET', '/api/drama/projects');
  check('B 看不到 A 的项目', () => assert.equal(r.body.projects.length, 0));
  r = await call('GET', `/api/drama/projects/${created[0]}`);
  check('B 访问 A 的项目返回 404', () => assert.equal(r.status, 404));
  r = await call('GET', '/api/generations/00000000-0000-0000-0000-000000000000');
  check('不存在的记录同样 404', () => assert.equal(r.status, 404));

  console.log('\n登录与登出：');
  cookie = cookieA;
  r = await call('POST', '/api/auth/logout');
  check('登出成功', () => assert.equal(r.status, 200));
  r = await call('GET', '/api/auth/me');
  check('登出后会话失效', () => assert.equal(r.status, 401));

  cookie = '';
  r = await call('POST', '/api/auth/login', { username: 'smoke_a', password: 'wrongpassword' });
  check('错误密码返回 401', () => assert.equal(r.status, 401));
  r = await call('POST', '/api/auth/login', { username: 'smoke_a', password: 'password1234' });
  check('正确密码登录成功', () => assert.equal(r.status, 200));
  r = await call('GET', '/api/drama/projects');
  check('重新登录后仍能看到自己的 7 个项目', () => assert.equal(r.body.projects.length, 7));
  void cookieB;

  console.log('\n数据库落盘检查：');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'studio.db'), { readOnly: true });
  const counts = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    invites: db.prepare('SELECT COUNT(*) c FROM invite_code_uses').get().c,
    entries: db.prepare('SELECT COUNT(*) c FROM credit_entries').get().c,
    projects: db.prepare('SELECT COUNT(*) c FROM drama_projects').get().c,
  };
  check('users=2', () => assert.equal(counts.users, 2));
  check('invite_code_uses=2', () => assert.equal(counts.invites, 2));
  check('credit_entries=2 (两笔赠送)', () => assert.equal(counts.entries, 2));
  check('drama_projects=7', () => assert.equal(counts.projects, 7));
  const drift = db.prepare(`
    SELECT u.id, u.credit_balance_micro - COALESCE((SELECT SUM(amount_micro) FROM credit_entries c WHERE c.user_id=u.id),0) AS d
    FROM users u`).all();
  check('每个账号余额与流水一致', () => { for (const row of drift) assert.equal(row.d, 0, `${row.id} 差额 ${row.d}`); });
  db.close();

  console.log('\n服务日志：');
  for (const line of serverLog.trim().split('\n').filter(l => !/ExperimentalWarning|trace-warnings/.test(l))) {
    console.log(`  ${line}`);
  }
} catch (error) {
  failures.push(`异常: ${error.message}`);
  console.error(error);
  console.error(serverLog);
} finally {
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
  child.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：`}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
