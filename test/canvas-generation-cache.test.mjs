import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('canvas generation menu fix reaches both versioned workspace entries', async () => {
  const entries = [
    ['index.html', ['/app.js?v=451', '/styles.css?v=336']],
    ['app.js', ['./drama-studio.js?v=199', './features/agent/workspace.js?v=68']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=107']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=107']],
    ['features/drama/director-workspace.js', ['./canvas-layout.js?v=1']],
  ];
  for (const [file, urls] of entries) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    for (const url of urls) {
      const [path, version] = url.split('?v=');
      const refs = [...source.matchAll(/(?:src|href)=["']([^"']+)|(?:from\s*|import\()["']([^"']+)/g)]
        .map(match => match[1] || match[2]).filter(ref => ref.split('?v=')[0] === path);
      assert.ok(refs.length, `${file}: ${path} must remain linked`);
      assert.ok(refs.every(ref => Number(ref.split('?v=')[1]) >= Number(version)), `${file}: stale ${path}`);
    }
  }
});
