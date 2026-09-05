import test from 'node:test';
import assert from 'node:assert/strict';

import { generationRequestFingerprint } from '../lib/generation-service.mjs';

test('generation request fingerprints are deterministic and payload-sensitive', () => {
  const request = { type:'image', prompt:'a red door', quantity:1, referenceAssetIds:[] };
  const first = generationRequestFingerprint(request);
  assert.equal(first, generationRequestFingerprint({ ...request }));
  assert.equal(first, generationRequestFingerprint({ referenceAssetIds:[], quantity:1, prompt:'a red door', type:'image' }));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, generationRequestFingerprint({ ...request, quantity:2 }));
});
