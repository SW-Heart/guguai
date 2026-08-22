import assert from 'node:assert/strict';
import test from 'node:test';
import { macDmgUpdateFile } from '../desktop/manual-update.mjs';

test('macOS manual updater selects the same-origin HTTPS DMG', () => {
  const result = macDmgUpdateFile({ files: [
    { url: 'GuGu-AI-0.1.2-mac-arm64.zip', sha512: 'zip' },
    { url: 'GuGu-AI-0.1.2-mac-arm64.dmg', sha512: 'dmg', size: 42 },
  ] }, 'https://download.example.com/desktop-updates');
  assert.equal(result.downloadUrl, 'https://download.example.com/desktop-updates/GuGu-AI-0.1.2-mac-arm64.dmg');
  assert.equal(result.fileName, 'GuGu-AI-0.1.2-mac-arm64.dmg');
  assert.equal(result.sha512, 'dmg');
  assert.equal(result.size, 42);
});

test('macOS manual updater rejects insecure or cross-origin installers', () => {
  assert.throws(() => macDmgUpdateFile({ files: [{ url: 'update.dmg' }] }, 'http://download.example.com'), /必须是 HTTPS/);
  assert.throws(() => macDmgUpdateFile({ files: [{ url: 'https://other.example.com/update.dmg' }] }, 'https://download.example.com'), /缺少同源 HTTPS DMG/);
});
