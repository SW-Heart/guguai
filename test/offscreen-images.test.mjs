import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOffscreenImages, placeholderImage, scrollContainer } from '../public/features/media/offscreen-images.js';

function image(src) {
  const attributes = { src };
  return { nodeType:1, isConnected:true, dataset:{}, getAttribute:name => attributes[name] ?? null, setAttribute:(name, value) => { attributes[name] = value; } };
}

test('far-off pictures release to a placeholder and restore their exact URL', () => {
  let callback, options;
  const observed = new Set();
  class IO { constructor(fn, opts) { callback = fn; options = opts; } observe(el) { observed.add(el); } unobserve(el) { observed.delete(el); } disconnect() { observed.clear(); } }
  const a = image('gugu-media://asset/a?thumbnail=1'), b = image('gugu-media://asset/b?thumbnail=1');
  const scroller = { nodeType:1, parentElement:null };
  const root = { nodeType:1, parentElement:scroller, children:[a, b], contains:el => root.children.includes(el), querySelectorAll:() => root.children };
  const images = createOffscreenImages({ root, IntersectionObserver:IO, getComputedStyle:el => ({ overflowY:el === scroller ? 'auto' : 'visible' }) });
  images.scan();
  assert.equal(options.root, scroller, 'margins apply to the element that actually scrolls');
  assert.equal(options.rootMargin, '1200px 0px');
  assert.equal(observed.size, 2);
  callback([{ target:a, isIntersecting:false }, { target:b, isIntersecting:true }]);
  assert.equal(a.getAttribute('src'), placeholderImage);
  assert.equal(b.getAttribute('src'), 'gugu-media://asset/b?thumbnail=1');
  callback([{ target:a, isIntersecting:false }]);
  assert.equal(a.dataset.releasedSrc, 'gugu-media://asset/a?thumbnail=1', 'a second release keeps the original URL');
  callback([{ target:a, isIntersecting:true }]);
  assert.equal(a.getAttribute('src'), 'gugu-media://asset/a?thumbnail=1');
  assert.equal(a.dataset.releasedSrc, undefined);
  root.children = [b]; a.isConnected = false;
  images.scan();
  assert.deepEqual([...observed], [b], 'removed cards stop being observed');
});

test('scroll container lookup starts at the grid itself', () => {
  const outer = { nodeType:1, parentElement:null }, grid = { nodeType:1, parentElement:outer };
  assert.equal(scrollContainer(grid, el => ({ overflowY:el === grid ? 'auto' : 'auto' })), grid);
  assert.equal(scrollContainer(grid, el => ({ overflowY:el === outer ? 'scroll' : 'visible' })), outer);
  assert.equal(scrollContainer(grid, () => ({ overflowY:'visible' })), null);
});

test('library and picker grids release off-screen pictures but leave upload previews alone', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("import { createOffscreenImages } from './features/media/offscreen-images.js?v=1';"));
  assert.ok(app.includes("['#fileGrid', '.file-card:not(.upload-job-card) img']"));
  assert.ok(app.includes("['#referenceGrid', '.reference-option img']"));
});
