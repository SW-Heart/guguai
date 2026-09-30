import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageScroller } from '../public/features/agent/message-scroller.js';

test('message scroller follows new content until the reader moves away, then resumes at the end', () => {
  const originals = {
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const frames = new Map();
  let nextFrame = 0;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(16));
  };
  const listeners = new Map();
  const surfaceListeners = new Map();
  let top = 0;
  const viewport = {
    scrollHeight: 1000,
    clientHeight: 300,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    classList: { toggle() {} },
    contains: target => target === viewport,
    querySelectorAll: () => [],
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const surface = { addEventListener(name, callback) { surfaceListeners.set(name, callback); } };
  const rail = {
    hidden: true,
    addEventListener() {},
    querySelectorAll: () => [],
    replaceChildren() {},
  };
  let scroller;
  try {
    scroller = createMessageScroller(viewport, rail, surface);
    flush();
    assert.equal(viewport.scrollTop, 700);

    let prevented = false;
    surfaceListeners.get('wheel')({ target: { closest: () => null }, deltaY: -80, deltaMode: 0, preventDefault() { prevented = true; } });
    assert.equal(viewport.scrollTop, 620);
    assert.equal(prevented, true);
    surfaceListeners.get('wheel')({ target: viewport, deltaY: -80 });
    assert.equal(viewport.scrollTop, 620);
    surfaceListeners.get('wheel')({ target: { closest: () => ({}) }, deltaY: -80 });
    assert.equal(viewport.scrollTop, 620);

    listeners.get('wheel')({ type: 'wheel', deltaY: -80 });
    viewport.scrollTop = 200;
    listeners.get('scroll')();
    viewport.scrollHeight = 1300;
    scroller.refresh({ immediate: true });
    flush();
    assert.equal(viewport.scrollTop, 200);

    viewport.scrollTop = 990;
    listeners.get('scroll')();
    scroller.refresh({ immediate: true });
    flush();
    assert.equal(viewport.scrollTop, 1000);

    viewport.scrollTop = 100;
    listeners.get('scroll')();
    scroller.refresh({ reset: true });
    flush();
    assert.equal(viewport.scrollTop, 1000);
  } finally {
    scroller?.destroy();
    Object.assign(globalThis, originals);
  }
});
