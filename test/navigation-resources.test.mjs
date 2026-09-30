import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function renderRouteLoadingShell(');
const end = app.indexOf('\nfunction cancelRouteContentRender(', start);

function libraryShell(children = []) {
  const grid = { children };
  let replacements = 0, skeletons = 0, hidden = false;
  Object.defineProperty(grid, 'innerHTML', {
    set() { replacements++; grid.children = [{ skeleton: true }]; },
  });
  const count = { textContent: '' };
  const loadMore = { classList: { add() { hidden = true; } } };
  const context = vm.createContext({
    $: selector => ({ '#fileGrid': grid, '#fileCount': count, '#loadMoreFiles': loadMore })[selector],
    mediaController: { libraryState: () => ({ files: children, total: children.length }) },
    fileLibraryLoadingSkeleton() { skeletons++; return '<placeholder>'; },
  });
  vm.runInContext(app.slice(start, end), context);
  return {
    enter: () => vm.runInContext("renderRouteLoadingShell('files')", context),
    grid, count,
    stats: () => ({ replacements, skeletons, hidden }),
  };
}

test('the first library visit shows a placeholder and repeated navigation reuses it', () => {
  const fixture = libraryShell();
  fixture.enter();
  const placeholder = fixture.grid.children[0];
  fixture.enter();
  assert.equal(fixture.grid.children[0], placeholder);
  assert.deepEqual(fixture.stats(), { replacements: 1, skeletons: 1, hidden: true });
  assert.equal(fixture.count.textContent, '正在加载…');
});

test('returning to the library preserves live media nodes and pagination', () => {
  const video = { src: 'gugu-media://workspace/video.mp4', currentTime: 3 };
  const image = { src: 'gugu-media://workspace/image.jpg', complete: true };
  const children = [{ video }, { image }];
  const fixture = libraryShell(children);
  fixture.enter();
  assert.equal(fixture.grid.children, children);
  assert.equal(fixture.grid.children[0].video, video);
  assert.equal(fixture.grid.children[1].image, image);
  assert.deepEqual(fixture.stats(), { replacements: 0, skeletons: 0, hidden: false });
  assert.equal(fixture.count.textContent, '2 个文件');
});

test('a rendered empty library is preserved until the deferred content update', () => {
  const empty = { className: 'empty-state' };
  const fixture = libraryShell([empty]);
  fixture.enter();
  assert.equal(fixture.grid.children[0], empty);
  assert.equal(fixture.stats().replacements, 0);
});

test('navigation resource changes reach all versioned app and stylesheet entries', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const [path, minimumVersion] of [['/app.js', 462], ['/styles.css', 347]]) {
    const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map(match => match[1]).filter(url => url.split('?')[0] === path);
    assert.ok(refs.length, `${path} must remain linked`);
    assert.ok(refs.every(url => Number(new URL(url, 'https://gugu.invalid').searchParams.get('v')) >= minimumVersion), `${path} uses a stale cache key`);
  }
});
