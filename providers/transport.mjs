export function createProviderTransport({
  fetchImpl = globalThis.fetch,
  errorMessage,
  videoProgress,
  sleep,
  pendingProviderSubmissions = new Set(),
} = {}) {
  for (const [name, dependency] of Object.entries({ fetchImpl, errorMessage, videoProgress, sleep })) {
    if (typeof dependency !== 'function') throw new TypeError(`供应商传输层缺少 ${name} 依赖`);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = { raw: text }; }
    if (!response.ok) {
      const message = errorMessage(value, text.slice(0, 300));
      throw Object.assign(new Error(`${response.status} ${message}`), {
        upstreamStatus: response.status,
        upstreamMessage: message,
      });
    }
    return value;
  }

  function trackProviderSubmission(operation) {
    const tracked = Promise.resolve(operation);
    pendingProviderSubmissions.add(tracked);
    void tracked.finally(() => pendingProviderSubmissions.delete(tracked)).catch(() => {});
    return tracked;
  }

  async function waitForProviderSubmissions(timeoutMs = 15_000) {
    const submissions = [...pendingProviderSubmissions];
    if (!submissions.length) return { pending: 0, timedOut: false };
    let timeout;
    const timedOut = await Promise.race([
      Promise.allSettled(submissions).then(() => false),
      new Promise(resolve => { timeout = setTimeout(() => resolve(true), Math.max(1, timeoutMs)); }),
    ]);
    if (timeout) clearTimeout(timeout);
    return { pending: pendingProviderSubmissions.size, timedOut };
  }

  function upstreamRequestErrorDetail(error) {
    return [error?.upstreamStatus, error?.cause?.code, error?.upstreamMessage || error?.cause?.message || error?.message]
      .filter(Boolean).join(' · ') || '未知上游网络错误';
  }

  function isDefinitiveSubmitRejection(error) {
    return Number(error?.upstreamStatus) >= 400
      && Number(error?.upstreamStatus) < 500
      && ![408, 409, 425, 429].includes(Number(error.upstreamStatus));
  }

  async function notifyVideoProgress(hooks, value) {
    const progress = videoProgress(value);
    if (progress === null) return hooks.onProgressAbsent?.();
    return hooks.onProgress?.({ progress });
  }

  return { fetchJson, trackProviderSubmission, waitForProviderSubmissions, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, notifyVideoProgress };
}
