import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
import { helpArticles, helpCategories } from '../public/help-content.js';
import { searchHelp, highlightHelp, escapeHelpHtml, resolveHelpLocation } from '../public/help-search.js';
import { buildHelpHtml, renderHelpTable } from '../scripts/build-help.mjs';
import { staticEntryFile } from '../server/static.mjs';
import { initSiteInteractions } from '../public/site-interactions.js';
import { initHomeMotion } from '../public/home-motion.js';
import { initHelpCopies } from '../public/help-copy.js';
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('help search finds relevant module guides, combines words and handles empty input', () => {
  assert.ok(searchHelp(helpArticles, '首尾帧').some(result => result.article.id === 'video-reference'));
  assert.equal(searchHelp(helpArticles, '分镜 导出')[0].article.id, 'drama-shots');
  assert.ok(searchHelp(helpArticles, 'ａｇｅｎｔ').some(result => result.article.id === 'agent-start'));
  assert.ok(searchHelp(helpArticles, '支付宝').some(result => result.article.id === 'credits'));
  assert.deepEqual(searchHelp(helpArticles, '不存在的创作工具'), []);
  assert.deepEqual(searchHelp(helpArticles, '  '), []);
});

test('search highlighting escapes content and treats regular expression syntax literally', () => {
  assert.equal(highlightHelp('<img src=x onerror=alert(1)> 视频', '视频'), '&lt;img src=x onerror=alert(1)&gt; <mark>视频</mark>');
  assert.equal(highlightHelp('C++ 与 [图像]', 'C++ [图像]'), '<mark>C++</mark> 与 <mark>[图像]</mark>');
  assert.equal(highlightHelp('a<b', '<b'), 'a<mark>&lt;b</mark>');
  assert.equal(highlightHelp('a&b', ''), 'a&amp;b');
});

test('core creation features can be found by the words users ask for', () => {
  for (const [query, id] of [
    ['@', 'mentions'], ['Agent', 'agent-capabilities'], ['提示词', 'prompt-guide'],
    ['字幕', 'subtitles'], ['配音', 'voiceover'], ['混音', 'sound-mixing'],
    ['分镜 合成', 'editing-compose'], ['画中画', 'overlays'], ['续拍', 'video-continuation'],
  ]) {
    assert.ok(searchHelp(helpArticles, query).some(result => result.article.id === id), `${query}: ${id}`);
  }
});

test('comparisons, model guidance, billing and service rules are searchable', () => {
  for (const [query, id] of [
    ['功能选择', 'feature-choice'], ['Midjourney', 'image-model-guide'], ['Seedance', 'video-model-guide'],
    ['计费', 'pricing-rules'], ['什么是积分', 'credit-basics'], ['整数', 'recharge-rules'],
    ['不支持退款', 'refund-policy'], ['aigcog', 'cooperation'],
  ]) assert.ok(searchHelp(helpArticles, query).some(result => result.article.id === id), `${query}: ${id}`);
  const tableArticle = { id: 'table', title: '比较', intro: '', sections: [{ title: '区别', table: { caption: '选择', columns: ['方式', '用途'], rows: [['画中画', '展示产品']] } }] };
  assert.equal(searchHelp([tableArticle], '画中画 展示产品')[0].article.id, 'table');
});

test('comparison tables preserve accessible structure and escape cell text', () => {
  const html = renderHelpTable({ caption: '费用 & 规格', columns: ['类型', '说明'], rows: [['<img src=x>', '1 < 2']] });
  assert.ok(html.includes('tabindex="0"'));
  assert.ok(html.includes('<caption>费用 &amp; 规格</caption>'));
  assert.ok(html.includes('<th scope="col">类型</th>'));
  assert.ok(html.includes('<th scope="row">&lt;img src=x&gt;</th>'));
  assert.ok(html.includes('<td>1 &lt; 2</td>'));
  assert.throws(() => renderHelpTable({ columns: ['类型', '说明'], rows: [['缺少一列']] }));
});

test('help links resolve articles and valid sections while unknown or malformed hashes fall back', () => {
  assert.equal(resolveHelpLocation(helpArticles, '#video-reference--1').target, 'video-reference--1');
  assert.equal(resolveHelpLocation(helpArticles, '#video-reference--99').target, 'video-reference');
  assert.equal(resolveHelpLocation(helpArticles, '#missing').article.id, 'quick-start');
  assert.equal(resolveHelpLocation(helpArticles, '#%E0%A4%A').article.id, 'quick-start');
});

test('all modules have published static help; every website tutorial and preview asset resolves', async () => {
  const help = await read('public/help.html');
  assert.equal(buildHelpHtml(help), help, 'rebuild help after editing its content');
  assert.equal(new Set(helpArticles.map(article => article.id)).size, helpArticles.length);
  for (const category of helpCategories) assert.ok(helpArticles.some(article => article.category === category.id));
  for (const article of helpArticles) {
    assert.ok(help.includes(`id="${article.id}"`));
    assert.ok(help.includes(article.title));
    for (const id of article.related || []) assert.ok(helpArticles.some(item => item.id === id), `${article.id} links to ${id}`);
  }
  for (const path of ['/help', '/help/']) {
    for (const desktop of [true, false]) assert.equal(staticEntryFile(path, { desktop, appOnly: true }), 'help.html');
  }
  const ids = new Set([...help.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const examples = helpArticles.flatMap(article => article.sections.flatMap((section, index) => section.example ? [{ id: `${article.id}-example-${index}`, text: section.example }] : []));
  assert.equal([...help.matchAll(/data-copy-example="/g)].length, examples.length);
  for (const example of examples) {
    assert.ok(help.includes(`data-copy-example="${example.id}"`));
    assert.ok(help.includes(`<code id="${example.id}">${escapeHelpHtml(example.text)}</code>`));
  }
  for (const match of help.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(match[1]), `help: ${match[1]}`);
  for (const page of ['home', 'features', 'pricing', 'help']) {
    const html = await read(`public/${page}.html`);
    assert.ok(html.includes('href="/help"'), `${page} links to help`);
    for (const match of html.matchAll(/href="\/help#([^"]+)"/g)) assert.ok(ids.has(match[1]), `${page}: ${match[1]}`);
    for (const match of html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:png|svg|js|css))(?:\?[^" ]*)?"/g)) await access(new URL(`../public${match[1]}`, import.meta.url));
    assert.doesNotMatch(html, /[↗→]/);
  }
});

test('all changed marketing entries and help imports use consistent current cache keys', async () => {
  for (const page of ['home', 'features', 'pricing', 'help']) {
    const html = await read(`public/${page}.html`);
    assert.ok(html.includes('/marketing.js?v=20'));
    assert.ok(html.includes('/marketing.css?v=15'));
    assert.doesNotMatch(html, /marketing\.(?:js\?v=1[6789]|css\?v=(?:[789]|1[01234]))\b/);
  }
  const help = await read('public/help.html');
  assert.ok(help.includes('/help.js?v=8'));
  assert.doesNotMatch(help, /help\.js\?v=[1234567]\b/);
  const script = await read('public/help.js');
  assert.ok(script.includes('./help-content.js?v=7'));
  assert.ok(script.includes('./help-copy.js?v=2'));
  assert.doesNotMatch(script, /help-copy\.js\?v=1\b/);
  await access(new URL('../public/help-copy.js', import.meta.url));
  assert.ok(script.includes('./help-search.js?v=3'));
  assert.doesNotMatch(script, /help-content\.js\?v=[123456]\b/);
  assert.doesNotMatch(script, /help-search\.js\?v=[12]\b/);
  assert.ok((await read('public/marketing.js')).includes('./site-interactions.js?v=2'));
  assert.ok((await read('public/site-interactions.js')).includes('./home-motion.js?v=1'));
  await access(new URL('../public/home-motion.js', import.meta.url));
});

class Element {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.dataset = {};
    this.hidden = false;
    this.value = '';
    this.innerHTML = '';
    const classes = new Set();
    this.classList = { add: value => classes.add(value), toggle: (value, active) => active ? classes.add(value) : classes.delete(value), contains: value => classes.has(value) };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  querySelectorAll() { return []; }
  fire(name, event = {}) { this.listeners.get(name)?.(event); }
}

test('preview tabs support pointer and keyboard selection; mobile navigation closes on Escape', () => {
  const menu = new Element({ 'aria-expanded': 'false' });
  const nav = new Element();
  const header = new Element();
  header.querySelector = selector => selector === '.menu-toggle' ? menu : nav;
  header.contains = () => true;
  const tabs = ['image', 'video', 'drama'].map(key => { const tab = new Element({ 'aria-controls': `preview-${key}` }); tab.dataset.previewTab = key; return tab; });
  const panels = new Map(tabs.map(tab => [tab.getAttribute('aria-controls'), new Element()]));
  const doc = new Element();
  doc.querySelector = () => header;
  doc.querySelectorAll = selector => selector === '[data-preview-tab]' ? tabs : [];
  doc.getElementById = id => panels.get(id);
  const win = { navigator: { platform: 'MacIntel' }, matchMedia: () => ({ addEventListener() {} }) };
  initSiteInteractions({ document: doc, window: win });
  tabs[1].fire('click');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(panels.get('preview-image').hidden, true);
  assert.equal(panels.get('preview-video').hidden, false);
  tabs[1].fire('keydown', { key: 'End', preventDefault() {} });
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[2].focused, true);
  menu.fire('click');
  assert.equal(menu.getAttribute('aria-expanded'), 'true');
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(menu.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.focused, true);
});

function homeMotionHarness({ reduced = false } = {}) {
  const doc = new Element();
  const hero = new Element();
  hero.dataset.homeMotion = 'true';
  const stage = new Element();
  stage.contains = node => node === stage;
  const productWindow = new Element();
  productWindow.style = { setProperty() {} };
  const toggle = new Element();
  const label = new Element();
  const nodes = new Map([
    ['.product-stage', stage], ['#product-window', productWindow],
    ['[data-motion-toggle]', toggle], ['[data-motion-label]', label],
    ['[data-motion-pause]', new Element()], ['[data-motion-play]', new Element()],
  ]);
  hero.querySelector = selector => nodes.get(selector);
  doc.querySelector = () => hero;
  const tabs = [0, 1, 2].map(index => new Element({ 'aria-selected': String(index === 0) }));
  const preference = new Element();
  preference.matches = reduced;
  const timers = new Map();
  let timerId = 0;
  let observed;
  const win = {
    matchMedia: query => query.includes('reduced-motion') ? preference : { matches: false },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    IntersectionObserver: class { constructor(callback) { observed = callback; } observe() {} },
  };
  const activate = tab => tabs.forEach(item => item.setAttribute('aria-selected', String(item === tab)));
  initHomeMotion({ document: doc, window: win, tabs, activate });
  const tick = () => {
    const [id, callback] = [...timers][0];
    timers.delete(id);
    callback();
  };
  return { doc, hero, stage, toggle, label, tabs, timers, preference, tick, visible: isIntersecting => observed([{ isIntersecting }]) };
}

test('homepage preview animation pauses for interaction, visibility and explicit control', () => {
  const h = homeMotionHarness();
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.equal(h.tabs[1].getAttribute('aria-selected'), 'true');
  h.stage.fire('pointerenter');
  assert.equal(h.timers.size, 0);
  h.stage.fire('pointerleave');
  assert.equal(h.timers.size, 1);
  h.stage.fire('focusin');
  assert.equal(h.timers.size, 0);
  h.stage.fire('focusout', { relatedTarget: null });
  assert.equal(h.timers.size, 1);
  h.doc.hidden = true;
  h.doc.fire('visibilitychange');
  assert.equal(h.timers.size, 0);
  h.doc.hidden = false;
  h.doc.fire('visibilitychange');
  assert.equal(h.timers.size, 1);
  h.visible(false);
  assert.equal(h.timers.size, 0);
  h.visible(true);
  assert.equal(h.timers.size, 1);
  h.tabs[0].fire('pointerdown');
  assert.equal(h.timers.size, 0, 'manual screenshot selection stays selected');
  assert.equal(h.label.textContent, '播放动画');
  h.toggle.fire('click');
  assert.equal(h.timers.size, 1);
  h.toggle.fire('click');
  assert.equal(h.timers.size, 0);
});

test('reduced motion keeps the homepage static and stops an already running preview', () => {
  const reduced = homeMotionHarness({ reduced: true });
  assert.equal(reduced.timers.size, 0);
  assert.equal(reduced.toggle.hidden, true);
  reduced.toggle.fire('click');
  assert.equal(reduced.timers.size, 0);
  const h = homeMotionHarness();
  h.preference.fire('change', { matches: true });
  assert.equal(h.timers.size, 0);
  assert.equal(h.toggle.hidden, true);
  assert.equal(h.hero.dataset.motionPaused, 'true');
});

async function helpHarness(url) {
  const selectors = new Map(['#help-search', '#help-results', '#help-articles', '.help-reading-nav', '.help-toc', '#help-mobile-nav', '.search-clear', '[data-exit-search]'].map(selector => [selector, new Element()]));
  const document = new Element();
  document.documentElement = new Element();
  document.querySelector = selector => selectors.get(selector);
  const articleNodes = helpArticles.map(article => Object.assign(new Element(), { id: article.id }));
  const navLinks = helpArticles.map(article => new Element({ href: `#${article.id}` }));
  document.querySelectorAll = selector => selector === '.help-article' ? articleNodes : selector === '#help-nav a' ? navLinks : [];
  const titles = new Map(helpArticles.map(article => [`${article.id}-title`, new Element()]));
  document.getElementById = id => articleNodes.find(article => article.id === id) || titles.get(id);
  const search = selectors.get('#help-search');
  search.form = new Element();
  const resultsChildren = new Map(['.results-count', '.results-list'].map(selector => [selector, new Element()]));
  selectors.get('#help-results').querySelector = selector => resultsChildren.get(selector);
  const neighbors = new Map(['[data-help-prev]', '[data-help-next]'].map(selector => [selector, new Element()]));
  selectors.get('.help-reading-nav').querySelector = selector => neighbors.get(selector);
  selectors.get('.help-toc').querySelector = () => new Element();
  let location = new URL(url);
  const window = new Element();
  Object.defineProperty(window, 'location', { get: () => location });
  window.history = { replaceState: (_, __, next) => { location = new URL(next, location); } };
  window.matchMedia = () => ({ matches: true });
  window.requestAnimationFrame = callback => callback();
  const source = (await read('public/help.js')).replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, { document, window, URL, URLSearchParams, helpArticles, helpCategories, searchHelp, highlightHelp, escape: escapeHelpHtml, resolveHelpLocation, initHelpCopies });
  return { document, window, selectors, articleNodes, search, resultsChildren };
}

test('help restores deep links and keeps a mobile article selection when leaving search', async () => {
  const h = await helpHarness('https://gugu.example/help#image-start');
  assert.deepEqual(h.articleNodes.filter(node => !node.hidden).map(node => node.id), ['image-start']);
  h.search.value = '首尾帧';
  h.search.fire('input');
  assert.equal(h.selectors.get('#help-results').hidden, false);
  assert.ok(h.resultsChildren.get('.results-list').innerHTML.includes('href="#video-reference"'));
  const select = h.selectors.get('#help-mobile-nav');
  select.value = 'drama-start';
  select.fire('change');
  assert.equal(h.window.location.hash, '#drama-start');
  assert.equal(h.window.location.search, '');
  h.window.fire('hashchange');
  assert.deepEqual(h.articleNodes.filter(node => !node.hidden).map(node => node.id), ['drama-start']);
});

test('help opens a shared search URL and safely renders unknown search text', async () => {
  const h = await helpHarness('https://gugu.example/help?q=%E7%A7%AF%E5%88%86');
  assert.equal(h.search.value, '积分');
  assert.equal(h.selectors.get('#help-results').hidden, false);
  h.search.value = '<img src=x onerror=alert(1)>';
  h.search.fire('input');
  assert.ok(h.resultsChildren.get('.results-list').innerHTML.includes('暂时没有找到'));
  assert.ok(!h.resultsChildren.get('.results-list').innerHTML.includes('<img'));
  h.selectors.get('.search-clear').fire('click');
  assert.equal(h.window.location.search, '');
  assert.equal(h.selectors.get('#help-results').hidden, true);
});
