import { AsyncLocalStorage } from 'node:async_hooks';
import { VIDEO_MODEL_IDS } from '../lib/video-capabilities.mjs';
import { minimaxH3RecordedModel } from '../providers/minimax-h3.mjs';

export const generationAttemptContext = new AsyncLocalStorage();
export const maxGenerationRetries = 3;
// Routed jobs try each channel twice (one retry), then move to the next
// channel. A new attempt may only start within this window after the job was
// submitted; an attempt already running is never cut short by it.
export const routedRetryWindowMs = 600_000;
// Special-offer models run on slower, cheaper channels, so they keep trying
// channels for an hour instead.
export const valueRoutedRetryWindowMs = 3_600_000;
const valueVideoModelIds = new Set(Object.entries(VIDEO_MODEL_IDS).filter(([key]) => key.endsWith('_VALUE')).map(([, id]) => id));
export function routedRetryWindowFor(task) {
  return valueVideoModelIds.has(task.videoModelId || task.modelId) ? valueRoutedRetryWindowMs : routedRetryWindowMs;
}
export const attemptsPerRoute = 2;
// Jobs saved without a usable submission time keep the former attempt cap.
const legacyRoutedRetryLimit = maxGenerationRetries + 1;

function attemptsOnCurrentRoute(task) {
  return (task.generationAttempts || []).filter(attempt => attempt.routeId === task.routeId).length;
}

function routedRetryAllowed(task, at) {
  const startedAt = Date.parse(task.createdAt);
  const failedAt = Date.parse(at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(failedAt)) return (Number(task.generationRetryCount) || 0) < legacyRoutedRetryLimit;
  return failedAt - startedAt < routedRetryWindowFor(task);
}

/** Points the job at another channel; the charge taken at submission is kept. */
export function applyGenerationRoute(task, route) {
  Object.assign(task, {
    provider: route.provider,
    model: minimaxH3RecordedModel(task, route.upstreamModelId, route),
    routeId: route.id,
    routeVersion: route.version,
    routePriority: route.priority,
    routeDisplayName: route.displayName,
    routeAdapter: route.adapterType,
    routeBaseUrl: route.baseUrl,
    routeCredentialId: route.credentialId,
    routeTextPlaceholderImage: Boolean(route.textPlaceholderImage),
    referenceLimits: {
      image: Number(route.capabilities?.image || 0),
      video: Number(route.capabilities?.video || 0),
      audio: Number(route.capabilities?.audio || 0),
      total: Number(route.capabilities?.image || 0) + Number(route.capabilities?.video || 0) + Number(route.capabilities?.audio || 0),
    },
  });
}

export function refreshGenerationRetryRoute(task, { selectModelRoute, routeUsable = () => true, referenceCounts = {} } = {}) {
  if (!task?.routeId || (Number(task.generationRetryCount) || 0) < 1) return null;
  // A channel an administrator picked by hand is used as chosen, even when it
  // is paused, for exactly the next attempt.
  if (task.adminRouteId === task.routeId) return { id:task.routeId, version:task.routeVersion };
  // The failed attempts are persisted on the job, so a restart resumes on the
  // same channel until it has used its retry and only then moves on. A channel
  // paused or switched off meanwhile gives up its retry.
  if (attemptsOnCurrentRoute(task) < attemptsPerRoute && routeUsable(task.routeId)) return { id:task.routeId, version:task.routeVersion };
  if (typeof selectModelRoute !== 'function') throw new TypeError('重新选择生成渠道缺少选路器');
  const route = selectModelRoute({
    logicalModelId: task.videoModelId || task.modelId,
    quality: task.quality,
    duration: task.duration,
    aspectRatio: task.aspectRatio,
    referenceCounts,
    excludeRouteIds: [...new Set([task.routeId, ...(task.generationAttempts || []).map(attempt => attempt.routeId).filter(Boolean)])],
    afterPriority: task.routePriority,
  });
  if (!route) {
    // Every channel has had its turn: report what actually went wrong last
    // rather than a generic "try again later".
    const error = new Error(task.generationAttempts?.at(-1)?.error || '当前模型暂无其他可用生成渠道，请稍后重试');
    error.retryable = false;
    throw error;
  }
  applyGenerationRoute(task, route);
  return route;
}

// An image the provider never finishes within the wait limit is submitted
// again once instead of failing outright; a second timeout still fails.
export const imagePollTimeoutRetries = 1;

function pollTimeoutRetryAllowed(task) {
  return task.type === 'image'
    && (task.generationAttempts || []).filter(attempt => attempt.pollTimedOut).length < imagePollTimeoutRetries;
}

export function generationRetryAllowed(task, error, at = new Date().toISOString()) {
  return !(!['image', 'video'].includes(task.type) || task.sourceUrl || task.archivePending
    || error.submissionUncertain || (error.pollTimedOut && !pollTimeoutRetryAllowed(task)) || error.retryable === false || [408, 409, 425].includes(Number(error.upstreamStatus))
    || !(error.upstreamTerminal || Number(error.upstreamStatus) >= 400)
    || (task.routeId ? !routedRetryAllowed(task, at) : (Number(task.generationRetryCount) || 0) >= maxGenerationRetries));
}

export function prepareGenerationRetry(task, error, at = new Date().toISOString()) {
  if (!generationRetryAllowed(task, error, at)) return false;
  task.generationAttempts = [...(task.generationAttempts || []), {
    attempt: (Number(task.generationRetryCount) || 0) + 1,
    providerTaskId: task.providerTaskId || '',
    startedAt: task.attemptStartedAt || task.createdAt,
    finishedAt: at,
    error: error.message,
    ...(error.pollTimedOut ? { pollTimedOut: true } : {}),
    ...(task.routeId ? {
      routeId: task.routeId,
      routeVersion: task.routeVersion,
      routePriority: task.routePriority,
      routeDisplayName: task.routeDisplayName,
      provider: task.provider,
      model: task.model,
      pricingSnapshot: task.pricingSnapshot ? structuredClone(task.pricingSnapshot) : null,
      creditCostMicro: task.creditCostMicro,
    } : {}),
  }];
  task.generationRetryCount = (Number(task.generationRetryCount) || 0) + 1;
  delete task.adminRouteId;
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
