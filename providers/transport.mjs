// Only connection establishment failures are safe to replay for a billed POST.
// Socket resets and response timeouts may happen after the provider accepted it.
export function isPreconnectFailure(error) {
  if (!error || error.upstreamStatus || error.requestPhase === 'response_body') return false;
  if (error.errors?.length) return error.errors.every(isPreconnectFailure);
  if (error.cause) return isPreconnectFailure(error.cause);
  return ['ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.code)
    || (error.syscall === 'connect' && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code));
}

export function transportErrorCodes(error) {
  const codes = new Set();
  const seen = new Set();
  function visit(value) {
    if (!value || seen.has(value)) return;
    seen.add(value);
    if (/^[A-Z][A-Z0-9_]{1,79}$/.test(value.code || '')) codes.add(value.code);
    visit(value.cause);
    for (const child of value.errors || []) visit(child);
  }
  visit(error);
  return [...codes];
}

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
    let response, text;
    try {
      response = await fetchImpl(url, options);
      text = await response.text();
    } catch (error) {
      const codes = transportErrorCodes(error);
      throw Object.assign(new Error(`${error.message}${codes.length ? ` [${codes.join(', ')}]` : ''}`, { cause:error }), {
        requestPhase:response ? 'response_body' : isPreconnectFailure(error) ? 'connect' : 'request',
        transportCodes:codes,
      });
    }
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
    return [error?.upstreamStatus, transportErrorCodes(error).join(', '), error?.upstreamMessage || error?.message]
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
