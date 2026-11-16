import { GPT_IMAGE_26_MODEL_ID, gptImage26Size } from '../lib/gpt-image-26.mjs';
import { isPreconnectFailure, transportErrorCodes, transportErrorDiagnostics } from './transport.mjs';

// WJ image generation is synchronous: one POST returns the finished image URL.
export function createWjImageProvider({
  baseUrl,
  apiKey,
  fetchJson,
  trackProviderSubmission,
  sleep,
  imageSubmitTimeoutMs = 360_000,
  upstreamRequestErrorDetail,
} = {}) {
  for (const [name, dependency] of Object.entries({ fetchJson, trackProviderSubmission, sleep, upstreamRequestErrorDetail })) {
    if (typeof dependency !== 'function') throw new TypeError(`WJ 图片适配器缺少 ${name} 依赖`);
  }
  const authorization = () => `Bearer ${String(apiKey || '').trim()}`;

  async function createImage(task, refs = []) {
    const size = gptImage26Size(task.size || '1:1', task.quality || '1k');
    if (!size) throw Object.assign(new Error('GPT Image 2.6 不支持该画面比例或清晰度'), { provider:'wj', upstreamTerminal:true });
    const payload = {
      model:GPT_IMAGE_26_MODEL_ID, prompt:task.prompt, size, n:1, response_format:'url',
      ...(refs.length ? { images:refs.slice(0, 16).map(url => ({ image_url:url })) } : {}),
    };
    const endpoint = `${baseUrl}/v1/images/${refs.length ? 'edits' : 'generations'}`;
    return trackProviderSubmission((async () => {
      const startedAt = Date.now();
      const signal = AbortSignal.timeout(imageSubmitTimeoutMs);
      const maxSubmitAttempts = 5;
      let created;
      for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
        task.submissionAttemptCount = attempt;
        const requestStartedAt = Date.now();
        try {
          created = await fetchJson(endpoint, {
            method:'POST',
            headers:{ Authorization:authorization(), 'Content-Type':'application/json' },
            body:JSON.stringify(payload),
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
          console.error('[image] WJ submission transport failure', {
            generationId:task.id, model:GPT_IMAGE_26_MODEL_ID, attempt, phase, safeToRetry, ...diagnostics,
            detail:upstreamRequestErrorDetail(error),
          });
          if (safeToRetry && attempt < maxSubmitAttempts && !signal.aborted) {
            await sleep(1000 * 2 ** (attempt - 1));
            if (!signal.aborted) continue;
          }
          // The image may still be generated after a lost response. Never replay it.
          if (!safeToRetry && (!error.upstreamStatus || [408, 409, 425].includes(error.upstreamStatus))) {
            throw Object.assign(new Error(`图片提交结果待确认：${upstreamRequestErrorDetail(error)}`, { cause:error }), {
              provider:'wj', submissionUncertain:true,
            });
          }
          throw error;
        }
      }
      const url = created?.data?.[0]?.url;
      if (!url) throw Object.assign(new Error('GPT Image 2.6 没有返回图片地址'), { provider:'wj', submissionUncertain:true });
      return { provider:'wj', taskId:'', url };
    })());
  }

  return { createImage };
}
