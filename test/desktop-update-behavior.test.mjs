import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

test('desktop updates check before studio entry and do not prompt on window restore', () => {
  assert.match(desktopMain, /let updatePromptOnStartup = false/);
  assert.match(desktopMain, /promptOnStartup: updatePromptOnStartup/);
  assert.match(desktopMain, /await startupUpdateGate.ready;[\s\S]*?promptOnStartup: false[\s\S]*?await loadStudio\(\)/);
  assert.doesNotMatch(desktopMain, /promptOnOpen: true/);

  const bridgeSource = app.slice(app.indexOf('async function initDesktopBridge('));
  assert.match(bridgeSource, /const shouldPrompt = mandatory \|\| payload\?\.promptOnStartup === true \|\| payload\?\.promptOnOpen === true/);
  assert.match(bridgeSource, /if \(status === 'available' \|\| status === 'downloading'\) \{\s+if \(shouldPrompt\) showUpdateButton\(\);\s+else hideUpdateButton\(\);/);
  assert.match(bridgeSource, /renderDesktopUpdateDialog\(payload, \{ open: shouldPrompt \}\)/);
  assert.match(bridgeSource, /if \(status === 'downloaded'\) \{[^\n]*updateButton\.onclick = openUpdateFromRail; \}/);
  // A rail click is explicit intent, so it must reopen a previously closed prompt.
  assert.match(bridgeSource, /const openUpdateFromRail = \(\) => \{\s+desktopUpdateDialogDismissed = false;\s+openDesktopUpdateDialog\(\);\s+\};/);
  const statusSubscription = bridgeSource.indexOf('desktopUpdateUnsubscribe = bridge.updates.onStatus(applyUpdateStatus);');
  const initialStatusRead = bridgeSource.indexOf('bridge.updates.getStatus?.()', statusSubscription);
  assert.ok(statusSubscription >= 0 && initialStatusRead > statusSubscription);
  assert.doesNotMatch(bridgeSource.slice(statusSubscription, initialStatusRead), /updateButton\.onclick = \(\) => bridge\.updates\.check\(\)/);
  assert.match(app, /function closeDesktopUpdateDialog\(\{ dismiss = false \} = \{\}\)/);
  assert.match(app, /function isMandatoryDesktopUpdate\(/);
  assert.match(app, /\(status !== 'checking' \|\| mandatory\)[^\n]*openDesktopUpdateDialog\(\)/);
  assert.match(app, /if \(dismiss && isMandatoryDesktopUpdate\(\)\) return/);
  assert.match(app, /toggleClass\(closeButton, 'hidden', mandatory\)/);
  assert.match(app, /if \(!mandatory && \(desktopUpdateReminderSnoozed \|\| payload\?\.snoozed\)\)/);
  assert.match(desktopMain, /mandatory: Boolean\(info\.mandatory \|\| info\.forceUpdate \|\| info\.critical\)/);
  assert.match(desktopMain, /if \(currentUpdateMandatory\) return currentUpdateStatus/);
  assert.match(bridgeSource, /if \(mandatory\) \{ renderDesktopUpdateDialog\(payload, \{ open: true \}\); return; \}/);
});

test('unpackaged development skips the online update prompt', () => {
  const start = desktopMain.indexOf('async function checkForUpdates(');
  const end = desktopMain.indexOf('\nasync function loadStudio()', start);
  const source = desktopMain.slice(start, end);
  assert.match(source, /if \(!app\.isPackaged\) \{[\s\S]*?startupUpdateGate\?\.finish\(\);[\s\S]*?sendUpdateStatus\('unconfigured'\);[\s\S]*?return \{ status: 'unconfigured' \};/);
});

test('mandatory update metadata cannot be dismissed or snoozed', async () => {
  const startup = await readFile(new URL('../desktop/renderer/startup.html', import.meta.url), 'utf8');
  assert.match(startup, /function isMandatoryUpdate\(/);
  assert.match(startup, /if \(isMandatoryUpdate\(\)\) return/);
  assert.match(startup, /\$\('#closeUpdate'\)\.classList\.toggle\('hidden', mandatory\)/);
  assert.match(startup, /renderUpdate\(payload, \{ open: mandatory \|\| \(payload\?\.status !== 'checking' && payload\?\.promptOnStartup === true\) \}\)/);
  assert.match(startup, /\(status !== 'checking' \|\| mandatory\)[^\n]*openUpdateDialog\(\)/);
});

test('Windows update opens the installer before allowing the tray app to quit', () => {
  const installer = desktopMain.slice(desktopMain.indexOf('async function launchDownloadedUpdateInstaller()'), desktopMain.indexOf('function configureAutoUpdater()'));
  const installerOpened = installer.indexOf('await openWindowsUpdateInstaller(installerPath, file => shell.openPath(file))');
  const restoreClosable = installer.indexOf('setWindowsModalState(false);');
  const allowQuit = installer.indexOf('isQuitting = true;');
  const quit = installer.indexOf('app.quit();');
  assert.ok(installerOpened >= 0 && restoreClosable > installerOpened && allowQuit > restoreClosable && quit > allowQuit);
  assert.match(installer, /setTimeout\(\(\) => \{[\s\S]*?app\.exit\(0\);[\s\S]*?\}, 5_000\);/);
  assert.match(desktopMain, /if \(updateInstallStarted && process\.platform === 'win32'\) return setWindowsModalState\(false\)/);
  assert.doesNotMatch(installer, /windowsNsisInstallerLauncher|helper\.unref/);
  assert.doesNotMatch(installer, /quitAndInstall/);
});

test('startup checks updates alongside workspace initialization', () => {
  const bootstrap = desktopMain.slice(desktopMain.indexOf('async function bootstrap()'));
  assert.ok(bootstrap.indexOf('void checkForUpdates({ promptOnStartup: true })') < bootstrap.indexOf('ensureWorkspaceRoot(workspaceRoot)'));
});

test('packaged clients schedule silent checks and clean up resume handling on quit', () => {
  assert.match(desktopMain, /check: \(\) => checkForUpdates\(\)/);
  assert.match(desktopMain, /canCheck: \(\) => app\.isPackaged && updateConfigured && !isQuitting && !updateCheckInFlight/);
  assert.match(desktopMain, /if \(updateCheckInFlight\) return currentUpdateStatus/);
  assert.match(desktopMain, /updateCheckScheduler\.recordCheck\(\);\s+const result = await autoUpdater\.checkForUpdates\(\)/);
  assert.match(desktopMain, /finally \{\s+updateCheckInFlight = false/);
  assert.match(desktopMain, /await loadStudio\(\);\s+startupTrace\('studio-loaded'\);\s+if \(app\.isPackaged\) \{\s+updateCheckScheduler\.start\(\);\s+powerMonitor\.on\('resume', checkUpdatesAfterResume\)/);
  assert.match(desktopMain, /app\.on\('will-quit', \(\) => \{\s+updateCheckScheduler\.stop\(\);\s+powerMonitor\.removeListener\('resume', checkUpdatesAfterResume\)/);
});

test('rail update entry sits above the account dock with Lucide state icons', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const footer = html.slice(html.indexOf('<div class="rail-footer">'), html.indexOf('<span id="desktopVersion"'));
  const button = footer.indexOf('id="desktopUpdateButton"');
  assert.ok(button >= 0 && button < footer.indexOf('id="railDock"'), 'update entry comes before the account dock');
  for (const icon of ['download', 'refresh', 'alert']) assert.match(footer, new RegExp(`data-update-icon="${icon}"`));
  assert.match(footer, /class="rail-update-progress"/);
  assert.doesNotMatch(footer, /id="desktopUpdateButton"[^>]*\btitle=/);
  assert.equal((css.match(/^\.rail-update-button \{/gm) || []).length, 1, 'one source of truth for the rail entry');

  const bridgeSource = app.slice(app.indexOf('async function initDesktopBridge('));
  assert.doesNotMatch(bridgeSource.slice(bridgeSource.indexOf('const showUpdateButton'), bridgeSource.indexOf('hideUpdateButton();', bridgeSource.indexOf('const showUpdateButton'))), /desktopVersion/);
  assert.match(bridgeSource, /status === 'downloading'\) \{ setUpdateState\('downloading'\); setUpdateProgress\(payload\?\.percent\); setUpdateLabel\('下载中'\)/);
  assert.match(bridgeSource, /status === 'error'\) \{ setUpdateState\('error'\); setUpdateProgress\(null\); setUpdateLabel\('重试'\)/);
  assert.match(bridgeSource, /updateButton\.dataset\.railTip = text;/);
});
