import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { justifiedRows } from '../public/features/media/justified-layout.js';
import { parseMediaRatio, mediaRatio, rememberMediaRatio, knownMediaRatio } from '../public/features/media/media-ratio.js';

const ratioSource = readFileSync(new URL('../public/features/media/media-ratio.js', import.meta.url), 'utf8');
// Inline the shared ratio cache so the layout can run in a plain script context.
const withoutModules = source => `${ratioSource}\n${source}`.replace(/^import .*$/gm, '').replaceAll('export function', 'function');

test('mixed image ratios fill every complete row without cropping or reordering', () => {
  for (const width of [320, 768, 1000, 1440]) {
    const ratios = [2, 1, .5, 16 / 9, 9 / 16, 1, 3, .75, 1.5, 1];
    const rows = justifiedRows(ratios, width);
    let index = 0;
    rows.forEach((row, rowIndex) => {
      assert.equal(row.start, index);
      row.widths.forEach(itemWidth => {
        assert.ok(itemWidth > 0 && row.height > 0);
        assert.ok(Math.abs(itemWidth / row.height - ratios[index++]) < 1e-9);
      });
      const occupied = row.widths.reduce((sum, value) => sum + value, 0) + 12 * (row.widths.length - 1);
      if (rowIndex < rows.length - 1) assert.ok(Math.abs(occupied - width) < 1e-8);
      else assert.ok(occupied <= width + 1e-8);
    });
    assert.equal(index, ratios.length);
  }
});

test('an incomplete final row stays at target height and left aligned', () => {
  const rows = justifiedRows([2, 1, .5], 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].height, 220);
  assert.deepEqual(rows[0].widths, [440, 220, 110]);
});

test('single panoramas fit, unknown dimensions have a fallback, hidden grids defer layout', () => {
  assert.deepEqual(justifiedRows([10], 1000)[0], { start:0, height:100, widths:[1000] });
  assert.deepEqual(justifiedRows([0, NaN, -2], 1000)[0].widths, [220, 220, 220]);
  assert.deepEqual(justifiedRows([1], 0), []);
  assert.deepEqual(justifiedRows([], 1000), []);
});

test('file library loads its layout through the current frontend cache chain', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=636'));
  assert.ok(html.includes('/styles.css?v=439'));
  assert.ok(app.includes('./features/media/justified-layout.js?v=4'));
});

test('poster-only portrait videos use cover dimensions and retain them when offscreen', () => {
  const frames = [];
  const probes = [];
  let posterChanged;
  const video = { tagName:'VIDEO', videoWidth:0, videoHeight:0, poster:'', getAttribute() { return this.poster; } };
  const card = { classList:{ contains:() => true }, dataset:{ aspectRatio:'1' }, style:{}, querySelector:() => video, contains:node => node === video };
  const grid = { style:{}, clientWidth:1000, children:[card], classList:{ toggle() {} }, addEventListener() {} };
  const context = vm.createContext({
    requestAnimationFrame:callback => { frames.push(callback); return frames.length; },
    getComputedStyle:() => ({ paddingLeft:'0', paddingRight:'0', columnGap:'12' }),
    Image:class { constructor() { probes.push(this); } },
    MutationObserver:class { constructor(callback) { posterChanged = callback; } observe() {} },
    ResizeObserver:class { observe() {} },
  });
  const source = readFileSync(new URL('../public/features/media/justified-layout.js', import.meta.url), 'utf8');
  vm.runInContext(withoutModules(source), context);
  const layout = context.createJustifiedFileLayout(grid);
  layout.schedule(); frames.shift()();
  assert.equal(parseFloat(card.style.height), 220);
  video.poster = 'gugu-media://portrait?thumbnail=1';
  posterChanged(); frames.shift()();
  assert.equal(probes.length, 1);
  probes[0].naturalWidth = 288;
  probes[0].naturalHeight = 512;
  probes[0].onload(); frames.shift()();
  assert.ok(Math.abs(parseFloat(card.style.width) / parseFloat(card.style.height) - 9 / 16) < .001);
  const portraitWidth = card.style.width;
  video.poster = '';
  posterChanged(); frames.shift()();
  assert.equal(card.style.width, portraitWidth);
  video.poster = 'gugu-media://portrait?thumbnail=1';
  posterChanged(); frames.shift()();
  assert.equal(probes.length, 1, 'returning to the viewport reuses known dimensions');
});

function imageLayoutFixture() {
  const frames = [];
  let writes = 0;
  const images = [0, 1].map(() => ({ tagName:'IMG', dataset:{}, naturalWidth:288, naturalHeight:512, complete:true, currentSrc:'gugu-media://image' }));
  const cards = images.map(image => ({
    classList:{ contains:() => true }, dataset:{ aspectRatio:'1' },
    style:new Proxy({}, { set(target, key, value) { writes++; target[key] = value; return true; } }),
    querySelector:() => image,
  }));
  const grid = { style:{}, scrollTop:0, clientWidth:1000, children:cards, classList:{ toggle() {} }, addEventListener() {}, getBoundingClientRect:() => ({ top:0 }) };
  const context = vm.createContext({
    requestAnimationFrame:callback => { frames.push(callback); return frames.length; },
    getComputedStyle:() => ({ paddingLeft:'0', paddingRight:'0', columnGap:'12' }),
    ResizeObserver:class { observe() {} },
  });
  const source = readFileSync(new URL('../public/features/media/justified-layout.js', import.meta.url), 'utf8');
  vm.runInContext(withoutModules(source), context);
  const layout = context.createJustifiedFileLayout(grid);
  const draw = () => { layout.schedule(); frames.shift()(); };
  draw();
  return { images, cards, grid, draw, writes:() => writes };
}

test('offscreen placeholder and source restoration never change rows or rewrite geometry', () => {
  const { images, cards, draw, writes } = imageLayoutFixture();
  const width = cards[0].style.width;
  const initialWrites = writes();
  for (let cycle = 0; cycle < 20; cycle++) {
    images[0].dataset.releasedSrc = 'gugu-media://image';
    images[0].currentSrc = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    images[0].naturalWidth = images[0].naturalHeight = 1;
    draw();
    delete images[0].dataset.releasedSrc;
    images[0].complete = false;
    draw();
    images[0].complete = true;
    images[0].currentSrc = 'gugu-media://image';
    images[0].naturalWidth = 288;
    images[0].naturalHeight = 512;
    draw();
  }
  assert.equal(cards[0].style.width, width);
  assert.equal(writes(), initialWrites, 'scrolling and restoring already known images performs no layout writes');
});

test('a newly discovered image ratio preserves the visible card position during scrolling', () => {
  const { images, cards, grid, draw } = imageLayoutFixture();
  grid.scrollTop = 50;
  cards[0].getBoundingClientRect = () => ({ top:-300, bottom:-100 });
  cards[1].getBoundingClientRect = () => ({ top:parseFloat(cards[0].style.width) - grid.scrollTop, bottom:500 });
  const originalTop = cards[1].getBoundingClientRect().top;
  images[0].naturalWidth = 1024;
  draw();
  assert.ok(Math.abs(cards[1].getBoundingClientRect().top - originalTop) < 1e-8);
  assert.ok(grid.scrollTop > 50);
  assert.equal(grid.style.overflowAnchor, 'none');
});

test('media ratios parse requested aspects and sizes and prefer measured values', () => {
  assert.equal(parseMediaRatio('16:9'), 16 / 9);
  assert.equal(parseMediaRatio('1024x1536'), 1024 / 1536);
  assert.equal(parseMediaRatio('auto'), 0);
  assert.equal(parseMediaRatio(''), 0);
  assert.equal(mediaRatio('ratio-unknown', [0, 0], '', '9:16'), 9 / 16);
  assert.equal(mediaRatio('ratio-unknown', [1920, 1080], '9:16'), 1920 / 1080);
  assert.ok(rememberMediaRatio('ratio-known', 720, 1280));
  assert.equal(rememberMediaRatio('ratio-known', 720, 1280), false, 'an unchanged ratio needs no relayout');
  assert.equal(mediaRatio('ratio-known', [1920, 1080], '16:9'), 720 / 1280);
  assert.equal(knownMediaRatio(''), 0);
});

test('a re-rendered file card reuses the ratio measured by its previous node', () => {
  const frames = [];
  const makeCard = () => ({ classList:{ contains:() => true }, dataset:{ recordId:'asset-portrait', aspectRatio:'1' }, style:{}, querySelector:() => video });
  const video = { tagName:'VIDEO', videoWidth:0, videoHeight:0, getAttribute:() => '' };
  const first = makeCard();
  const grid = { style:{}, clientWidth:1000, children:[first], classList:{ toggle() {} }, addEventListener() {} };
  const context = vm.createContext({
    requestAnimationFrame:callback => { frames.push(callback); return frames.length; },
    getComputedStyle:() => ({ paddingLeft:'0', paddingRight:'0', columnGap:'12' }),
    ResizeObserver:class { observe() {} },
  });
  const source = readFileSync(new URL('../public/features/media/justified-layout.js', import.meta.url), 'utf8');
  vm.runInContext(withoutModules(source), context);
  const layout = context.createJustifiedFileLayout(grid);
  video.videoWidth = 720; video.videoHeight = 1280;
  layout.schedule(); frames.shift()();
  const width = first.style.width;
  video.videoWidth = video.videoHeight = 0;
  const second = makeCard();
  grid.children = [second];
  layout.schedule(); frames.shift()();
  assert.equal(second.style.width, width);
});

test('generation cards reserve their media size before covers load and after release', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(css, /\.card-media\.video video \{[^}]*aspect-ratio: var\(--media-ratio, 16 \/ 9\)/);
  assert.match(css, /\.card-media img \{[^}]*aspect-ratio: var\(--media-ratio, auto\)/);
  assert.ok(app.includes("./features/media/media-ratio.js?v=1"));
  const start = app.indexOf('function cardMediaAttributes(');
  const context = vm.createContext({ esc:String, mediaRatio:(key, ...candidates) => candidates.map(parseMediaRatio).find(Boolean) || 0, parseMediaRatio:value => Array.isArray(value) ? 0 : parseMediaRatio(value) });
  vm.runInContext(app.slice(start, app.indexOf('function rememberCardMediaRatio(', start)), context);
  assert.equal(context.cardMediaAttributes({ aspectRatio:'9:16' }, { id:'asset-a' }), ` data-media-key="asset-a" style="--media-ratio:${9 / 16}"`);
  assert.equal(context.cardMediaAttributes({ size:'auto' }, { id:'asset-b' }), ' data-media-key="asset-b"');
});
