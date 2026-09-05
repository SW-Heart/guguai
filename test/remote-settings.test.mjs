import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeControlledUrl } from '../desktop/remote-settings.mjs';

test('remote settings allow local HTTP only outside packaged production', () => {
  assert.equal(normalizeControlledUrl('http://127.0.0.1:4317/', { production:false }), 'http://127.0.0.1:4317');
  assert.equal(normalizeControlledUrl('https://studio.example.test/', { production:true, allowedOrigin:'https://studio.example.test' }), 'https://studio.example.test');
  assert.throws(() => normalizeControlledUrl('http://studio.example.test', { production:true }), /只允许 HTTPS/);
  assert.throws(() => normalizeControlledUrl('https://other.example.test', { production:true, allowedOrigin:'https://studio.example.test' }), /受控来源/);
  assert.equal(normalizeControlledUrl('', { production:true, allowEmpty:true }), '');
});
