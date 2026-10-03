import test from 'node:test';
import assert from 'node:assert/strict';
import { createOptimizationDither } from '../public/features/drama/prompt-optimization-loading.js';
import { createPromptOptimizationDialog } from '../public/features/drama/prompt-optimization.js';

function fixture({ reduced = false, hovering = true, observer = true } = {}) {
  const listeners = target => Object.assign(target, {
    events:new Map(), addEventListener(type, fn) { this.events.set(type, fn); },
    removeEventListener(type, fn) { if (this.events.get(type) === fn) this.events.delete(type); },
  });
  const reduce = listeners({ matches:reduced });
  const hover = { matches:hovering };
  const document = listeners({ hidden:false });
  let dimensions = { width:400, height:300, left:10, top:20 };
  const points = [], transforms = [], frames = new Map();
  let frameId = 0, resizeObserver;
  const context = {
    clearRect() { points.length = 0; }, setTransform(...args) { transforms.push(args); },
    beginPath() {}, arc(...args) { points.push(args); }, fill() {},
  };
  const canvas = listeners({ ownerDocument:document, getContext:() => context, getBoundingClientRect:() => dimensions });
  const host = listeners({
    devicePixelRatio:3, getComputedStyle:() => ({color:'#5754d8'}),
    matchMedia:query => query.includes('reduced-motion') ? reduce : hover,
    requestAnimationFrame:fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame:id => frames.delete(id),
    ResizeObserver:observer ? class {
      constructor(callback) { this.callback = callback; resizeObserver = this; }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    } : undefined,
  });
  return { canvas, host, document, reduce, hover, points, transforms, frames,
    get observer() { return resizeObserver; },
    resize(width, height) { dimensions = { ...dimensions, width, height }; (resizeObserver?.callback || host.events.get('resize'))(); },
    nextFrame(time) { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(time); },
  };
}

test('dither animation resizes at bounded DPR and releases every resource on cancellation and restart', () => {
  const f = fixture();
  const field = createOptimizationDither(f.canvas, f.host);
  field.start(); field.start();
  assert.equal(f.frames.size, 1, 'repeated state updates do not duplicate frames');
  assert.equal(f.canvas.width, 800); assert.equal(f.canvas.height, 600);
  assert.deepEqual(f.transforms[0], [2,0,0,2,0,0]);
  assert.ok(f.points.length > 100);
  assert.ok(f.points.every(point => point.every(Number.isFinite)));
  f.resize(280,180);
  assert.equal(f.canvas.width, 560); assert.equal(f.canvas.height, 360);
  assert.equal(f.frames.size, 1);
  f.nextFrame(1700);
  assert.equal(f.frames.size, 1);
  field.stop(); field.stop();
  assert.equal(f.frames.size, 0); assert.equal(f.observer.connected, false);
  for (const target of [f.canvas,f.document,f.reduce]) assert.equal(target.events.size, 0);
  field.start(); assert.equal(f.frames.size, 1); field.stop();
});

test('reduced motion renders a static field and respects preference changes while open', () => {
  const f = fixture({ reduced:true });
  const field = createOptimizationDither(f.canvas, f.host);
  field.start();
  assert.equal(f.frames.size, 0); assert.ok(f.points.length);
  const before = structuredClone(f.points);
  f.canvas.events.get('pointermove')({clientX:20,clientY:20});
  f.reduce.events.get('change')();
  assert.deepEqual(f.points, before, 'reduced motion disables pointer displacement');
  f.resize(300,200); assert.equal(f.canvas.width, 600); assert.equal(f.frames.size, 0);
  f.reduce.matches = false; f.reduce.events.get('change')();
  assert.equal(f.frames.size, 1);
  f.reduce.matches = true; f.reduce.events.get('change')();
  assert.equal(f.frames.size, 0);
  field.stop();
});

test('hidden pages suspend frames and touch devices do not activate hover tracking', () => {
  const f = fixture({ hovering:false, observer:false });
  const field = createOptimizationDither(f.canvas, f.host);
  field.start();
  const control = fixture({ hovering:false, observer:false });
  const controlField = createOptimizationDither(control.canvas, control.host); controlField.start();
  f.canvas.events.get('pointermove')({clientX:0,clientY:0});
  f.document.hidden = true; f.document.events.get('visibilitychange')();
  control.document.hidden = true; control.document.events.get('visibilitychange')();
  assert.equal(f.frames.size, 0);
  assert.ok(JSON.stringify(f.points) === JSON.stringify(control.points), 'the pointer does not pull the field on touch devices');
  f.resize(200,150); assert.equal(f.canvas.width, 400);
  f.document.hidden = false; f.document.events.get('visibilitychange')();
  assert.equal(f.frames.size, 1);
  field.stop(); controlField.stop(); assert.equal(f.host.events.size, 0);
});

test('a missing canvas context leaves the textual loading status available', () => {
  const field = createOptimizationDither({ getContext:() => null }, {});
  assert.doesNotThrow(() => { field.start(); field.stop(); });
});

test('the dialog cleans up loading on success, failed reoptimization, confirmation and cancellation', async () => {
  const f = fixture(), appended = [], requests = [], accepted = [];
  function element() {
    const nodes = new Map(), classes = new Set(), events = new Map();
    return {
      value:'', textContent:'', innerHTML:'', open:false,
      classList:{ toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); } },
      querySelector(selector) {
        if (selector.includes('canvas')) return f.canvas;
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      },
      querySelectorAll(selector) { return [this.querySelector(selector)]; },
      addEventListener(type, fn) { events.set(type, fn); },
      setAttribute() {}, showModal() { this.open = true; },
      close() { this.open = false; events.get('close')?.(); },
    };
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.document = Object.assign(f.document, {createElement:element, body:{style:{overflow:''},append:node => appended.push(node)}});
  globalThis.window = f.host;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  let controller;
  try {
    controller = createPromptOptimizationDialog({esc:String, setCreditBalance(){}, api:(url,options) => new Promise((resolve,reject) => requests.push({resolve,reject,body:JSON.parse(options.body)}))});
    const options = {original:'@小美 走进房间',projectId:'p',shotId:'s',isCurrent:() => true,apply:async value => accepted.push(value)};
    controller.open(options); await tick();
    const dialog = appended[0], loading = dialog.querySelector('[data-optimize-loading]'), editor = dialog.querySelector('[data-optimized-prompt]');
    assert.equal(loading.hidden, false); assert.equal(editor.disabled, true); assert.equal(f.frames.size, 1);
    requests[0].resolve({prompt:'@小美 缓缓走进房间',suggestions:['补充动作节奏']}); await tick();
    assert.equal(loading.hidden, true); assert.equal(editor.disabled, false); assert.equal(f.frames.size, 0);
    editor.value = '@小美 推开房门'; editor.oninput({target:editor});
    dialog.querySelector('[data-optimize-again]').onclick();
    const direction = appended[1]; direction.querySelector('textarea').value = '突出紧张感';
    direction.querySelector('[data-direction-confirm]').onclick(); await tick();
    assert.equal(requests[1].body.prompt, '@小美 推开房门'); assert.equal(requests[1].body.direction, '突出紧张感');
    assert.equal(loading.hidden, false); assert.equal(f.frames.size, 1);
    requests[1].reject(new Error('暂时无法优化，请重试')); await tick();
    assert.equal(loading.hidden, true); assert.equal(editor.value, '@小美 推开房门'); assert.equal(editor.disabled, false); assert.equal(f.frames.size, 0);
    await dialog.querySelector('[data-optimize-confirm]').onclick();
    assert.deepEqual(accepted, ['@小美 推开房门']); assert.equal(dialog.open, false);
    controller.open(options); await tick(); assert.equal(f.frames.size, 1);
    controller.close(); assert.equal(f.frames.size, 0); assert.equal(f.observer.connected, false);
    requests[2].resolve({prompt:'延迟内容',suggestions:['补充细节']}); await tick();
    assert.equal(dialog.open, false); assert.equal(f.frames.size, 0); assert.equal(accepted.length, 1);
  } finally {
    controller?.close();
    if (previousDocument) Object.defineProperty(globalThis,'document',previousDocument); else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis,'window',previousWindow); else delete globalThis.window;
  }
});
