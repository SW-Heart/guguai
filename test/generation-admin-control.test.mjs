import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, closeDatabase, resetForTests, sql } from '../lib/db.mjs';
import { createModelRoute, ensureDefaultModelRoutes, listSwitchableModelRoutes, modelRoute, updateModelRoute } from '../lib/model-routes.mjs';
import { chargeGenerationMicro, grantSignupBonus, refundGenerationMicro, walletOf } from '../lib/ledger.mjs';
import { creditsToMicro } from '../lib/billing.mjs';
import { findGeneration, saveGenerationRecord } from '../lib/store.mjs';
import { claimGenerationJobs, enqueueGenerationJob, generationJobLeaseActive, revokeGenerationJobs } from '../repositories/generation-jobs.mjs';
import { createGenerationAdminControl } from '../services/generation-admin-control.mjs';
import { prepareGenerationRetry, refreshGenerationRetryRoute } from '../services/generation-retry.mjs';

const request = { logicalModelId:'seedance-2.5', quality:'1080p' };

test('administrators stop or move running jobs', async t => {
  const originalKey = process.env.DIW_KEY;
  let control, drained, current, next, paused;
  t.beforeEach(async () => {
    resetForTests();
    openDatabase({ file:':memory:' });
    process.env.DIW_KEY = 'test-key';
    ensureDefaultModelRoutes();
    const addRoute = (upstreamModelId, priority, durations = [30]) => createModelRoute({
      ...request, credentialId:'diw-main', upstreamModelId, priority, salePriceYuan:1, costYuan:1, durations,
    });
    current = addRoute('current-channel', 1);
    next = addRoute('next-channel', 2);
    paused = addRoute('paused-channel', 3);
    updateModelRoute(paused.id, { adminEnabled:false }, { actorUserId:null });
    addRoute('short-channel', 4, [5]);
    sql(`INSERT INTO users(id, username, password_hash, created_at, doc_json) VALUES('u', 'control-user', 'hash', 'now', '{}')`).run();
    await grantSignupBonus('u', 1000);
    await chargeGenerationMicro('u', 'g', 108000000);
    saveGenerationRecord('u', {
      id:'g', type:'video', modelId:request.logicalModelId, quality:request.quality, duration:30, aspectRatio:'9:16',
      status:'running', provider:current.provider, model:current.upstreamModelId, routeId:current.id, routeVersion:current.version,
      routePriority:current.priority, routeDisplayName:current.displayName, routeCredentialId:current.credentialId,
      providerTaskId:'upstream-1', createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z',
      creditCost:108, creditCostMicro:108000000, creditStatus:'charged',
    });
    drained = 0;
    control = createGenerationAdminControl({
      generationOwner:id => sql('SELECT user_id FROM generations WHERE id = :id').get({ id })?.user_id || '',
      findGeneration, saveGenerationRecord, revokeGenerationJobs, enqueueGenerationJob,
      drainGenerationJobs:() => { drained++; }, clearProviderTaskIdTimeout:() => {},
      refundGenerationMicro, creditsToMicro, listSwitchableModelRoutes, modelRoute,
      referenceCounts:() => ({}), relatedOutputs:(_, task) => [task], now:() => '2026-01-01T00:05:00Z',
    });
  });
  t.afterEach(() => {
    closeDatabase({ checkpoint:false });
    if (originalKey === undefined) delete process.env.DIW_KEY;
    else process.env.DIW_KEY = originalKey;
  });
  // A worker busy polling the job holds its lease.
  const busyWorker = () => {
    enqueueGenerationJob({ userId:'u', generationId:'g', kind:'poll' });
    const [job] = claimGenerationJobs({ owner:'worker', limit:1 });
    const guard = { id:job.id, owner:'worker', leaseToken:job.leaseToken };
    assert.equal(generationJobLeaseActive(guard), true);
    return guard;
  };

  await t.test('lists channels that can take the job, paused ones included and marked', () => {
    const { routes, task } = control.routeOptions('g');
    assert.equal(task.routeId, current.id);
    assert.deepEqual(routes.map(route => [route.id, route.state]), [[next.id, 'available'], [paused.id, 'disabled']]);
  });

  await t.test('moving a job revokes the busy worker and resubmits on the chosen channel without a new charge', () => {
    const worker = busyWorker();
    const result = control.switchRoute('g', paused.id, { actorUserId:'admin' });
    assert.equal(generationJobLeaseActive(worker), false, 'the old worker can no longer save');
    const task = findGeneration('u', 'g');
    assert.equal(task.status, 'queued');
    assert.equal(task.routeId, paused.id);
    assert.equal(task.providerTaskId, '');
    assert.equal(task.creditCostMicro, 108000000);
    assert.equal(task.generationAttempts.at(-1).routeId, current.id);
    assert.equal(task.generationAttempts.at(-1).error, '管理员切换线路');
    assert.equal(result.after.routeId, paused.id);
    assert.equal(sql("SELECT kind, state FROM generation_jobs WHERE generation_id = 'g'").all().map(row => `${row.kind}:${row.state}`).join(), 'generation:pending');
    assert.equal(drained, 1);
    assert.equal(walletOf('u').balance, 892);
    // The hand-picked channel is used even though it is switched off…
    assert.equal(refreshGenerationRetryRoute(task, { routeUsable:() => false, selectModelRoute:() => assert.fail('keeps the chosen channel') }).id, paused.id);
    // …but only once: a later automatic retry goes back to normal selection.
    assert.equal(prepareGenerationRetry(task, { upstreamTerminal:true }, '2026-01-01T00:06:00Z'), true);
    assert.equal(task.adminRouteId, undefined);
  });

  await t.test('rejects channels that cannot take the job', () => {
    const short = sql("SELECT id FROM model_routes WHERE upstream_model_id = 'short-channel'").get().id;
    for (const routeId of [short, current.id, 'missing']) {
      assert.throws(() => control.switchRoute('g', routeId), error => error.statusCode === 409);
    }
    assert.equal(findGeneration('u', 'g').routeId, current.id);
  });

  await t.test('stopping fails the job at once and refunds exactly once', async () => {
    const worker = busyWorker();
    const result = await control.stop('g', { actorUserId:'admin' });
    assert.equal(generationJobLeaseActive(worker), false);
    const task = findGeneration('u', 'g');
    assert.equal(task.status, 'failed');
    assert.equal(task.creditStatus, 'refunded');
    assert.equal(task.error, '任务已停止，积分已退回');
    assert.equal(result.after.status, 'failed');
    assert.equal(walletOf('u').balance, 1000);
    assert.equal(sql("SELECT COUNT(*) AS count FROM generation_jobs WHERE generation_id = 'g'").get().count, 0);
    assert.deepEqual(sql("SELECT type FROM credit_entries WHERE generation_id = 'g' ORDER BY created_at").all().map(row => row.type), ['generation_charge', 'generation_refund']);
    await assert.rejects(control.stop('g'), error => error.statusCode === 409);
    assert.throws(() => control.switchRoute('g', next.id), error => error.statusCode === 409);
    assert.equal(walletOf('u').balance, 1000);
  });

  await t.test('finished jobs, jobs delivering a result and unknown jobs cannot be controlled', async () => {
    const task = findGeneration('u', 'g');
    saveGenerationRecord('u', { ...task, status:'running', archivePending:true, sourceUrl:'https://result' });
    await assert.rejects(control.stop('g'), error => error.statusCode === 409);
    saveGenerationRecord('u', { ...task, status:'completed' });
    await assert.rejects(control.stop('g'), error => error.statusCode === 409);
    await assert.rejects(control.stop('missing'), error => error.statusCode === 404);
  });
});

test('log center offers controls only on running jobs, and channel moves only on routed videos', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const admin = await readFile(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
  const context = vm.createContext({ esc:String });
  vm.runInContext(admin.slice(admin.indexOf('  function generationControls('), admin.indexOf('  const userCell =')), context);
  const cell = item => context.generationActionsCell(item);
  const running = { id:'g', type:'video', status:'running', details:{ routeId:'r' } };
  assert.match(cell(running), /data-generation-switch="g"[^>]*>切换线路<\/button><button[^>]*data-generation-stop="g"[^>]*>停止<\/button>/);
  assert.doesNotMatch(cell({ ...running, details:{} }), /切换线路/);
  assert.match(cell({ ...running, type:'image', details:{} }), /停止/);
  for (const item of [{ ...running, status:'completed' }, { ...running, status:'failed' }, { ...running, type:'audio' }, { ...running, details:{ routeId:'r', archivePending:true } }]) {
    assert.doesNotMatch(cell(item), /<button/);
  }
});
