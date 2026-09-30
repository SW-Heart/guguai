import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { ensureDefaultModelRoutes, modelRoute, selectModelRoute, updateModelRoute, updateRoutePolicy } from '../lib/model-routes.mjs';
import { ROUTE_AUTO_DISABLE_THRESHOLD, recordModelRouteFailure, recordModelRouteSuccess, routeAvailabilityFailure } from '../lib/model-route-health.mjs';
import { createRoutedProvider } from '../providers/routed.mjs';

const envNames = ['DIW_KEY', 'WJ_TJWD_KEY', 'WJ_SD_PY_900_KEY', 'CNTCN_KEY', 'MODEL_ROUTE_CREDENTIAL_SECRET'];
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

function freshDb() {
  resetForTests();
  openDatabase({ file: ':memory:' });
  process.env.DIW_KEY = 'diw-test';
  process.env.WJ_TJWD_KEY = 'wj-test';
  process.env.WJ_SD_PY_900_KEY = 'wj-py-test';
  process.env.CNTCN_KEY = 'cntcn-test';
  process.env.MODEL_ROUTE_CREDENTIAL_SECRET = 'model-route-test-secret';
  ensureDefaultModelRoutes();
}

function cleanupDb() {
  closeDatabase({ checkpoint: false });
  resetForTests();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const routeError = (message, extra = {}) => Object.assign(new Error(message), { routeAttempt: true, upstreamTerminal: true, ...extra });
const request = { logicalModelId: 'seedance-2.0', quality: '480p', duration: 15, aspectRatio: '16:9' };

test('availability failures are separated from user-caused failures', () => {
  for (const [message, extra] of [
    ['503 service unavailable', { upstreamStatus: 503 }],
    ['502 Bad Gateway', { upstreamStatus: 502 }],
    ['401 invalid api key', { upstreamStatus: 401 }],
    ['400 model seedance-x does not exist', { upstreamStatus: 400 }],
    ['模型不存在或未开放', {}],
    ['402 insufficient balance', { upstreamStatus: 402 }],
    ['模型无响应：超过7分钟未获得上游任务 ID', {}],
    ['视频生成等待超时', { pollTimedOut: true }],
  ]) assert.ok(routeAvailabilityFailure(routeError(message, extra)), message);

  for (const [message, extra] of [
    ['400 prompt contains prohibited content', { upstreamStatus: 400 }],
    ['500 input image may violate our usage policies', { upstreamStatus: 500 }],
    ['内容审核未通过：包含敏感信息', {}],
    ['451 unavailable for legal reasons', { upstreamStatus: 451 }],
    ['422 invalid parameter: duration', { upstreamStatus: 422 }],
    ['400 reference image #2 could not be downloaded', { upstreamStatus: 400 }],
    ['503 输入的提示词包含违禁词', { upstreamStatus: 503 }],
    ['video may contain real person', {}],
    ['Prompt length exceeds the maximum allowed length of 2000', {}],
    ['429 too many requests', { upstreamStatus: 429 }],
    ['生成失败', {}],
  ]) assert.equal(routeAvailabilityFailure(routeError(message, extra)), null, message);

  assert.equal(routeAvailabilityFailure(Object.assign(new Error('503 service unavailable'), { upstreamStatus: 503 })), null, 'errors outside the channel call never count');
  assert.equal(routeAvailabilityFailure(routeError('视频提交结果待确认：socket hang up', { submissionUncertain: true })), null);
});

test('routed provider tags channel errors for health tracking', async () => {
  const provider = createRoutedProvider({
    fetchJson: async () => { throw Object.assign(new Error('503 service unavailable'), { upstreamStatus: 503 }); },
    sleep: async () => {}, routeCredential: () => 'key', videoPollRemainingMs: () => 1000,
    videoPollRequestSignal: () => undefined, videoPollTimeoutError: () => new Error('timeout'), videoPollStartedAt: () => Date.now(),
    videoMaxPollDurationMs: 1000, notifyVideoProgress: async () => {}, upstreamRequestErrorDetail: error => error.message,
    isDefinitiveSubmitRejection: error => Number(error.upstreamStatus) >= 400, errorMessage: value => String(value),
  });
  await assert.rejects(provider.createVideo({ routeCredentialId: 'diw-main', routeBaseUrl: 'https://example.test', model: 'm', prompt: 'p', duration: 15 }, []), error => error.routeAttempt === true && error.upstreamTerminal === true);
});

test('channel model auto-disable after consecutive availability failures', async t => {
  t.beforeEach(freshDb);
  t.afterEach(cleanupDb);

  await t.test('three consecutive failures disable only that channel model and fall back to the next priority', () => {
    const first = selectModelRoute(request);
    for (let index = 1; index < ROUTE_AUTO_DISABLE_THRESHOLD; index++) {
      const outcome = recordModelRouteFailure({ routeId: first.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }), generationId: `gen-${index}` });
      assert.deepEqual([outcome.counted, outcome.autoDisabled, outcome.failures], [true, false, index]);
      assert.equal(selectModelRoute(request).id, first.id);
    }
    const outcome = recordModelRouteFailure({ routeId: first.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }), generationId: 'gen-3' });
    assert.equal(outcome.autoDisabled, true);

    const disabled = modelRoute(first.id);
    assert.equal(disabled.adminEnabled, false);
    assert.equal(disabled.autoDisabled, true);
    assert.match(disabled.autoDisabledReason, /连续 3 次生成失败/);
    assert.ok(disabled.autoDisabledAt);
    assert.equal(disabled.version, first.version + 1);

    const next = selectModelRoute(request);
    assert.ok(next && next.id !== first.id);
    assert.ok(next.priority >= first.priority);

    const audit = sql("SELECT actor_user_id, metadata_json FROM audit_events WHERE action='model_route.update' AND target_id=:id").all({ id: first.id });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, null);
    assert.equal(JSON.parse(audit[0].metadata_json).reason, 'auto_disabled');
    assert.equal(sql("SELECT COUNT(*) AS count FROM system_events WHERE category='model_route.auto_disabled'").get().count, 1);

    // Further failures on an already disabled route do not disable it again.
    recordModelRouteFailure({ routeId: first.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    assert.equal(sql("SELECT COUNT(*) AS count FROM audit_events WHERE action='model_route.update' AND target_id=:id").get({ id: first.id }).count, 1);
  });

  await t.test('user-caused failures never count and a success resets the streak', () => {
    const route = selectModelRoute(request);
    recordModelRouteFailure({ routeId: route.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    recordModelRouteFailure({ routeId: route.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    for (let index = 0; index < 5; index++) {
      assert.equal(recordModelRouteFailure({ routeId: route.id, error: routeError('400 prompt contains prohibited content', { upstreamStatus: 400 }) }).counted, false);
    }
    assert.equal(modelRoute(route.id).runtimeFailures, 2);
    assert.equal(modelRoute(route.id).adminEnabled, true);

    recordModelRouteSuccess(route.id);
    assert.equal(modelRoute(route.id).runtimeFailures, 0);
    recordModelRouteFailure({ routeId: route.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    recordModelRouteFailure({ routeId: route.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    assert.equal(modelRoute(route.id).adminEnabled, true);
  });

  await t.test('a forced route that gets auto-disabled falls through to the priority order', () => {
    const routes = [selectModelRoute(request)];
    const forced = sql('SELECT id FROM model_routes WHERE logical_model_id=:modelId AND quality=:quality AND id<>:id ORDER BY priority DESC LIMIT 1').get({ modelId: routes[0].logicalModelId, quality: routes[0].quality, id: routes[0].id });
    assert.ok(forced, 'fixture needs a second route in the same pool');
    updateRoutePolicy(routes[0].logicalModelId, routes[0].quality, forced.id);
    assert.equal(selectModelRoute(request).id, forced.id);
    for (let index = 0; index < ROUTE_AUTO_DISABLE_THRESHOLD; index++) recordModelRouteFailure({ routeId: forced.id, error: routeError('模型不存在') });
    assert.equal(selectModelRoute(request).id, routes[0].id);
  });

  await t.test('an admin can re-enable an auto-disabled route and its streak restarts', () => {
    const route = selectModelRoute(request);
    for (let index = 0; index < ROUTE_AUTO_DISABLE_THRESHOLD; index++) recordModelRouteFailure({ routeId: route.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    const disabled = modelRoute(route.id);
    assert.equal(disabled.autoDisabled, true);

    const enabled = updateModelRoute(route.id, { adminEnabled: true }, { actorUserId: null, expectedVersion: disabled.version });
    assert.equal(enabled.adminEnabled, true);
    assert.equal(enabled.autoDisabled, false);
    assert.equal(enabled.autoDisabledAt, null);
    assert.equal(enabled.autoDisabledReason, '');
    assert.equal(enabled.runtimeFailures, 0);
    assert.equal(selectModelRoute(request).id, route.id);

    // A single new failure after re-enabling does not disable it again.
    recordModelRouteFailure({ routeId: route.id, error: routeError('503 service unavailable', { upstreamStatus: 503 }) });
    assert.equal(modelRoute(route.id).adminEnabled, true);
  });

  await t.test('a manual admin disable is not reported as automatic', () => {
    const route = selectModelRoute(request);
    const disabled = updateModelRoute(route.id, { adminEnabled: false }, { expectedVersion: route.version });
    assert.equal(disabled.adminEnabled, false);
    assert.equal(disabled.autoDisabled, false);
  });
});
