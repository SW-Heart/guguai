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
    assert.ok(html.includes('/marketing.js?v=26'));
    assert.ok(html.includes('/marketing.css?v=18'));
    assert.doesNotMatch(html, /marketing\.(?:js\?v=(?:1[6789]|2[0-5])|css\?v=(?:[789]|1[0-7]))\b/);
  }
  const help = await read('public/help.html');
  assert.ok(help.includes('/help.js?v=11'));
  assert.doesNotMatch(help, /help\.js\?v=(?:[1-9]|10)\b/);
  const script = await read('public/help.js');
  assert.ok(script.includes('./help-content.js?v=10'));
  assert.ok(script.includes('./help-copy.js?v=2'));
  assert.doesNotMatch(script, /help-copy\.js\?v=1\b/);
  await access(new URL('../public/help-copy.js', import.meta.url));
  assert.ok(script.includes('./help-search.js?v=3'));
  assert.doesNotMatch(script, /help-content\.js\?v=[1-9]\b/);
  assert.doesNotMatch(script, /help-search\.js\?v=[12]\b/);
  assert.ok((await read('public/marketing.js')).includes('./site-interactions.js?v=3'));
  assert.ok((await read('public/site-interactions.js')).includes('./home-motion.js?v=2'));
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

test('homepage film assets resolve and every chapter starts inside the film', async () => {
  const html = await read('public/home.html');
  for (const match of html.matchAll(/(?:src|poster|srcset)="([^"]+)"/g)) {
    for (const candidate of match[1].split(',')) {
      const file = candidate.trim().split(/\s+/)[0].split('?')[0];
      if (file.startsWith('/')) await access(new URL(`../public${file}`, import.meta.url));
    }
  }
  const starts = [...html.matchAll(/data-film-chapter data-start="([\d.]+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(starts[0], 0);
  assert.ok(starts.every(start => start < 24), 'the film is 24 seconds long');
  assert.match(html, /<video data-hero-film muted loop playsinline/);
});

test('mobile navigation closes on Escape; works rows repeat once for a seamless loop', () => {
  const menu = new Element({ 'aria-expanded': 'false' });
  const nav = new Element();
  const header = new Element();
  header.querySelector = selector => selector === '.menu-toggle' ? menu : nav;
  header.contains = () => true;
  const row = new Element();
  row.children = [new Element(), new Element()].map((item, index) => Object.assign(item, { id: index, cloneNode: () => Object.assign(new Element(), { copyOf: index }) }));
  row.append = node => row.children.push(node);
  const doc = new Element();
  doc.querySelector = selector => selector === '#site-header' ? header : null;
  doc.querySelectorAll = selector => selector === '[data-works-marquee] .works-row' ? [row] : [];
  const win = { navigator: { platform: 'MacIntel' }, matchMedia: () => ({ addEventListener() {} }) };
  initSiteInteractions({ document: doc, window: win });
  assert.equal(row.children.length, 4);
  assert.deepEqual(row.children.slice(2).map(item => [item.copyOf, item.getAttribute('aria-hidden')]), [[0, 'true'], [1, 'true']]);
  menu.fire('click');
  assert.equal(menu.getAttribute('aria-expanded'), 'true');
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(menu.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.focused, true);
});

test('case films play only on screen and wait for the viewer under reduced motion', () => {
  const makeVideo = () => Object.assign(new Element(), { playing: false, play() { this.playing = true; return Promise.resolve(); }, pause() { this.playing = false; } });
  const setup = reduced => {
    const videos = [makeVideo(), makeVideo()];
    const doc = new Element();
    doc.querySelector = () => null;
    doc.querySelectorAll = selector => selector === '[data-case-video]' ? videos : [];
    let observed;
    const win = {
      navigator: { platform: 'MacIntel' },
      matchMedia: query => ({ matches: reduced && query.includes('reduced-motion'), addEventListener() {} }),
      IntersectionObserver: class { constructor(callback) { observed = callback; } observe() {} },
    };
    initSiteInteractions({ document: doc, window: win });
    return { videos, show: (video, isIntersecting) => observed([{ target: video, isIntersecting }]) };
  };
  const h = setup(false);
  h.show(h.videos[0], true);
  assert.deepEqual(h.videos.map(video => video.playing), [true, false]);
  h.show(h.videos[0], false);
  assert.equal(h.videos[0].playing, false);
  const reduced = setup(true);
  assert.deepEqual(reduced.videos.map(video => video.controls), [true, true]);
});

function homeMotionHarness({ reduced = false, autoplayBlocked = false } = {}) {
  const doc = new Element();
  const hero = new Element();
  hero.dataset.homeMotion = 'true';
  const video = new Element();
  Object.assign(video, { currentTime: 0, duration: 24, playing: false, plays: 0 });
  video.play = () => {
    video.plays += 1;
    if (autoplayBlocked) return Promise.reject(new Error('NotAllowedError'));
    video.playing = true;
    return Promise.resolve();
  };
  video.pause = () => { video.playing = false; };
  const productWindow = new Element();
  productWindow.style = { setProperty() {} };
  const toggle = new Element();
  const label = new Element();
  const chapters = [0, 8, 13.2].map(start => {
    const chapter = new Element();
    chapter.dataset.start = String(start);
    const progress = new Map();
    chapter.style = { setProperty: (name, value) => progress.set(name, value) };
    chapter.progress = () => Number(progress.get('--progress'));
    return chapter;
  });
  const nodes = new Map([
    ['[data-hero-film]', video], ['#product-window', productWindow],
    ['[data-motion-toggle]', toggle], ['[data-motion-label]', label],
    ['[data-motion-pause]', new Element()], ['[data-motion-play]', new Element()],
  ]);
  hero.querySelector = selector => nodes.get(selector);
  hero.querySelectorAll = selector => selector === '[data-film-chapter]' ? chapters : [];
  doc.querySelector = () => hero;
  const preference = new Element();
  preference.matches = reduced;
  let observed;
  const win = {
    matchMedia: query => query.includes('reduced-motion') ? preference : { matches: false },
    IntersectionObserver: class { constructor(callback) { observed = callback; } observe() {} },
  };
  initHomeMotion({ document: doc, window: win });
  const seek = time => { video.currentTime = time; video.fire('timeupdate'); };
  return { doc, hero, video, toggle, label, chapters, preference, seek, visible: isIntersecting => observed([{ isIntersecting }]) };
}

test('homepage film plays while visible, follows chapters and honours the pause button', () => {
  const h = homeMotionHarness();
  assert.equal(h.video.playing, true);
  h.seek(10.6);
  assert.equal(h.chapters[1].getAttribute('aria-current'), 'true');
  assert.equal(h.chapters[0].getAttribute('aria-current'), undefined);
  assert.equal(h.chapters[0].progress(), 1);
  assert.equal(Math.round(h.chapters[1].progress() * 100), 50);
  assert.equal(h.chapters[2].progress(), 0);
  h.chapters[2].fire('click');
  assert.equal(h.video.currentTime, 13.2);
  assert.equal(h.chapters[2].getAttribute('aria-current'), 'true');
  h.visible(false);
  assert.equal(h.video.playing, false);
  h.visible(true);
  assert.equal(h.video.playing, true);
  h.doc.hidden = true;
  h.doc.fire('visibilitychange');
  assert.equal(h.video.playing, false);
  h.doc.hidden = false;
  h.doc.fire('visibilitychange');
  h.toggle.fire('click');
  assert.equal(h.video.playing, false);
  assert.equal(h.label.textContent, '播放');
  assert.equal(h.hero.dataset.motionPaused, 'true');
  h.toggle.fire('click');
  assert.equal(h.video.playing, true);
  assert.equal(h.label.textContent, '暂停');
});

test('reduced motion never starts the film by itself but the play button still works', () => {
  const reduced = homeMotionHarness({ reduced: true });
  assert.equal(reduced.video.plays, 0);
  assert.equal(reduced.label.textContent, '播放');
  reduced.chapters[1].fire('click');
  assert.equal(reduced.video.currentTime, 8);
  assert.equal(reduced.video.plays, 0, 'choosing a chapter only moves the frame');
  reduced.toggle.fire('click');
  assert.equal(reduced.video.playing, true);
  const h = homeMotionHarness();
  h.preference.fire('change', { matches: true });
  assert.equal(h.video.playing, false);
  assert.equal(h.hero.dataset.motionPaused, 'true');
});

test('a refused autoplay falls back to the play button', async () => {
  const h = homeMotionHarness({ autoplayBlocked: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.label.textContent, '播放');
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
