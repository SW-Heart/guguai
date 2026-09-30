import { sql, tx } from './db.mjs';
import { appendSystemEvent } from './audit.mjs';
import { generationFailureCode } from './generation-failure-code.mjs';
import { modelRoute, updateModelRoute } from './model-routes.mjs';

// A channel model is switched off after this many consecutive generations
// that failed because the channel/model itself was unusable.
export const ROUTE_AUTO_DISABLE_THRESHOLD = 3;

// Failure codes that describe the channel or upstream model being unusable.
// Everything else (content review, prompt, references, parameters, rate
// limits, interruptions on our side, unknown causes) never counts.
const AVAILABILITY_FAILURE_CODES = new Set([
  'MODEL_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'SERVICE_NOT_CONFIGURED',
  'UPSTREAM_BILLING',
  'MODEL_UNRESPONSIVE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'RESULT_INVALID',
]);

// HTTP statuses that reject the user's request rather than the service.
const USER_INPUT_STATUSES = new Set([400, 413, 415, 422, 451]);

// Second safety net on top of generationFailureCode: any hint that the
// request content was the reason for the failure keeps it out of the count,
// even when it is wrapped in a generic 5xx or network message.
const USER_INPUT_PATTERN = /violat|prohibit|forbidden content|inappropriate|sensitive|copyright|infring|sexual|porn|nud(?:e|ity)|violen|terror|politic|illegal|flagged|minor|child|prompt|reference|违禁|违法|违规|不合规|不适宜|侵权|版权|未成年|暴力|恐怖|政治|血腥|风控|提示词|创作描述|参考|素材/i;

/**
 * Returns the failure code when `error` proves the routed channel model is
 * unavailable, otherwise null. Only errors raised by the routed provider
 * itself (tagged `routeAttempt`) are considered, so local problems such as
 * reference preparation or storage never count against a channel.
 */
export function routeAvailabilityFailure(error) {
  if (!error || error.routeAttempt !== true || error.submissionUncertain) return null;
  const message = String(error.message || '');
  if (USER_INPUT_PATTERN.test(message)) return null;
  const code = generationFailureCode({ error: message });
  if (!AVAILABILITY_FAILURE_CODES.has(code)) return null;
  const status = Number(error.upstreamStatus);
  if (USER_INPUT_STATUSES.has(status) && code !== 'MODEL_UNAVAILABLE') return null;
  return code;
}

/**
 * Records one generation failure for a channel model. When the streak of
 * availability failures reaches the threshold the model is disabled through
 * the same update path the admin console uses, so the selector falls through
 * to the next priority route and an admin can re-enable it the usual way.
 */
export function recordModelRouteFailure({ routeId, error, generationId = null, threshold = ROUTE_AUTO_DISABLE_THRESHOLD, at = new Date().toISOString() } = {}) {
  if (!routeId) return { counted: false };
  const code = routeAvailabilityFailure(error);
  if (!code) return { counted: false };
  return tx(() => {
    const updated = sql('UPDATE model_routes SET runtime_failures = runtime_failures + 1 WHERE id = :id').run({ id: routeId });
    if (!Number(updated?.changes)) return { counted: false };
    const route = modelRoute(routeId);
    const failures = route.runtimeFailures;
    if (!route.adminEnabled || failures < threshold) return { counted: true, code, failures, autoDisabled: false };
    const lastError = String(error.message || '').slice(0, 240);
    const reason = `连续 ${failures} 次生成失败，已自动停用${lastError ? `：${lastError}` : ''}`.slice(0, 500);
    updateModelRoute(routeId, { adminEnabled: false }, {
      actorUserId: null,
      audit: { metadata: { reason: 'auto_disabled', failureCode: code, failures, threshold, generationId, lastError } },
    });
    sql('UPDATE model_routes SET auto_disabled_at = :at, auto_disabled_reason = :reason WHERE id = :id').run({ id: routeId, at, reason });
    appendSystemEvent({
      level: 'warning',
      category: 'model_route.auto_disabled',
      modelId: route.logicalModelId,
      generationId,
      message: `${route.displayName}：${reason}`,
      details: { routeId, credentialId: route.credentialId, upstreamModelId: route.upstreamModelId, quality: route.quality, failureCode: code, failures },
    });
    return { counted: true, code, failures, autoDisabled: true, route: modelRoute(routeId) };
  });
}

/** A successful generation ends the failure streak of its channel model. */
export function recordModelRouteSuccess(routeId) {
  if (!routeId) return;
  sql('UPDATE model_routes SET runtime_failures = 0 WHERE id = :id AND runtime_failures <> 0').run({ id: routeId });
}
