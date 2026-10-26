import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutedProvider } from '../providers/routed.mjs';
import { createProviderTransport } from '../providers/transport.mjs';
import { createGenerationJobPolicy } from '../jobs/generation-policy.mjs';

const task = () => ({ id:'local-1', provider:'yk', routeId:'yk-route', routeAdapter:'yk-video', routeCredentialId:'yk-main', routeBaseUrl:'https://yk.test/v1/', model:'any-configured-model', prompt:'参考 @图片1 和 @音频1', duration:'5', quality:'1080p', aspectRatio:'9:16', referenceLimits:{ image:2, video:1, audio:1 } });
function setup(responses) {
  const calls = [];
  const transport = createProviderTransport({
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      const next = responses.shift();
      assert.ok(next, 'unexpected request');
      return new Response(JSON.stringify(next.body), { status:next.status || 200, headers:next.headers });
    }, errorMessage: value => value?.error?.message || '失败', videoProgress:() => null, sleep:async () => {},
  });
  const provider = createRoutedProvider({ ...transport, sleep:async () => {}, routeCredential:() => 'test-key', videoPollRemainingMs:() => 100_000, videoPollRequestSignal:() => AbortSignal.timeout(1000), videoPollTimeoutError:() => new Error('timeout'), videoPollStartedAt:() => Date.now(), videoMaxPollDurationMs:100_000, errorMessage:value => typeof value === 'string' ? value : value?.message || '失败' });
  return { provider, calls };
}

test('YK submits arbitrary configured models and typed references with stable idempotency', async () => {
  const { provider, calls } = setup([{ status:202, headers:{ 'Retry-After':'30' }, body:{ id:'original-id', url:'https://cdn.test/premature.mp4' } }]);
  const current = task();
  const submitted = [];
  const result = await provider.createVideo(current, { images:['https://cdn.test/a.png'], videos:['https://cdn.test/v.mp4'], audios:['https://cdn.test/a.wav'] }, { deferPolling:true, onSubmitted: value => { assert.equal(current.providerTaskId, 'original-id'); submitted.push(value); } });
  assert.equal(result.pending, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://yk.test/v1/videos');
  assert.equal(calls[0].headers['Idempotency-Key'], 'local-1:0');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].body), { model:'any-configured-model', prompt:'参考 @图片1 和 @音频1', duration:5, resolution:'1080p', ratio:'9:16', sound:true, generation_mode:'reference', media:[{type:'image', label:'图片1', url:'https://cdn.test/a.png'}, {type:'video', label:'视频1', url:'https://cdn.test/v.mp4'}, {type:'audio', label:'音频1', url:'https://cdn.test/a.wav'}] });
  assert.ok(current.providerNextPollAt > Date.now() + 29_000);
  assert.equal(submitted.length, 1);
  await provider.pollVideo(current, {}, { immediate:true, pollOnce:true });
  assert.equal(calls.length, 1, 'durable recovery respects Retry-After');
});

test('every routed H3 text submission overrides stale model IDs at every quality', async () => {
  for (const routeAdapter of ['yk-video', 'diw-video', 'wj-video', 'cntcn-video']) {
    for (const quality of ['480p', '768p', '1088p', '1440p']) {
      for (const refs of [[], { images:[], audios:['https://cdn.test/audio.wav'] }]) {
        const { provider, calls } = setup([{ body:{ id:'h3-text-task' } }]);
        await provider.createVideo({ ...task(), videoModelId:'minimax-h3-15s', model:'minimax_h3_zm_u24', routeAdapter, quality }, refs, { deferPolling:true });
        assert.equal(JSON.parse(calls[0].body).model, 'minimax_h3_z0901', `${routeAdapter} ${quality}`);
        assert.equal(calls.length, 1);
      }
    }
  }
});

test('routed H3 selects its model using submitted images and preserves other models', () => {
  const { provider } = setup([]);
  for (const routeAdapter of ['yk-video', 'diw-video', 'wj-video', 'cntcn-video']) {
    const current = { ...task(), videoModelId:'minimax-h3-15s', model:'minimax_h3_zm_u24', routeAdapter };
    assert.equal(provider.payload({ ...current, generationType:'TEXT' }, { images:['https://cdn.test/image.png'] }).model, current.model);
    assert.equal(provider.payload({ ...current, generationType:'REFERENCE' }, { images:[] }).model, 'minimax_h3_z0901');
    assert.equal(provider.payload({ ...current, model:'configured-h3-image-model' }, []).model, 'minimax_h3_z0901');
    assert.equal(provider.payload({ ...current, videoModelId:'seedance-2.0', model:'configured-seedance-model' }, []).model, 'configured-seedance-model');
  }
});

test('YK polls original task and downloads authenticated content only on success', async () => {
  const { provider, calls } = setup([{ body:{ status:'running', url:'https://cdn.test/early.mp4' } }, { body:{ status:'succeeded' } }]);
  const current = { ...task(), providerTaskId:'original-id' };
  assert.equal((await provider.pollVideo(current, {}, { immediate:true, pollOnce:true })).pending, true);
  current.providerNextPollAt = 0;
  assert.deepEqual(await provider.pollVideo(current, {}, { immediate:true, pollOnce:true }), { provider:'yk', taskId:'original-id', url:'https://yk.test/v1/videos/original-id/content', requiresAuth:true });
  assert.ok(calls.every(call => !call.method && call.url === 'https://yk.test/v1/videos/original-id'));
});

test('YK accepts OpenAI results and every documented result URL location', async () => {
  for (const fields of [{url:'https://cdn.test/out.mp4'}, {video_url:'https://cdn.test/out.mp4'}, {data:[{url:'https://cdn.test/out.mp4'}]}]) {
    const { provider } = setup([{body:{status:'completed', job_status:'succeeded', ...fields}}]);
    const result = await provider.pollVideo({...task(), providerTaskId:'id'}, {}, {immediate:true, pollOnce:true});
    assert.equal(result.url, 'https://cdn.test/out.mp4');
    assert.equal(result.requiresAuth, false);
  }
});

test('YK paused or financially held jobs remain pending until failure is confirmed', async () => {
  for (const body of [{status:'paused'}, {status:'failed', failure_confirmed:false}, {status:'failed', financial_hold:true}, {status:'failed', job_status:'paused', error:{message:'核查中'}}]) {
    const {provider} = setup([{body}]);
    assert.equal((await provider.pollVideo({...task(), providerTaskId:'id'}, {}, {immediate:true, pollOnce:true})).pending, true);
  }
  const {provider} = setup([{body:{status:'failed', failure_confirmed:true, financial_hold:false, error:{message:'失败'}}}]);
  await assert.rejects(provider.pollVideo({...task(), providerTaskId:'id'}, {}, {immediate:true, pollOnce:true}), error => error.upstreamTerminal === true && error.providerTaskId === 'id');
});

test('YK transport errors keep accepted jobs pending and honor Retry-After dates', async () => {
  const next = Date.now() + 120_000;
  const {provider} = setup([{status:429, headers:{'Retry-After':new Date(next).toUTCString()}, body:{error:{message:'稍后查询'}}}]);
  const current = {...task(), providerTaskId:'id'};
  assert.equal((await provider.pollVideo(current, {}, {immediate:true, pollOnce:true})).pending, true);
  assert.ok(current.providerNextPollAt >= next - 1000);
  const policy = createGenerationJobPolicy({providerTaskIdDeadline:() => 0});
  assert.equal(policy.nextRunAt(current, 'poll'), current.providerNextPollAt);
});

test('YK handles base addresses without v1 and never resubmits a saved task', async () => {
  const {provider, calls} = setup([{body:{status:'succeeded'}}]);
  const current = {...task(), routeBaseUrl:'https://yk.test', providerTaskId:'id'};
  await provider.createVideo(current, [], {deferPolling:true});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://yk.test/v1/videos/id');
  assert.equal(calls[0].method, undefined);
});

test('YK ambiguous submission errors never trigger a fresh billed task automatically', async () => {
  const {provider, calls} = setup([{status:503, body:{error:{message:'暂时不可用'}}}]);
  await assert.rejects(provider.createVideo(task(), [], {deferPolling:true}), error => error.submissionUncertain === true && !error.upstreamTerminal);
  assert.equal(calls.length, 1);
});

test('YK temporary credential failures do not establish that an accepted task failed', async () => {
  const {provider} = setup([{status:401, body:{error:{message:'请检查凭据'}}}]);
  assert.equal((await provider.pollVideo({...task(), providerTaskId:'id'}, {}, {immediate:true, pollOnce:true})).pending, true);
});

test('YK confirmed content rejection is final while billing remains held', async () => {
  const message = 'FAILED: The generated video may contain sensitive content and has been blocked. Try adjusting your prompt or reference media.';
  const {provider, calls} = setup([{body:{status:'paused', job_status:'paused', failure_confirmed:true, financial_hold:true, error:message, progress_known:false, progress:0}}]);
  const current = {...task(), providerTaskId:'original-id'};
  await assert.rejects(provider.pollVideo(current, {}, {immediate:true, pollOnce:true}), error => error.message === message && error.upstreamTerminal === true && error.retryable === false);
  assert.equal(current.providerFinancialHold, true);
  assert.equal(current.providerFailureConfirmed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, undefined);
});

test('YK nested confirmed failures preserve status detail and billing state', async () => {
  const {provider} = setup([{body:{data:{status:'paused', failure_confirmed:true, financial_hold:true, status_detail:'生成内容未通过审核'}}}]);
  const current = {...task(), providerTaskId:'original-id'};
  await assert.rejects(provider.pollVideo(current, {}, {immediate:true, pollOnce:true}), error => error.message === '生成内容未通过审核' && error.upstreamTerminal === true);
  assert.equal(current.providerFinancialHold, true);
});
