import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const studio = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');

test('project asset dialog leaves the page layout after close', () => {
  assert.match(styles, /\.project-asset-dialog\[open\]\s*\{[^}]*display:\s*flex\s*;[^}]*\}/s);
  assert.match(styles, /\.project-asset-dialog:not\(\[open\]\)\s*\{[^}]*display:\s*none\s*;[^}]*\}/s);
});

test('project asset dialog uses one guarded lifecycle instance', () => {
  assert.match(studio, /querySelectorAll\('dialog#projectAssetDialog'\)/);
  assert.match(studio, /dialogs\.filter\(item=>item!==dialog\)\.forEach\(item=>item\.remove\(\)\)/);
  assert.match(studio, /dialog\.dataset\.projectAssetLifecycleBound!=='true'/);
  assert.match(studio, /button\.onclick=closeProjectAssetDialog/);
});
