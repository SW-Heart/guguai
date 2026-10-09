import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const dropSource = readFileSync(new URL('../scripts/director/reference-canvas/canvasImageDrop.ts', import.meta.url), 'utf8');
const boundsUrl = new URL('../public/features/agent/image-bounds.js', import.meta.url).href;
const dropJs = stripTypeScriptTypes(dropSource).replace('../../../public/features/agent/image-bounds.js', boundsUrl);
const { insertDroppedImagesAtCanvasPosition } = await import(`data:text/javascript;base64,${Buffer.from(dropJs).toString('base64')}`);

function mockImage(t, Image) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', {configurable:true,writable:true,value:Image});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else delete globalThis.Image;
  });
}

test('dropped photos fit alongside ordinary imported content without changing source files', async t => {
  const dimensions = {
    landscape: [4000, 3000], portrait: [1080, 1920],
    panorama: [12000, 500], small: [80, 60],
  };
  mockImage(t, class {
    set src(url) {
      [this.naturalWidth, this.naturalHeight] = dimensions[url];
      queueMicrotask(() => this.onload());
    }
  });
  let nodes, selected;
  const api = { createNodes(created, select) { nodes = created; selected = select; } };
  const urls = Object.keys(dimensions);
  await insertDroppedImagesAtCanvasPosition(api, urls, {x:100,y:200});
  assert.equal(selected, true);
  assert.equal(nodes.length, 4);
  assert.equal(new Set(nodes.map(node => node.id)).size, 4);
  for (const [index, node] of nodes.entries()) {
    const [width, height] = dimensions[urls[index]];
    assert.equal(node.$_imageUrl, urls[index]);
    assert.ok(node.width <= 280 && node.height <= 220);
    assert.ok(Math.abs(node.width / node.height - width / height) < 1e-8);
    assert.equal(node.y, 200);
    assert.equal(node.x, index ? nodes[index - 1].x + nodes[index - 1].width + 20 : 100);
  }
  assert.equal(nodes[0].width, 280);
  assert.equal(nodes[0].height, 210);
  assert.equal(nodes[1].height, 220);
  assert.equal(nodes[3].width, 80);
  assert.equal(nodes[3].height, 60);
});

test('failed image decoding does not create broken canvas nodes', async t => {
  mockImage(t, class {
    set src(url) { queueMicrotask(() => this.onerror()); }
  });
  const api = { createNodes() { assert.fail('must not create a broken image'); } };
  await assert.rejects(insertDroppedImagesAtCanvasPosition(api, ['broken'], {x:0,y:0}));
});

test('canvas drop uses bounded insertion while quick edit keeps its existing insertion behavior', () => {
  const source = readFileSync(new URL('../scripts/director/reference-canvas/index.tsx', import.meta.url), 'utf8');
  const drop = source.slice(source.indexOf('  const handleCanvasDrop'), source.indexOf("    const offCustomBlockChange"));
  assert.ok(drop.includes('await insertDroppedImagesAtCanvasPosition(whiteboardApi, imageUrls, dropPoint)'));
  assert.ok(source.includes('void insertImagesAtCanvasPosition('));
});
