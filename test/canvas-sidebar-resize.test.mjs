import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchWhiteboardResize } from '../scripts/director/whiteboard-resize.mjs';

const bundle = readFileSync(new URL('../public/vendor/director/reference-canvas.js', import.meta.url), 'utf8');
const observer = bundle.match(/new ResizeObserver\((\w+)=>function\([\s\S]*?\}\(this,\1\)\)/)?.[0];

test('closing, opening and dragging the chat column preserve the scene at any zoom', () => {
  for (const scale of [0.2, 0.8, 1, 2.5]) {
    const state = { viewport: { x: -317, y: 124, scale }, nodes: [{ id: 'image', x: 230, y: 110, width: 280, height: 180 }] };
    const original = structuredClone(state);
    let width = 820, height = 700, overlayUpdates = 0;
    const core = {
      getStage: () => ({ width: value => { width = value; }, height: value => { height = value; } }),
      getCanvasTransformer: () => ({ emitPositionChange() { overlayUpdates++; } }),
      _updateViewport(value) { Object.assign(state.viewport, value); },
      getState: () => state,
    };
    assert.ok(observer, 'built surface resize observer');
    const callback = vm.runInNewContext(`(function(){return ${observer}}).call(core)`, {
      core, ResizeObserver: class { constructor(callback) { return callback; } },
    });
    const screenPosition = () => ({ x: state.nodes[0].x * scale + state.viewport.x, y: state.nodes[0].y * scale + state.viewport.y });
    const before = screenPosition();
    for (const size of [1280, 820, 796, 772, 720, 560, 820, 1280, 820]) {
      callback([{ contentRect: { width: size, height: 700 } }]);
      assert.equal(width, size);
      assert.equal(height, 700);
      assert.deepEqual(state, original);
      assert.deepEqual(screenPosition(), before);
    }
    // Full-screen conversation layouts can temporarily hide the surface.
    callback([{ contentRect: { width: 0, height: 0 } }]);
    callback([{ contentRect: { width: 820, height: 640 } }]);
    assert.deepEqual(state, original);
    assert.equal(height, 640);
    assert.equal(overlayUpdates, 11);
  }
});

test('build applies the resize adapter and fails on unsupported engine versions', () => {
  const build = readFileSync(new URL('../scripts/director/build-reference-canvas.mjs', import.meta.url), 'utf8');
  assert.match(build, /contents: patchWhiteboardResize\(readFileSync\(args.path, 'utf8'\)\)/);
  assert.ok(observer);
  assert.throws(() => patchWhiteboardResize('unsupported observer'), /Unable to locate/);
});
