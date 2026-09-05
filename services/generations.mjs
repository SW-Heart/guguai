export function createGenerationLifecycleService({
  now = () => new Date().toISOString(),
  saveGenerationWithRetry,
  providerTaskIdDeadline,
} = {}) {
  for (const [name, dependency] of Object.entries({ now, saveGenerationWithRetry, providerTaskIdDeadline })) {
    if (typeof dependency !== 'function') throw new TypeError(`生成生命周期服务缺少 ${name} 依赖`);
  }

  function markRunning(task) {
    task.status = 'running';
    task.finishedAt = null;
    return task;
  }
  function markSubmissionUncertain(task, error) {
    markRunning(task);
    task.submissionUncertain = true;
    task.submissionUncertainAt ||= now();
    task.lastSubmissionError = error.message;
    task.lastSubmissionErrorAt = now();
    task.error = error.message;
    task.creditStatus = 'charged';
    return task;
  }
  function markProviderTaskPaused(task, error) {
    markRunning(task);
    task.error = `任务处理暂时中断，将由持久化任务恢复：${error.message}`;
    task.creditStatus = 'charged';
    return task;
  }
  function markFinished(task) {
    task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
    return task;
  }
  function markSubmissionTimedOut(task) {
    task.lastSubmissionError ||= task.error || '';
    task.lastSubmissionErrorAt ||= task.submissionUncertainAt || task.updatedAt || now();
    task.submissionUncertain = false;
    task.submissionTimedOut = true;
    return task;
  }
  function isSubmissionTimedOut(task, at = Date.now()) {
    return ['queued', 'running'].includes(task?.status)
      && !task?.providerTaskId
      && !task?.sourceUrl
      && Boolean(task?.submissionUncertain)
      && at >= providerTaskIdDeadline(task);
  }
  async function persist(userId, task, phase) {
    return saveGenerationWithRetry(userId, task, phase);
  }
  return { markRunning, markSubmissionUncertain, markProviderTaskPaused, markFinished, markSubmissionTimedOut, isSubmissionTimedOut, persist };
}
