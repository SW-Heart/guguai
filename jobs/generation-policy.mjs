export function createGenerationJobPolicy({
  imagePollIntervalMs,
  oaiPollIntervalMs,
  autodlPollIntervalMs,
  ttapiPollIntervalMs,
  cntcnPollIntervalMs,
  duomiPollIntervalMs = 8_000,
  defaultPollIntervalMs,
  recoverySweepMs,
  archiveRescheduleMs,
  providerTaskIdDeadline,
} = {}) {
  const dependencies = { imagePollIntervalMs, oaiPollIntervalMs, autodlPollIntervalMs, ttapiPollIntervalMs, cntcnPollIntervalMs, duomiPollIntervalMs, defaultPollIntervalMs, recoverySweepMs, archiveRescheduleMs, providerTaskIdDeadline };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== 'function' && !['imagePollIntervalMs', 'oaiPollIntervalMs', 'autodlPollIntervalMs', 'ttapiPollIntervalMs', 'cntcnPollIntervalMs', 'duomiPollIntervalMs', 'defaultPollIntervalMs', 'recoverySweepMs', 'archiveRescheduleMs'].includes(name)) throw new TypeError(`生成任务策略缺少 ${name} 依赖`);
  }

  function pollInterval(task) {
    if (task?.type === 'image' && task.provider === 'duomi') return imagePollIntervalMs;
    if (task?.provider === 'oai') return oaiPollIntervalMs;
    if (task?.provider === 'autodl') return autodlPollIntervalMs;
    if (task?.provider === 'ttapi') return ttapiPollIntervalMs;
    if (task?.provider === 'cntcn' || task?.routeId) return task?.routeId ? 10_000 : cntcnPollIntervalMs;
    if (task?.provider === 'duomi') return duomiPollIntervalMs;
    return defaultPollIntervalMs;
  }
  function nextRunAt(task, kind, at = Date.now()) {
    if (kind === 'reconcile_submission') return providerTaskIdDeadline(task);
    if (kind === 'archive') {
      const failures = Math.max(0, Number(task?.archiveFailureCount) || 0);
      if (!failures) {
        const deadline = Date.parse(task?.localDeliveryDeadlineAt || '');
        return Math.max(at, Number.isFinite(deadline) ? deadline : at);
      }
      return at + Math.min(archiveRescheduleMs * 2 ** Math.min(failures - 1, 4), 60 * 60_000);
    }
    if (kind === 'poll') {
      const failures = Math.max(0, Number(task?.pollFailureCount) || 0);
      return at + Math.min(pollInterval(task) * 2 ** Math.min(failures, 3), 60_000);
    }
    return at + recoverySweepMs;
  }
  function recoveryKind(task) {
    if (task?.archivePending) return 'archive';
    if (task?.submissionUncertain && !task?.providerTaskId) return 'reconcile_submission';
    if (task?.providerTaskId) return 'poll';
    return 'generation';
  }
  return { pollInterval, nextRunAt, recoveryKind };
}
