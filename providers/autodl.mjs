export function createAutodlProvider({
  baseUrl,
  workflowId,
  apiKey,
  fetchJson,
  sleep,
  notifyVideoProgress,
  upstreamRequestErrorDetail,
  isDefinitiveSubmitRejection,
  errorMessage,
  videoPollTimeoutError,
  pollIntervalMs = 10_000,
  requestTimeoutMs = 60_000,
  maxPollDurationMs = 60 * 60_000,
  maxPolls = Math.ceil(maxPollDurationMs / pollIntervalMs),
} = {}) {
  for (const [name, dependency] of Object.entries({ baseUrl, workflowId, apiKey, fetchJson, sleep, notifyVideoProgress, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, errorMessage, videoPollTimeoutError })) {
    if (typeof dependency !== 'function' && !['baseUrl', 'workflowId', 'apiKey'].includes(name)) throw new TypeError(`AutoDL 适配器缺少 ${name} 依赖`);
  }

  function status(value) {
    return String(value?.data?.status || value?.status || '').trim().toLowerCase();
  }
  function taskId(value) {
    const candidate = value?.data?.task_id || value?.data?.taskId || value?.task_id || value?.taskId;
    return candidate === undefined || candidate === null ? '' : String(candidate);
  }
  function results(value) {
    return Array.isArray(value?.data?.results) ? value.data.results : Array.isArray(value?.results) ? value.results : [];
  }
  function videoUrl(value) {
    const result = results(value).find(item => item?.type === 'video' && typeof item.url === 'string' && item.url.trim())
      || results(value).find(item => typeof item?.url === 'string' && item.url.trim());
    return result?.url?.trim() || '';
  }
  function retryableResponseError(value) {
    const code = value?.code;
    const normalizedCode = code === undefined || code === null ? '' : String(code).trim().toLowerCase();
    if (!normalizedCode || normalizedCode === 'success' || value?.data != null) return null;
    const detail = errorMessage(value, 'AutoDL 返回业务错误');
    return Object.assign(new Error(detail), {
      upstreamCode: String(code),
      upstreamMessage: detail,
      retryableBusinessResponse: true,
    });
  }
  function payload(task, refs) {
    const groups = Array.isArray(refs) ? { images: refs, audios: [] } : (refs || { images: [], audios: [] });
    const value = {
      prompt: task.prompt,
      duration: task.duration,
      resolution: `${task.quality || '768p'}${task.aspectRatio === '9:16' ? '竖' : '横'}`,
    };
    groups.images?.slice(0, task.referenceLimits?.image || task.maxReferenceImages || 9).forEach((url, index) => { value[`ref_image_${index}`] = url; });
    groups.audios?.slice(0, task.referenceLimits?.audio || 3).forEach((url, index) => { value[`ref_audio_${index}`] = url; });
    return value;
  }

  async function pollVideo(providerTaskId, hooks = {}, runtime = {}) {
    const fetchState = runtime.fetchJson || fetchJson;
    const wait = runtime.sleep || sleep;
    const now = runtime.now || Date.now;
    const runtimeMaxPolls = Math.max(1, Number(runtime.maxPolls ?? maxPolls));
    const pollOnce = Boolean(runtime.pollOnce);
    const runtimeMaxDurationMs = Math.max(1, Number(runtime.maxDurationMs ?? maxPollDurationMs));
    const runtimePollIntervalMs = Math.max(0, Number(runtime.pollIntervalMs ?? pollIntervalMs));
    const startedAt = Number.isFinite(runtime.startedAt) ? runtime.startedAt : now();
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < runtimeMaxPolls; attempt++) {
      const remainingMs = runtimeMaxDurationMs - (now() - startedAt);
      if (remainingMs <= 0) break;
      const delay = consecutiveErrors
        ? Math.min(runtimePollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), 60_000)
        : runtimePollIntervalMs;
      if (!pollOnce) await wait(Math.min(delay, remainingMs));
      const requestRemainingMs = runtimeMaxDurationMs - (now() - startedAt);
      if (requestRemainingMs <= 0) break;
      let state;
      try {
        state = await fetchState(`${baseUrl}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(providerTaskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, requestRemainingMs))),
        });
        const businessError = retryableResponseError(state);
        if (businessError) throw businessError;
      } catch (error) {
        if (runtimeMaxDurationMs - (now() - startedAt) <= 0) break;
        if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: 'autodl', providerTaskId, upstreamTerminal: true });
        consecutiveErrors++;
        const detail = upstreamRequestErrorDetail(error);
        console.error('[video] AutoDL poll retryable failure; task remains active', { taskId: providerTaskId, consecutiveErrors, detail });
        try { await hooks.onPollError?.({ consecutiveErrors, detail }); }
        catch (saveError) { console.error('[video] AutoDL poll state persistence failed', { taskId: providerTaskId, message: saveError.message }); }
        if (pollOnce) return { pending: true, provider: 'autodl', taskId: providerTaskId };
        continue;
      }
      try { await hooks.onPollRecovered?.(); }
      catch (saveError) { console.error('[video] AutoDL recovery state persistence failed', { taskId: providerTaskId, message: saveError.message }); }
      consecutiveErrors = 0;
      await notifyVideoProgress(hooks, state);
      const resultUrl = videoUrl(state);
      const currentStatus = status(state);
      if (resultUrl) return { provider: 'autodl', taskId: providerTaskId, url: resultUrl };
      if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(currentStatus)) {
        throw Object.assign(new Error(state.msg || state.message || 'AutoDL 视频生成失败'), { provider: 'autodl', providerTaskId, upstreamTerminal: true });
      }
      if (pollOnce) return { pending: true, provider: 'autodl', taskId: providerTaskId };
    }
    if (pollOnce && runtimeMaxDurationMs - (now() - startedAt) > 0) return { pending: true, provider: 'autodl', taskId: providerTaskId };
    throw videoPollTimeoutError('AutoDL', providerTaskId);
  }

  async function createVideo(task, refs, hooks = {}, runtime = {}) {
    const submit = runtime.fetchJson || fetchJson;
    let providerTaskId = '';
    try {
      const created = await submit(`${baseUrl}/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(task, refs)),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      providerTaskId = taskId(created);
      if (!providerTaskId) throw Object.assign(new Error('AutoDL 已接受请求，但没有返回任务 ID，提交结果待核对'), { submissionUncertain: true });
      await hooks.onSubmitted?.({ provider: 'autodl', taskId: providerTaskId });
      const immediateUrl = videoUrl(created);
      if (immediateUrl) return { provider: 'autodl', taskId: providerTaskId, url: immediateUrl };
      if (hooks.deferPolling) return { pending: true, provider: 'autodl', taskId: providerTaskId };
      const persistedStartedAt = Date.parse(task.submittedAt || '');
      return pollVideo(providerTaskId, hooks, Number.isFinite(persistedStartedAt) ? { ...runtime, startedAt: persistedStartedAt } : runtime);
    } catch (error) {
      if (error.upstreamTerminal || error.submissionUncertain) throw error;
      if (!providerTaskId && isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: 'autodl', upstreamTerminal: true });
      if (providerTaskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: 'autodl', providerTaskId });
      throw Object.assign(new Error(`AutoDL 提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: 'autodl', submissionUncertain: true, cause: error });
    }
  }

  return { status, taskId, results, videoUrl, retryableResponseError, payload, pollVideo, createVideo };
}
