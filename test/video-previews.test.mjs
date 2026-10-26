import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVideoPreviews } from '../public/features/media/video-previews.js';

function fixture({ count = 200, observe = true, limit, coverUrl, Image } = {}) {
  const videos = Array.from({ length:count }, (_, id) => ({
    dataset:{ previewSrc:`gugu-media://asset/${id}` }, isConnected:true,
    src:'', loads:0, pauses:0, currentTime:0, handlers:{},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeEventListener(type) { delete this.handlers[type]; },
    closest() { return this; },
    pause() { this.pauses++; }, load() { this.loads++; },
    attributes:{}, controls:false,
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { if (name === 'src') this.src = ''; delete this.attributes[name]; },
  }));
  let intersect, mutated;
  const observed = new Set();
  const events = {};
  const root = { addEventListener:(type, handler) => { events[type] = handler; }, removeEventListener:type => { delete events[type]; }, contains:video => videos.includes(video), querySelectorAll:() => videos.filter(video => video.isConnected) };
  const previews = createVideoPreviews({ root, limit, coverUrl, Image,
    IntersectionObserver:observe ? class {
      constructor(callback) { intersect = callback; }
      observe(video) { observed.add(video); } unobserve(video) { observed.delete(video); }
      disconnect() { observed.clear(); }
    } : undefined,
    MutationObserver:class {
      constructor(callback) { mutated = callback; }
      observe() {} disconnect() {}
    },
  });
  previews.scan();
  return { videos, previews, observed, events,
    show:(items, isIntersecting = true) => intersect(items.map(target => ({ target, isIntersecting }))),
    remove(video) {
      video.isConnected = false;
      mutated([{ addedNodes:[], removedNodes:[{ querySelector:() => video }] }]);
    },
  };
}

test('every visible card gets a cover however many fit on screen, and leaving the view releases them', () => {
  const { videos, show } = fixture();
  assert.equal(videos.filter(video => video.src).length, 0);
  show(videos.slice(0, 24));
  assert.equal(videos.filter(video => video.src).length, 24);
  show(videos);
  assert.equal(videos.filter(video => video.src).length, 200, 'a zoomed-out canvas shows every visible video');
  show(videos.slice(0, 190), false);
  assert.equal(videos.filter(video => video.src).length, 10);
});

test('an explicit budget still lets the pressed player load without exceeding it', () => {
  const { videos, show, events } = fixture({ limit:8 });
  show(videos);
  assert.equal(videos.filter(video => video.src).length, 8);
  assert.equal(videos[120].src, '');
  events.pointerdown({ target:videos[120] });
  assert.ok(videos[120].src);
  assert.equal(videos.filter(video => video.src).length, 8);
});

test('offscreen players release sources and restore playback position when shown again', () => {
  const { videos, show } = fixture({ count:1 });
  show(videos);
  videos[0].currentTime = 12;
  show(videos, false);
  videos[0].currentTime = 0;
  show(videos);
  videos[0].handlers.loadedmetadata();
  assert.equal(videos[0].currentTime, 12);
});

test('all high-volume video surfaces defer sources to the shared controller', async () => {
  const paths = ['features/agent/attachment-preview.js', 'features/drama/director-workspace.js', 'features/drama/canvas-generation-editor.js', 'drama-studio.js'];
  for (const path of paths) {
    const source = await readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
    assert.ok(source.includes('data-preview-src='), path);
  }
  const drama = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
  const history = drama.slice(drama.indexOf('function openProfessionalAssemblyLibrary('), drama.indexOf('function patchWorkbenchPreviewProgress('));
  assert.doesNotMatch(history, /<video src=/);
});

test('scrolling releases old decoders and fills freed slots with visible cards', () => {
  const { videos, show } = fixture({ limit:8 });
  show(videos);
  show(videos.slice(0, 8), false);
  assert.equal(videos[0].src, '');
  assert.equal(videos[0].pauses, 1);
  assert.equal(videos[0].loads, 1);
  assert.equal(videos.filter(video => video.src).length, 8);
  assert.ok(videos[8].src);
});

test('removing cards releases sources and observer references without another render', () => {
  const { videos, previews, observed, show, remove } = fixture();
  show(videos);
  remove(videos[0]);
  assert.equal(videos[0].src, '');
  assert.equal(observed.has(videos[0]), false);
  previews.dispose();
  assert.equal(observed.size, 0);
  assert.equal(videos.filter(video => video.src).length, 0);
});

test('failed previews do not repeatedly reopen an unreadable video', () => {
  const { videos, previews, show } = fixture();
  show(videos);
  previews.fail(videos[0]);
  show([videos[0]], false);
  show([videos[0]]);
  previews.scan();
  assert.equal(videos[0].src, '');
  assert.equal(videos[0].loads, 1);
  assert.ok(videos[8].src);
});

test('missing IntersectionObserver leaves sources unloaded', () => {
  const { videos } = fixture({ observe:false });
  assert.equal(videos.filter(video => video.src).length, 0);
});

test('preview errors stop before the full-library refresh and cache URLs match', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(media\.dataset\.previewSrc\) \{\s*videoPreviews\.fail\(media\);\s*return;/);
  assert.ok(app.includes('./features/media/video-previews.js?v=5'));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=608'));
});

function probes() {
  const created = [];
  return { created, Image:class { constructor() { created.push(this); } } };
}

test('desktop video covers show a still frame and never open card videos', () => {
  const { created, Image } = probes();
  const { videos, show, events } = fixture({ count:30, Image, coverUrl:src => `${src}?thumbnail=1` });
  show(videos);
  assert.equal(created.length, 30);
  created.forEach(probe => probe.onload());
  assert.equal(videos.filter(video => video.src).length, 0, 'covered cards keep no decoders');
  assert.equal(videos[3].getAttribute('poster'), 'gugu-media://asset/3?thumbnail=1');
  events.pointerdown({ target:videos[3] });
  assert.equal(videos[3].src, '', 'cards open the detail view instead of playing in place');
  show([videos[3]], false);
  assert.equal(videos[3].getAttribute('poster'), null, 'off-screen covers are released');
  show([videos[3]]);
  assert.equal(created.length, 30, 'a known cover is not probed again');
  assert.equal(videos[3].getAttribute('poster'), 'gugu-media://asset/3?thumbnail=1');
});

test('canvas players with controls keep the cover and load the video only when pressed', () => {
  const { created, Image } = probes();
  const { videos, show, events } = fixture({ count:1, Image, coverUrl:src => `${src}?thumbnail=1` });
  videos[0].controls = true;
  show(videos); created[0].onload();
  assert.equal(videos[0].src, '');
  events.pointerdown({ target:videos[0] });
  assert.equal(videos[0].src, 'gugu-media://asset/0');
  assert.equal(videos[0].getAttribute('poster'), 'gugu-media://asset/0?thumbnail=1');
});

test('a video whose frame cannot be produced falls back to opening the video', () => {
  const { created, Image } = probes();
  const { videos, show } = fixture({ count:2, Image, coverUrl:src => `${src}?thumbnail=1` });
  show(videos);
  created[0].onerror(); created[1].onload();
  assert.equal(videos[0].src, 'gugu-media://asset/0');
  assert.equal(videos[1].src, '');
});

test('older desktops without frame support keep loading visible videos', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /window\.guguDesktop\?\.capabilities\?\.videoCovers && String\(src \|\| ''\)\.startsWith\('gugu-media:\/\/'\) \? imageThumbnailUrl\(src\) : ''/);
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /capabilities: Object\.freeze\(\{ videoCovers: true \}\)/);
  const { videos, show } = fixture({ count:3 });
  show(videos);
  assert.equal(videos.filter(video => video.src).length, 3);
});
