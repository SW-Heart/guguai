import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/guguadmin.js', import.meta.url), 'utf8');
const start = source.indexOf('  function positionSelectPopup() {');
const end = source.indexOf('  function openSelectPopup(', start);
assert.ok(start >= 0 && end > start);

function position({ rect, viewport, innerWidth = 390, innerHeight = 844 }) {
  const popup = {
    style: {},
    classList: { toggle() {} },
    get offsetWidth() { return Math.min(Math.max(280, parseFloat(this.style.minWidth)), parseFloat(this.style.maxWidth)); },
    get offsetHeight() { return Math.min(300, parseFloat(this.style.maxHeight)); },
  };
  runInNewContext(`${source.slice(start, end)}\npositionSelectPopup();`, {
    openSelect: { popup, select: { isConnected: true, _ui: { trigger: { getBoundingClientRect: () => rect } } } },
    window: { visualViewport: viewport }, innerWidth, innerHeight,
    closeSelectPopup() { assert.fail('visible trigger should remain open'); },
  });
  return popup;
}

test('admin dropdown remains within narrow screens and the visible area above the keyboard', () => {
  for (const scenario of [
    { rect: { left: 220, top: 140, bottom: 184, width: 90 }, innerWidth: 320 },
    { rect: { left: 12, top: 600, bottom: 644, width: 366 }, viewport: { width: 390, height: 320, offsetTop: 150, offsetLeft: 0 } },
    { rect: { left: 120, top: 200, bottom: 244, width: 366 }, viewport: { width: 230, height: 220, offsetTop: 100, offsetLeft: 80 } },
    { rect: { left: 260, top: 500, bottom: 536, width: 500 }, innerWidth: 1440, innerHeight: 900 },
  ]) {
    const popup = position(scenario);
    const viewport = scenario.viewport || { width: scenario.innerWidth || 390, height: scenario.innerHeight || 844 };
    const left = (viewport.offsetLeft || 0) + 8;
    const top = (viewport.offsetTop || 0) + 8;
    const x = parseFloat(popup.style.left);
    const y = parseFloat(popup.style.top);
    assert.ok(x >= left && x + popup.offsetWidth <= left + viewport.width - 16);
    assert.ok(y >= top && y + popup.offsetHeight <= top + viewport.height - 16);
  }
});

test('admin dropdown uses the layout viewport when visualViewport is unavailable', () => {
  const popup = position({ rect: { left: 12, top: 780, bottom: 824, width: 366 } });
  assert.ok(parseFloat(popup.style.top) < 780);
  assert.ok(parseFloat(popup.style.top) + popup.offsetHeight <= 836);
});
