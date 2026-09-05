export function createOaiProvider({
  baseUrl,
  keys = {},
  fetchJson,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  buildVideoPayload,
  videoModelIds,
  legacyVideoModelIds,
  pollIntervalMs = 4_000,
  requestTimeoutMs = 300_000,
  maxPollDurationMs = 60 * 60_000,
  maxPolls = Math.ceil(maxPollDurationMs / pollIntervalMs),
  errorMessage,
} = {}) {
  for (const [name, dependency] of Object.entries({ baseUrl, fetchJson, sleep, videoPollRemainingMs, videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt, buildVideoPayload, videoModelIds, legacyVideoModelIds, errorMessage })) {
    if (typeof dependency !== 'function' && !['baseUrl', 'videoModelIds', 'legacyVideoModelIds'].includes(name)) throw new TypeError(`OAI 适配器缺少 ${name} 依赖`);
  }

  function videoUrl(value) {
    const candidate = value?.data?.[0]?.video_url || value?.data?.[0]?.url || value?.data?.video_url || value?.data?.url || value?.video_url || value?.videoUrl || value?.output?.url || value?.result?.url || value?.url;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '';
  }
  function taskId(value) {
    const candidate = value?.task_id || value?.taskId || value?.id || value?.data?.task_id || value?.data?.taskId || value?.data?.id || value?.data?.[0]?.task_id || value?.data?.[0]?.taskId || value?.data?.[0]?.id;
    return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
  }
  function status(value) {
    return String(value?.status || value?.state || value?.data?.status || value?.data?.state || value?.data?.[0]?.status || value?.data?.[0]?.state || '').trim().toUpperCase();
  }
  function isLegacyGrokTask(task) {
    return task?.provider === 'oai' && [legacyVideoModelIds.GUGU_2, legacyVideoModelIds.GROK_VIDEO_1_5].includes(task?.videoModelId);
  }
  function keyForTask(task) {
    if (isLegacyGrokTask(task)) return keys.grok;
    if (task.videoModelId === videoModelIds.VEO_31) return keys.veo;
    if (task.videoModelId === videoModelIds.MINIMAX_H3) return keys.minimax;
    return keys.gemini;
  }
  function veo31Size(task) {
    const sizeByAspect = {
      '16:9': { '720p': '1280x720', '1080p': '1920x1080' },
      '9:16': { '720p': '720x1280', '1080p': '1080x1920' },
    };
    return sizeByAspect[task.aspectRatio]?.[task.quality || '720p'] || '1280x720';
  }
  function payload(task, refs) {
    if (task.videoModelId === videoModelIds.MINIMAX_H3) return buildVideoPayload(task, refs);
    if (task.videoModelId === videoModelIds.VEO_31) {
      const value = {
        model: task.model,
        prompt: task.prompt,
        seconds: String(task.duration),
        size: veo31Size(task),
        generation_type: task.generationType || (refs.length ? 'REFERENCE' : 'TEXT'),
      };
      if (task.generationType === 'FIRST&LAST') {
        if (refs[0]) value.first_image_url = refs[0];
        if (refs[1]) value.last_image_url = refs[1];
      } else if (task.generationType === 'REFERENCE') {
        if (refs.length === 1) value.image_url = refs[0];
        else if (refs.length > 1) value.images = refs.slice(0, task.maxReferenceImages || 3);
      }
      return value;
    }
    const legacy = isLegacyGrokTask(task);
    const value = { model: task.model, prompt: task.prompt, aspect_ratio: task.aspectRatio, seconds: legacy ? String(task.duration) : task.duration };
    if (legacy) {
      value.resolution = task.quality || '720p';
      if (refs[0]) value.image = refs[0];
    } else if (task.generationType === 'FIRST&LAST') {
      if (refs[0]) value.first_image_url = refs[0];
      if (refs[1]) value.last_image_url = refs[1];
    } else if (refs.length === 1) {
      value.image_url = refs[0];
    } else if (refs.length > 1) {
      value.images = refs.slice(0, task.maxReferenceImages || 5);
    }
    return value;
  }
  function request(task, refs, apiKey = keyForTask(task)) {
    return {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(task, refs)),
    };
  }

  async function pollVideo(task, hooks = {}, { immediate = false, allowExpiredFinalCheck = false, pollOnce = false } = {}) {
    const providerTaskId = String(task.providerTaskId || '');
    const apiKey = keyForTask(task);
    const startedAt = videoPollStartedAt(task);
    let firstRequest = true;
    let consecutiveErrors = 0;
    for (let poll = 0; poll < maxPolls; poll++) {
      let remainingMs = videoPollRemainingMs(startedAt, maxPollDurationMs);
      if (remainingMs <= 0 && !(firstRequest && allowExpiredFinalCheck)) throw videoPollTimeoutError('OAI', providerTaskId);
      if (!(firstRequest && immediate)) {
        await sleep(Math.min(pollIntervalMs, Math.max(1, remainingMs)));
        remainingMs = videoPollRemainingMs(startedAt, maxPollDurationMs);
      }
      firstRequest = false;
      let state;
      try {
        state = await fetchJson(`${baseUrl}/videos/${encodeURIComponent(providerTaskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: remainingMs > 0
            ? videoPollRequestSignal('OAI', providerTaskId, startedAt, maxPollDurationMs, requestTimeoutMs)
            : AbortSignal.timeout(requestTimeoutMs),
        });
        // Poll jobs are durable and may resume in a new invocation with a
        // reset local error counter. Always notify recovery on success so a
        // persisted error flag cannot outlive the successful poll.
        await hooks.onPollRecovered?.();
        consecutiveErrors = 0;
      } catch (error) {
        if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: 'oai', providerTaskId, upstreamTerminal: true });
        if (videoPollRemainingMs(startedAt, maxPollDurationMs) <= 0) throw videoPollTimeoutError('OAI', providerTaskId);
        consecutiveErrors += 1;
        await hooks.onPollError?.({ consecutiveErrors, detail: error.message });
        if (pollOnce) return { pending: true, provider: 'oai', taskId: providerTaskId };
        continue;
      }
      const resultUrl = videoUrl(state);
      const currentStatus = status(state);
      if (resultUrl) return { provider: 'oai', taskId: providerTaskId, url: resultUrl, requiresAuth: /\/videos\/[^/]+\/content(?:$|\?)/.test(resultUrl) };
      if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'COMPLETE', 'DONE'].includes(currentStatus)) {
        if (task.videoModelId === videoModelIds.VEO_31) throw Object.assign(new Error('Veo 3.1 任务已完成，但响应没有返回顶层 video_url'), { provider: 'oai', providerTaskId, upstreamTerminal: true });
        if (task.videoModelId === videoModelIds.MINIMAX_H3) throw Object.assign(new Error('MiniMax H3 任务已完成，但响应没有返回 video_url'), { provider: 'oai', providerTaskId, upstreamTerminal: true });
        return { provider: 'oai', taskId: providerTaskId, url: `${baseUrl}/videos/${encodeURIComponent(providerTaskId)}/content`, requiresAuth: true };
      }
      if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(currentStatus)) {
        throw Object.assign(new Error(errorMessage(state, 'OAI 视频生成失败')), { provider: 'oai', providerTaskId, upstreamTerminal: true });
      }
      if (pollOnce) {
        if (videoPollRemainingMs(startedAt, maxPollDurationMs) <= 0) throw videoPollTimeoutError('OAI', providerTaskId);
        return { pending: true, provider: 'oai', taskId: providerTaskId };
      }
    }
    throw videoPollTimeoutError('OAI', providerTaskId);
  }

  async function createVideo(task, refs, hooks = {}) {
    const apiKey = keyForTask(task);
    let providerTaskId = '';
    try {
      const created = await fetchJson(`${baseUrl}/videos`, { method: 'POST', ...request(task, refs, apiKey), signal: AbortSignal.timeout(requestTimeoutMs) });
      providerTaskId = taskId(created);
      if (providerTaskId) await hooks.onSubmitted?.({ provider: 'oai', taskId: providerTaskId });
      const submittedUrl = videoUrl(created);
      if (submittedUrl && providerTaskId) return { provider: 'oai', taskId: providerTaskId, url: submittedUrl, requiresAuth: /\/videos\/[^/]+\/content(?:$|\?)/.test(submittedUrl) };
      if (!providerTaskId) throw new Error('OAI 视频任务没有返回任务 ID');
      if (hooks.deferPolling) return { pending: true, provider: 'oai', taskId: providerTaskId };
      return pollVideo(task, hooks);
    } catch (error) {
      if (providerTaskId && error.pollTimedOut !== true && !error.upstreamTerminal && Date.parse(task.submittedAt || '') + maxPollDurationMs <= Date.now()) error = videoPollTimeoutError('OAI', providerTaskId);
      if (providerTaskId && error.providerTaskId === undefined) error = Object.assign(error, { provider: 'oai', providerTaskId });
      throw error;
    }
  }

  return { videoUrl, taskId, status, isLegacyGrokTask, keyForTask, veo31Size, payload, request, pollVideo, createVideo };
}
