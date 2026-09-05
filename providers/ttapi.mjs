export function createTtapiProvider({
  baseUrl,
  apiKey,
  fetchJson,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  pollIntervalMs = 8_000,
  maxBackoffMs = 60_000,
  requestTimeoutMs = 60_000,
  notifyVideoProgress,
  upstreamRequestErrorDetail,
  isDefinitiveSubmitRejection,
  errorMessage,
} = {}) {
  for (const [name, dependency] of Object.entries({ baseUrl, apiKey, fetchJson, sleep, videoPollRemainingMs, videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt, videoMaxPollDurationMs, notifyVideoProgress, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, errorMessage })) {
    if (typeof dependency !== 'function' && !['baseUrl', 'apiKey', 'videoMaxPollDurationMs'].includes(name)) throw new TypeError(`TTAPI 适配器缺少 ${name} 依赖`);
  }

  async function pollVideo(taskId, hooks = {}, pollStartedAt = Date.now(), { immediate = false, pollOnce = false } = {}) {
    let consecutiveErrors = 0;
    for (;;) {
      const delay = consecutiveErrors
        ? Math.min(pollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), maxBackoffMs)
        : pollIntervalMs;
      const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
      if (remainingMs <= 0) throw videoPollTimeoutError('TTAPI', taskId);
      if (!immediate) await sleep(Math.min(delay, remainingMs));
      if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('TTAPI', taskId);
      let state;
      try {
        state = await fetchJson(`${baseUrl}/grok/fetch?jobId=${encodeURIComponent(taskId)}`, {
          headers: { 'TT-API-KEY': apiKey },
          signal: videoPollRequestSignal('TTAPI', taskId, pollStartedAt, videoMaxPollDurationMs, requestTimeoutMs),
        });
      } catch (error) {
        if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('TTAPI', taskId);
        if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: 'ttapi', providerTaskId: taskId, upstreamTerminal: true });
        consecutiveErrors += 1;
        const detail = upstreamRequestErrorDetail(error);
        console.error('[video] TTAPI poll transport failure; task remains active', { taskId, consecutiveErrors, detail });
        try { await hooks.onPollError?.({ consecutiveErrors, detail }); }
        catch (saveError) { console.error('[video] TTAPI poll state persistence failed', { taskId, message: saveError.message }); }
        if (pollOnce) return { pending: true, provider: 'ttapi', taskId };
        continue;
      }
      try { await hooks.onPollRecovered?.(); }
      catch (saveError) { console.error('[video] TTAPI recovery state persistence failed', { taskId, message: saveError.message }); }
      consecutiveErrors = 0;
      await notifyVideoProgress(hooks, state);
      const videoUrl = state.data?.videoUrl;
      if (videoUrl) return { provider: 'ttapi', taskId, url: videoUrl };
      const status = String(state.status || state.data?.status || '').toUpperCase();
      if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) {
        throw Object.assign(new Error(errorMessage(state, 'TTAPI 视频生成失败')), { provider: 'ttapi', providerTaskId: taskId, upstreamTerminal: true });
      }
      if (pollOnce) return { pending: true, provider: 'ttapi', taskId };
    }
  }

  async function createVideo(task, refs, hooks = {}) {
    const payload = { prompt: task.prompt, model: task.model, aspect_ratio: task.aspectRatio, video_length: String(task.duration), resolution_name: task.quality || '720p' };
    if (refs.length) payload.refer_images = refs.slice(0, task.maxReferenceImages || 7);
    let created;
    try {
      created = await fetchJson(`${baseUrl}/grok/generations`, {
        method: 'POST',
        headers: { 'TT-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: 'ttapi', upstreamTerminal: true });
      throw Object.assign(new Error(`TTAPI 提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: 'ttapi', submissionUncertain: true, cause: error });
    }
    const taskId = created.data?.jobId || created.jobId;
    if (!taskId) throw Object.assign(new Error('TTAPI 已接受请求，但没有返回任务 ID，提交结果待核对'), { provider: 'ttapi', submissionUncertain: true });
    await hooks.onSubmitted?.({ provider: 'ttapi', taskId: String(taskId) });
    if (hooks.deferPolling) return { pending: true, provider: 'ttapi', taskId: String(taskId) };
    return pollVideo(String(taskId), hooks, videoPollStartedAt(task));
  }

  return { pollVideo, createVideo };
}
