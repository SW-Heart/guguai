import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../server.mjs';

const { detectUploadContentMime } = __test;

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const mp4 = Buffer.concat([Buffer.from('00000018', 'hex'), Buffer.from('ftypmp42')]);
const intent = (mimeType, kind = 'image') => ({ mimeType, kind });

test('upload content type keeps the declared type when the content matches', () => {
  assert.equal(detectUploadContentMime(intent('image/png'), png), 'image/png');
  assert.equal(detectUploadContentMime(intent('video/mp4', 'video'), mp4), 'video/mp4');
});

test('upload content type follows the real image format when the extension is wrong', () => {
  assert.equal(detectUploadContentMime(intent('image/png'), jpeg), 'image/jpeg');
  assert.equal(detectUploadContentMime(intent('image/png'), webp), 'image/webp');
  assert.equal(detectUploadContentMime(intent('image/jpeg'), png), 'image/png');
});

test('upload content type rejects unsupported content with a readable reason', () => {
  assert.throws(
    () => detectUploadContentMime(intent('image/png'), Buffer.from('<!doctype html><html>')),
    error => error.statusCode === 422 && error.code === 'UPLOAD_MAGIC_MISMATCH' && /不是可识别的图片/.test(error.message) && /PNG、JPG、WebP/.test(error.message),
  );
  assert.throws(
    () => detectUploadContentMime(intent('image/png'), mp4),
    error => error.code === 'UPLOAD_MAGIC_MISMATCH' && /实际是视频/.test(error.message),
  );
});
