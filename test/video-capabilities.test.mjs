import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoPayload, validateVideoRequest } from '../lib/video-capabilities.mjs';

test('first and last frame mode selects continuity profile and enforces eight seconds', () => {
  const request = validateVideoRequest({ generationType:'FIRST&LAST', aspectRatio:'9:16', duration:8, quality:'1080p' }, 2);
  assert.equal(request.profileKey, 'continuity');
  assert.equal(request.generationType, 'FIRST&LAST');
  assert.equal(request.duration, 8);
  assert.throws(() => validateVideoRequest({ generationType:'FIRST&LAST', aspectRatio:'9:16', duration:10 }, 2), /固定为 8 秒/);
});

test('eight-second text and reference modes select the Veo routing', () => {
  const reference = validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'9:16', duration:8 }, 4);
  const text = validateVideoRequest({ generationType:'TEXT', aspectRatio:'16:9', duration:8 }, 0);
  assert.equal(reference.profileKey, 'veo');
  assert.equal(reference.model, 'veo3.1-fast');
  assert.equal(text.profileKey, 'veo');
  assert.equal(text.model, 'veo3.1-fast');
  assert.throws(() => validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'16:9', duration:8 }, 8), /1～7 张/);
});

test('reference image order is preserved in the provider payload', () => {
  const request = validateVideoRequest({ generationType:'REFERENCE', aspectRatio:'16:9', duration:10 }, 3);
  const ordered = ['prop-url', 'character-url', 'location-url'];
  const payload = buildVideoPayload({ model:request.model, prompt:'test', aspectRatio:request.aspectRatio, duration:request.duration, quality:request.quality, generationType:request.generationType, videoProfile:request.profileKey, maxReferenceImages:request.maxImages }, ordered);
  assert.deepEqual(payload.image_urls, ordered);
});

test('legacy image to video requests retain standard model compatibility', () => {
  const request = validateVideoRequest({ aspectRatio:'9:16', duration:10 }, 4);
  assert.equal(request.profileKey, 'standard');
  const payload = buildVideoPayload({ model:request.model, prompt:'test', aspectRatio:request.aspectRatio, duration:request.duration, quality:request.quality, generationType:request.generationType, videoProfile:request.profileKey, maxReferenceImages:request.maxImages }, ['a','b','c','d']);
  assert.equal(payload.generation_type, undefined);
  assert.equal(payload.image_urls.length, 4);
});

test('continuity payload follows provider field contract', () => {
  const payload = buildVideoPayload({ model:'configured-in-env', prompt:'广告', aspectRatio:'16:9', duration:8, quality:'4k', generationType:'FIRST&LAST', videoProfile:'continuity', maxReferenceImages:3 }, ['first','last']);
  assert.deepEqual(payload, { model:'configured-in-env', prompt:'广告', aspect_ratio:'16:9', duration:8, quality:'4k', generation_type:'FIRST&LAST', image_urls:['first','last'] });
});
