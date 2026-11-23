#Requires -Version 5.1
<#
.SYNOPSIS
  Removes the GitHub Bulk Cloner native messaging host registration and files.

.PARAMETER InstallDir
  The install directory used by install.ps1.
  Defaults to %LOCALAPPDATA%\GitHubBulkCloner.

.PARAMETER KeepFiles
  Remove the registry entry but leave the executable and manifest in place.

.EXAMPLE
  .\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GitHubBulkCloner'),
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HostName = 'com.tonbiattack.github_bulk_cloner'
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

# ------------------------------------------------------------- registration

Write-Step 'レジストリ登録を解除しています'

if (Test-Path -LiteralPath $RegistryPath) {
  Remove-Item -LiteralPath $RegistryPath -Recurse -Force
  Write-Ok "削除しました: $RegistryPath"
} else {
  Write-Ok "登録は見つかりませんでした: $RegistryPath"
}

# -------------------------------------------------------------------- files

if ($KeepFiles) {
  Write-Step '-KeepFiles のためファイルは残します'
  Write-Ok $InstallDir
} else {
  Write-Step 'インストールしたファイルを削除しています'

  $resolvedInstall = $null
  if (Test-Path -LiteralPath $InstallDir) {
    $resolvedInstall = (Resolve-Path -LiteralPath $InstallDir).Path
  }

  if ($resolvedInstall) {
    # Only delete a directory that looks like ours, so a mistyped -InstallDir
    # cannot remove unrelated files.
    $expectedExe = Join-Path $resolvedInstall 'github-bulk-cloner-host.exe'
    $expectedManifest = Join-Path $resolvedInstall "$HostName.json"

    if (-not (Test-Path -LiteralPath $expectedExe) -and -not (Test-Path -LiteralPath $expectedManifest)) {
      Write-Host "    想定したファイルが無いため削除しません: $resolvedInstall" -ForegroundColor Yellow
    } else {
      Get-Process -Name 'github-bulk-cloner-host' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$resolvedInstall*" } |
        ForEach-Object { Stop-Process -Id $_.Id -Force }
      Start-Sleep -Milliseconds 300

      Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
      Write-Ok "削除しました: $resolvedInstall"
    }
  } else {
    Write-Ok "ディレクトリは存在しません: $InstallDir"
  }
}

Write-Host ''
Write-Host 'アンインストールが完了しました。' -ForegroundColor Green
Write-Host 'Chrome の拡張機能ページから拡張自体も削除してください。'
