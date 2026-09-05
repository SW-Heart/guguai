const DEFAULT_TIMEOUT_MS = 30_000;

function requestHeaders(scopeHeaders, options) {
  const isBlob = typeof Blob !== 'undefined' && options.body instanceof Blob;
  return {
    ...scopeHeaders(),
    ...(isBlob ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  };
}

function responseError(data, response) {
  const error = Object.assign(new Error(data?.error || '请求失败'), data && typeof data === 'object' ? data : {});
  error.status = response.status;
  error.requestId = response.headers?.get?.('X-Request-Id') || '';
  return error;
}

function responseShapeError(shape, data) {
  const error = new Error(`服务响应格式无效（${shape}）`);
  error.code = 'INVALID_RESPONSE_SCHEMA';
  error.status = 502;
  error.responseShape = shape;
  error.responseData = data;
  return error;
}

export function validateResponseShape(data, shape = 'json') {
  if (typeof shape === 'function') {
    const result = shape(data);
    if (result === false) throw responseShapeError('custom', data);
    return data;
  }
  if (shape === 'json' && (data === null || data === undefined)) throw responseShapeError('json', data);
  if (shape === 'object' && (!data || typeof data !== 'object' || Array.isArray(data))) throw responseShapeError('object', data);
  if (shape === 'array' && !Array.isArray(data)) throw responseShapeError('array', data);
  if (shape === 'page' && (!Array.isArray(data) && (!data || typeof data !== 'object' || !Array.isArray(data.items)))) throw responseShapeError('page', data);
  return data;
}

function requestSignal(signal, timeoutMs) {
  const Controller = globalThis.AbortController;
  if (typeof Controller !== 'function') return { signal, dispose: () => {} };
  const controller = new Controller();
  let timer = null;
  let removeListener = () => {};
  const abort = reason => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (signal) {
    if (signal.aborted) abort(signal.reason);
    else {
      const onAbort = () => abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      removeListener = () => signal.removeEventListener('abort', onAbort);
    }
  }
  const boundedTimeout = Number(timeoutMs);
  if (Number.isFinite(boundedTimeout) && boundedTimeout > 0) {
    timer = setTimeout(() => abort(Object.assign(new Error('请求超时'), { code: 'API_TIMEOUT' })), boundedTimeout);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      removeListener();
    },
  };
}

function normalizeAbortError(error, signal) {
  if (!signal?.aborted) return error;
  const reason = signal.reason;
  if (reason?.code === 'API_TIMEOUT') return Object.assign(new Error('请求超时，请稍后重试'), { code: 'API_TIMEOUT', cause: error });
  return Object.assign(new Error('请求已取消'), { code: 'API_ABORTED', cause: error });
}

export function createApiClient({ fetchImpl = globalThis.fetch?.bind(globalThis), scopeHeaders = () => ({}), timeoutMs = DEFAULT_TIMEOUT_MS, responseShapeFor = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch');

  async function request(url, options = {}) {
    const { timeoutMs: requestTimeout = timeoutMs, signal: callerSignal, responseShape: requestedShape, ...fetchOptions } = options;
    const responseShape = requestedShape || responseShapeFor?.(url, fetchOptions) || 'json';
    const control = requestSignal(callerSignal, requestTimeout);
    try {
      const response = await fetchImpl(url, { credentials:'same-origin', ...fetchOptions, signal:control.signal, headers:requestHeaders(scopeHeaders, fetchOptions) });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw responseError(data, response);
      return validateResponseShape(data, responseShape);
    } catch (error) {
      throw normalizeAbortError(error, control.signal);
    } finally {
      control.dispose();
    }
  }

  async function page(url, options = {}) {
    const { timeoutMs: requestTimeout = timeoutMs, signal: callerSignal, responseShape: requestedShape, ...fetchOptions } = options;
    const responseShape = requestedShape || responseShapeFor?.(url, fetchOptions) || 'page';
    const control = requestSignal(callerSignal, requestTimeout);
    try {
      const response = await fetchImpl(url, { credentials:'same-origin', ...fetchOptions, signal:control.signal, headers:requestHeaders(scopeHeaders, fetchOptions) });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw responseError(data, response);
      validateResponseShape(data, responseShape);
      const headers = response.headers || { get: () => '' };
      return {
        items:Array.isArray(data) ? data : data.items,
        nextCursor:headers.get('X-Next-Cursor') || '',
        total:Number(headers.get('X-Total-Count') || data.total) || 0,
      };
    } catch (error) {
      throw normalizeAbortError(error, control.signal);
    } finally {
      control.dispose();
    }
  }

  return Object.freeze({ request, page });
}
