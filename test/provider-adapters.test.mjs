import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAdapterRegistry } from '../lib/provider-adapters.mjs';
import { createRoutedProvider } from '../providers/routed.mjs';

const methods = {
  validate: value => value,
  submit: async value => value,
  poll: async value => value,
  lookup: async value => value,
};

test('provider adapter registry enforces the common contract and resolves routes', async () => {
  const registry = createProviderAdapterRegistry({ duomi:methods, route:{ ...methods, name:'route-adapter' } });
  assert.deepEqual(registry.names, ['duomi', 'route']);
  assert.equal(registry.get('duomi').name, 'duomi');
  assert.equal(registry.forTask({ provider:'duomi' }).name, 'duomi');
  assert.equal(registry.forTask({ provider:'cntcn', routeId:'route-1' }).name, 'route-adapter');
  assert.equal(registry.get('missing'), null);
  assert.equal(await registry.get('duomi').submit('task'), 'task');
});

test('provider adapter registry rejects incomplete adapters', () => {
  assert.throws(() => createProviderAdapterRegistry({ broken:{ validate:() => true } }), /缺少 submit/);
});

test('routed polling clears a persisted retry marker after a later durable poll succeeds', async () => {
  const responses = [
    Object.assign(new Error('502 Bad Gateway'), { upstreamStatus: 502 }),
    { status: 'processing', progress: 42 },
  ];
  let lastPollError = '';
  let recovered = 0;
  const hooks = {
    onPollError: ({ detail }) => { lastPollError = detail; },
    onPollRecovered: () => { lastPollError = ''; recovered += 1; },
  };
  const provider = createRoutedProvider({
    fetchJson: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async () => {},
    routeCredential: () => 'test-key',
    videoPollRemainingMs: () => 10_000,
    videoPollRequestSignal: () => undefined,
    videoPollTimeoutError: () => new Error('poll timeout'),
    videoPollStartedAt: () => 0,
    videoMaxPollDurationMs: 10_000,
    notifyVideoProgress: async () => {},
    upstreamRequestErrorDetail: error => error.message,
    isDefinitiveSubmitRejection: () => false,
    errorMessage: value => String(value),
  });
  const task = { provider: 'wj', providerTaskId: 'provider-task-1', routeBaseUrl: 'https://example.com', routeCredentialId: 'test' };

  const first = await provider.pollVideo(task, hooks, { immediate: true, pollOnce: true });
  assert.equal(first.pending, true);
  assert.match(lastPollError, /502/);

  const second = await provider.pollVideo(task, hooks, { immediate: true, pollOnce: true });
  assert.equal(second.pending, true);
  assert.equal(lastPollError, '');
  assert.equal(recovered, 1);
});

function expiredRoutedProvider(fetchJson, overrides = {}) {
  return createRoutedProvider({
    fetchJson,
    sleep: async () => {},
    routeCredential: () => 'test-key',
    videoPollRemainingMs: () => 0,
    videoPollRequestSignal: () => { throw new Error('expired budget must use a final-check signal'); },
    videoPollTimeoutError: () => Object.assign(new Error('poll timeout'), { upstreamTerminal: true, pollTimedOut: true }),
    videoPollStartedAt: () => 0,
    videoMaxPollDurationMs: 60 * 60_000,
    notifyVideoProgress: async () => {},
    upstreamRequestErrorDetail: error => error.message,
    isDefinitiveSubmitRejection: () => false,
    errorMessage: value => String(value),
    ...overrides,
  });
}
const expiredTask = { provider: 'wj', providerTaskId: 'finished-upstream', routeBaseUrl: 'https://example.com', routeCredentialId: 'test' };

test('routed recovery accepts an upstream success after the local polling deadline', async () => {
  let calls = 0;
  const provider = expiredRoutedProvider(async (_url, options) => {
    calls += 1;
    assert.equal(options.signal.aborted, false);
    return { status: 'completed', video_url: 'https://example.com/result.mp4' };
  });
  const result = await provider.pollVideo(expiredTask, {}, { immediate: true, pollOnce: true });
  assert.equal(calls, 1);
  assert.equal(result.url, 'https://example.com/result.mp4');
});

test('routed recovery checks upstream before timing out a still-pending task', async () => {
  let calls = 0;
  const provider = expiredRoutedProvider(async () => { calls += 1; return { status: 'processing' }; });
  await assert.rejects(provider.pollVideo(expiredTask, {}, { immediate: true, pollOnce: true }), { pollTimedOut: true });
  assert.equal(calls, 1);
});

test('routed final-check transport errors remain recoverable without terminal refund', async () => {
  for (const upstreamStatus of [undefined, 502]) {
    const provider = expiredRoutedProvider(async () => { throw Object.assign(new Error('network timeout'), { upstreamStatus }); });
    await assert.rejects(provider.pollVideo(expiredTask, {}, { immediate: true, pollOnce: true }), error => {
      assert.equal(error.upstreamTerminal, undefined);
      assert.equal(error.providerTaskId, expiredTask.providerTaskId);
      return true;
    });
  }
});

test('routed polling checks the result when its budget expires during the poll delay', async () => {
  let remaining = 1;
  const provider = expiredRoutedProvider(async () => ({ status: 'completed', url: '/result.mp4' }), {
    videoPollRemainingMs: () => remaining,
    sleep: async () => { remaining = 0; },
  });
  assert.equal((await provider.pollVideo(expiredTask)).url, 'https://example.com/result.mp4');
});
