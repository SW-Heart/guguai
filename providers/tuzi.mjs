import { SEEDREAM_MODEL_ID, SEEDREAM_UPSTREAM_MODEL_ID, seedreamSize } from '../lib/seedream.mjs';
import { isPreconnectFailure, transportErrorCodes, transportErrorDiagnostics } from './transport.mjs';

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
  imageSubmitTimeoutMs = 360_000,
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
    const isSeedream = task.model === SEEDREAM_MODEL_ID || task.model === SEEDREAM_UPSTREAM_MODEL_ID;
    const size = isSeedream ? seedreamSize(task.size || '1:1', task.quality) : task.size;
    if (isSeedream && !size) throw new Error('不支持的 Seedream 5.0 图片尺寸');
    const form = isSeedream ? null : new FormData();
    if (form) {
      form.append('model', task.model || 'gpt-image-2.5');
      form.append('prompt', task.prompt);
      if (task.size) form.append('size', task.size);
      for (const reference of refs) form.append('input_reference', reference);
    }
    const submission = await trackProviderSubmission((async () => {
      const startedAt = Date.now();
      const signal = AbortSignal.timeout(imageSubmitTimeoutMs);
      const maxSubmitAttempts = 5;
      let created;
      for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
        task.submissionAttemptCount = attempt;
        const requestStartedAt = Date.now();
        try {
          created = await fetchJson(`${baseUrl}${isSeedream ? '/v1/images/generations' : '/v1/videos'}`, {
            method:'POST',
            headers:{ Authorization:authorization(), ...(isSeedream ? { 'Content-Type':'application/json' } : {}) },
            body:isSeedream ? JSON.stringify({ model:SEEDREAM_UPSTREAM_MODEL_ID, prompt:task.prompt, size, response_format:'url', ...(refs.length ? { image:refs.length === 1 ? refs[0] : refs } : {}) }) : form,
            signal,
          });
          break;
        } catch (error) {
          const safeToRetry = isPreconnectFailure(error);
          const phase = error.requestPhase || (safeToRetry ? 'connect' : 'request');
          const diagnostics = {
            elapsedMs:Date.now() - startedAt, requestElapsedMs:Date.now() - requestStartedAt,
            timeoutMs:imageSubmitTimeoutMs, deadlineAborted:signal.aborted,
            ...(signal.aborted ? { abortReason:signal.reason?.name || 'AbortError' } : {}),
            ...transportErrorDiagnostics(error),
          };
          task.submissionAttempts = [...(task.submissionAttempts || []), {
            generationAttempt:(Number(task.generationRetryCount) || 0) + 1,
            attempt, at:new Date().toISOString(), phase, codes:transportErrorCodes(error), safeToRetry, ...diagnostics,
          }].slice(-20);
          console.error('[image] Tuzi submission transport failure', {
            generationId:task.id, model:task.model, mode:isSeedream ? 'synchronous' : 'asynchronous',
            attempt, phase, safeToRetry, ...diagnostics,
            detail:upstreamRequestErrorDetail(error),
          });
          if (safeToRetry && attempt < maxSubmitAttempts && !signal.aborted) {
            await sleep(1000 * 2 ** (attempt - 1));
            if (!signal.aborted) continue;
          }
          // A response may have been lost after acceptance. Never replay it.
          if (!safeToRetry && (!error.upstreamStatus || [408, 409, 425].includes(error.upstreamStatus))) {
            throw Object.assign(new Error(`图片提交结果待确认：${upstreamRequestErrorDetail(error)}`, { cause:error }), {
              provider:'tuzi', submissionUncertain:true,
            });
          }
          throw error;
        }
      }
      if (isSeedream) {
        const url = created?.data?.[0]?.url;
        if (!url) throw Object.assign(new Error('Seedream 5.0 没有返回图片地址'), { provider:'tuzi', submissionUncertain:true });
        return { provider:'tuzi', taskId:'', url };
      }
      const taskId = created.id || created.task_id;
      if (!taskId) throw Object.assign(new Error('Tuzi 图片任务没有返回任务 ID'), { provider:'tuzi', submissionUncertain:true });
      await hooks.onSubmitted?.({ provider:'tuzi', taskId:String(taskId) });
      if (hooks.deferPolling) return { pending:true, provider:'tuzi', taskId:String(taskId) };
      return String(taskId);
    })());
    if (submission?.pending || submission?.url) return submission;
    return pollImage(submission, hooks, videoPollStartedAt(task));
  }

  return { createImage, pollImage };
}
