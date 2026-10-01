import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
function events(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, callback) => {
    const callbacks = listeners.get(type) || [];
    callbacks.push(callback);
    listeners.set(type, callbacks);
  };
  target.emit = (type, event = {}) => listeners.get(type)?.forEach(callback => callback(event));
  return target;
}
function fixture({ stored, dark = false, reduce = false, unavailableStorage = false, animation } = {}) {
  const storage = new Map(stored === undefined ? [] : [['gugu_theme', stored]]);
  const classes = new Set();
  const root = { dataset: {}, style: {}, classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name) } };
  const system = events({ matches: dark });
  const reducedMotion = events({ matches: reduce });
  const buttons = ['system', 'light', 'dark'].map(value => ({
    dataset: { themeChoice: value }, attributes: {}, tabIndex: -1,
    setAttribute(name, value) { this.attributes[name] = value; },
    closest() { return this; }, focus() { document.activeElement = this; },
  }));
  const picker = events({ contains: button => buttons.includes(button), querySelectorAll: () => buttons });
  let mounted = false;
  const meta = { setAttribute(name, value) { this[name] = value; } };
  const transitions = [];
  const document = events({
    documentElement: root,
    querySelector: () => meta,
    querySelectorAll: () => mounted ? buttons : [],
    getElementById: () => picker,
  });
  if (animation) document.startViewTransition = callback => {
    if (animation === 'throws') throw new Error('Unavailable snapshot');
    let finish, reject;
    const entry = {
      callback, skipped: false,
      finished: new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
      skipTransition() { this.skipped = true; },
      finish() { finish(); }, reject() { reject(new Error('Skipped snapshot')); },
    };
    transitions.push(entry);
    return entry;
  };
  const window = events({
    matchMedia: query => query.includes('color-scheme') ? system : reducedMotion,
    localStorage: {
      getItem(key) { if (unavailableStorage) throw new Error('Blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (unavailableStorage) throw new Error('Blocked'); storage.set(key, value); },
    },
  });
  vm.runInNewContext(script, { window, document });
  return {
    root, buttons, transitions, meta, storage, classes,
    mount() { mounted = true; document.emit('DOMContentLoaded'); },
    click(value) { picker.emit('click', { target: buttons.find(button => button.dataset.themeChoice === value) }); },
    key(value, key) {
      let prevented = false;
      picker.emit('keydown', { target: buttons.find(button => button.dataset.themeChoice === value), key, preventDefault() { prevented = true; } });
      return { prevented, focused: document.activeElement?.dataset.themeChoice };
    },
    systemDark(matches) { system.matches = matches; system.emit('change'); },
    remote(value) { value == null ? storage.delete('gugu_theme') : storage.set('gugu_theme', value); window.emit('storage', { key: 'gugu_theme' }); },
  };
}

test('saved preference applies before controls mount and before the first paint', () => {
  for (const [stored, systemDark, expected, choice] of [
    [undefined, true, 'dark', 'system'], ['invalid', false, 'light', 'system'],
    ['light', true, 'light', 'light'], ['dark', false, 'dark', 'dark'],
  ]) {
    const app = fixture({ stored, dark: systemDark });
    assert.equal(app.root.dataset.theme, expected);
    assert.equal(app.root.style.colorScheme, expected);
    assert.equal(app.meta.content, expected);
    assert.equal(app.classes.has('dark'), expected === 'dark');
    app.mount();
    assert.deepEqual(app.buttons.filter(button => button.attributes['aria-checked'] === 'true').map(button => button.dataset.themeChoice), [choice]);
    assert.equal(app.buttons.filter(button => button.tabIndex === 0).length, 1);
  }
});

test('system changes follow only system mode; choices persist and synchronize between windows', () => {
  const app = fixture();
  app.mount();
  app.systemDark(true);
  assert.equal(app.root.dataset.theme, 'dark');
  app.click('light');
  assert.equal(app.storage.get('gugu_theme'), 'light');
  app.systemDark(false);
  app.systemDark(true);
  assert.equal(app.root.dataset.theme, 'light');
  app.click('system');
  assert.equal(app.root.dataset.theme, 'dark');
  app.remote('light');
  assert.equal(app.root.dataset.theme, 'light');
  app.remote(null);
  assert.equal(app.root.dataset.themePreference, 'system');
  assert.equal(app.root.dataset.theme, 'dark');
});

test('unavailable storage, reduced motion, unsupported transitions, and snapshot failures still switch themes', () => {
  for (const options of [{ unavailableStorage: true }, { reduce: true, animation: true }, {}, { animation: 'throws' }]) {
    const app = fixture(options);
    app.mount();
    app.click('dark');
    assert.equal(app.root.dataset.theme, 'dark');
    assert.equal(app.transitions.length, 0);
    assert.equal(app.root.dataset.beuiVt, undefined);
  }
});

test('arrow keys wrap and Home/End select and focus the requested radio', () => {
  const app = fixture();
  app.mount();
  assert.deepEqual(app.key('system', 'ArrowLeft'), { prevented: true, focused: 'dark' });
  assert.equal(app.root.dataset.theme, 'dark');
  assert.deepEqual(app.key('dark', 'ArrowRight'), { prevented: true, focused: 'system' });
  assert.deepEqual(app.key('system', 'End'), { prevented: true, focused: 'dark' });
  assert.deepEqual(app.key('dark', 'Home'), { prevented: true, focused: 'system' });
  assert.equal(app.key('system', 'Escape').prevented, false);
});

test('rapid switches cannot let an older transition overwrite the latest choice', async () => {
  const app = fixture({ animation: true });
  app.mount();
  app.click('dark');
  assert.equal(app.root.dataset.beuiVt, 'rect');
  const first = app.transitions[0];
  first.callback();
  assert.equal(app.root.dataset.theme, 'dark');
  app.click('light');
  const second = app.transitions[1];
  assert.equal(first.skipped, true);
  first.reject();
  await Promise.resolve();
  assert.equal(app.root.dataset.beuiVt, 'rect');
  second.callback();
  second.finish();
  await Promise.resolve();
  first.callback();
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.root.dataset.beuiVt, undefined);
  assert.equal(app.storage.get('gugu_theme'), 'light');
});

test('a pending snapshot and switching to the same resolved theme keep the latest preference', async () => {
  const app = fixture({ animation: true });
  app.mount();
  app.click('dark');
  const pending = app.transitions[0];
  app.click('system');
  pending.callback();
  pending.finish();
  await Promise.resolve();
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.root.dataset.themePreference, 'system');
  assert.equal(app.root.dataset.beuiVt, undefined);
  assert.equal(app.transitions.length, 1);
});

test('theme controls stay inside the account menu, and every changed resource has a current cache key', () => {
  const html = read('index.html');
  const rail = html.slice(html.indexOf('<nav id="appRail"'), html.indexOf('<aside id="agentHistory"'));
  const menu = rail.slice(rail.indexOf('id="accountMenu"'));
  assert.match(menu, /id="accountThemePicker"[^>]*role="radiogroup"/);
  for (const choice of ['system', 'light', 'dark']) assert.match(menu, new RegExp(`role="radio" data-theme-choice="${choice}"`));
  for (const [path, minimum] of [['/theme.js', 1], ['/styles/theme.css', 3], ['/styles.css', 349]]) {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1], 'https://gugu.invalid')).filter(url => url.pathname === path);
    assert.ok(refs.length);
    assert.ok(refs.every(url => Number(url.searchParams.get('v')) >= minimum));
  }
  assert.ok(html.indexOf('/theme.js?v=1') < html.indexOf('/styles/base.css'));
  const styles = read('styles.css');
  const theme = read('styles/theme.css');
  for (const variable of new Set(styles.match(/--theme-[\w-]+/g))) assert.ok(theme.includes(`${variable}:`), `${variable} has a dark value`);
  assert.match(theme, /prefers-reduced-motion: reduce/);
});

test('dark text, muted labels, and primary buttons keep readable contrast', () => {
  const root = read('styles/theme.css').split('/* Fixed legacy colors')[0];
  const colors = Object.fromEntries([...root.matchAll(/(--[\w-]+): (#[\da-f]{6});/g)].map(match => [match[1], match[2]]));
  const luminance = hex => {
    const rgb = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const [foreground, background] of [
    ['--ink', '--panel'], ['--muted', '--surface'], ['--faint', '--surface'],
    ['--brand', '--brand-soft'], ['#ffffff', '--brand-fill'], ['#ffffff', '--brand-fill-hover'],
  ]) {
    const values = [luminance(colors[foreground] || foreground), luminance(colors[background] || background)].sort((a, b) => a - b);
    assert.ok((values[1] + .05) / (values[0] + .05) >= 4.5, `${foreground} on ${background} needs readable contrast`);
  }
});
