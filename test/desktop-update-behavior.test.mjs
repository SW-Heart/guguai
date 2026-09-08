import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

test('desktop updates prompt on launch or window restore and stay silent while downloading', () => {
  assert.match(desktopMain, /let updatePromptOnStartup = false/);
  assert.match(desktopMain, /promptOnStartup: updatePromptOnStartup/);
  assert.match(desktopMain, /updatePromptOnStartup = true;\s+void autoUpdater\.checkForUpdates\(\)/);
  assert.match(desktopMain, /currentUpdateStatus = \{ \.\.\.currentUpdateStatus, promptOnOpen: true \}/);

  const bridgeSource = app.slice(app.indexOf('async function initDesktopBridge('));
  assert.match(bridgeSource, /const shouldPrompt = payload\?\.promptOnStartup === true \|\| payload\?\.promptOnOpen === true/);
  assert.match(bridgeSource, /if \(status === 'available' \|\| status === 'downloading'\) \{\s+if \(shouldPrompt\) showUpdateButton\(\);\s+else hideUpdateButton\(\);/);
  assert.match(bridgeSource, /renderDesktopUpdateDialog\(payload, \{ open: shouldPrompt \}\)/);
  assert.match(bridgeSource, /if \(status === 'downloaded'\) \{[^}]*updateButton\.onclick = openDesktopUpdateDialog;/s);
  const statusSubscription = bridgeSource.indexOf('desktopUpdateUnsubscribe = bridge.updates.onStatus(applyUpdateStatus);');
  const initialStatusRead = bridgeSource.indexOf('bridge.updates.getStatus?.()', statusSubscription);
  assert.ok(statusSubscription >= 0 && initialStatusRead > statusSubscription);
  assert.doesNotMatch(bridgeSource.slice(statusSubscription, initialStatusRead), /updateButton\.onclick = \(\) => bridge\.updates\.check\(\)/);
  assert.match(app, /function closeDesktopUpdateDialog\(\{ dismiss = false \} = \{\}\)/);
  assert.match(app, /if \(desktopUpdateDialogDismissed \|\| !dialog/);
});

test('Windows update hands the installer to electron-updater for automatic app shutdown', () => {
  assert.match(desktopMain, /if \(process\.platform === 'win32'\) \{[\s\S]*autoUpdater\.quitAndInstall\(false, true\);[\s\S]*return true;/);
  assert.match(desktopMain, /autoUpdater\.quitAndInstall\(false, true\);[\s\S]*?\n\s*return true;/);
  assert.doesNotMatch(desktopMain.slice(desktopMain.indexOf("if (process.platform === 'win32')"), desktopMain.indexOf("const installerPath =", desktopMain.indexOf("if (process.platform === 'win32')"))), /spawn\(installerPath/);
});
