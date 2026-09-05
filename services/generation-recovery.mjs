export function createGenerationRecoveryService({
  activeGenerations,
  now,
  saveGeneration,
  saveGenerationWithRetry,
  completeGenerationResult,
  failGeneration,
} = {}) {
  for (const [name, dependency] of Object.entries({ activeGenerations, now, saveGeneration, saveGenerationWithRetry, completeGenerationResult, failGeneration })) {
    if (!dependency || (typeof dependency !== 'function' && name !== 'activeGenerations')) throw new TypeError(`生成恢复服务缺少 ${name} 依赖`);
  }

  function resume(userId, task, {
    pollOnce = false,
    startPhase,
    finalPhase,
    poll,
    useRetryForStart = false,
    missingUrlMessage = '',
    pauseMessage = error => `任务恢复暂时中断，将在服务重启后继续：${error.message}`,
    logScope = 'video',
    logContext = () => ({}),
  } = {}) {
    if (typeof poll !== 'function') throw new TypeError('生成恢复服务缺少 poll 配置');
    if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
    const promise = (async () => {
      try {
        task.status = 'running';
        task.finishedAt = null;
        task.error = '';
        if (useRetryForStart) await saveGenerationWithRetry(userId, task, startPhase);
        else await saveGeneration(userId, task);
        const result = await poll({ pollOnce });
        if (result?.pending) return;
        if (missingUrlMessage && !result?.url) throw Object.assign(new Error(missingUrlMessage), { upstreamTerminal: true });
        await completeGenerationResult(userId, task, result);
      } catch (error) {
        if (error.upstreamTerminal) await failGeneration(userId, task, error);
        else {
          task.status = 'running';
          task.error = pauseMessage(error);
          task.creditStatus = 'charged';
          console.error(`[${logScope}] recovery paused without refund`, { generationId: task.id, ...logContext(), message: error.message });
        }
      } finally {
        task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
        try { await saveGenerationWithRetry(userId, task, finalPhase); }
        finally { activeGenerations.delete(task.id); }
      }
    })();
    activeGenerations.set(task.id, promise);
    return promise;
  }

  return Object.freeze({ resume });
}
