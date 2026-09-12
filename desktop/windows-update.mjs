import path from 'node:path';

const waitThenInstallScript = [
  "$ErrorActionPreference='Stop'",
  '$targetPid=[int]$env:GUGU_UPDATE_PARENT_PID',
  '$installer=$env:GUGU_UPDATE_INSTALLER_PATH',
  'while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }',
  "Start-Process -FilePath $installer -ArgumentList @('--updated','--force-run')",
].join('; ');

export function windowsNsisInstallerLauncher(filePath, processId = process.pid, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const installerPath = String(filePath || '').trim();
  const pid = Number(processId);
  const windowsRoot = String(systemRoot || '').trim();
  if (!path.win32.isAbsolute(installerPath) || !installerPath.toLowerCase().endsWith('.exe') || /[\0\r\n]/.test(installerPath)) {
    throw new Error('Windows 更新安装包路径无效');
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Windows 客户端进程 ID 无效');
  if (!path.win32.isAbsolute(windowsRoot) || /[\0\r\n]/.test(windowsRoot)) throw new Error('Windows 系统目录无效');
  return {
    command: path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(waitThenInstallScript, 'utf16le').toString('base64'),
    ],
    env: {
      GUGU_UPDATE_PARENT_PID: String(pid),
      GUGU_UPDATE_INSTALLER_PATH: installerPath,
    },
  };
}
