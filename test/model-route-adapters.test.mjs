import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../server.mjs';

const task = {
  model: 'upstream-model', prompt: '镜头推进', duration: 15,
  aspectRatio: '16:9', quality: '720p',
  referenceLimits: { image: 1, video: 1, audio: 1 },
};
const refs = { images: ['image-1', 'image-2'], videos: ['video-1'], audios: ['audio-1'] };

test('dynamic route adapters preserve each supplier field contract', () => {
  assert.deepEqual(__test.routedVideoPayload({ ...task, routeAdapter: 'wj-video' }, refs), {
    model: 'upstream-model', prompt: '镜头推进', seconds: 15, aspect_ratio: '16:9',
    images: ['image-1'], videos: ['video-1'], audios: ['audio-1'],
  });
  assert.deepEqual(__test.routedVideoPayload({ ...task, routeAdapter: 'diw-video' }, refs), {
    model: 'upstream-model', prompt: '镜头推进', duration: 15, aspect_ratio: '16:9', resolution: '720p',
    images: ['image-1'], videos: ['video-1'], audios: ['audio-1'],
  });
  assert.deepEqual(__test.routedVideoPayload({ ...task, routeAdapter: 'cntcn-video' }, refs), {
    model: 'upstream-model', prompt: '镜头推进', seconds: 15, aspect_ratio: '16:9', resolution: '720p',
    reference_image_urls: ['image-1'], reference_videos: ['video-1'], reference_audios: ['audio-1'],
  });
});
