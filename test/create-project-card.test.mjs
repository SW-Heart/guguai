import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import vm from 'node:vm';

const result = await build({
  stdin: {
    contents: "export * from './scripts/ui/create-project-entry.jsx'; export * from './scripts/ui/project-type-modal.jsx'; export { morphOffset } from './scripts/ui/components/center-morph-modal.jsx';",
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
});
const module = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url) });
const { CreateProjectCard, mountCreateProjectCard, ProjectTypeModal, morphOffset } = module.exports;

test('React project card keeps a native creation button and two text-free project previews', () => {
  const html = renderToStaticMarkup(createElement(CreateProjectCard));
  assert.match(html, /<button type="button" class="create-home-primary" data-home-create=""/);
  assert.match(html, /创建项目/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /data-project-mode="smart"/);
  assert.match(html, /data-project-mode="professional"/);
  assert.equal((html.match(/<i>/g) || []).length, 6);
  assert.doesNotMatch(html, /智能画布|短剧工作台/);
  assert.doesNotMatch(html, /create-home-tilt-glare/);
});

test('a disposed home cannot mount a new React root', () => {
  const controller = new AbortController();
  controller.abort();
  const dispose = mountCreateProjectCard(null, { signal: controller.signal });
  assert.doesNotThrow(dispose);
});

test('project type modal starts folded and keeps both choices and a named close control', () => {
  const html = renderToStaticMarkup(createElement(ProjectTypeModal, {
    options: [
      { type: 'canvas', label: '智能画布', description: '画布说明<内容>', icon: 'layout-dashboard' },
      { type: 'drama', label: '短剧工作台', description: '短剧说明', icon: 'clapperboard' },
    ],
    onComplete() {},
  }));
  assert.match(html, /<dialog[^>]*aria-label="创建项目"/);
  assert.match(html, /clip-path:inset\(48% 48% 48% 48% round 30px\)/);
  assert.match(html, /data-project-type="canvas"/);
  assert.match(html, /data-project-type="drama"/);
  assert.match(html, /aria-label="关闭"/);
  assert.match(html, /画布说明&lt;内容&gt;/);
  assert.doesNotMatch(html, /method="dialog"|type="submit"/);
  assert.match(html, /project-type-preview-canvas/);
  assert.match(html, /project-type-preview-drama/);
});

test('the folded panel center lands on the originating plus, with a centered fallback', () => {
  const rect = { left: 280, top: 180, width: 840, height: 460 };
  const offset = morphOffset(rect, { x: 620, y: 290 });
  assert.equal(rect.left + rect.width / 2 + offset.x, 620);
  assert.equal(rect.top + rect.height / 2 + offset.y, 290);
  assert.equal(morphOffset(rect, null).x, 0);
  assert.equal(morphOffset(rect, null).y, 0);
});
