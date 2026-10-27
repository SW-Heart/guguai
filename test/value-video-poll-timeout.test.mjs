import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutedProvider } from '../providers/routed.mjs';
import { isValueVideoTask } from '../services/generation-retry.mjs';
import { __test } from '../server.mjs';

const hour = 60 * 60_000;

test('special-offer video models wait up to 24 hours during generation', () => {
  assert.equal(__test.valueVideoMaxPollDurationMs, 24 * hour);
  assert.equal(__test.videoMaxPollDurationMs, 2 * hour);
  for (const id of ['wan-3.0-value', 'seedance-2.0-value', 'seedance-2.0-mini-value', 'seedance-2.0-fast-value', 'seedance-2.5-value']) assert.equal(isValueVideoTask({ videoModelId:id }), true, id);
  for (const id of ['wan-3.0', 'seedance-2.0', 'kling-4.0']) assert.equal(isValueVideoTask({ videoModelId:id }), false, id);
});

test('routed polling applies the per-task generation wait', async () => {
  const limits = [];
  const provider = createRoutedProvider({
    fetchJson:async () => ({ status:'processing' }), sleep:async () => {}, routeCredential:() => 'key',
    videoPollRemainingMs:(startedAt, maxMs) => { limits.push(maxMs); return Math.max(0, maxMs - (Date.now() - startedAt)); },
    videoPollRequestSignal:() => AbortSignal.timeout(1000), videoPollTimeoutError:() => new Error('timeout'),
    videoPollStartedAt:() => Date.now() - 3 * hour,
    videoMaxPollDurationMs:task => isValueVideoTask(task) ? 24 * hour : 2 * hour,
    notifyVideoProgress:async () => {}, upstreamRequestErrorDetail:() => '', isDefinitiveSubmitRejection:() => false, errorMessage:() => '失败',
  });
  const base = { provider:'route', providerTaskId:'t1', routeBaseUrl:'https://route.test', routeCredentialId:'c' };
  const pending = await provider.pollVideo({ ...base, videoModelId:'seedance-2.0-value' }, {}, { immediate:true, pollOnce:true });
  assert.equal(pending.pending, true);
  assert.ok(limits.every(ms => ms === 24 * hour));
  await assert.rejects(provider.pollVideo({ ...base, videoModelId:'seedance-2.0' }, {}, { immediate:true, pollOnce:true }), /timeout/);
});
