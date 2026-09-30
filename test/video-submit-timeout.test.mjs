import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutedProvider } from '../providers/routed.mjs';
import { createDuomiProvider } from '../providers/duomi.mjs';
import { createTtapiProvider } from '../providers/ttapi.mjs';
import { createCntcnProvider } from '../providers/cntcn.mjs';
import { createAutodlProvider } from '../providers/autodl.mjs';
import { createOaiProvider } from '../providers/oai.mjs';

for (const [name, createProvider] of Object.entries({
  routed:createRoutedProvider, duomi:createDuomiProvider, ttapi:createTtapiProvider,
  cntcn:createCntcnProvider, autodl:createAutodlProvider, oai:createOaiProvider,
})) {
  test(`${name} allows a video submission to wait ten minutes for the provider response`, async t => {
    t.mock.timers.enable({ apis:['setTimeout'] });
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    let requestSignal;
    const provider = createProvider({
      baseUrl:'https://provider.example', apiKey:'test-key', workflowId:'test-workflow',
      keys:{ gemini:'test-key' }, videoModelIds:{}, legacyVideoModelIds:{},
      fetchJson:(_url, { signal }) => {
        requestSignal = signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once:true }));
      },
      trackProviderSubmission:value => value,
      sleep:async () => {}, routeCredential:() => 'test-key',
      videoPollRemainingMs:() => 120 * 60_000, videoPollRequestSignal:() => undefined,
      videoPollTimeoutError:() => new Error('poll timeout'), videoPollStartedAt:() => Date.now(),
      videoMaxPollDurationMs:120 * 60_000, imageMaxPollDurationMs:10 * 60_000,
      buildVideoPayload:() => ({}), buildPayload:() => ({}),
      notifyVideoProgress:async () => {}, upstreamRequestErrorDetail:error => error.message,
      isDefinitiveSubmitRejection:() => false, errorMessage:value => String(value),
    });
    const task = {
      type:'video', provider:name, videoModelId:'test-model', model:'test-model',
      prompt:'test', duration:5, aspectRatio:'16:9', quality:'720p',
      routeBaseUrl:'https://provider.example', routeCredentialId:'test',
    };
    const rejected = assert.rejects(provider.createVideo(task, [], { deferPolling:true }));
    assert.ok(requestSignal, 'the provider submission must start');
    t.mock.timers.tick(599999);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(requestSignal.aborted, true);
    await rejected;
  });
}
