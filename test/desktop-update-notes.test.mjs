import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNotesFor } from '../public/features/updates/release-notes.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

test('the update dialog lists the highlights of the version being installed', () => {
  const notes = releaseNotesFor('0.8.6');
  assert.equal(notes.length, 4);
  assert.deepEqual(releaseNotesFor('v0.8.6'), notes);
  assert.ok(notes.every(item => item.title && item.text && !/[↗→]/.test(item.title + item.text)));
  assert.deepEqual(releaseNotesFor('9.9.9'), []);
  assert.deepEqual(releaseNotesFor(undefined), []);
});

test('notes render only while an update is offered and are reachable through fresh cache keys', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /<ul id="desktopUpdateNotes" class="desktop-update-notes hidden"/);
  assert.match(html, /\/app\.js\?v=641"/);
  assert.match(html, /\/styles\.css\?v=441"/);
  assert.match(app, /from '\.\/features\/updates\/release-notes\.js\?v=1'/);
  assert.match(app, /\['available', 'downloading', 'downloaded'\]\.includes\(status\)/);
  assert.match(app, /esc\(item\.title\)/);
  assert.match(read('styles.css'), /\.desktop-update-notes li::before/);
});
