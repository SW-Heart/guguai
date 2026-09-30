// Keep the abort signal alive through response-body reads, not just until the
// response headers arrive. Native timeout signals do not keep the app running.
export function fetchWithTimeout(fetchImpl, url, { timeoutMs = 60_000, ...options } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  timeout.addEventListener('abort', () => controller.abort(new Error('连接超时，请稍后重试')), { once:true });
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  return fetchImpl(url, { ...options, signal });
}
