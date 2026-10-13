import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ImageCache, mapImagesWithLimit } from '../public/features/media/image-cache.js';
import { imageThumbnailUrl } from '../public/features/media/thumbnail-url.js';
import { attachmentCardMarkup, attachmentDetailMarkup } from '../public/features/agent/attachment-preview.js';

test('image cache evicts old references by decoded pixel budget and count', () => {
  const cache = new ImageCache({ maxPixels:200, maxEntries:2 });
  const image = () => ({ naturalWidth:10, naturalHeight:10 });
  cache.set('a', image()).set('b', image()).set('c', image());
  assert.deepEqual([...cache.keys()], ['b', 'c']);
  cache.set('huge', { naturalWidth:100, naturalHeight:100 });
  assert.deepEqual([...cache.keys()], ['huge']);
  cache.set('small', image());
  assert.deepEqual([...cache.keys()], ['small']);
});

test('bulk image preparation caps concurrency at two and retains order', async () => {
  let running = 0, peak = 0;
  const output = await mapImagesWithLimit(Array.from({ length:80 }, (_, i) => i), async item => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    return item;
  });
  assert.equal(peak, 2);
  assert.deepEqual(output, Array.from({ length:80 }, (_, i) => i));
});

test('canvas dimension loads are bounded and deleted nodes release queued and cached images', () => {
  const source = readFileSync(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
  let created = 0;
  const context = vm.createContext({ epoch:1, canvas:null, assetSizes:new Map(), assetSizeLoads:new Map(), assetImages:new ImageCache(),
    Image:class { constructor() { created++; } },
  });
  vm.runInContext(source.slice(source.indexOf('  function assetBounds('), source.indexOf('  function nodeContent(')), context);
  for (let i = 0; i < 100; i++) context.loadAssetSize(`id-${i}`, `gugu-media://asset/${i}`);
  assert.equal(created, 2);
  assert.equal(context.assetSizeLoads.size, 2);
  context.assetSizeLoads.values().next().value.onerror();
  assert.equal(created, 3);
  context.assetImages.set('old', { naturalWidth:10, naturalHeight:10 });
  context.pruneAssetImages([]);
  assert.equal(context.assetSizeLoads.size, 0);
  assert.equal(context.assetImages.size, 0);
  assert.equal(created, 3, 'deleted queued nodes must never start decoding');
});

test('only card image URLs use thumbnails; detail and original record remain full size', () => {
  const file = { key:'a', kind:'image', url:'gugu-media://asset/a' };
  assert.equal(imageThumbnailUrl(file.url), 'gugu-media://asset/a?thumbnail=1');
  assert.equal(imageThumbnailUrl('/image.png'), '/image.png');
  assert.match(attachmentCardMarkup(file), /src="gugu-media:\/\/asset\/a\?thumbnail=1"/);
  assert.match(attachmentDetailMarkup(file), /src="gugu-media:\/\/asset\/a"/);
  assert.equal(file.url, 'gugu-media://asset/a');
});
