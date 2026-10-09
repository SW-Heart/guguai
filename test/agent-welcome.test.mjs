import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { creativePresets, bindCreativePresets } from '../public/features/agent/welcome.js';

function setup() {
  const root = new EventTarget(), input = new EventTarget(), controller = new AbortController();
  let locked = false, inputEvents = 0, submissions = 0;
  root.contains = button => button.inside !== false;
  input.value = ''; input.disabled = false;
  input.focus = () => { input.focused = true; };
  input.setSelectionRange = (start, end) => { input.selection = [start, end]; };
  input.addEventListener('input', () => inputEvents++);
  root.addEventListener('submit', () => submissions++);
  bindCreativePresets(root, input, { signal: controller.signal, isDisabled: () => locked });
  const click = (id, inside = true) => {
    const button = { dataset: { agentPreset: id }, inside };
    const event = new Event('click');
    Object.defineProperty(event, 'target', { value: { closest: () => button } });
    root.dispatchEvent(event);
  };
  return { input, controller, click, lock: () => { locked = true; }, inputEvents: () => inputEvents, submissions: () => submissions };
}

test('each creative shortcut fills an editable draft and selects the first detail to customize', () => {
  const fixture = setup();
  for (const preset of creativePresets) {
    fixture.click(preset.id);
    assert.equal(fixture.input.value, preset.text);
    const [start, end] = fixture.input.selection;
    assert.match(fixture.input.value.slice(start, end), /^\[[^\]]+\]$/);
    assert.equal(fixture.input.focused, true);
  }
  assert.equal(fixture.inputEvents(), creativePresets.length, 'composer availability and size update through its input event');
  assert.equal(fixture.submissions(), 0, 'choosing a shortcut leaves sending to the user');
});

test('shortcuts cannot change a locked, disabled, unrelated or disposed composer', () => {
  for (const guard of ['locked', 'disabled', 'outside', 'unknown', 'disposed']) {
    const fixture = setup();fixture.input.value = '保留我的草稿';
    if (guard === 'locked') fixture.lock();
    if (guard === 'disabled') fixture.input.disabled = true;
    if (guard === 'disposed') fixture.controller.abort();
    fixture.click(guard === 'unknown' ? 'missing' : 'character', guard !== 'outside');
    assert.equal(fixture.input.value, '保留我的草稿', guard);
    assert.equal(fixture.inputEvents(), 0, guard);
  }
});

test('the welcome changes reach every versioned entry and both workspaces share the same module', () => {
  const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const entries = [
    ['index.html', ['/app.js?v=492', '/styles.css?v=367']],
    ['app.js', ['./features/agent/workspace.js?v=90', './drama-studio.js?v=228']],
    ['drama-studio.js', ['./features/drama/director-workspace.js?v=126']],
    ['features/agent/workspace.js', ['../drama/director-workspace.js?v=126', './welcome.js?v=1']],
    ['features/drama/director-workspace.js', ['../agent/welcome.js?v=1']],
    ['features/agent/welcome.js', ['../drama/canvas-icons.js?v=1']],
  ];
  for (const [file, refs] of entries) {
    const source = read(file);
    for (const ref of refs) {
      const [path, version] = ref.split('?v=');
      const linked = [...source.matchAll(/(?:src|href)=["']([^"']+)|(?:from\s*|import\()["']([^"']+)/g)]
        .map(match => match[1] || match[2]).filter(url => url.split('?v=')[0] === path);
      assert.ok(linked.length, `${file}: ${path}`);
      assert.ok(linked.every(url => Number(url.split('?v=')[1]) >= Number(version)), `${file}: stale ${path}`);
    }
  }
  const directorVersions = entries.slice(2, 4).map(([file]) => read(file).match(/director-workspace\.js\?v=(\d+)/)[1]);
  assert.equal(directorVersions[0], directorVersions[1]);
});
