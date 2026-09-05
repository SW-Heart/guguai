export function createRoutedProvider({
  fetchJson,
  sleep,
  routeCredential,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  submitTimeoutMs = 180_000,
  notifyVideoProgress,
  upstreamRequestErrorDetail,
  isDefinitiveSubmitRejection,
  errorMessage,
} = {}) {
  for (const [name, dependency] of Object.entries({ fetchJson, sleep, routeCredential, videoPollRemainingMs, videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt, videoMaxPollDurationMs, notifyVideoProgress, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, errorMessage })) {
    if (typeof dependency !== 'function' && name !== 'videoMaxPollDurationMs') throw new TypeError(`动态线路适配器缺少 ${name} 依赖`);
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
  function payload(task, refs) {
    const groups = Array.isArray(refs) ? { images: refs, videos: [], audios: [] } : (refs || { images: [], videos: [], audios: [] });
    const limits = task.referenceLimits || {};
    const images = groups.images?.slice(0, limits.image || 0) || [];
    const videos = groups.videos?.slice(0, limits.video || 0) || [];
    const audios = groups.audios?.slice(0, limits.audio || 0) || [];
    if (task.routeAdapter === 'cntcn-video') return {
      model: task.model, prompt: task.prompt, seconds: task.duration,
      aspect_ratio: task.aspectRatio, resolution: task.quality,
      ...(images.length ? { reference_image_urls: images } : {}),
      ...(videos.length ? { reference_videos: videos } : {}),
      ...(audios.length ? { reference_audios: audios } : {}),
    };
    const value = {
      model: task.model,
      prompt: task.prompt,
      [task.routeAdapter === 'wj-video' ? 'seconds' : 'duration']: task.duration,
      aspect_ratio: task.aspectRatio,
    };
    if (task.routeAdapter === 'diw-video') value.resolution = task.quality;
    if (images.length) value.images = images;
    if (videos.length) value.videos = videos;
    if (audios.length) value.audios = audios;
    return value;
  }

  async function pollVideo(task, hooks = {}, { immediate = false, pollOnce = false } = {}) {
    const key = routeCredential(task.routeCredentialId);
    if (!key) throw Object.assign(new Error('任务原调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
    const base = String(task.routeBaseUrl || '').replace(/\/$/, '');
    let consecutiveErrors = 0;
    const pollStartedAt = videoPollStartedAt(task);
    for (;;) {
      const delay = consecutiveErrors ? Math.min(10_000 * 2 ** Math.min(consecutiveErrors, 3), 60_000) : 10_000;
      const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
      if (remainingMs <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
      if (!immediate) await sleep(Math.min(delay, remainingMs));
      if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
      let state;
      try {
        state = await fetchJson(`${base}/v1/videos/${encodeURIComponent(task.providerTaskId)}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: videoPollRequestSignal(task.provider, task.providerTaskId, pollStartedAt, videoMaxPollDurationMs, 60_000),
        });
      } catch (error) {
        if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
        if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: task.provider, providerTaskId: task.providerTaskId, upstreamTerminal: true });
        consecutiveErrors += 1;
        await hooks.onPollError?.({ consecutiveErrors, detail: upstreamRequestErrorDetail(error) });
        if (pollOnce) return { pending: true, provider: task.provider, taskId: task.providerTaskId };
        continue;
      }
      // A durable poll job starts with a fresh local error counter. Recovery
      // therefore has to be signalled on every successful response so a
      // persisted error from the previous poll job is cleared as well.
      await hooks.onPollRecovered?.();
      consecutiveErrors = 0;
      await notifyVideoProgress(hooks, state);
      const status = String(state.status || state.data?.status || '').trim().toLowerCase();
      const resultUrl = videoUrl(state);
      if (resultUrl) return { provider: task.provider, taskId: task.providerTaskId, url: new URL(resultUrl, `${base}/`).href, requiresAuth: /\/v1\/videos\/[^/]+\/content(?:$|\?)/.test(resultUrl) };
      if (['completed', 'succeeded', 'success', 'done'].includes(status)) return { provider: task.provider, taskId: task.providerTaskId, url: `${base}/v1/videos/${encodeURIComponent(task.providerTaskId)}/content`, requiresAuth: true };
      if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) throw Object.assign(new Error(errorMessage(state.error || state, '视频生成失败')), { provider: task.provider, providerTaskId: task.providerTaskId, upstreamTerminal: true });
      if (pollOnce) return { pending: true, provider: task.provider, taskId: task.providerTaskId };
    }
  }

  async function createVideo(task, refs, hooks = {}) {
    const key = routeCredential(task.routeCredentialId);
    if (!key) throw Object.assign(new Error('当前调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
    const base = String(task.routeBaseUrl || '').replace(/\/$/, '');
    let taskId = '';
    try {
      const created = await fetchJson(`${base}/v1/videos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(task, refs)),
        signal: AbortSignal.timeout(submitTimeoutMs),
      });
      taskId = taskIdFromResponse(created);
      if (!taskId) throw new Error('渠道已接受请求，但没有返回任务 ID');
      await hooks.onSubmitted?.({ provider: task.provider, taskId });
      task.providerTaskId = taskId;
      if (hooks.deferPolling) return { pending: true, provider: task.provider, taskId };
      return pollVideo(task, hooks);
    } catch (error) {
      if (error.upstreamTerminal) throw error;
      if (isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: task.provider, upstreamTerminal: true });
      if (taskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: task.provider, providerTaskId: taskId });
      throw Object.assign(new Error(`视频提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: task.provider, submissionUncertain: true, cause: error });
    }
  }

  function taskIdFromResponse(value) { return taskId(value); }
  return { payload, pollVideo, createVideo, videoUrl, taskId };
}
