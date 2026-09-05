export function createCntcnProvider({
  baseUrl,
  apiKey,
  fetchJson,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  pollIntervalMs = 5_000,
  requestTimeoutMs = 60_000,
  notifyVideoProgress,
  upstreamRequestErrorDetail,
  isDefinitiveSubmitRejection,
  errorMessage,
  buildVideoPayload,
} = {}) {
  for (const [name, dependency] of Object.entries({ baseUrl, apiKey, fetchJson, sleep, videoPollRemainingMs, videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt, videoMaxPollDurationMs, notifyVideoProgress, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, errorMessage, buildVideoPayload })) {
    if (typeof dependency !== 'function' && !['baseUrl', 'apiKey', 'videoMaxPollDurationMs'].includes(name)) throw new TypeError(`CNTCN 适配器缺少 ${name} 依赖`);
  }

  function videoUrl(value) {
    const candidates = [value?.video_url, value?.url, value?.download_url, value?.original_video_url, value?.data?.video_url, value?.data?.url, value?.data?.download_url, value?.data?.original_video_url];
    const candidate = candidates.find(item => typeof item === 'string' && item.trim());
    return candidate ? candidate.trim() : '';
  }
  function taskId(value) {
    const candidate = value?.task_id || value?.taskId || value?.id || value?.data?.task_id || value?.data?.taskId || value?.data?.id;
    return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
  }
  function status(value) { return String(value?.status || value?.data?.status || value?.data?.status_code || '').trim().toLowerCase(); }
  function errorText(value) { return errorMessage(value?.error || value?.error_message || value?.api_error || value, 'CNTCN 视频生成失败'); }

  async function pollVideo(providerTaskId, hooks = {}, pollStartedAt = Date.now(), { immediate = false, pollOnce = false } = {}) {
    let consecutiveErrors = 0;
    for (;;) {
      const delay = consecutiveErrors ? Math.min(pollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), 60_000) : pollIntervalMs;
      const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
      if (remainingMs <= 0) throw videoPollTimeoutError('CNTCN', providerTaskId);
      if (!immediate) await sleep(Math.min(delay, remainingMs));
      if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('CNTCN', providerTaskId);
      let value;
      try {
        value = await fetchJson(`${baseUrl}/videos/${encodeURIComponent(providerTaskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: videoPollRequestSignal('CNTCN', providerTaskId, pollStartedAt, videoMaxPollDurationMs, requestTimeoutMs),
        });
      } catch (error) {
        if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('CNTCN', providerTaskId);
        if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: 'cntcn', providerTaskId, upstreamTerminal: true });
        consecutiveErrors += 1;
        const detail = upstreamRequestErrorDetail(error);
        console.error('[video] CNTCN poll transport failure; task remains active', { taskId: providerTaskId, consecutiveErrors, detail });
        try { await hooks.onPollError?.({ consecutiveErrors, detail }); }
        catch (saveError) { console.error('[video] CNTCN poll state persistence failed', { taskId: providerTaskId, message: saveError.message }); }
        if (pollOnce) return { pending: true, provider: 'cntcn', taskId: providerTaskId };
        continue;
      }
      try { await hooks.onPollRecovered?.(); }
      catch (saveError) { console.error('[video] CNTCN recovery state persistence failed', { taskId: providerTaskId, message: saveError.message }); }
      consecutiveErrors = 0;
      await notifyVideoProgress(hooks, value);
      const resultUrl = videoUrl(value);
      if (resultUrl) return { provider: 'cntcn', taskId: providerTaskId, url: resultUrl };
      if (['failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status(value))) throw Object.assign(new Error(errorText(value)), { provider: 'cntcn', providerTaskId, upstreamTerminal: true });
      if (pollOnce) return { pending: true, provider: 'cntcn', taskId: providerTaskId };
    }
  }

  async function createVideo(task, refs, hooks = {}) {
    let providerTaskId = '';
    try {
      const created = await fetchJson(`${baseUrl}/videos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildVideoPayload(task, refs)),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      providerTaskId = taskId(created);
      if (!providerTaskId) throw new Error('CNTCN 已接受请求，但没有返回任务 ID，提交结果待核对');
      await hooks.onSubmitted?.({ provider: 'cntcn', taskId: providerTaskId });
      if (hooks.deferPolling) return { pending: true, provider: 'cntcn', taskId: providerTaskId };
      return pollVideo(providerTaskId, hooks, videoPollStartedAt(task));
    } catch (error) {
      if (error.upstreamTerminal) throw error;
      if (isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: 'cntcn', upstreamTerminal: true });
      if (providerTaskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: 'cntcn', providerTaskId });
      throw Object.assign(new Error(`CNTCN 提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: 'cntcn', submissionUncertain: true, cause: error });
    }
  }

  return { pollVideo, createVideo, videoUrl, taskId, status, errorText };
}
