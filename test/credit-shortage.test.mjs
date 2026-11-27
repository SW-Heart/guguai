import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCreditShortagePrompt, isInsufficientCreditsError } from '../public/features/credits/shortage.js';
import { createVideoUpscaleController } from '../public/features/generation/upscale-controller.js';

function promptFixture({ purchaseOpen = false } = {}) {
  const events = [];
  const timers = [];
  let open = purchaseOpen;
  const prompt = createCreditShortagePrompt({
    toast:message => events.push(['toast', message]),
    openPurchase:() => { open = true; events.push(['purchase']); },
    isPurchaseOpen:() => open,
    setTimer:(callback, ms) => { const timer = { callback, ms, cleared:false }; timers.push(timer); return timer; },
    clearTimer:timer => { timer.cleared = true; },
  });
  const flush = () => timers.splice(0).filter(timer => !timer.cleared).forEach(timer => timer.callback());
  return { prompt, events, timers, flush, setOpen:value => { open = value; } };
}

test('only our own 402 counts as a short wallet, not an upstream balance message', () => {
  assert.equal(isInsufficientCreditsError({ status:402, message:'积分不足，本次需要 5 积分' }), true);
  assert.equal(isInsufficientCreditsError({ status:502, message:'上游账户余额不足' }), false);
  assert.equal(isInsufficientCreditsError(new Error('insufficient balance')), false);
  assert.equal(isInsufficientCreditsError(null), false);
});

test('a short wallet is announced first and the purchase dialog opens after it', () => {
  const f = promptFixture();
  assert.equal(f.prompt.notify('积分不足，本次需要 5 积分'), true);
  assert.deepEqual(f.events, [['toast', '积分不足，本次需要 5 积分']]);
  assert.equal(f.timers[0].ms > 0, true);
  f.flush();
  assert.deepEqual(f.events, [['toast', '积分不足，本次需要 5 积分'], ['purchase']]);
});

test('several short requests at once give one prompt and one dialog', () => {
  const f = promptFixture();
  f.prompt.notify('积分不足');
  assert.equal(f.prompt.notify('积分不足'), false);
  f.flush();
  assert.equal(f.prompt.notify('积分不足'), false, 'the dialog is already open');
  assert.deepEqual(f.events, [['toast', '积分不足'], ['purchase']]);
});

test('an open purchase dialog or a reset account suppresses the prompt', () => {
  const open = promptFixture({ purchaseOpen:true });
  assert.equal(open.prompt.notify('积分不足'), false);
  assert.deepEqual(open.events, []);

  const reset = promptFixture();
  reset.prompt.notify('积分不足');
  reset.prompt.cancel();
  reset.flush();
  assert.deepEqual(reset.events, [['toast', '积分不足']]);
  assert.equal(reset.prompt.notify('积分不足'), true, 'a later shortage prompts again');
});

test('a dialog opened by the user before the timer fires is not opened twice', () => {
  const f = promptFixture();
  f.prompt.notify('积分不足');
  f.setOpen(true);
  f.flush();
  assert.deepEqual(f.events, [['toast', '积分不足']]);
});

function element() {
  const listeners = {};
  const attributes = new Map();
  return {
    textContent:'', disabled:false, open:false,
    classList:{ toggle() {} },
    toggleAttribute(name, on) { if (on) attributes.set(name, ''); else attributes.delete(name); },
    getAttribute:name => (attributes.has(name) ? attributes.get(name) : null),
    addEventListener(type, handler) { listeners[type] = handler; },
    showModal() { this.open = true; },
    close() { this.open = false; listeners.close?.(); },
    click() { return listeners.click?.(); },
  };
}

async function upscaleFixture(balance) {
  const nodes = {};
  const $ = selector => (nodes[selector] ||= element());
  const calls = [];
  const shortages = [];
  let wallet = balance;
  const previous = globalThis.document;
  globalThis.document = {
    createElement:() => {
      const video = { removeAttribute() {}, load() {}, videoWidth:1280, videoHeight:720, duration:5 };
      Object.defineProperty(video, 'src', { set() { queueMicrotask(() => video.onloadedmetadata()); } });
      return video;
    },
  };
  const controller = createVideoUpscaleController({
    $, toast() {}, creditText:value => String(value), getBalance:() => wallet, setCreditBalance() {},
    fileById:() => ({ url:'gugu-media://a.mp4', localStatus:'saved', size:10 }),
    taskById:() => null, onTasksChanged() {}, observeTaskFailure() {},
    onInsufficientCredits:message => shortages.push(message),
    api:async (url, options) => {
      calls.push(url);
      if (url.endsWith('/quote')) return { credits:20, balance:wallet, sourceWidth:1280, sourceHeight:720, outputWidth:1920, outputHeight:1080, label:'1080P' };
      return { balance:wallet - 20, task:{ id:'up-1', creditCost:20 }, upload:null };
    },
  });
  await controller.open({ id:'v1', type:'video', status:'completed', quality:'720p', assetId:'a1' });
  return {
    controller, nodes, calls, shortages,
    setWallet:value => { wallet = value; },
    restore:() => { globalThis.document = previous; },
  };
}

test('upscale with a short wallet keeps its button and opens the purchase dialog on click', async t => {
  const f = await upscaleFixture(5);
  t.after(f.restore);
  const button = f.nodes['#confirmVideoUpscale'];
  assert.equal(button.textContent, '开始放大');
  assert.equal(button.disabled, false);
  assert.match(f.nodes['#videoUpscaleError'].textContent, /积分不足，本次需要 20 积分/);
  assert.deepEqual(f.shortages, [], 'opening the panel alone never opens the purchase dialog');

  await button.click();
  assert.deepEqual(f.shortages, ['积分不足，本次需要 20 积分']);
  assert.deepEqual(f.calls, ['/api/generations/upscale/quote'], 'nothing is charged');
  assert.equal(f.nodes['#videoUpscaleDialog'].open, true);
});

test('a top-up made while the upscale panel is open clears the shortage', async t => {
  const f = await upscaleFixture(5);
  t.after(f.restore);
  f.setWallet(100);
  f.controller.refreshBalance();
  assert.equal(f.nodes['#videoUpscaleError'].textContent, '');
  assert.equal(f.nodes['#videoUpscaleBalance'].textContent, '100 积分');
  await f.nodes['#confirmVideoUpscale'].click();
  assert.deepEqual(f.shortages, []);
  assert.deepEqual(f.calls, ['/api/generations/upscale/quote', '/api/generations/upscale']);
});

test('every module shares the API wrapper that reacts to a short wallet', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /import \{ createCreditShortagePrompt, isInsufficientCreditsError \} from '\.\/features\/credits\/shortage\.js\?v=1';/);
  assert.match(app, /const api = \(url, options\) => requestApi\(url, options\)\.catch\(error => \{\n  if \(isInsufficientCreditsError\(error\)\) creditShortage\.notify\(error\.message\);/);
  assert.equal((app.match(/createApiClient\(/g) || []).length, 1, 'no second client bypasses the wrapper');
  assert.match(app, /onInsufficientCredits:message => creditShortage\.notify\(message\)/);
  assert.match(app, /features\/generation\/upscale-controller\.js\?v=3'/);
  assert.match(html, /\/app\.js\?v=650"/);
});
