import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cullOffscreenImages, isOffscreen } from '../public/features/drama/canvas-culling.js';

test('offscreen detection keeps a margin around the window', () => {
  assert.equal(isOffscreen({x:100,y:100,width:50,height:50}, 800, 600), false);
  assert.equal(isOffscreen({x:950,y:100,width:50,height:50}, 800, 600), false, 'inside the 200px margin');
  assert.equal(isOffscreen({x:1100,y:100,width:50,height:50}, 800, 600), true);
  assert.equal(isOffscreen({x:-400,y:100,width:150,height:50}, 800, 600), true);
  assert.equal(isOffscreen({x:-400,y:100,width:350,height:50}, 800, 600), false, 'partly visible pictures still draw');
  assert.equal(isOffscreen({x:5000,y:0,width:1,height:1}, 0, 0), false, 'an unmeasured stage never hides content');
});

function konva() {
  const calls = [];
  class Shape { drawScene(canvas, top) { calls.push(['scene', this.name, canvas, top]); return this; } drawHit(canvas, top) { calls.push(['hit', this.name, canvas, top]); return this; } }
  class Image extends Shape {}
  const layerCanvas = {}, hitCanvas = {}, stage = { width:() => 800, height:() => 600 };
  const layer = { getCanvas:() => layerCanvas, getHitCanvas:() => hitCanvas };
  const image = (name, x) => Object.assign(new Image(), { name, getLayer:() => layer, getStage:() => stage, getClientRect:() => ({ x, y:0, width:100, height:100 }) });
  return { calls, Image, Shape, layerCanvas, hitCanvas, image };
}

test('live layer draws skip far-off pictures while exports still draw everything', () => {
  const { calls, Image, Shape, layerCanvas, hitCanvas, image } = konva();
  const near = image('near', 10), far = image('far', 5000);
  assert.equal(cullOffscreenImages(near), true);
  assert.equal(cullOffscreenImages(far), false, 'the shared class is patched once');
  near.drawScene(layerCanvas); far.drawScene(layerCanvas);
  near.drawHit(hitCanvas); far.drawHit(hitCanvas);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['scene','near'], ['hit','near']]);
  calls.length = 0;
  const exportCanvas = {};
  far.drawScene(exportCanvas); far.drawScene(layerCanvas, far);
  assert.equal(calls.length, 2, 'exports and node renders draw off-screen pictures');
  assert.ok(Object.hasOwn(Image.prototype, 'drawScene') && !Object.hasOwn(Shape.prototype, 'patched'));
});

test('canvas wiring registers pictures and marks off-screen cards without touching node attributes', () => {
  const source = readFileSync(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ cullOffscreenImages, isOffscreen \} from '\.\/canvas-culling\.js\?v=1';/);
  assert.match(source, /cullOffscreenImages\(shape\);\n    shape\.image\(image\);/);
  assert.match(source, /element\.classList\?\.toggle\('dw-offscreen',isOffscreen\(rect,stage\.width\(\),stage\.height\(\)\)\)/);
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.director-workspace \.dw-offscreen\{content-visibility:hidden\}/);
  const culling = readFileSync(new URL('../public/features/drama/canvas-culling.js', import.meta.url), 'utf8');
  assert.doesNotMatch(culling, /visible\(|setAttr|\.attrs/);
});
