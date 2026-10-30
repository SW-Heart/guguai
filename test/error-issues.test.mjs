import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { appendSystemEvent } from '../lib/audit.mjs';
import { backfillIssues, errorFingerprint, findIssue, issueCounts, issueEvents, normalizeErrorMessage, pruneErrorHistory, resetIssueSampling, resolveOpenIssues, setIssueStatus, stackLocation } from '../lib/error-issues.mjs';
import { clientErrorEntries, consoleErrorEntry, installServerErrorCapture, isClientAbort, reportServerError } from '../lib/error-tracker.mjs';
import { createErrorReporter, isExpectedFailure } from '../public/features/errors/reporter.js';

function withDatabase(t) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'error-issues-'));
  resetForTests();
  resetIssueSampling();
  openDatabase({ file: path.join(workDir, 'studio.db') });
  t.after(() => { closeDatabase({ checkpoint: false }); rmSync(workDir, { recursive: true, force: true }); });
}

test('同类错误去掉变化部分后合并为一个指纹', () => {
  assert.equal(normalizeErrorMessage('任务 1f2e3d4c-1111-2222-3333-444455556666 第 3 次失败：/opt/gugu-ai/data/tmp/a.mp4'), '任务 <id> 第 <n> 次失败：<path>');
  assert.equal(
    errorFingerprint({ category: 'server.media', message: '临时目录清理失败 /opt/gugu-ai/data/tmp/job-1' }),
    errorFingerprint({ category: 'server.media', message: '临时目录清理失败 /opt/gugu-ai/data/tmp/job-2' }),
  );
  assert.notEqual(errorFingerprint({ source: 'web', message: 'x' }), errorFingerprint({ source: 'desktop', message: 'x' }));
  assert.equal(stackLocation('Error: x\n    at node:internal/a:1:1\n    at run (file:///opt/gugu-ai/lib/generation-service.mjs:42:7)'), 'run lib/generation-service.mjs');
  assert.equal(stackLocation('TypeError: y\nrender@https://guguai.xyz/features/drama/pure.js?v=3:10:2'), 'render features/drama/pure.js');
});

test('错误汇总为问题：累计次数、已解决后复发自动重新打开、忽略后只计数', t => {
  withDatabase(t);
  const first = appendSystemEvent({ category: 'server.generation', message: '上游超时 3 次', userId: 'u1', createdAt: '2026-10-20T00:00:00.000Z' });
  appendSystemEvent({ category: 'server.generation', message: '上游超时 5 次', userId: 'u2', createdAt: '2026-10-21T00:00:00.000Z' });
  appendSystemEvent({ level: 'info', category: 'model_route.trial', message: '试用一次' });
  let issue = findIssue(first.fingerprint);
  assert.equal(issue.count, 2);
  assert.equal(issue.userCount, 2);
  assert.equal(issue.firstSeenAt, '2026-10-20T00:00:00.000Z');
  assert.equal(issue.lastSeenAt, '2026-10-21T00:00:00.000Z');
  assert.equal(issue.message, '上游超时 5 次');
  assert.deepEqual(issueCounts(), { open: 1, resolved: 0, ignored: 0 });

  setIssueStatus(first.fingerprint, { status: 'resolved', note: '已换线路' }, { actorUserId: 'admin' });
  issue = findIssue(first.fingerprint);
  assert.equal(issue.status, 'resolved');
  assert.equal(issue.resolvedBy, 'admin');
  appendSystemEvent({ level: 'critical', category: 'server.generation', message: '上游超时 9 次', createdAt: '2026-10-22T00:00:00.000Z' });
  issue = findIssue(first.fingerprint);
  assert.equal(issue.status, 'open');
  assert.equal(issue.level, 'critical');
  assert.equal(issue.reopenedCount, 1);
  assert.equal(issue.resolvedAt, null);
  assert.equal(issue.note, '已换线路');

  setIssueStatus(first.fingerprint, { status: 'ignored' });
  appendSystemEvent({ category: 'server.generation', message: '上游超时 1 次', createdAt: '2026-10-23T00:00:00.000Z' });
  issue = findIssue(first.fingerprint);
  assert.equal(issue.status, 'ignored');
  assert.equal(issue.count, 4);
  assert.throws(() => setIssueStatus(first.fingerprint, { status: 'done' }), /处理状态无效/);
});

test('一键解决只处理筛选范围内、加载列表之前出现的未处理问题', t => {
  withDatabase(t);
  const old = appendSystemEvent({ category: 'server.a', message: '旧问题', createdAt: '2026-10-20T00:00:00.000Z' });
  const web = appendSystemEvent({ source: 'web', category: 'web.error', message: '页面问题', createdAt: '2026-10-20T00:00:00.000Z' });
  const fresh = appendSystemEvent({ category: 'server.b', message: '新问题', createdAt: '2026-10-25T00:00:00.000Z' });
  const ignored = appendSystemEvent({ category: 'server.c', message: '忽略的问题', createdAt: '2026-10-20T00:00:00.000Z' });
  setIssueStatus(ignored.fingerprint, { status: 'ignored' });

  const serverOnly = resolveOpenIssues({ before: '2026-10-24T00:00:00.000Z', source: 'server' }, { actorUserId: 'admin', at: '2026-10-25T01:00:00.000Z' });
  assert.equal(serverOnly.resolved, 1);
  assert.equal(findIssue(old.fingerprint).status, 'resolved');
  assert.equal(findIssue(web.fingerprint).status, 'open');
  assert.equal(findIssue(fresh.fingerprint).status, 'open');
  assert.equal(findIssue(ignored.fingerprint).status, 'ignored');

  const all = resolveOpenIssues({ before: '2026-10-25T00:30:00.000Z' }, { at: '2026-10-25T01:00:00.000Z' });
  assert.equal(all.resolved, 2);
  assert.deepEqual(issueCounts(), { open: 0, resolved: 3, ignored: 1 });
});

test('高频重复只保留样本，次数照常累计；过期记录按保留期清理', t => {
  withDatabase(t);
  const at = new Date('2026-10-25T00:00:00.000Z');
  let fingerprint;
  for (let index = 0; index < 50; index += 1) fingerprint = appendSystemEvent({ category: 'server.loop', message: `循环错误 ${index}`, createdAt: new Date(at.getTime() + index).toISOString() }).fingerprint;
  assert.equal(findIssue(fingerprint).count, 50);
  assert.equal(sql('SELECT COUNT(*) AS count FROM system_events WHERE fingerprint = :fingerprint').get({ fingerprint }).count, 20);
  assert.equal(issueEvents(fingerprint, 5).length, 5);

  appendSystemEvent({ level: 'info', category: 'client_log', message: '诊断日志', createdAt: '2026-01-01T00:00:00.000Z' });
  const stale = appendSystemEvent({ category: 'server.old', message: '很久以前', createdAt: '2026-01-01T00:00:00.000Z' });
  setIssueStatus(stale.fingerprint, { status: 'resolved' });
  const pruned = pruneErrorHistory({ at: Date.parse('2026-10-25T00:00:00.000Z') });
  assert.deepEqual(pruned, { events: 1, issues: 1 });
  assert.equal(sql("SELECT COUNT(*) AS count FROM system_events WHERE category = 'client_log'").get().count, 1);
  assert.equal(findIssue(fingerprint).count, 50);
});

test('console.error 原样输出并入库，标签成为分类，未捕获异常记为严重', t => {
  withDatabase(t);
  const printed = [];
  const fakeConsole = { error: (...args) => printed.push(args) };
  const fakeProcess = new EventEmitter();
  const uninstall = installServerErrorCapture({ consoleImpl: fakeConsole, processImpl: fakeProcess });
  t.after(uninstall);

  const error = Object.assign(new Error('R2 上传失败'), { code: 'ECONNRESET' });
  fakeConsole.error('[image-reference] 参考图暂存失败', { generationId: 'gen-1', userId: 'user-1', message: error.message }, error);
  assert.equal(printed.length, 1);
  const row = sql("SELECT category, message, generation_id, user_id, details_json FROM system_events WHERE category = 'server.image-reference'").get();
  assert.equal(row.message, '参考图暂存失败：R2 上传失败');
  assert.equal(row.generation_id, 'gen-1');
  assert.equal(row.user_id, 'user-1');
  assert.equal(JSON.parse(row.details_json).code, 'ECONNRESET');

  fakeProcess.emit('uncaughtExceptionMonitor', new Error('boom'), 'unhandledRejection');
  const fatal = sql("SELECT level, message FROM system_events WHERE category = 'server.unhandled_rejection'").get();
  assert.deepEqual({ ...fatal }, { level: 'critical', message: 'boom' });

  const reported = reportServerError(new Error('handler crashed'), { category: 'server.http', requestId: 'req-1' });
  assert.equal(findIssue(reported.fingerprint).category, 'server.http');
  assert.equal(printed.length, 2);
  assert.equal(consoleErrorEntry(['plain']).category, 'server');
});

test('前端上报过滤噪音，分来源归类', () => {
  const entries = clientErrorEntries({ appVersion: '0.8.4', platform: 'darwin', reports: [
    { kind: 'unhandledrejection', message: 'TypeError: a is null', stack: 'TypeError: a is null\n    at go (https://guguai.xyz/app.js?v=618:1:1)' },
    { kind: 'error', message: 'Script error.' },
    { kind: 'error', message: 'ResizeObserver loop limit exceeded' },
    { kind: 'error', message: 'oops', source: 'chrome-extension://abc/inject.js' },
    { kind: 'weird', message: 'TypeError: b', source: 'https://guguai.xyz/drama-studio.js?v=2' },
    { kind: 'main', message: '(node:38942) ExperimentalWarning: SQLite is an experimental feature and might change at any time' },
    { kind: 'main', message: "Error occurred in handler for 'media:download-remote': Error: net::ERR_TIMED_OUT" },
    { kind: 'main', message: '(node:38942) electron: Failed to load URL: https://guguai.xyz/ with error: ERR_CONNECTION_CLOSED' },
    { kind: 'main', message: "Error occurred in handler for 'media:download-remote': Error: 下载连接或传输停滞，请重试" },
  ] }, { source: 'desktop', userId: 'u1' });
  assert.deepEqual(entries.map(entry => [entry.category, entry.location, entry.userId]), [
    ['desktop.unhandledrejection', 'go app.js', 'u1'],
    ['desktop.error', 'drama-studio.js', 'u1'],
  ]);
  assert.equal(entries[0].details.appVersion, '0.8.4');
});

test('页面上报器去重、跳过接口业务错误并批量发送', async () => {
  const calls = [];
  const reporter = createErrorReporter({ fetchImpl: (url, options) => { calls.push([url, JSON.parse(options.body), options.headers]); return Promise.resolve(); }, headers: () => ({ 'X-GuGu-Desktop': '1' }), meta: () => ({ appVersion: '0.8.4' }), flushDelayMs: 5, location: { pathname: '/' }, navigator: { userAgent: 'test' } });
  const boom = new TypeError('x is undefined');
  reporter.onError({ error: boom, message: boom.message, filename: 'https://guguai.xyz/app.js?v=618', lineno: 3, colno: 4 });
  reporter.onError({ error: boom, message: boom.message });
  reporter.onRejection({ reason: Object.assign(new Error('请先登录'), { status: 401 }) });
  reporter.onRejection({ reason: new Error('render failed') });
  reporter.onError({ target: { tagName: 'IMG' }, currentTarget: {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  const [url, body, headers] = calls[0];
  assert.equal(url, '/api/errors');
  assert.equal(headers['X-GuGu-Desktop'], '1');
  assert.equal(body.appVersion, '0.8.4');
  assert.deepEqual(body.reports.map(report => [report.kind, report.message]), [['error', 'TypeError: x is undefined'], ['unhandledrejection', 'render failed']]);
  assert.equal(isExpectedFailure({ code: 'API_TIMEOUT' }), true);
  assert.equal(isExpectedFailure(new Error('x')), false);
});

test('上线前的历史错误记录按时间顺序补齐成问题', t => {
  withDatabase(t);
  const insert = sql(`INSERT INTO system_events(id, level, category, user_id, message, created_at) VALUES(:id, :level, 'admin_api', :userId, :message, :createdAt)`);
  insert.run({ id: 'e2', level: 'error', userId: 'u2', message: '后台接口失败 2', createdAt: '2026-10-02T00:00:00.000Z' });
  insert.run({ id: 'e1', level: 'error', userId: 'u1', message: '后台接口失败 1', createdAt: '2026-10-01T00:00:00.000Z' });
  insert.run({ id: 'e3', level: 'info', userId: null, message: '普通记录', createdAt: '2026-10-03T00:00:00.000Z' });
  assert.equal(backfillIssues({ batch: 1 }), 2);
  assert.equal(backfillIssues(), 0);
  const fingerprint = sql("SELECT fingerprint FROM system_events WHERE id = 'e1'").get().fingerprint;
  const issue = findIssue(fingerprint);
  assert.equal(issue.count, 2);
  assert.equal(issue.userCount, 2);
  assert.equal(issue.firstSeenAt, '2026-10-01T00:00:00.000Z');
  assert.equal(issue.lastSeenAt, '2026-10-02T00:00:00.000Z');
  assert.equal(sql("SELECT fingerprint FROM system_events WHERE id = 'e3'").get().fingerprint, null);
});

test('客户端主进程错误排队上报，连上服务后补发，崩溃立即发送', async () => {
  const { createMainErrorReporter, mainErrorReport } = await import('../desktop/error-reporter.mjs');
  const sent = [];
  let online = false;
  const reporter = createMainErrorReporter({ send: async body => { if (!online) return false; sent.push(body); return true; }, meta: () => ({ appVersion: '0.8.5', platform: 'win32' }), flushDelayMs: 5 });
  const printed = [];
  const fakeConsole = { error: (...args) => printed.push(args) };
  const fakeProcess = new EventEmitter();
  const uninstall = reporter.install({ consoleImpl: fakeConsole, processImpl: fakeProcess });
  fakeConsole.error('[desktop] 渲染进程退出', { reason: 'crashed', exitCode: 3 });
  fakeConsole.error('[desktop] 渲染进程退出', { reason: 'crashed', exitCode: 3 });
  fakeConsole.error('[update] 检查失败', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(printed.length, 3);
  assert.equal(reporter.pending(), 1);
  await reporter.flush();
  assert.equal(sent.length, 0);
  assert.equal(reporter.pending(), 1);
  online = true;
  fakeProcess.emit('uncaughtExceptionMonitor', new Error('main boom'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.flatMap(body => body.reports.map(report => [report.kind, report.message])), [
    ['main', "[desktop] 渲染进程退出 { reason: 'crashed', exitCode: 3 }"],
    ['crash', 'Error: main boom'],
  ]);
  assert.equal(sent[0].appVersion, '0.8.5');
  assert.equal(reporter.pending(), 0);
  uninstall();
  assert.equal(mainErrorReport([new Error('x')]).stack.startsWith('Error: x'), true);
  const [crash] = clientErrorEntries({ reports: [{ kind: 'crash', message: 'Error: main boom', stack: 'Error: main boom\n    at boot (file:///C:/app/resources/app.asar/desktop/main.mjs:1:1)' }] }, { source: 'desktop' });
  assert.deepEqual([crash.category, crash.level, crash.location], ['desktop.crash', 'critical', 'boot desktop/main.mjs']);
});

test('用户中途断开的请求不算服务端错误', () => {
  const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  assert.equal(isClientAbort(aborted), true);
  assert.equal(isClientAbort(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), false);
  assert.equal(isClientAbort(new Error('aborted')), false);
});
