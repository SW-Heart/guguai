import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { sharedReactRuntime, assertSharedReactBundle } from '../scripts/shared/react-runtime.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('separately bundled consumers share React, DOM, hooks and JSX element identity', async () => {
  const runtime = await sharedReactRuntime();
  const exports = [];
  for (const name of ['card', 'canvas']) {
    const result = await build({
      stdin: { contents: `import React, {useRef, version} from 'react'; import {createRoot} from 'react-dom/client'; import {createPortal,flushSync} from 'react-dom'; import {jsx} from 'react/jsx-runtime'; export {React,useRef,version,createRoot,createPortal,flushSync,jsx}; export const name=${JSON.stringify(name)};` },
      bundle: true, format: 'esm', write: false, metafile: true,
      plugins: [runtime.plugin],
    });
    assertSharedReactBundle(result, runtime.url);
    const localUrl = new URL(runtime.url, new URL('../public/vendor/ui/create-project.js', import.meta.url)).href;
    const code = result.outputFiles[0].text.replaceAll(runtime.url, localUrl);
    exports.push(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`));
  }
  for (const key of ['React', 'useRef', 'createRoot', 'createPortal', 'flushSync', 'jsx', 'version']) {
    assert.equal(exports[0][key], exports[1][key], `${key} must share the same runtime`);
  }
  assert.ok(exports[0].React.isValidElement(exports[1].jsx('span', { children: 'test' })));
});

test('shipped islands import the same immutable runtime without embedding React', () => {
  const runtimeImport = /["'](\.\.\/react\/runtime-([a-f0-9]{16})\.js\?v=\2)["']/;
  const canvas = read('public/vendor/director/reference-canvas.js');
  const card = read('public/vendor/ui/create-project.js');
  const url = canvas.match(runtimeImport)?.[1];
  assert.ok(url);
  assert.equal(card.match(runtimeImport)?.[1], url);
  for (const source of [canvas, card]) {
    assert.doesNotMatch(source, /react(?:-dom-client|-dom)?\.production/);
  }
  const runtime = readFileSync(new URL(url, new URL('../public/vendor/ui/create-project.js', import.meta.url)), 'utf8');
  assert.equal([...runtime.matchAll(/\.useRef=function\(/g)].length, 1);
  assert.equal(new Set([...runtime.matchAll(/\.version="(19\.[0-9]+\.[0-9]+)"/g)].map(match => match[1])).size, 1);
});

test('both paths to React components use fresh cache keys from the HTML entry', () => {
  const entries = [
    ['public/index.html', '/app.js?v=613'],
    ['public/app.js', './features/projects/library.js?v=5'],
    ['public/app.js', './features/agent/workspace.js?v=183'],
    ['public/app.js', './drama-studio.js?v=316'],
    ['public/features/projects/library.js', '../../vendor/ui/create-project.js?v=5'],
    ['public/features/agent/workspace.js', '../../vendor/ui/create-project.js?v=5'],
    ['public/features/agent/workspace.js', '../drama/director-workspace.js?v=207'],
    ['public/drama-studio.js', './features/drama/director-workspace.js?v=207'],
    ['public/features/drama/director-workspace.js', '../../vendor/director/reference-canvas.js?v=43'],
  ];
  for (const [file, url] of entries) assert.ok(read(file).includes(url), `${file} must use ${url}`);
  assert.doesNotMatch(read('public/features/projects/library.js'), /^import.*reference-canvas/m);
});
