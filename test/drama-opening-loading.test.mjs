import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('opening a short-drama project covers the list with a loading screen until the workbench shows', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('styles.css');
  assert.match(html, /id="dramaOpening" class="drama-project-loading"[^>]*role="status"[^>]*hidden>.*正在打开项目…/);
  assert.match(app, /setDramaOpening\(Boolean\(id\) && String\(dramaController\?\.project\?\.id \|\| ''\) !== id\)/);
  assert.match(app, /function syncDramaProjectLocation\([^)]*\) \{\n  setDramaOpening\(false\);/);
  assert.match(app, /\.finally\(\(\) => \{ if \(epoch === routeRenderEpoch && state\.route === 'drama'\) setDramaOpening\(false\); \}\)/);
  assert.match(css, /\.drama-view\.drama-opening>#dramaProjects,\.drama-view\.drama-opening>#dramaStudio \{ display:none !important; \}/);
});
