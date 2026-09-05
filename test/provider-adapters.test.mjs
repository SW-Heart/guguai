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
