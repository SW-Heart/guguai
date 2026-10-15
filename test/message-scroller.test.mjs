import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMessageScroller, groupMessageTurns, nearestMessageTurn } from '../public/features/agent/message-scroller.js';

test('long conversation scrolling measures only nearby turns',()=>{
  let measurements=0;
  const turns=Array.from({length:1024},(_,index)=>{
    const node={getBoundingClientRect(){measurements++;return {top:index*200,bottom:index*200+100};}};
    return {start:node,end:node};
  });
  for(const [middle,expected] of [[-10,0],[640*200+50,640],[640*200+140,640],[640*200+180,641],[300000,1023]]){
    measurements=0;
    assert.equal(nearestMessageTurn(turns,middle),expected);
    assert.ok(measurements<=13,`${measurements} layout measurements for 1024 turns`);
  }
  assert.equal(nearestMessageTurn([],0),-1);
});

const message = (role, text = '', top = 0, bottom = top + 100) => ({
  classList: { contains: name => name === role },
  querySelector: () => ({ textContent: text }),
  getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
});

test('turns contain all reply fragments and the draft until the next user message', () => {
  const first = message('user', '制作参考图');
  const fragments = [message('assistant', '先生成角色'), message('assistant', '再生成场景'), message('assistant', '生成完成')];
  const second = message('user', '生成视频');
  const draft = message('assistant', '正在生成');
  const turns = groupMessageTurns([first, ...fragments, second, draft]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].start, first);
  assert.equal(turns[0].end, fragments.at(-1));
  assert.deepEqual(turns[0].replies, fragments);
  assert.equal(turns[1].start, second);
  assert.deepEqual(turns[1].replies, [draft]);
  assert.equal(groupMessageTurns([first, ...fragments, draft]).length, 1);
  assert.equal(groupMessageTurns([first, ...fragments]).length, 1);
});

test('attachment-only and unanswered questions stay separate; leading assistant replies share a turn', () => {
  const orphan = [message('assistant', '你好'), message('assistant', '有什么想法？')];
  const attachment = message('user');
  const pending = message('user', '继续');
  const turns = groupMessageTurns([...orphan, attachment, pending]);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[0].replies, orphan);
  assert.equal(turns[1].start, attachment);
  assert.equal(turns[1].end, attachment);
  assert.deepEqual(turns[2].replies, []);
  assert.deepEqual(groupMessageTurns([]), []);
});

test('rail keeps one marker per turn while streaming and jumps to the last question instead of the bottom', () => {
  const originals = Object.fromEntries(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
  const frames = new Map();
  let frame = 0;
  const element = () => ({
    children: [], attrs: {}, hidden: false,
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    get firstElementChild() { return this.children[0]; },
    get lastElementChild() { return this.children.at(-1); },
  });
  globalThis.document = { createElement: element };
  globalThis.window = { matchMedia: () => ({ matches: true }), setTimeout: callback => callback() };
  globalThis.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(16)); };
  const nodes = [message('user', '第一问', 0), message('assistant', '第一段', 100, 200), message('assistant', '第二段', 200, 400), message('user', '第二问', 500, 550), message('assistant', '回答中', 550, 1300)];
  const listeners = {};
  const viewport = {
    scrollHeight: 1400, clientHeight: 300, scrollTop: 0,
    classList: { toggle() {} },
    querySelectorAll: () => nodes,
    addEventListener: (name, callback) => { listeners[name] = callback; },
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo({ top }) { this.scrollTop = top; },
  };
  let click;
  const railListeners = {};
  const rail = Object.assign(element(), {
    addEventListener: (name, callback) => { railListeners[name] = callback; if (name === 'click') click = callback; },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return this.children; },
    contains(node) { return this.children.includes(node); },
  });
  let scroller;
  try {
    scroller = createMessageScroller(viewport, rail);
    flush();
    assert.equal(rail.children.length, 2);
    assert.match(rail.children[0].attrs['aria-label'], /第 1 轮对话：第一问/);
    assert.equal(rail.children[0].lastElementChild.lastElementChild.textContent, '第一段 第二段');
    nodes.push(message('assistant', '新的思考结果', 1300, 1350));
    scroller.refresh(); flush();
    assert.equal(rail.children.length, 2);
    viewport.scrollTop = 60;
    listeners.scroll();
    assert.equal(rail.children[0].attrs['aria-current'], 'location');
    assert.equal(rail.children[1].attrs['aria-current'], undefined);
    const button = rail.children[1];
    click({ target: { closest: () => button } });
    assert.equal(viewport.scrollTop, 548);
    assert.notEqual(viewport.scrollTop, viewport.scrollHeight);
    nodes.splice(3);
    scroller.refresh(); flush();
    assert.equal(rail.children.length, 1);
    assert.equal(rail.hidden, false);

    nodes.push(...Array.from({ length: 4 }, (_, index) => message('user', `后续问题 ${index + 1}`, 500 + index * 200)));
    viewport.scrollTop = 0;
    scroller.refresh(); flush();
    const wave = () => rail.children.map(button => button.attrs['data-wave']);
    assert.deepEqual(wave(), ['peak', 'near', 'far', 'rest', 'rest']);
    const hover = (index, pointerType = 'mouse', buttons = 0) => railListeners.pointerover({
      target: { closest: () => rail.children[index] }, pointerType, buttons,
    });
    hover(3);
    assert.deepEqual(wave(), ['rest', 'far', 'near', 'peak', 'near']);
    assert.equal(rail.children[0].attrs['aria-current'], 'location');
    // Scrolling changes the selected turn without stealing the hover wave.
    viewport.scrollTop = 1100;
    listeners.scroll();
    assert.deepEqual(wave(), ['rest', 'far', 'near', 'peak', 'near']);
    railListeners.pointerleave({ pointerType: 'mouse' });
    assert.deepEqual(wave(), ['rest', 'rest', 'far', 'near', 'peak']);
    hover(0, 'touch');
    hover(0, 'pen', 1);
    assert.deepEqual(wave(), ['rest', 'rest', 'far', 'near', 'peak']);
    const focused = rail.children[1];
    focused.matches = () => true;
    railListeners.focusin({ target: { closest: () => focused } });
    assert.deepEqual(wave(), ['near', 'peak', 'near', 'far', 'rest']);
    railListeners.focusout();
    assert.deepEqual(wave(), ['rest', 'rest', 'far', 'near', 'peak']);
  } finally {
    scroller?.destroy();
    Object.assign(globalThis, originals);
  }
});

test('message scroller follows new content until the reader moves away, then resumes at the end', () => {
  const originals = {
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const frames = new Map();
  let nextFrame = 0;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(16));
  };
  const listeners = new Map();
  const surfaceListeners = new Map();
  let top = 0;
  const viewport = {
    scrollHeight: 1000,
    clientHeight: 300,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    classList: { toggle() {} },
    contains: target => target === viewport,
    querySelectorAll: () => [],
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const surface = { addEventListener(name, callback) { surfaceListeners.set(name, callback); } };
  const rail = {
    hidden: true,
    addEventListener() {},
    querySelectorAll: () => [],
    replaceChildren() {},
  };
  let scroller;
  try {
    scroller = createMessageScroller(viewport, rail, surface);
    flush();
    assert.equal(viewport.scrollTop, 700);

    let prevented = false;
    surfaceListeners.get('wheel')({ target: { closest: () => null }, deltaY: -80, deltaMode: 0, preventDefault() { prevented = true; } });
    assert.equal(viewport.scrollTop, 620);
    assert.equal(prevented, true);
    surfaceListeners.get('wheel')({ target: viewport, deltaY: -80 });
    assert.equal(viewport.scrollTop, 620);
    surfaceListeners.get('wheel')({ target: { closest: () => ({}) }, deltaY: -80 });
    assert.equal(viewport.scrollTop, 620);
    surfaceListeners.get('wheel')({ target: { closest: selector => selector.split(', ').includes('.dw-skill-menu') ? {} : null }, deltaY: -80 });
    assert.equal(viewport.scrollTop, 620);

    listeners.get('wheel')({ type: 'wheel', deltaY: -80 });
    viewport.scrollTop = 200;
    listeners.get('scroll')();
    viewport.scrollHeight = 1300;
    scroller.refresh({ immediate: true });
    flush();
    assert.equal(viewport.scrollTop, 200);

    viewport.scrollTop = 990;
    listeners.get('scroll')();
    scroller.refresh({ immediate: true });
    flush();
    assert.equal(viewport.scrollTop, 1000);

    viewport.scrollTop = 100;
    listeners.get('scroll')();
    scroller.refresh({ reset: true });
    flush();
    assert.equal(viewport.scrollTop, 1000);
  } finally {
    scroller?.destroy();
    Object.assign(globalThis, originals);
  }
});

test('minimizing the conversation flies it into the reopen button and the button calls attention to itself', () => {
  const source = readFileSync(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(source, /const toggleAgent=collapsed=>\{animateAgentToggle\(collapsed,/);
  assert.match(source, /prefers-reduced-motion: reduce\)'\)\.matches\)return;/);
  assert.match(source, /reopen\.classList\.add\('is-arriving'\)/);
  assert.match(css, /\.dw-agent-reopen\.is-arriving::after\{[^}]*animation:dw-agent-reopen-ripple/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.director-workspace \.dw-agent-reopen\.is-arriving::after\{animation:none\}\}/);
});
