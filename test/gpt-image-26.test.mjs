import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, closeDatabase, sql } from '../lib/db.mjs';
import { isImageModelAvailable, updateModelControl } from '../lib/model-controls.mjs';
import { modelPriceFields } from '../lib/pricing.mjs';
import { buildApiModelCatalog, normalizeImageRequest } from '../lib/api-catalog.mjs';
import { GPT_IMAGE_26_ASPECTS, GPT_IMAGE_26_DIMENSIONS, GPT_IMAGE_26_QUALITIES } from '../lib/gpt-image-26.mjs';
import { createWjImageProvider } from '../providers/wj-image.mjs';
import { canvasGenerationPayload, canvasGenerationOptions } from '../public/features/drama/canvas-generation.js';

process.env.WJ_IMAGE_KEY = 'test-wj-image';
const { __test } = await import('../server.mjs');
openDatabase({ file:':memory:' });
after(() => closeDatabase({ checkpoint:false }));
const config = { imageModels:[{ id:'gpt-image-2.6', label:'GPT Image 2.6' }] };

function provider(fetchJson, options = {}) {
  return createWjImageProvider({
    baseUrl:'https://wj.example', apiKey:'wj-test-key', fetchJson,
    trackProviderSubmission:operation => operation, sleep:async () => {},
    upstreamRequestErrorDetail:error => error.message, ...options,
  });
}

test('GPT Image 2.6 sends text requests to generations with the exact upstream pixel size', async () => {
  for (const quality of GPT_IMAGE_26_QUALITIES) for (const aspect of GPT_IMAGE_26_ASPECTS) {
    let calls = 0;
    const wj = provider(async (url, options) => {
      calls++;
      assert.equal(url, 'https://wj.example/v1/images/generations');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer wj-test-key');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), { model:'gpt-image-2.6', prompt:'小猫', size:GPT_IMAGE_26_DIMENSIONS[aspect][quality], n:1, response_format:'url' });
      return { data:[{ url:'https://cdn.example/out.png' }] };
    });
    const result = await wj.createImage({ prompt:'小猫', size:aspect, quality }, [], { deferPolling:true });
    assert.deepEqual(result, { provider:'wj', taskId:'', url:'https://cdn.example/out.png' });
    assert.equal(calls, 1);
  }
});

test('GPT Image 2.6 sends reference images to edits as image_url entries', async () => {
  const refs = ['https://cdn.example/a.png', 'https://cdn.example/b.png'];
  const wj = provider(async (url, options) => {
    assert.equal(url, 'https://wj.example/v1/images/edits');
    const body = JSON.parse(options.body);
    assert.equal(body.size, '2048x1536');
    assert.deepEqual(body.images, refs.map(image_url => ({ image_url })));
    assert.equal(body.image_urls, undefined);
    return { data:[{ url:'https://cdn.example/edit.png' }] };
  });
  assert.equal((await wj.createImage({ prompt:'合成', size:'4:3', quality:'2k' }, refs)).url, 'https://cdn.example/edit.png');
});

test('GPT Image 2.6 retries only before connecting and never replays a lost response', async () => {
  let calls = 0;
  const retried = provider(async () => {
    if (++calls === 1) throw Object.assign(new Error('DNS failure'), { code:'EAI_AGAIN' });
    return { data:[{ url:'https://cdn.example/out.png' }] };
  });
  assert.equal((await retried.createImage({ prompt:'test', size:'1:1', quality:'1k' }, [])).url, 'https://cdn.example/out.png');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(provider(async () => { calls++; throw new Error('response lost'); }).createImage({ prompt:'test', size:'1:1', quality:'1k' }, []), error => error.submissionUncertain === true);
  assert.equal(calls, 1);
  for (const response of [{}, { data:[] }, { data:[{ b64_json:'' }] }]) {
    await assert.rejects(provider(async () => response).createImage({ prompt:'test', size:'1:1', quality:'1k' }, []), error => error.submissionUncertain === true);
  }
  const rejected = Object.assign(new Error('unsupported image size'), { upstreamStatus:500 });
  await assert.rejects(provider(async () => { throw rejected; }).createImage({ prompt:'test', size:'1:1', quality:'1k' }, []), error => error === rejected && !error.submissionUncertain);
  await assert.rejects(provider(() => assert.fail('unsupported sizes must not be submitted')).createImage({ prompt:'test', size:'1:2', quality:'1k' }, []), /不支持/);
});

test('GPT Image 2.6 logs upstream request rejections as warnings, not transport failures', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  const refused = Object.assign(new Error('图片请求未通过'), { upstreamStatus:400 });
  await assert.rejects(provider(async () => { throw refused; }).createImage({ prompt:'test', size:'1:1', quality:'1k' }, []), error => error === refused);
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(warnings.mock.calls[0].arguments[0], '[image] WJ submission rejected');
  await assert.rejects(provider(async () => { throw Object.assign(new Error('bad gateway'), { upstreamStatus:502 }); }).createImage({ prompt:'test', size:'1:1', quality:'1k' }, []));
  assert.equal(errors.mock.calls[0].arguments[0], '[image] WJ submission transport failure');
});

test('GPT Image 2.6 is listed first, costs one credit per image and rejects ratios it cannot draw', async () => {
  assert.equal(isImageModelAvailable('gpt-image-2.6', { WJ_IMAGE_KEY:'test' }), true);
  assert.equal(isImageModelAvailable('gpt-image-2.6', { TUZI_DEFAULT_API_KEY:'test', DUOMI_API_KEY:'test' }), false);
  const first = sql("SELECT model_id FROM model_controls WHERE kind = 'image' ORDER BY sort_order, model_id LIMIT 1").get();
  assert.equal(first.model_id, 'gpt-image-2.6');
  assert.deepEqual(modelPriceFields({ imagePerRequest:1 }).filter(row => row.modelId === 'gpt-image-2.6').map(row => [row.quality, row.amount]), [['1K',1], ['2K',1], ['4K',1]]);
  const prices = __test.publicPlatformPrices({ imagePerRequest:1, version:1 }, { models:[] });
  assert.deepEqual(prices.filter(row => row.modelId === 'gpt-image-2.6').map(row => [row.quality, row.credits]), [['1K',1], ['2K',1], ['4K',1]]);
  const [model] = buildApiModelCatalog({ imageModels:config.imageModels, videoModels:[], prices, imageAspectRatios:[] });
  assert.deepEqual(model.parameters.find(param => param.name === 'quality').values, ['1k','2k','4k']);
  for (const quality of GPT_IMAGE_26_QUALITIES) for (const aspect of GPT_IMAGE_26_ASPECTS) {
    const draft = { type:'image', modelId:'gpt-image-2.6', prompt:'小猫', aspect, quality, quantity:2, attachments:[] };
    assert.deepEqual(canvasGenerationOptions(draft, config).qualities, ['1k','2k','4k']);
    const payload = canvasGenerationPayload(draft, config);
    assert.equal(payload.size, aspect);
    assert.equal(payload.quality, quality);
    const normalized = normalizeImageRequest(model, { prompt:'小猫', size:GPT_IMAGE_26_DIMENSIONS[aspect][quality] });
    assert.deepEqual([normalized.input.size, normalized.input.quality], [aspect, quality]);
    const quote = await __test.generationRoute.submit({ user:{ id:'gpt26-quote-user' }, scope:{}, input:payload, previewOnly:true });
    assert.equal(quote.status, 200, JSON.stringify(quote));
    assert.equal(quote.data.credits, 2);
  }
  assert.ok(!canvasGenerationOptions({ type:'image', modelId:'gpt-image-2.6' }, config).aspects.includes('1:2'));
  assert.deepEqual(normalizeImageRequest(model, { prompt:'test' }).input.quality, '1k');
  assert.throws(() => normalizeImageRequest(model, { prompt:'test', size:'1:2' }), /size/);
  assert.throws(() => normalizeImageRequest(model, { prompt:'test', size:'2048x2048', quality:'1k' }), /不匹配/);
  assert.throws(() => normalizeImageRequest(model, { prompt:'test', quality:'3k' }), /清晰度/);
  for (const input of [{ size:'1:2' }, { size:'2:1' }, { quality:'medium' }]) {
    const invalid = await __test.generationRoute.submit({ user:{ id:'gpt26-quote-user' }, scope:{}, input:{ type:'image', modelId:'gpt-image-2.6', prompt:'test', ...input }, previewOnly:true });
    assert.equal(invalid.status, 400);
  }
  updateModelControl('gpt-image-2.6', { userVisible:false });
  assert.equal(isImageModelAvailable('gpt-image-2.6', process.env), false);
});
