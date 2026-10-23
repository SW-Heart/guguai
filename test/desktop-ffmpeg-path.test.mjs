import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnableBundledPath } from '../desktop/ffmpeg-path.mjs';

test('packaged ffmpeg resolves to the unpacked copy, never the ASAR path', () => {
  assert.equal(
    spawnableBundledPath('/Applications/GuGu AI.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg'),
    '/Applications/GuGu AI.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg',
  );
  assert.equal(
    spawnableBundledPath('C:\\Program Files\\GuGu AI\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'),
    'C:\\Program Files\\GuGu AI\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe',
  );
});

test('development ffmpeg path is kept as is', () => {
  assert.equal(spawnableBundledPath('/repo/node_modules/ffmpeg-static/ffmpeg'), '/repo/node_modules/ffmpeg-static/ffmpeg');
  assert.equal(spawnableBundledPath(''), '');
});
