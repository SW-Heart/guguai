export function createTuziProvider({
  baseUrl,
  apiKey,
  fetchJson,
  trackProviderSubmission,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  imageMaxPollDurationMs,
  errorMessage,
  upstreamRequestErrorDetail,
} = {}) {
  const dependencies = {
    baseUrl, apiKey, fetchJson, trackProviderSubmission, sleep, videoPollRemainingMs,
    videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt,
    imageMaxPollDurationMs, errorMessage, upstreamRequestErrorDetail,
  };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== 'function' && !['baseUrl', 'apiKey', 'imageMaxPollDurationMs'].includes(name)) {
      throw new TypeError(`Tuzi 适配器缺少 ${name} 依赖`);
    }
  }

  const authorization = () => `Bearer ${String(apiKey || '').trim()}`;

  async function pollImage(taskId, hooks = {}, pollStartedAt = Date.now(), { immediate = false, allowExpiredFinalCheck = false, pollOnce = false } = {}) {
    let consecutiveErrors = 0;
    let firstRequest = true;
    for (;;) {
      let remainingMs = videoPollRemainingMs(pollStartedAt, imageMaxPollDurationMs);
      if (remainingMs <= 0 && !(firstRequest && allowExpiredFinalCheck)) throw videoPollTimeoutError('图片', taskId);
      if (!(firstRequest && immediate)) {
        await sleep(Math.min(6_000, Math.max(1, remainingMs)));
        remainingMs = videoPollRemainingMs(pollStartedAt, imageMaxPollDurationMs);
      }
      firstRequest = false;
      let state;
      try {
        state = await fetchJson(`${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: authorization() },
          signal: remainingMs > 0
            ? videoPollRequestSignal('图片', taskId, pollStartedAt, imageMaxPollDurationMs, 60_000)
            : AbortSignal.timeout(60_000),
        });
        consecutiveErrors = 0;
        await hooks.onPollRecovered?.();
      } catch (error) {
        if ([401, 403].includes(Number(error.upstreamStatus))) {
          throw Object.assign(error, { provider:'tuzi', providerTaskId:taskId, upstreamTerminal:true });
        }
        if (videoPollRemainingMs(pollStartedAt, imageMaxPollDurationMs) <= 0) throw videoPollTimeoutError('图片', taskId);
        consecutiveErrors += 1;
        await hooks.onPollError?.({ consecutiveErrors, detail:upstreamRequestErrorDetail(error) });
        console.error('[image] Tuzi poll transport failure; task remains active', { taskId, consecutiveErrors, detail:upstreamRequestErrorDetail(error) });
        if (pollOnce) return { pending:true, provider:'tuzi', taskId };
        continue;
      }
      await hooks.onProgress?.({ progress:Number(state.progress) || 0 });
      const status = String(state.status || '').toLowerCase();
      if (['succeeded', 'completed', 'success', 'done'].includes(status)) {
        const url = state.video_url || state.image_url || state.url;
        if (!url) throw Object.assign(new Error('Tuzi 图片任务已完成，但没有返回结果地址'), { provider:'tuzi', providerTaskId:taskId, upstreamTerminal:true });
        return { provider:'tuzi', taskId, url };
      }
      if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) {
        throw Object.assign(new Error(errorMessage(state.message || state.error || state, 'Tuzi 图片生成失败')), { provider:'tuzi', providerTaskId:taskId, upstreamTerminal:true });
      }
      if (pollOnce) return { pending:true, provider:'tuzi', taskId };
    }
  }

  async function createImage(task, refs, hooks = {}) {
    const form = new FormData();
    form.append('model', task.model || 'gpt-image-2.5');
    form.append('prompt', task.prompt);
    if (task.size) form.append('size', task.size);
    for (const reference of refs) form.append('input_reference', reference);
    const submission = await trackProviderSubmission((async () => {
      const created = await fetchJson(`${baseUrl}/v1/videos`, {
        method:'POST',
        headers:{ Authorization:authorization() },
        body:form,
        signal:AbortSignal.timeout(180_000),
      });
      const taskId = created.id || created.task_id;
      if (!taskId) throw new Error('Tuzi 图片任务没有返回任务 ID');
      await hooks.onSubmitted?.({ provider:'tuzi', taskId:String(taskId) });
      if (hooks.deferPolling) return { pending:true, provider:'tuzi', taskId:String(taskId) };
      return String(taskId);
    })());
    if (submission?.pending) return submission;
    return pollImage(submission, hooks, videoPollStartedAt(task));
  }

  return { createImage, pollImage };
}
