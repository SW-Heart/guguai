import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('canvas generation menu fix reaches both versioned workspace entries', async () => {
  const entries = [
    ['index.html', ['/app.js?v=585', '/styles.css?v=418']],
    ['app.js', ['./drama-studio.js?v=297', './features/agent/workspace.js?v=164']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=188']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=188']],
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
    ['index.html', '/app.js?v=585'],
    ['index.html', '/styles.css?v=418'],
    ['app.js', './drama-studio.js?v=297'],
    ['app.js', './features/agent/workspace.js?v=164'],
    ['drama-studio.js', './features/drama/director-workspace.js?v=188'],
    ['features/agent/workspace.js', '../drama/director-workspace.js?v=188'],
    ['features/drama/director-workspace.js', '../../vendor/director/reference-canvas.js?v=41'],
    ['features/drama/director-workspace.js', './canvas-generation-references.js?v=10'],
    ['features/drama/director-workspace.js', './storyboard-drafts.js?v=9'],
    ['features/drama/storyboard-drafts.js', './canvas-generation-references.js?v=10'],
    ['features/drama/director-workspace.js', './canvas-links.js?v=2'],
    ['features/drama/director-workspace.js', './canvas-connect.js?v=3'],
    ['features/drama/director-workspace.js', './canvas-ops.js?v=5'],
    ['features/drama/director-workspace.js', '../agent/frames.js?v=4'],
    ['features/drama/director-workspace.js', './document-card.js?v=3'],
    ['features/drama/director-actions.js', './canvas-links.js?v=2'],
    ['features/drama/storyboard-drafts.js', './canvas-links.js?v=2'],
    ['features/agent/workspace.js', '../drama/director-actions.js?v=20'],
    ['features/drama/canvas-generation-references.js', './canvas-generation.js?v=18'],
    ['app.js', './features/media/controller.js?v=13'],
    ['features/drama/director-workspace.js', './director-mentions.js?v=5'],
    ['features/drama/director-workspace.js', './canvas-media-library.js?v=3'],
    ['features/drama/director-workspace.js', './director-actions.js?v=20'],
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

test('drawing and selection fixes reach both workspace entries through fresh cache versions', async () => {
  const entries = [
    ['index.html', '/app.js?v=585'],
    ['app.js', './drama-studio.js?v=297'],
    ['app.js', './features/agent/workspace.js?v=164'],
    ['drama-studio.js', './features/drama/director-workspace.js?v=188'],
    ['features/agent/workspace.js', '../drama/director-workspace.js?v=188'],
  ];
  for (const [file, url] of entries) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(url), `${file}: missing fresh ${url}`);
  }
});
