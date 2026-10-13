import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVideoPreviews } from '../public/features/media/video-previews.js';

function fixture({ count = 200, observe = true } = {}) {
  const videos = Array.from({ length:count }, (_, id) => ({
    dataset:{ previewSrc:`gugu-media://asset/${id}` }, isConnected:true,
    src:'', loads:0, pauses:0, currentTime:0, handlers:{},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeEventListener(type) { delete this.handlers[type]; },
    closest() { return this; },
    pause() { this.pauses++; }, load() { this.loads++; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
  }));
  let intersect, mutated;
  const observed = new Set();
  const events = {};
  const root = { addEventListener:(type, handler) => { events[type] = handler; }, removeEventListener:type => { delete events[type]; }, contains:video => videos.includes(video), querySelectorAll:() => videos.filter(video => video.isConnected) };
  const previews = createVideoPreviews({ root,
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

test('opening a library of 200 videos never loads more than eight card sources', () => {
  const { videos, show } = fixture();
  assert.equal(videos.filter(video => video.src).length, 0);
  show(videos);
  assert.equal(videos.filter(video => video.src).length, 8);
});

test('explicit player interaction works beyond the preview limit without exceeding it', () => {
  const { videos, show, events } = fixture();
  show(videos);
  assert.equal(videos[20].src, '');
  events.pointerdown({ target:videos[20] });
  assert.ok(videos[20].src);
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
  const { videos, show } = fixture();
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
  assert.ok(app.includes('./features/media/video-previews.js?v=2'));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('/app.js?v=547'));
});
