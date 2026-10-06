import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('settings dialog separates account and generation preferences', async () => {
  const html = await read('index.html');
  const dialog = html.slice(html.indexOf('<dialog id="accountSettingsDialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="accountSettingsDialog"')));
  assert.match(dialog, /role="tablist"/);
  assert.match(dialog, /id="settingsPanelGeneration"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(dialog, /<input id="autoPromptRepair" type="checkbox" role="switch"/);
  assert.match(dialog, /短剧分镜里的「AI 优化」/);
  assert.doesNotMatch(dialog, /dialog-kicker/);
  assert.doesNotMatch(dialog.replace(/<[^>]*>/g, ''), /提示词|上游|Prompt/);
});

test('settings save keeps the automatic rewording preference opt-out', async () => {
  const app = await read('app.js');
  assert.match(app, /\$\('#autoPromptRepair'\)\.checked = state\.user\.preferences\?\.autoPromptRepair !== false/);
  assert.match(app, /preferences:\{ autoPromptRepair:\$\('#autoPromptRepair'\)\.checked \}/);
});
