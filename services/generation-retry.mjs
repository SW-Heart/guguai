import { AsyncLocalStorage } from 'node:async_hooks';

export const generationAttemptContext = new AsyncLocalStorage();
export const maxGenerationRetries = 3;

export function refreshGenerationRetryRoute(task, { selectModelRoute, referenceCounts = {} } = {}) {
  if (!task?.routeId || (Number(task.generationRetryCount) || 0) < 1) return null;
  if (typeof selectModelRoute !== 'function') throw new TypeError('重新选择生成渠道缺少选路器');
  const route = selectModelRoute({
    logicalModelId: task.videoModelId || task.modelId,
    quality: task.quality,
    duration: task.duration,
    aspectRatio: task.aspectRatio,
    referenceCounts,
  });
  if (!route) throw Object.assign(new Error('当前模型暂无可用生成渠道，请稍后重试'), { upstreamTerminal: true });
  Object.assign(task, {
    provider: route.provider,
    model: route.upstreamModelId,
    routeId: route.id,
    routeVersion: route.version,
    routeDisplayName: route.displayName,
    routeAdapter: route.adapterType,
    routeBaseUrl: route.baseUrl,
    routeCredentialId: route.credentialId,
    referenceLimits: {
      image: Number(route.capabilities?.image || 0),
      video: Number(route.capabilities?.video || 0),
      audio: Number(route.capabilities?.audio || 0),
      total: Number(route.capabilities?.image || 0) + Number(route.capabilities?.video || 0) + Number(route.capabilities?.audio || 0),
    },
  });
  return route;
}

export function prepareGenerationRetry(task, error, at = new Date().toISOString()) {
  if (!['image', 'video'].includes(task.type) || task.sourceUrl || task.archivePending
    || error.submissionUncertain || error.pollTimedOut || [408, 409, 425].includes(Number(error.upstreamStatus))
    || !(error.upstreamTerminal || Number(error.upstreamStatus) >= 400)
    || (Number(task.generationRetryCount) || 0) >= maxGenerationRetries) return false;
  task.generationAttempts = [...(task.generationAttempts || []), {
    attempt: (Number(task.generationRetryCount) || 0) + 1,
    providerTaskId: task.providerTaskId || '',
    startedAt: task.attemptStartedAt || task.createdAt,
    finishedAt: at,
    error: error.message,
  }];
  task.generationRetryCount = (Number(task.generationRetryCount) || 0) + 1;
  Object.assign(task, {
    status: 'queued', attemptStartedAt: at, providerTaskId: '', submittedAt: null,
    finishedAt: null, error: '', submissionUncertain: false, submissionUncertainAt: null,
    submissionTimedOut: false, lastSubmissionError: '', lastSubmissionErrorAt: null,
    lastPollError: '', lastPollErrorAt: null, pollFailureCount: 0,
    progress: null,
  });
  return true;
}

export async function generationRequestLog(url, options, context) {
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  for (const key of Object.keys(headers)) {
    if (/authorization|cookie|api[-_]?key|token|secret/i.test(key)) headers[key] = '[REDACTED]';
  }
  let body = options.body ?? null;
  if (body instanceof FormData) {
    body = await Promise.all([...body.entries()].map(async ([key, value]) => [key,
      typeof value === 'string' ? value : {
        name: value.name, type: value.type,
        base64: Buffer.from(await value.arrayBuffer()).toString('base64'),
      }]));
  }
  return { generationId: context.id, attempt: (Number(context.generationRetryCount) || 0) + 1,
    isRetry: Boolean(context.generationRetryCount), retryCount: Number(context.generationRetryCount) || 0,
    url: String(url), method: options.method || 'GET', headers, body };
}
