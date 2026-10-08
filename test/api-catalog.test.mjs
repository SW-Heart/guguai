import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApiModelCatalog, normalizeImageRequest, normalizeVideoRequest, publicModelObject, videoDimensions } from '../lib/api-catalog.mjs';
import { decodeDataUrl, fetchRemoteMedia, isPublicAddress, sniffMediaType } from '../lib/remote-media.mjs';
import { generateApiKey, hashApiKey } from '../repositories/api-platform.mjs';

const videoModel = {
  id:'seedance-2.0', label:'Seedance 2.0', description:'测试模型', availability:'available', enabled:true,
  modes:[
    { generationType:'TEXT', aspectRatios:['16:9', '9:16', '1:1'], durations:[5, 10], qualityOptions:['480p', '720p'], referenceLimits:{ image:9, video:3, audio:3, total:15 }, minImages:0, maxImages:0,
      durationsByQuality:{ '480p':{ '16:9':[5, 10], '9:16':[5, 10], '1:1':[5] }, '720p':{ '16:9':[5], '9:16':[5], '1:1':[5] } } },
    { generationType:'REFERENCE', aspectRatios:['16:9'], durations:[5], qualityOptions:['720p'], referenceLimits:{ image:9, video:3, audio:3, total:15 }, minImages:1, maxImages:9 },
  ],
};
const prices = [
  { modelId:'gpt-image-2', quality:'标准', duration:null, credits:1, yuan:0.1, unit:'request', available:true },
  { modelId:'seedance-2.0', quality:'720p', duration:5, credits:2, yuan:0.2, unit:'second', available:true },
];
const catalog = buildApiModelCatalog({
  imageModels:[{ id:'gpt-image-2.5', label:'GPT Image 2.5' }, { id:'gpt-image-2', label:'GPT-Image-2' }, { id:'midjourney', label:'Midjourney' }],
  videoModels:[videoModel, { ...videoModel, id:'hidden', availability:'coming-soon' }],
  prices,
  imageAspectRatios:['1:1', '16:9', '9:16'],
});
const model = id => catalog.find(item => item.id === id);

test('catalog lists only available models with OpenAI model objects', () => {
  assert.deepEqual(catalog.map(item => item.id), ['gpt-image-2.5', 'gpt-image-2', 'midjourney', 'seedance-2.0']);
  assert.deepEqual(publicModelObject(model('gpt-image-2')), { id:'gpt-image-2', object:'model', created:model('gpt-image-2').created, owned_by:'gugu-ai', type:'image', name:'GPT-Image-2' });
  assert.deepEqual(model('seedance-2.0').pricing, [{ quality:'720p', seconds:5, unit:'second', credits:2, yuan:0.2 }]);
  const text = model('seedance-2.0').modes[0];
  assert.deepEqual(text.seconds_by_resolution, { '480p':[5, 10], '720p':[5] });
  assert.ok(text.sizes.some(item => item.size === '1280x720' && item.aspect_ratio === '16:9' && item.resolution === '720p'));
});

test('video sizes follow aspect ratio and resolution', () => {
  assert.equal(videoDimensions('16:9', '720p'), '1280x720');
  assert.equal(videoDimensions('9:16', '1080p'), '1080x1920');
  assert.equal(videoDimensions('16:9', '480p'), '854x480');
  assert.equal(videoDimensions('1:1', '720p'), '720x720');
  assert.equal(videoDimensions('16:9', '标准'), '');
});

test('video requests map size, seconds and mode onto generation input', () => {
  const plain = normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪', size:'854x480', seconds:'10' });
  assert.deepEqual(plain.input, { type:'video', modelId:'seedance-2.0', prompt:'海浪', duration:10, aspectRatio:'16:9', quality:'480p', generationType:'TEXT' });
  assert.equal(plain.params.size, '854x480');
  const defaults = normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪' });
  assert.deepEqual([defaults.input.aspectRatio, defaults.input.quality, defaults.input.duration], ['16:9', '720p', 5]);
  assert.throws(() => normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪', size:'1280x720', seconds:10 }), error => error.apiParam === 'seconds');
  assert.throws(() => normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪', size:'1280x720', resolution:'480p' }), error => error.apiParam === 'resolution');
  assert.throws(() => normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪', mode:'first_last' }), error => error.apiParam === 'mode');
  assert.throws(() => normalizeVideoRequest(model('seedance-2.0'), { prompt:'' }), error => error.apiParam === 'prompt');
  const reference = normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪' }, { referenceCounts:{ image:2, video:1, audio:0 } });
  assert.equal(reference.input.generationType, 'REFERENCE');
  assert.throws(() => normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪', mode:'text' }, { referenceCounts:{ image:1, video:0, audio:0 } }), error => error.apiParam === 'mode');
  assert.throws(() => normalizeVideoRequest(model('seedance-2.0'), { prompt:'海浪' }, { referenceCounts:{ image:10, video:0, audio:0 } }), error => error.apiParam === 'input_reference');
});

test('image requests map OpenAI sizes and tiers', () => {
  assert.deepEqual(normalizeImageRequest(model('gpt-image-2'), { prompt:'猫', size:'1536x1024', n:'2' }).input, { type:'image', modelId:'gpt-image-2', prompt:'猫', size:'3:2', quality:'medium', quantity:2 });
  assert.throws(() => normalizeImageRequest(model('gpt-image-2'), { prompt:'猫', n:11 }), error => error.apiParam === 'n');
  const tiered = normalizeImageRequest(model('gpt-image-2.5'), { prompt:'猫', size:'3536x1984' });
  assert.deepEqual([tiered.input.size, tiered.input.quality], ['3536x1984', '4k'], 'the size decides the billed tier');
  assert.deepEqual(normalizeImageRequest(model('gpt-image-2.5'), { prompt:'猫', size:'16:9', quality:'2k' }).input.size, '2048x1152');
  assert.throws(() => normalizeImageRequest(model('gpt-image-2.5'), { prompt:'猫', size:'3536x1984', quality:'1k' }), error => error.apiParam === 'quality');
  const mj = normalizeImageRequest(model('midjourney'), { prompt:'猫', size:'16:9', n:8, stylize:'250', raw:'true' });
  assert.equal(mj.input.quantity, 8);
  assert.equal(mj.input.midjourneyOptions.stylize, 250);
  assert.equal(mj.input.midjourneyOptions.raw, true);
  assert.throws(() => normalizeImageRequest(model('midjourney'), { prompt:'猫', n:5 }), error => error.apiParam === 'n');
});

test('API keys are random and stored only as hashes', () => {
  const first = generateApiKey();
  const second = generateApiKey();
  assert.match(first.key, /^sk-gugu-[A-Za-z0-9_-]{40}$/);
  assert.notEqual(first.key, second.key);
  assert.equal(first.hash, hashApiKey(first.key));
  assert.ok(!first.hint.includes(first.key.slice(12, -4)));
});

test('reference downloads refuse private networks and detect media by content', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(fetchRemoteMedia('http://127.0.0.1:9/a.png', { maxBytes:1024 }), /公开/);
  await assert.rejects(fetchRemoteMedia('http://[::1]:9/a.png', { maxBytes:1024 }), /公开/);
  await assert.rejects(fetchRemoteMedia('ftp://example.com/a.png', { maxBytes:1024 }), /http/);
  await assert.rejects(fetchRemoteMedia('http://localhost:9/a.png', { maxBytes:1024 }), /公开/);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal(sniffMediaType(png), 'image/png');
  assert.equal(sniffMediaType(Buffer.from('000000186674797069736f6d', 'hex')), 'video/mp4');
  assert.equal(sniffMediaType(Buffer.from('ID3\u0004\u0000')), 'audio/mpeg');
  assert.equal(sniffMediaType(Buffer.from('<svg></svg>')), '');
  assert.deepEqual(decodeDataUrl(`data:image/png;base64,${png.toString('base64')}`, { maxBytes:1024 }).buffer, png);
  assert.throws(() => decodeDataUrl('data:image/png,abc', { maxBytes:1024 }), /base64/);
  assert.throws(() => decodeDataUrl(`data:image/png;base64,${Buffer.alloc(4096).toString('base64')}`, { maxBytes:1024 }), /MB/);
});

test('API console entry and marketing pages use current cache keys', async () => {
  const { readFile, access } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/api-console.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/api-console.js?v=1'));
  assert.ok(html.includes('/api-console.css?v=2'));
  assert.ok(html.includes('/marketing.css?v=15'));
  for (const match of html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:png|svg|js|css))(?:\?[^" ]*)?"/g)) await access(new URL(`../public${match[1]}`, import.meta.url));
  assert.doesNotMatch(html, /[↗→]/);
  for (const page of ['home', 'features', 'pricing', 'help']) {
    const source = await readFile(new URL(`../public/${page}.html`, import.meta.url), 'utf8');
    assert.ok(source.includes('<a class="nav-api" href="https://api.guguai.xyz">使用 API</a>'), `${page} links to the API site`);
  }
});

test('cloud copies of API results follow the six-day retention', async () => {
  const { cloudCopyExpiresAt } = await import('../services/media-retention.mjs');
  const { API_DEVICE_ID } = await import('../repositories/api-platform.mjs');
  const uploadedAt = '2026-10-01T00:00:00.000Z';
  const day = 24 * 3600_000;
  assert.equal(cloudCopyExpiresAt({ objectKey:'k', source:'generation', objectUploadedAt:uploadedAt, originDeviceId:API_DEVICE_ID }), Date.parse(uploadedAt) + 6 * day);
  assert.equal(cloudCopyExpiresAt({ objectKey:'k', source:'generation', objectUploadedAt:uploadedAt, originDeviceId:'desktop' }), Date.parse(uploadedAt) + 30 * day);
});
