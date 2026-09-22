import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsNsisInstallerLauncher, openWindowsUpdateInstaller } from '../desktop/windows-update.mjs';

test('opening the installer reports shell failures before the caller can quit', async () => {
  let finish;
  const opened = openWindowsUpdateInstaller('C:\\Temp\\update.exe', () => new Promise(resolve => { finish = resolve; }));
  finish('用户取消了操作');
  await assert.rejects(opened, /用户取消/);
  await assert.rejects(openWindowsUpdateInstaller('C:\\Temp\\update.exe', async () => { throw new Error('denied'); }), /denied/);
  assert.equal(await openWindowsUpdateInstaller('C:\\Temp\\update.exe', async () => ''), true);
  await assert.rejects(openWindowsUpdateInstaller('relative.exe', () => assert.fail('must not launch')), /路径无效/);
});

test('Windows update helper waits for the client process before starting NSIS', () => {
  const installerPath = 'C:\\Users\\creator\\AppData\\Local\\gugu-updater\\GuGu AI Setup.exe';
  const launcher = windowsNsisInstallerLauncher(installerPath, 4321, 'C:\\Windows');
  assert.equal(launcher.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(launcher.env, { GUGU_UPDATE_PARENT_PID:'4321', GUGU_UPDATE_INSTALLER_PATH:installerPath });
  const encoded = launcher.args[launcher.args.indexOf('-EncodedCommand') + 1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /while \(Get-Process -Id \$targetPid/);
  assert.match(script, /Start-Process -FilePath \$installer/);
  assert.match(script, /--updated/);
  assert.match(script, /--force-run/);
  assert.doesNotMatch(script, /GuGu AI Setup/);
});

test('Windows update helper rejects unsafe launch targets', () => {
  assert.throws(() => windowsNsisInstallerLauncher('relative\\update.exe', 4321, 'C:\\Windows'), /路径无效/);
  assert.throws(() => windowsNsisInstallerLauncher('C:\\Temp\\update.msi', 4321, 'C:\\Windows'), /路径无效/);
  assert.throws(() => windowsNsisInstallerLauncher('C:\\Temp\\update.exe\nmalicious', 4321, 'C:\\Windows'), /路径无效/);
  assert.throws(() => windowsNsisInstallerLauncher('C:\\Temp\\update.exe', 0, 'C:\\Windows'), /进程 ID 无效/);
});
