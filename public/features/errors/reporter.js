// 页面脚本错误上报：捕获未处理的异常和 Promise 拒绝，合并后批量发给 /api/errors。
// 只做旁路记录，不弹任何提示；上报失败直接丢弃，不重试，不影响页面使用。
const IGNORED_MESSAGES = [/^Script error\.?$/i, /ResizeObserver loop/i, /Failed to fetch|Load failed|NetworkError/i, /AbortError|aborted/i];

function errorText(reason) {
  if (reason instanceof Error) return `${reason.name && reason.name !== 'Error' ? `${reason.name}: ` : ''}${reason.message}`;
  if (typeof reason === 'string') return reason;
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

/** 接口返回的业务错误（4xx、超时、主动取消）属于正常流程，不算脚本异常。 */
export function isExpectedFailure(reason) {
  const status = Number(reason?.status);
  if (status >= 400 && status < 500) return true;
  return ['API_TIMEOUT', 'ABORT_ERR'].includes(reason?.code) || reason?.name === 'AbortError';
}

export function createErrorReporter({
  endpoint = '/api/errors',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  headers = () => ({}),
  meta = () => ({}),
  maxReports = 30,
  flushDelayMs = 2000,
  location = globalThis.location,
  navigator = globalThis.navigator,
} = {}) {
  const seen = new Set();
  let queue = [];
  let timer = 0;
  let sent = 0;

  function flush() {
    timer = 0;
    if (!queue.length || typeof fetchImpl !== 'function') { queue = []; return; }
    const reports = queue.splice(0, 10);
    const info = meta() || {};
    try {
      fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports, appVersion: info.appVersion || '', platform: info.platform || '' }),
      })?.catch?.(() => {});
    } catch {}
    if (queue.length) timer = setTimeout(flush, flushDelayMs);
  }

  function report({ kind = 'error', message, stack = '', source = '', line, column }) {
    const text = String(message || '').trim().slice(0, 1000);
    if (!text || IGNORED_MESSAGES.some(pattern => pattern.test(text))) return false;
    const key = `${kind}|${text}|${String(stack).split('\n').slice(0, 3).join('|')}`;
    if (seen.has(key) || sent >= maxReports) return false;
    seen.add(key);
    sent += 1;
    queue.push({ kind, message: text, stack: String(stack || '').slice(0, 4000), source: String(source || '').slice(0, 300), line, column, page: String(location?.pathname || '').slice(0, 300), userAgent: String(navigator?.userAgent || '').slice(0, 300) });
    if (!timer) timer = setTimeout(flush, flushDelayMs);
    return true;
  }

  function onError(event) {
    // 图片、视频等资源加载失败也会冒泡成 error 事件，但不是脚本异常。
    if (!event || (event.target && event.target !== event.currentTarget && !event.error && !event.message)) return;
    report({ kind: 'error', message: event.error ? errorText(event.error) : event.message, stack: event.error?.stack, source: event.filename, line: event.lineno, column: event.colno });
  }

  function onRejection(event) {
    const reason = event?.reason;
    if (isExpectedFailure(reason)) return;
    report({ kind: 'unhandledrejection', message: errorText(reason), stack: reason?.stack });
  }

  function install(target = globalThis) {
    target.addEventListener?.('error', onError);
    target.addEventListener?.('unhandledrejection', onRejection);
    target.addEventListener?.('pagehide', flush);
    return () => {
      target.removeEventListener?.('error', onError);
      target.removeEventListener?.('unhandledrejection', onRejection);
      target.removeEventListener?.('pagehide', flush);
    };
  }

  return Object.freeze({ install, report, flush, onError, onRejection });
}
