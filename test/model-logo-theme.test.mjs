import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { modelLogoUrls, modelLogoUrl, modelLogoMarkup } from '../public/components/model-logo.js';
import { canvasGenerationModelIcon } from '../public/features/drama/canvas-generation.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const luminance = hex => {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const contrast = (a, b) => {
  const [lo, hi] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (hi + .05) / (lo + .05);
};

test('every model brand has local light and dark assets with matching geometry and readable dark colors', () => {
  const urls = [...new Set(Object.values(modelLogoUrls))];
  assert.equal(urls.length, 6);
  for (const src of urls) {
    assert.match(src, /^\/icons\/models\/[\w-]+\.svg\?v=1$/);
    const path = src.split('?')[0].slice(1);
    const light = read(path), dark = read(path.replace('.svg', '-dark.svg'));
    for (const svg of [light, dark]) {
      assert.match(svg, /^<svg\b/);
      assert.doesNotMatch(svg, /currentColor|<script|<foreignObject|<image|on\w+=/);
    }
    assert.notEqual(light, dark);
    assert.equal(light.replace(/#[\da-f]{6}/gi, 'COLOR'), dark.replace(/#[\da-f]{6}/gi, 'COLOR'));
    const colors = [...dark.matchAll(/(?:fill|stop-color|stroke)="(#[\da-f]{6})"/gi)].map(match => match[1]);
    assert.ok(colors.length);
    for (const color of colors) for (const surface of ['#202432', '#30364c', '#373655']) {
      assert.ok(contrast(color, surface) >= 3, `${path}: ${color} needs visible contrast on ${surface}`);
    }
  }
  assert.match(read('icons/models/LICENSE'), /MIT License/);
});

test('all model menus share the same sources, and both variants are ready for manual or system theme switches', () => {
  assert.equal(modelLogoUrl('gpt-image-2'), modelLogoUrl('gpt-image-2.5'));
  assert.equal(modelLogoUrl('custom-model', 'OPENAI'), modelLogoUrl('gpt-image-2'));
  assert.equal(modelLogoUrl('custom-model', 'unknown'), '');
  for (const id of Object.keys(modelLogoUrls)) assert.equal(canvasGenerationModelIcon(id), modelLogoUrl(id));
  const markup = modelLogoMarkup(modelLogoUrl('grok'), { className: 'select-model-icon', generation: true, lazy: true });
  assert.match(markup, /class="model-logo select-model-icon"/);
  assert.match(markup, /class="model-logo-day" src="\/icons\/models\/grok\.svg\?v=1"/);
  assert.match(markup, /class="model-logo-night" src="\/icons\/models\/grok-dark\.svg\?v=1"/);
  assert.equal((markup.match(/data-gen-model-icon/g) || []).length, 2);
  assert.equal(modelLogoMarkup('https://example.invalid/logo.svg'), '');
  const css = read('styles/theme.css');
  assert.match(css, /html\[data-theme="dark"\] \.model-logo > \.model-logo-day \{ display: none; \}/);
  assert.match(css, /html\[data-theme="dark"\] \.model-logo > \.model-logo-night \{ display: block; \}/);
  for (const path of ['app.js', 'drama-studio.js', 'features/drama/director-workspace.js', 'features/agent/model-preference-picker.js']) {
    assert.match(read(path), /modelLogoMarkup/);
    assert.doesNotMatch(read(path), /unpkg\.com\/.*icons-static-svg/);
  }
});

test('generator hover and selection override local light tokens and remain distinct with readable labels', () => {
  const css = read('styles/theme.css');
  const root = css.split('/* Fixed legacy colors')[0];
  const parameters = css.match(/html\[data-theme="dark"\] \.generator-form \{([^}]+)\}/)?.[1];
  assert.ok(parameters);
  assert.doesNotMatch(parameters, /rgba?\(255[ ,]+255[ ,]+255/);
  const colors = Object.fromEntries([...`${root}\n${parameters}`.matchAll(/(--[\w-]+): (#[\da-f]{6});/g)].map(match => [match[1], match[2]]));
  const states = ['--control-surface', '--control-surface-hover', '--control-surface-selected'];
  assert.equal(new Set(states.map(state => colors[state])).size, 3);
  for (const state of states) for (const label of ['--ink-soft', '--muted']) {
    assert.ok(contrast(colors[label], colors[state]) >= 4.5, `${label} on ${state}`);
  }
  assert.ok(contrast(colors['--control-ink-selected'], colors['--control-surface-selected']) >= 4.5);
  assert.ok(contrast(colors['--control-border-hover'], colors['--control-surface-hover']) >= 3);
  assert.match(css, /button\.selected[^}]+\):hover:not\(:disabled\),/);
  assert.match(css, /button\[aria-selected="true"\][^}]+\):focus-visible \{\s+border-color: var\(--brand\)/);
});

test('logo and parameter fixes reach all current versioned frontend entries', () => {
  const entries = [
    ['index.html', ['/app.js?v=469', '/styles/theme.css?v=3']],
    ['app.js', ['./components/model-logo.js?v=1', './drama-studio.js?v=211', './features/agent/workspace.js?v=80']],
    ['drama-studio.js', ['./components/model-logo.js?v=1', './features/drama/director-workspace.js?v=117']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=117', './model-preference-picker.js?v=5']],
    ['features/drama/director-workspace.js', ['./canvas-generation.js?v=6', '../agent/model-preference-picker.js?v=5', '../../components/model-logo.js?v=1']],
    ['features/drama/canvas-generation.js', ['../../components/model-logo.js?v=1']],
    ['features/agent/model-preference-picker.js', ['../drama/canvas-generation.js?v=6', '../../components/model-logo.js?v=1']],
  ];
  for (const [path, urls] of entries) for (const url of urls) assert.ok(read(path).includes(url), `${path}: ${url}`);
});
