import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAgentSkills} from '../lib/agent/skills.mjs';
import {galleryItems, skillCardMarkup, skillDetailMarkup, mountSkillGallery} from '../public/features/agent/skill-gallery.js';

test('gallery covers built-in skills, with local full-size and thumbnail JPEGs', async () => {
  const skills = await createAgentSkills({roots: [new URL('../agent-skills/', import.meta.url).pathname]}).search();
  const items = galleryItems(skills);
  assert.equal(items.length, 10);
  for (const item of items) {
    if (item.name === 'minimax-creation-bible') {
      assert.equal(item.title, 'MiniMax 创作圣经');
      assert.equal(item.media.src, '/images/skills/minimax-creation-bible-v1.jpg');
      assert.equal(item.media.thumbnail, '/images/skills/minimax-creation-bible-thumb-v1.jpg');
      assert.ok(skillCardMarkup(item).includes('data-skill-quick-use="minimax-creation-bible"'));
    }
    if (item.name === 'seedance-creation-bible') {
      assert.equal(item.title, 'Seedance 创作圣经');
      assert.ok(skillCardMarkup(item).includes('data-skill-quick-use="seedance-creation-bible"'));
    }
    assert.ok(item.prompt && item.input && item.output && item.alt, item.name);
    for (const path of [item.media.src, item.media.thumbnail]) {
      const bytes = readFileSync(new URL(`../public${path}`, import.meta.url));
      assert.equal(bytes.readUInt16BE(0), 0xffd8, path);
    }
    assert.ok(skillDetailMarkup(item).includes('使用此技能'));
    assert.ok(!skillDetailMarkup(item).includes('<video'), 'stills are not presented as playable videos');
  }
  assert.deepEqual(galleryItems(skills.slice(0, 1)).map(item => item.name), [skills[0].name]);
});

test('custom skill cards escape content and do not expose internal skill descriptions', () => {
  const [item] = galleryItems([{name: 'custom"<', title: '<img src=x onerror=alert(1)>', summary: 'A & B', description: 'SECRET INTERNAL INSTRUCTIONS'}]);
  const html = skillCardMarkup(item) + skillDetailMarkup(item);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('A &amp; B'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('SECRET INTERNAL'));
  assert.equal(item.media, null);
});

test('preview, use, retry and disposal keep skill selection inside the current entry', t => {
  // A DOM fixture exercises event/state logic without starting a browser or client.
  const oldDocument = globalThis.document;
  const elements = [];
  function element() {
    const node = {listeners: {}, attrs: {}, open: false, isConnected: true, pauses: 0,
      setAttribute(k, v) {this.attrs[k] = v;},
      append(child) {this.child = child;},
      addEventListener(type, fn, options = {}) {(this.listeners[type] ||= []).push(fn); options.signal?.addEventListener('abort', () => {this.listeners[type] = this.listeners[type].filter(listener => listener !== fn);}, {once: true});},
      emit(type, event = {}) {for (const fn of this.listeners[type] || []) fn(event);},
      querySelector(selector) {return selector === 'dialog' ? dialog : grid;},
      querySelectorAll() {return [{pause: () => this.pauses++}];},
      showModal() {this.open = true;}, close() {this.open = false; this.emit('close');},
      remove() {this.isConnected = false;}, focus() {this.focused = true;},
      getBoundingClientRect() {return {left: 100, right: 700, top: 100, bottom: 700};},
    }; elements.push(node); return node;
  }
  const host = element(), grid = element(), dialog = element();
  globalThis.document = {createElement: element};
  t.after(() => {if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;});
  const controller = new AbortController(), selected = []; let retries = 0;
  const gallery = mountSkillGallery(host, {signal: controller.signal, onChoose: name => selected.push(name), onRetry: () => retries++});
  const section = host.child;
  gallery.update([{name: 'image-design', title: '图像设计'}]);
  const trigger = {dataset: {skillPreview: 'image-design'}, isConnected: true, focus() {this.focused = true;}};
  const click = (selector, target = {}) => section.emit('click', {target: {closest: value => value === selector ? target : null}});
  click('[data-skill-quick-use]', {dataset: {skillQuickUse: 'image-design'}});
  assert.deepEqual(selected, ['image-design']);
  assert.equal(dialog.open, false, 'quick use selects the skill without opening a preview');
  click('[data-skill-quick-use]', {dataset: {skillQuickUse: 'unavailable'}});
  assert.equal(selected.length, 1, 'quick use cannot select an unavailable skill');
  selected.length = 0;
  click('[data-skill-preview]', trigger);
  assert.equal(dialog.open, true);
  assert.equal(selected.length, 0);
  click('[data-skill-close]');
  assert.equal(trigger.focused, true);
  click('[data-skill-preview]', trigger);
  click('[data-skill-use]');
  assert.deepEqual(selected, ['image-design']);
  assert.equal(dialog.open, false);
  gallery.error(); assert.ok(grid.innerHTML.includes('重新加载'));
  click('[data-skill-retry]'); assert.equal(retries, 1);
  click('[data-skill-preview]', trigger);
  controller.abort();
  assert.equal(dialog.open, false);
  assert.equal(section.isConnected, false);
  const previous = grid.innerHTML;
  gallery.update([{name: 'short-drama'}]); gallery.error();
  assert.equal(grid.innerHTML, previous, 'late responses do not update a disposed entry');
  click('[data-skill-use]'); assert.equal(selected.length, 1);
});

test('skill gallery cache versions are connected through HTML and the app entry', () => {
  for (const [path, refs] of [
    ['index.html', ['/app.js?v=489', '/styles.css?v=364']],
    ['app.js', ['./features/agent/workspace.js?v=90']],
    ['features/agent/workspace.js', ['./skill-gallery.js?v=6']],
  ]) {
    const source = readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
    for (const ref of refs) assert.ok(source.includes(ref), `${path}: ${ref}`);
  }
  const workspace = readFileSync(new URL('../public/features/agent/workspace.js', import.meta.url), 'utf8');
  assert.ok(workspace.includes("api('/api/agent/skills'"));
});
