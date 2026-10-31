import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { logSummary, logDrawerContent, createLogDrawer, bindLogStickyHeader } from '../public/features/admin/log-details.js';

test('log details escape untrusted values and keep raw records collapsed', () => {
  const item = { id:'task-1', status:'failed', creditCost:0, userNickname:'<script>bad()</script>', details:{ error:{ message:'<img onerror="bad()">' }, prompt:'a prompt', request:{ input:1 }, response:{ error:'failure' } } };
  assert.equal(logSummary(item, 'generations'), '<img onerror="bad()">');
  const html = logDrawerContent({ item, category:'generations', record:item, label:'任务', formatDate:() => '', statusText:() => '失败' });
  assert.match(html, /失败原因/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /<dt>消耗积分<\/dt><dd>0<\/dd>/);
  assert.match(html, /画面描述/);
  assert.match(html, /请求内容/);
  assert.match(html, /响应内容/);
  assert.match(html, /完整原始记录/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test('drawer preserves a copy snapshot, resets its scroll and restores focus without moving the page', () => {
  const nodes = new Map();
  const find = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent:'', innerHTML:'', listeners:{}, scrollTop:99,
      addEventListener(event, callback) { this.listeners[event] = callback; },
      replaceChildren() { this.innerHTML = ''; },
      focus(options) { this.focusOptions = options; },
      showModal() { this.open = true; },
      close() { this.open = false; this.listeners.close(); },
    });
    return nodes.get(id);
  };
  const classes = new Set();
  const root = { querySelector:selector => find(selector.slice(1)), body:{ classList:{ add:name => classes.add(name), remove:name => classes.delete(name) } } };
  let copied;
  const drawer = createLogDrawer({ root, copy:value => { copied = value; }, formatDate:String, statusText:String });
  const trigger = { isConnected:true, focus(options) { this.options = options; } };
  const item = { id:'task', status:'running', details:{ prompt:'original' } };
  drawer.open({ item, category:'generations', data:item, label:'生成任务', trigger });
  assert.equal(find('logDetailDrawer').open, true);
  assert.equal(find('logDrawerBody').scrollTop, 0);
  assert.equal(classes.has('log-drawer-open'), true);
  item.details.prompt = 'updated by background refresh';
  find('copyLogDrawer').onclick();
  assert.equal(JSON.parse(copied).details.prompt, 'original');
  drawer.close();
  assert.equal(classes.has('log-drawer-open'), false);
  assert.equal(trigger.options.preventScroll, true);
  assert.equal(find('logDrawerBody').innerHTML, '');
});

test('sticky table header matches horizontal scrolling, mobile navigation and releases listeners', () => {
  let resize;
  let disconnected = false;
  const events = new Map();
  const head = { cloneNode:() => ({}), getBoundingClientRect:() => ({ height:44 }) };
  const clone = { style:{}, removeAttribute() {}, append() {} };
  const table = { getBoundingClientRect:() => ({ width:1080 }), cloneNode:() => clone,
    querySelector:selector => selector === 'thead' ? head : { cloneNode:() => ({}) } };
  const wrap = { scrollLeft:140, querySelector:() => table, addEventListener:(event, callback) => events.set(event, callback), removeEventListener:event => events.delete(event) };
  let sticky;
  const region = { querySelector:() => wrap, prepend:value => { sticky = value; }, classList:{ add() {}, remove() {} } };
  const root = { querySelector:() => region, ownerDocument:{ querySelector:() => ({ getBoundingClientRect:() => ({ height:110 }) }),
    createElement:() => ({ style:{}, setAttribute() {}, append() {}, remove() { this.removed = true; } }) } };
  const win = { matchMedia:() => ({ matches:true }), addEventListener:(_event, callback) => { resize = callback; }, removeEventListener:() => { resize = null; } };
  class Observer { observe() {} disconnect() { disconnected = true; } }
  const dispose = bindLogStickyHeader(root, { window:win, ResizeObserver:Observer });
  assert.equal(sticky.style.top, '110px');
  assert.equal(sticky.scrollLeft, 140);
  assert.equal(clone.style.width, '1080px');
  wrap.scrollLeft = 280;
  events.get('scroll')();
  assert.equal(sticky.scrollLeft, 280);
  dispose();
  assert.equal(sticky.removed, true);
  assert.equal(disconnected, true);
  assert.equal(resize, null);
  assert.equal(events.size, 0);
});

test('new log presentation is reachable through fresh cached entries', () => {
  const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
  assert.match(read('guguadmin.html'), /\/guguadmin\.js\?v=78"/);
  assert.match(read('guguadmin.html'), /\/guguadmin\.css\?v=39"/);
  assert.match(read('guguadmin.js'), /features\/admin\/log-details\.js\?v=1/);
  assert.match(read('guguadmin.html'), /id="logDetailDrawer"/);
  assert.match(read('guguadmin.js'), /data-log-full=/);
});
