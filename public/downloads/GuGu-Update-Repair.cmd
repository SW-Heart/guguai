@echo off
chcp 65001 >nul
echo GuGu AI 更新助手
echo 本工具使用已经下载的 0.7.3 安装包，不会重新下载安装包或删除项目。
echo 请先保存工作，然后按任意键继续。
pause >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; try { $dir=Join-Path $env:LOCALAPPDATA 'model-studio-updater\pending'; $info=Get-Content -LiteralPath (Join-Path $dir 'update-info.json') -Raw | ConvertFrom-Json; $name=[string]$info.fileName; if ([string]::IsNullOrWhiteSpace($name) -or [IO.Path]::GetFileName($name) -ne $name -or [IO.Path]::GetExtension($name) -ne '.exe') { throw '未找到完整安装包，请打开客户端检查更新。' }; $installer=Join-Path $dir $name; $expected='dh49XuKcHjJ4dyjLAy4mCACzcmr7Lm7ufOnlQMC0vjg7I0gSskYTNgkJLKLGiakhZsq+zLkZdVn1xQDXDhvf0A=='; $stream=[IO.File]::OpenRead($installer); $hash=[Security.Cryptography.SHA512]::Create(); try { $actual=[Convert]::ToBase64String($hash.ComputeHash($stream)) } finally { $stream.Dispose(); $hash.Dispose() }; if ($actual -cne $expected) { throw '现有文件与 0.7.3 安装包不一致，未启动安装。请联系支持。' }; Start-Process -FilePath $installer -ErrorAction Stop; Write-Host '安装程序已打开，请按安装界面提示完成更新。' } catch { Write-Host ('更新未开始：'+$_.Exception.Message); exit 1 }"
echo.
echo 如未出现安装界面，请将此窗口中的提示发给我们。
pause
