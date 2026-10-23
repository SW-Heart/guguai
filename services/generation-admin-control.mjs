import { applyGenerationRoute } from './generation-retry.mjs';

// Lets an administrator stop a running job or move it to another channel.
// Every step runs synchronously, so no worker can interleave a write: the
// job's queue entries are revoked first, which makes a worker still busy with
// it lose its lease and drop whatever it would have saved afterwards.
export function createGenerationAdminControl(deps) {
  for (const name of ['generationOwner', 'findGeneration', 'saveGenerationRecord', 'revokeGenerationJobs', 'enqueueGenerationJob', 'drainGenerationJobs', 'clearProviderTaskIdTimeout', 'refundGenerationMicro', 'creditsToMicro', 'listSwitchableModelRoutes', 'modelRoute', 'referenceCounts', 'relatedOutputs', 'now']) {
    if (typeof deps?.[name] !== 'function') throw new TypeError(`任务管理缺少 ${name} 依赖`);
  }
  const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

  function load(generationId) {
    const userId = deps.generationOwner(generationId);
    const task = userId && deps.findGeneration(userId, generationId);
    if (!task) throw fail(404, '任务不存在');
    return { userId, task };
  }

  function stoppable(task) {
    return ['queued', 'running'].includes(task.status) && ['image', 'video'].includes(task.type)
      && !task.archivePending && !task.sourceUrl && !(Number(task.midjourneyOutputIndex) > 0);
  }
  const switchable = task => stoppable(task) && task.type === 'video' && Boolean(task.routeId);

  function routeRequest(userId, task) {
    return {
      logicalModelId: task.videoModelId || task.modelId,
      quality: task.quality,
      duration: task.duration,
      aspectRatio: task.aspectRatio,
      referenceCounts: deps.referenceCounts(userId, task),
      excludeRouteId: task.routeId,
    };
  }

  function summary(task) {
    return {
      id: task.id, status: task.status, routeId: task.routeId || '', routeDisplayName: task.routeDisplayName || '',
      providerTaskId: task.providerTaskId || '', creditStatus: task.creditStatus || '', error: task.error || '',
      generationRetryCount: Number(task.generationRetryCount) || 0,
    };
  }

  function routeOptions(generationId) {
    const { userId, task } = load(generationId);
    if (!switchable(task)) throw fail(409, '该任务当前不能切换线路');
    return { task: summary(task), routes: deps.listSwitchableModelRoutes(routeRequest(userId, task)) };
  }

  async function stop(generationId, { actorUserId } = {}) {
    let { userId, task } = load(generationId);
    if (!stoppable(task)) throw fail(409, '该任务已结束或正在交付结果，不能停止');
    const before = summary(task);
    deps.revokeGenerationJobs(task.id);
    deps.clearProviderTaskIdTimeout(task.id);
    // Re-read after revoking so the latest saved state is the one we finish.
    task = deps.findGeneration(userId, generationId);
    const at = deps.now();
    const message = '任务已停止，积分已退回';
    const refundDue = task.creditStatus !== 'refunded' && task.creditStatus !== 'included';
    // Saved as an outstanding refund first: if the process stops before the
    // refund lands, recovery finishes it.
    Object.assign(task, { status: 'failed', error: message, finishedAt: at, progress: null, adminStoppedBy: actorUserId || '', adminStoppedAt: at, ...(refundDue ? { creditStatus: 'refund_failed' } : {}) });
    for (const output of deps.relatedOutputs(userId, task)) {
      if (output.id === task.id || output.status === 'failed') continue;
      Object.assign(output, { status: 'failed', error: message, finishedAt: at, creditStatus: 'included' });
      deps.revokeGenerationJobs(output.id);
      deps.saveGenerationRecord(userId, output);
    }
    deps.saveGenerationRecord(userId, task);
    if (refundDue) {
      try {
        await deps.refundGenerationMicro(userId, task.id, task.creditCostMicro ?? deps.creditsToMicro(task.creditCost), { note: '任务已停止，积分退回' });
        task.creditStatus = 'refunded';
      } catch (refundError) {
        task.error = '任务已停止，积分退回处理中';
        task.adminRefundError = refundError.message;
        deps.enqueueGenerationJob({ userId, generationId: task.id, kind: 'refund_reconcile', nextRunAt: Date.now() });
      }
      deps.saveGenerationRecord(userId, task);
    }
    return { userId, before, after: summary(task) };
  }

  function switchRoute(generationId, routeId, { actorUserId } = {}) {
    let { userId, task } = load(generationId);
    if (!switchable(task)) throw fail(409, '该任务当前不能切换线路');
    const target = String(routeId || '');
    if (!deps.listSwitchableModelRoutes(routeRequest(userId, task)).some(item => item.id === target)) throw fail(409, '所选线路不能处理这个任务，请刷新后重新选择');
    const route = deps.modelRoute(target);
    if (!route) throw fail(404, '线路不存在');
    const before = summary(task);
    deps.revokeGenerationJobs(task.id);
    deps.clearProviderTaskIdTimeout(task.id);
    task = deps.findGeneration(userId, generationId);
    const at = deps.now();
    task.generationAttempts = [...(task.generationAttempts || []), {
      attempt: (Number(task.generationRetryCount) || 0) + 1,
      providerTaskId: task.providerTaskId || '',
      startedAt: task.attemptStartedAt || task.createdAt,
      finishedAt: at,
      error: '管理员切换线路',
      adminSwitchedBy: actorUserId || '',
      routeId: task.routeId, routeVersion: task.routeVersion, routePriority: task.routePriority, routeDisplayName: task.routeDisplayName,
      provider: task.provider, model: task.model,
    }];
    task.generationRetryCount = (Number(task.generationRetryCount) || 0) + 1;
    applyGenerationRoute(task, route);
    Object.assign(task, {
      adminRouteId: route.id,
      status: 'queued', attemptStartedAt: at, providerTaskId: '', submittedAt: null,
      finishedAt: null, error: '', submissionUncertain: false, submissionUncertainAt: null,
      submissionTimedOut: false, lastSubmissionError: '', lastSubmissionErrorAt: null,
      lastPollError: '', lastPollErrorAt: null, pollFailureCount: 0, progress: null,
    });
    deps.saveGenerationRecord(userId, task);
    deps.enqueueGenerationJob({ userId, generationId: task.id, kind: 'generation', nextRunAt: Date.now() });
    deps.drainGenerationJobs();
    return { userId, before, after: summary(task) };
  }

  return { routeOptions, stop, switchRoute, stoppable, switchable };
}
