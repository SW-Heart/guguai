export function createDuomiProvider({
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
  videoMaxPollDurationMs,
  buildVideoPayload,
  errorMessage,
  upstreamRequestErrorDetail,
} = {}) {
  const dependencies = {
    baseUrl, apiKey, fetchJson, trackProviderSubmission, sleep, videoPollRemainingMs,
    videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt,
    imageMaxPollDurationMs, videoMaxPollDurationMs, buildVideoPayload,
    errorMessage, upstreamRequestErrorDetail,
  };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== 'function' && !['baseUrl', 'apiKey', 'imageMaxPollDurationMs', 'videoMaxPollDurationMs'].includes(name)) {
      throw new TypeError(`Duomi 适配器缺少 ${name} 依赖`);
    }
  }

  const MIDJOURNEY_MODEL_ID = 'midjourney';
  const isMidjourneyTask = task => task?.modelId === MIDJOURNEY_MODEL_ID || task?.model === MIDJOURNEY_MODEL_ID;
  function midjourneyPrompt(task, refs) {
    const options = task.midjourneyOptions || {};
    // The editor stores image mentions as Image1/Image2 tokens. MJ expects the
    // staged image URLs at the beginning of the prompt instead.
    const prompt = String(task.prompt || '').replace(/\bImage\s*\d+\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const flags = [];
    if (options.aspectRatio) flags.push(`--ar ${options.aspectRatio}`);
    if (options.chaos !== undefined && options.chaos !== '') flags.push(`--c ${options.chaos}`);
    if (options.quality !== undefined && options.quality !== '') flags.push(`--q ${options.quality}`);
    if (options.stylize !== undefined && options.stylize !== '') flags.push(`--s ${options.stylize}`);
    if (options.weird !== undefined && options.weird !== '') flags.push(`--w ${options.weird}`);
    if (options.seed !== undefined && options.seed !== '') flags.push(`--seed ${options.seed}`);
    if (options.negativePrompt) flags.push(`--no ${String(options.negativePrompt).trim()}`);
    if (refs.length && options.imageWeight !== undefined && options.imageWeight !== '') flags.push(`--iw ${options.imageWeight}`);
    if (options.version) flags.push(`--v ${options.version}`);
    if (options.tile) flags.push('--tile');
    if (options.raw) flags.push('--raw');
    if (options.draft) flags.push('--draft');
    return [...refs.slice(0, 7), prompt, flags.join(' ')].filter(Boolean).join(' ').trim();
  }

  async function pollImage(taskId, hooks = {}, pollStartedAt = Date.now(), { immediate = false, allowExpiredFinalCheck = false, pollOnce = false, modelId = '' } = {}) {
    const midjourney = modelId === MIDJOURNEY_MODEL_ID;
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
        const url = midjourney
          ? `${baseUrl}/api/midjourney/feed?task_id=${encodeURIComponent(taskId)}`
          : `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`;
        state = await fetchJson(url, {
          headers: { Authorization: apiKey },
          signal: remainingMs > 0
            ? videoPollRequestSignal('图片', taskId, pollStartedAt, imageMaxPollDurationMs, 60_000)
            : AbortSignal.timeout(60_000),
        });
        consecutiveErrors = 0;
        await hooks.onPollRecovered?.();
      } catch (error) {
        if ([401, 403].includes(Number(error.upstreamStatus))) {
          throw Object.assign(error, { provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true });
        }
        if (videoPollRemainingMs(pollStartedAt, imageMaxPollDurationMs) <= 0) throw videoPollTimeoutError('图片', taskId);
        consecutiveErrors += 1;
        await hooks.onPollError?.({ consecutiveErrors, detail: error.message });
        console.error('[image] Duomi poll transport failure; task remains active', { taskId, consecutiveErrors, detail: error.message });
        if (pollOnce) return { pending: true, provider: 'duomi', taskId };
        continue;
      }
      if (midjourney && Number(state.code) >= 400) {
        throw Object.assign(new Error(errorMessage(state.msg || state.message || state.data || state, '图片生成失败')), {
          provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true,
        });
      }
      const result = midjourney && state.data && typeof state.data === 'object' ? state.data : state;
      const rawStatus = String(result.state || result.status || '').toLowerCase();
      const status = rawStatus === '3' ? 'succeeded' : rawStatus;
      if (['succeeded', 'completed', 'success', 'done'].includes(status)) {
        const url = result.image_url || result.data?.images?.[0]?.url || result.data?.url || result.url;
        if (!url) throw Object.assign(new Error('图片任务已完成，但没有返回结果地址'), { provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true });
        return { provider: 'duomi', taskId, url };
      }
      if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected', 'expired', '4'].includes(status)) {
        throw Object.assign(new Error(errorMessage(result.msg || result.message || result.error || result, '图片生成失败')), {
          provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true,
        });
      }
      if (pollOnce) {
        if (videoPollRemainingMs(pollStartedAt, imageMaxPollDurationMs) <= 0) throw videoPollTimeoutError('图片', taskId);
        return { pending: true, provider: 'duomi', taskId };
      }
    }
  }

  async function createImage(task, refs, hooks = {}) {
    const midjourney = isMidjourneyTask(task);
    const payload = midjourney
      ? { action: 'generate', prompt: midjourneyPrompt(task, refs) }
      : { model: task.model, prompt: task.prompt, size: task.size, quality: task.quality };
    if (!midjourney && refs.length) payload.image = refs.slice(0, 7);
    const submission = await trackProviderSubmission((async () => {
      const created = await fetchJson(midjourney ? `${baseUrl}/api/midjourney/imagine/fast` : `${baseUrl}/v1/images/generations?async=true`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (midjourney && created.code !== undefined && Number(created.code) !== 200) throw new Error(errorMessage(created.msg || created.data || created, '图片任务提交失败'));
      const submittedTaskId = midjourney ? created.data?.task_id : (created.id || created.task_id);
      if (!submittedTaskId) throw new Error('图片任务没有返回任务 ID');
      await hooks.onSubmitted?.({ provider: 'duomi', taskId: String(submittedTaskId) });
      if (hooks.deferPolling) return { pending: true, provider: 'duomi', taskId: String(submittedTaskId) };
      return String(submittedTaskId);
    })());
    if (submission?.pending) return submission;
    return pollImage(submission, hooks, videoPollStartedAt(task), { modelId: midjourney ? MIDJOURNEY_MODEL_ID : '' });
  }

  async function pollVideo(task, hooks = {}, pollStartedAt = Date.now(), { immediate = false, allowExpiredFinalCheck = false, pollOnce = false } = {}) {
    const taskId = String(task.providerTaskId || '');
    let firstRequest = true;
    let consecutiveErrors = 0;
    for (;;) {
      let remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
      if (remainingMs <= 0 && !(firstRequest && allowExpiredFinalCheck)) throw videoPollTimeoutError('多米', taskId);
      if (!(firstRequest && immediate)) {
        await sleep(Math.min(8_000, Math.max(1, remainingMs)));
        remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
      }
      firstRequest = false;
      let state;
      try {
        state = await fetchJson(`${baseUrl}/v1/videos/tasks/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: apiKey },
          signal: remainingMs > 0
            ? videoPollRequestSignal('多米', taskId, pollStartedAt, videoMaxPollDurationMs, 60_000)
            : AbortSignal.timeout(60_000),
        });
        // Poll jobs are durable and may resume in a new invocation with a
        // reset local error counter. Always notify recovery on success so a
        // persisted error flag cannot outlive the successful poll.
        await hooks.onPollRecovered?.();
        consecutiveErrors = 0;
      } catch (error) {
        if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true });
        if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('多米', taskId);
        consecutiveErrors += 1;
        await hooks.onPollError?.({ consecutiveErrors, detail: upstreamRequestErrorDetail(error) });
        console.error('[video] Duomi poll transport failure; task remains active', { taskId, consecutiveErrors, detail: upstreamRequestErrorDetail(error) });
        if (pollOnce) return { pending: true, provider: 'duomi', taskId };
        continue;
      }
      const status = String(state.state || state.status || '').toLowerCase();
      if (['succeeded', 'completed', 'success', 'done'].includes(status)) {
        const url = state.data?.videos?.[0]?.url || state.data?.url || state.url;
        if (!url) throw Object.assign(new Error('多米视频任务已完成，但没有返回结果地址'), { provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true });
        return { provider: 'duomi', taskId, url };
      }
      if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) {
        throw Object.assign(new Error(errorMessage(state.message || state.error || state, '多米视频生成失败')), { provider: 'duomi', providerTaskId: taskId, upstreamTerminal: true });
      }
      if (pollOnce) {
        if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('多米', taskId);
        return { pending: true, provider: 'duomi', taskId };
      }
    }
  }

  async function createVideo(task, refs, hooks = {}) {
    let taskId = '';
    try {
      const created = await trackProviderSubmission(fetchJson(`${baseUrl}/v1/videos/generations`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildVideoPayload(task, refs)),
        signal: AbortSignal.timeout(180_000),
      }));
      taskId = created.id || created.task_id;
      if (!taskId) throw Object.assign(new Error('多米视频任务没有返回任务 ID'), { provider: 'duomi', fallbackEligible: false });
      task.providerTaskId = String(taskId);
      await hooks.onSubmitted?.({ provider: 'duomi', taskId: String(taskId) });
      if (hooks.deferPolling) return { pending: true, provider: 'duomi', taskId: String(taskId) };
      return pollVideo(task, hooks, videoPollStartedAt(task));
    } catch (error) {
      if (taskId && Date.parse(task.submittedAt || '') + videoMaxPollDurationMs <= Date.now() && !error.upstreamTerminal) error = videoPollTimeoutError('多米', taskId);
      console.error('[video] Duomi upstream failure', {
        generationId: task.id,
        modelId: task.videoModelId || task.modelId || null,
        model: task.model || null,
        phase: taskId ? 'poll' : 'submit',
        status: error.upstreamStatus || null,
        message: error.upstreamMessage || error.message,
      });
      if (taskId && error.fallbackEligible === undefined) error = Object.assign(error, { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
      throw error;
    }
  }

  return { pollImage, createImage, pollVideo, createVideo };
}
