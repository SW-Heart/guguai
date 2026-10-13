import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canvasContextPoint, mountCanvasContextMenu } from '../public/features/drama/canvas-context-menu.js';

test('right-click placement accounts for the canvas offset, pan and zoom', () => {
  assert.deepEqual(canvasContextPoint({ x: 500, y: 350 }, { left: 100, top: 50 }, { x: -200, y: 100, scale: 2 }), { x: 300, y: 100 });
  assert.deepEqual(canvasContextPoint({ x: 50, y: 25 }, { left: 0, top: 0 }, { scale: .5 }), { x: 100, y: 50 });
});

test('the context menu is reachable through fresh script and stylesheet cache versions', () => {
  const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  for (const [file, urls] of [
    ['index.html', ['/app.js?v=555', '/styles.css?v=401']],
    ['app.js', ['./drama-studio.js?v=272', './features/agent/workspace.js?v=139']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=165']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=165']],
    ['features/drama/director-workspace.js', ['./canvas-context-menu.js?v=2']],
  ]) for (const url of urls) assert.ok(read(file).includes(url), `${file}: ${url}`);
});

test('context menu selects all three actions at the saved point and supports dismissal and keyboard navigation', async () => {
  const originals = { document: globalThis.document, window: globalThis.window };
  const surface = () => ({
    handlers: {},
    addEventListener(type, callback, options) { (this.handlers[type] ||= []).push({ callback, signal: options?.signal }); },
    emit(type, event = {}) { for (const item of this.handlers[type] || []) if (!item.signal?.aborted) item.callback(event); },
  });
  const doc = surface(), win = Object.assign(surface(), { innerWidth: 800, innerHeight: 600 });
  let menu;
  doc.createElement = () => {
    menu = Object.assign(surface(), {
      style: {}, hidden: true, setAttribute() {},
      getBoundingClientRect: () => ({ width: 188, height: 132 }),
      contains(target) { return target === this || this.buttons.includes(target); },
      querySelectorAll() { return this.buttons; },
      remove() { this.removed = true; },
    });
    Object.defineProperty(menu, 'innerHTML', { set(value) {
        this.buttons = [...value.matchAll(/data-canvas-action="(.*?)"/g)].map(match => ({
          dataset: { canvasAction: match[1] },
          closest() { return this; },
          focus() { doc.activeElement = this; },
        }));
      } });
    return menu;
  };
  globalThis.document = doc; globalThis.window = win;
  const canvas = surface(), calls = [];
  const previousFocus = { isConnected: true, focus() { doc.activeElement = this; } };
  let mounted, enabled = true;
  const event = (extra = {}) => ({ clientX: 790, clientY: 590, target: { closest: () => null }, preventDefault() {}, stopPropagation() {}, ...extra });
  const open = () => { doc.activeElement = previousFocus; canvas.emit('contextmenu', event()); };
  try {
    mounted = mountCanvasContextMenu(canvas, {
      layer: { append() {} }, icons: { upload: '', image: '', video: '' }, ready: () => enabled,
      view: () => ({ rect: { left: 100, top: 50 }, viewport: { x: 90, y: 40, scale: 2 } }),
      onSelect: (action, point) => calls.push({ action, point }), onError: error => assert.fail(error.message),
    });
    for (const [index, action] of ['upload', 'image', 'video'].entries()) {
      open();
      assert.equal(menu.style.left, '604px'); assert.equal(menu.style.top, '460px');
      assert.equal(doc.activeElement, menu.buttons[0]);
      menu.emit('click', event({ target: menu.buttons[index] }));
      assert.equal(menu.hidden, true);
      assert.deepEqual(calls.at(-1), { action, point: { x: 300, y: 250 } });
    }
    open(); menu.emit('keydown', event({ key: 'ArrowUp' }));
    assert.equal(doc.activeElement, menu.buttons[2]);
    menu.emit('keydown', event({ key: 'Home' }));
    assert.equal(doc.activeElement, menu.buttons[0]);
    doc.emit('keydown', event({ key: 'Escape' }));
    assert.equal(menu.hidden, true); assert.equal(doc.activeElement, previousFocus);
    open(); doc.emit('pointerdown', { target: {} }); assert.equal(menu.hidden, true);
    open(); win.emit('resize'); assert.equal(menu.hidden, true);
    open(); doc.emit('scroll', { target: canvas }); assert.equal(menu.hidden, true);
    open(); menu.emit('keydown', event({ key: 'Tab' })); assert.equal(menu.hidden, true);
    enabled = false; open(); assert.equal(menu.hidden, true);
    enabled = true;
    canvas.emit('contextmenu', event({ target: { closest: () => ({}) } })); assert.equal(menu.hidden, true);
    mounted.destroy(); assert.equal(menu.removed, true);
    open(); assert.equal(menu.hidden, true);
  } finally { mounted?.destroy(); Object.assign(globalThis, originals); }
});

test('image and video nodes use the requested point and keep normal draft setup', () => {
  const source = readFileSync(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
  const state = { generationDrafts: [], positions: {} }, selected = [];
  const context = vm.createContext({
    canvas: { selectNodes: ids => selected.push([...ids]) }, generationConfig: () => ({}),
    createCanvasGenerationDraft: type => ({ id: type, type, aspect: '1:1', modelId: 'model' }),
    canvasGenerationFrameSize: () => ({ width: 280, height: 280 }), workspace: () => state,
    syncCanvas() {}, renderGenerationComposer() {}, queueWorkspaceFrame() {}, scheduleCanvasSave() {},
    bridge: { toast: message => assert.fail(message) },
  });
  vm.runInContext(source.slice(source.indexOf('  function createGenerationArea('), source.indexOf('  async function submitGenerationArea(')), context);
  for (const type of ['image', 'video']) context.createGenerationArea(type, { point: { x: -150, y: 400 } });
  assert.equal(state.generationDrafts.length, 2);
  assert.equal(state.positions.image.x, -150); assert.equal(state.positions.video.y, 400);
  assert.deepEqual(selected, [['image'], ['video']]);
});
