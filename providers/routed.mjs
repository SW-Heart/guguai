import { generationFailureCode } from '../lib/generation-failure-code.mjs';
import { minimaxH3SubmitModel } from './minimax-h3.mjs';

export function createRoutedProvider({
  fetchJson,
  sleep,
  routeCredential,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  submitTimeoutMs = 10 * 60_000,
  notifyVideoProgress,
  upstreamRequestErrorDetail,
  isDefinitiveSubmitRejection,
  errorMessage,
  createAutodlRouteProvider,
} = {}) {
  for (const [name, dependency] of Object.entries({ fetchJson, sleep, routeCredential, videoPollRemainingMs, videoPollRequestSignal, videoPollTimeoutError, videoPollStartedAt, videoMaxPollDurationMs, notifyVideoProgress, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, errorMessage })) {
    if (typeof dependency !== 'function' && name !== 'videoMaxPollDurationMs') throw new TypeError(`动态线路适配器缺少 ${name} 依赖`);
  }

  // AutoDL routes speak the ComfyUI workflow protocol: the route's upstream
  // model ID is the workflow ID, and submit/poll are delegated per task.
  function autodlRouteProvider(task) {
    if (task.routeAdapter !== 'autodl-comfyui') return null;
    if (typeof createAutodlRouteProvider !== 'function') throw Object.assign(new Error('AutoDL 线路尚未接入'), { upstreamTerminal: true });
    const apiKey = routeCredential(task.routeCredentialId);
    if (!apiKey) throw Object.assign(new Error('当前调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
    return createAutodlRouteProvider({ baseUrl: String(task.routeBaseUrl || '').replace(/\/$/, ''), workflowId: task.model, apiKey, providerName: task.provider || 'autodl' });
  }

  function apiBase(task) {
    const base = String(task.routeBaseUrl || '').replace(/\/+$/, '');
    return /\/v1$/i.test(base) ? base : `${base}/v1`;
  }
  // Keep the deadline on the durable task so worker restarts also respect it.
  function pollDeadline(task, response) {
    const raw = response.headers?.get('retry-after');
    const seconds = raw == null ? NaN : Number(raw);
    const deadline = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw || '');
    task.providerNextPollAt = Math.max(Date.now() + 10_000, Number.isFinite(deadline) ? deadline : 0);
  }

  function videoUrl(value) {
    const candidates = [value?.video_url, value?.url, value?.download_url, value?.original_video_url, value?.data?.[0]?.url, value?.data?.video_url, value?.data?.url, value?.data?.download_url, value?.data?.original_video_url];
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
    const model = minimaxH3SubmitModel(task, task.model, images.some(Boolean));
    if (task.routeAdapter === 'yk-video') return {
      model, prompt: task.prompt, duration: Number(task.duration),
      resolution: task.quality, ratio: task.aspectRatio,
      sound: true,
      ...(images.length || videos.length || audios.length ? { generation_mode: 'reference' } : {}),
      media: [
        ...images.map((url, index) => ({ type: 'image', label: `图片${index + 1}`, url })),
        ...videos.map((url, index) => ({ type: 'video', label: `视频${index + 1}`, url })),
        ...audios.map((url, index) => ({ type: 'audio', label: `音频${index + 1}`, url })),
      ],
    };
    if (task.routeAdapter === 'cntcn-video') return {
      model, prompt: task.prompt, seconds: task.duration,
      aspect_ratio: task.aspectRatio, resolution: task.quality,
      ...(images.length ? { reference_image_urls: images } : {}),
      ...(videos.length ? { reference_videos: videos } : {}),
      ...(audios.length ? { reference_audios: audios } : {}),
    };
    const value = {
      model,
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
    const autodl = autodlRouteProvider(task);
    if (autodl) return autodl.pollVideo(task.providerTaskId, hooks, { startedAt: videoPollStartedAt(task), pollOnce });
    const key = routeCredential(task.routeCredentialId);
    if (!key) throw Object.assign(new Error('任务原调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
    const base = String(task.routeBaseUrl || '').replace(/\/$/, '');
    const yk = task.routeAdapter === 'yk-video';
    let consecutiveErrors = 0;
    const pollStartedAt = videoPollStartedAt(task);
    // Special-offer models may wait much longer upstream than full-price ones.
    const maxPollMs = typeof videoMaxPollDurationMs === 'function' ? videoMaxPollDurationMs(task) : videoMaxPollDurationMs;
    for (;;) {
      if (yk && Number(task.providerNextPollAt) > Date.now()) {
        if (pollOnce) return { pending: true, provider: task.provider, taskId: task.providerTaskId };
        await sleep(task.providerNextPollAt - Date.now());
      }
      const delay = consecutiveErrors ? Math.min(10_000 * 2 ** Math.min(consecutiveErrors, 3), 60_000) : 10_000;
      const remainingMs = videoPollRemainingMs(pollStartedAt, maxPollMs);
      if (!immediate && !(yk && task.providerNextPollAt) && remainingMs > 0) await sleep(Math.min(delay, remainingMs));
      // A worker may resume after sleep or downtime, long after upstream has
      // completed. Check the final state before applying our local deadline.
      const expired = videoPollRemainingMs(pollStartedAt, maxPollMs) <= 0;
      let state;
      try {
        if (yk) task.providerNextPollAt = Date.now() + 10_000;
        state = await fetchJson(`${yk ? apiBase(task) : `${base}/v1`}/videos/${encodeURIComponent(task.providerTaskId)}`, {
          headers: { Authorization: `Bearer ${key}` },
          ...(yk ? { onResponse: response => pollDeadline(task, response) } : {}),
          signal: expired ? AbortSignal.timeout(60_000) : videoPollRequestSignal(task.provider, task.providerTaskId, pollStartedAt, maxPollMs, 60_000),
        });
      } catch (error) {
        if (!yk && [401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: task.provider, providerTaskId: task.providerTaskId, upstreamTerminal: true });
        consecutiveErrors += 1;
        await hooks.onPollError?.({ consecutiveErrors, detail: upstreamRequestErrorDetail(error) });
        // An unavailable status endpoint does not prove generation failed.
        // Let durable recovery retry without issuing a premature refund.
        if (expired || videoPollRemainingMs(pollStartedAt, maxPollMs) <= 0) throw Object.assign(error, { provider: task.provider, providerTaskId: task.providerTaskId });
        if (pollOnce) return { pending: true, provider: task.provider, taskId: task.providerTaskId };
        continue;
      }
      // A durable poll job starts with a fresh local error counter. Recovery
      // therefore has to be signalled on every successful response so a
      // persisted error from the previous poll job is cleared as well.
      await hooks.onPollRecovered?.();
      consecutiveErrors = 0;
      await notifyVideoProgress(hooks, state);
      const status = String((yk && (state.job_status || state.data?.job_status)) || state.status || state.data?.status || '').trim().toLowerCase();
      const resultUrl = videoUrl(state);
      if (resultUrl && (!yk || ['completed', 'succeeded'].includes(status))) {
        const url = new URL(resultUrl, `${base}/`).href;
        return { provider: task.provider, taskId: task.providerTaskId, url, requiresAuth: /\/v1\/videos\/[^/]+\/content(?:$|\?)/.test(url) && new URL(url).origin === new URL(base).origin };
      }
      if (['completed', 'succeeded', 'success', 'done'].includes(status)) return { provider: task.provider, taskId: task.providerTaskId, url: `${yk ? apiBase(task) : `${base}/v1`}/videos/${encodeURIComponent(task.providerTaskId)}/content`, requiresAuth: true };
      const failureConfirmed = state.failure_confirmed ?? state.data?.failure_confirmed;
      const financialHold = state.financial_hold ?? state.data?.financial_hold;
      if (yk) {
        task.providerFailureConfirmed = failureConfirmed ?? null;
        task.providerFinancialHold = financialHold ?? null;
      }
      // A confirmed generation failure is final even while upstream billing
      // remains under review. Financial hold is not evidence of a refund.
      const uncertainFailure = yk && failureConfirmed !== true && (failureConfirmed === false || financialHold);
      if (!uncertainFailure && (status !== 'paused' || failureConfirmed === true) && ['paused', 'failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) {
        const message = errorMessage(state.error || state.data?.error || state.status_detail || state.data?.status_detail || state, '视频生成失败');
        throw Object.assign(new Error(message), {
          provider: task.provider, providerTaskId: task.providerTaskId, upstreamTerminal: true,
          ...(yk && generationFailureCode({ error: message }) === 'CONTENT_REJECTED' ? { retryable: false } : {}),
        });
      }
      if (videoPollRemainingMs(pollStartedAt, maxPollMs) <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
      if (pollOnce) return { pending: true, provider: task.provider, taskId: task.providerTaskId };
    }
  }

  async function createVideo(task, refs, hooks = {}) {
    const autodl = autodlRouteProvider(task);
    if (autodl) return autodl.createVideo(task, refs, hooks);
    const key = routeCredential(task.routeCredentialId);
    if (!key) throw Object.assign(new Error('当前调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
    const base = String(task.routeBaseUrl || '').replace(/\/$/, '');
    const yk = task.routeAdapter === 'yk-video';
    if (yk && task.providerTaskId) return pollVideo(task, hooks, { immediate: true });
    let taskId = '';
    try {
      const created = await fetchJson(`${yk ? apiBase(task) : `${base}/v1`}/videos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          ...(yk ? { 'Idempotency-Key': `${task.id}:${Number(task.generationRetryCount) || 0}` } : {}), },
        ...(yk ? { onResponse: response => pollDeadline(task, response) } : {}),
        body: JSON.stringify(payload(task, refs)),
        signal: AbortSignal.timeout(submitTimeoutMs),
      });
      taskId = taskIdFromResponse(created);
      if (!taskId) throw new Error('渠道已接受请求，但没有返回任务 ID');
      task.providerTaskId = taskId;
      await hooks.onSubmitted?.({ provider: task.provider, taskId });
      if (hooks.deferPolling) return { pending: true, provider: task.provider, taskId };
      return pollVideo(task, hooks);
    } catch (error) {
      if (error.upstreamTerminal) throw error;
      if (isDefinitiveSubmitRejection(error) && (!yk || Number(error.upstreamStatus) < 500)) throw Object.assign(error, { provider: task.provider, upstreamTerminal: true });
      if (taskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: task.provider, providerTaskId: taskId });
      throw Object.assign(new Error(`视频提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: task.provider, submissionUncertain: true, cause: error });
    }
  }

  function taskIdFromResponse(value) { return taskId(value); }
  // Mark every error raised while talking to the channel so route health
  // tracking can tell channel failures apart from local preparation errors.
  function markRouteAttempt(error) {
    if (error && typeof error === 'object') error.routeAttempt = true;
    return error;
  }
  const trackedPollVideo = (...args) => pollVideo(...args).catch(error => { throw markRouteAttempt(error); });
  const trackedCreateVideo = (...args) => createVideo(...args).catch(error => { throw markRouteAttempt(error); });
  return { payload, pollVideo: trackedPollVideo, createVideo: trackedCreateVideo, videoUrl, taskId };
}
