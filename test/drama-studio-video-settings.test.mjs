import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShotVideoParameters } from '../public/drama-studio.js';

test('switching video model replaces only parameters unsupported by the selected model', () => {
  const shot = {
    aspectRatio: '9:16',
    duration: 15,
    generation: { quality: '480p' },
  };

  const changed = normalizeShotVideoParameters(shot, {
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [4, 5, 15],
    qualityOptions: ['768p', '2k'],
  });

  assert.equal(changed, true);
  assert.deepEqual(shot, {
    aspectRatio: '9:16',
    duration: 15,
    generation: { quality: '768p' },
  });
});

test('switching to a restrictive model selects supported defaults for every incompatible parameter', () => {
  const shot = {
    aspectRatio: '21:9',
    duration: 8,
    generation: { quality: '2k' },
  };

  normalizeShotVideoParameters(shot, {
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [15],
    qualityOptions: ['720p'],
  });

  assert.deepEqual(shot, {
    aspectRatio: '16:9',
    duration: 15,
    generation: { quality: '720p' },
  });
});
