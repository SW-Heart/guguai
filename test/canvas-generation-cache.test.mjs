import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('speech language popover style fix reaches the versioned stylesheet entry', async () => {
  for (const [file, url] of [
    ['index.html', '/styles.css?v=429'],
    ['styles.css', '/styles/speech.css?v=7'],
  ]) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(url), `${file}: missing fresh ${url}`);
  }
});

test('canvas generation menu fix reaches both versioned workspace entries', async () => {
  const entries = [
    ['index.html', ['/app.js?v=597', '/styles.css?v=429']],
    ['app.js', ['./drama-studio.js?v=310', './features/agent/workspace.js?v=177']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=202']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=202']],
    ['features/drama/director-workspace.js', ['./canvas-layout.js?v=2']],
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

test('bounded image drops reach both workspace entries through fresh cache versions', async () => {
  const entries = [
    ['index.html', '/app.js?v=597'],
    ['index.html', '/styles.css?v=429'],
    ['app.js', './drama-studio.js?v=310'],
    ['app.js', './features/agent/workspace.js?v=177'],
    ['drama-studio.js', './features/drama/director-workspace.js?v=202'],
    ['features/agent/workspace.js', '../drama/director-workspace.js?v=202'],
    ['features/drama/director-workspace.js', '../../vendor/director/reference-canvas.js?v=43'],
    ['features/drama/director-workspace.js', './canvas-generation-references.js?v=12'],
    ['features/drama/director-workspace.js', './storyboard-drafts.js?v=11'],
    ['features/drama/storyboard-drafts.js', './canvas-generation-references.js?v=12'],
    ['features/drama/director-workspace.js', './canvas-links.js?v=3'],
    ['features/drama/director-workspace.js', './canvas-connect.js?v=3'],
    ['features/drama/director-workspace.js', './canvas-ops.js?v=7'],
    ['features/drama/director-workspace.js', '../agent/frames.js?v=4'],
    ['features/drama/director-workspace.js', './document-card.js?v=3'],
    ['features/drama/director-actions.js', './canvas-links.js?v=3'],
    ['features/drama/storyboard-drafts.js', './canvas-links.js?v=3'],
    ['features/agent/workspace.js', '../drama/director-actions.js?v=21'],
    ['features/drama/canvas-generation-references.js', './canvas-generation.js?v=20'],
    ['app.js', './features/media/controller.js?v=13'],
    ['features/drama/director-workspace.js', './director-mentions.js?v=5'],
    ['features/drama/director-workspace.js', './canvas-media-library.js?v=3'],
    ['features/drama/director-workspace.js', './director-actions.js?v=21'],
    ['features/drama/director-workspace.js', './canvas-generation-editor.js?v=5'],
    ['features/drama/director-workspace.js', './document-card.js?v=3'],
    ['features/drama/canvas-generation-editor.js', './director-mentions.js?v=5'],
    ['features/drama/canvas-generation-editor.js', '../../components/prompt-editor.js?v=2'],
  ];
  for (const [file, url] of entries) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const [path, version] = url.split('?v=');
    const refs = [...source.matchAll(/(?:src|href)=["']([^"']+)|(?:from\s*|import\()["']([^"']+)/g)]
      .map(match => match[1] || match[2]).filter(ref => ref.split('?v=')[0] === path);
    assert.ok(refs.length, `${file}: ${path} must remain linked`);
    assert.ok(refs.every(ref => Number(ref.split('?v=')[1]) >= Number(version)), `${file}: stale ${path}`);
  }
});

test('connection endpoint handle fix reaches both workspace entries through fresh cache versions', async () => {
  const entries = [
    ['index.html', '/app.js?v=597'],
    ['app.js', './drama-studio.js?v=310'],
    ['app.js', './features/agent/workspace.js?v=177'],
    ['drama-studio.js', './features/drama/director-workspace.js?v=202'],
    ['features/agent/workspace.js', '../drama/director-workspace.js?v=202'],
    ['features/drama/director-workspace.js', '../../vendor/director/reference-canvas.js?v=43'],
  ];
  for (const [file, url] of entries) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(url), `${file}: missing fresh ${url}`);
  }
});
