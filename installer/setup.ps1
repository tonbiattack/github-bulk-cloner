#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the GitHub Bulk Cloner native host for the Chrome Web Store build.

.DESCRIPTION
  One command sets up everything the extension needs:

    1. Checks Git for Windows (required) and reports the gh CLI state.
    2. Downloads the prebuilt native host from GitHub Releases, or uses a
       local file with -HostPath. Go is not required.
    3. Verifies the SHA256 checksum of the download.
    4. Writes the native messaging manifest for the extension ID.
    5. Registers it under HKCU (no administrator rights needed).
    6. Pings the host to prove it runs.

  Re-running repairs the installation. -Uninstall removes it.

  The store build uses a fixed extension ID, so the user never copies an ID.
  A development (unpacked) build uses its own ID: pass -Dev -ExtensionId.

.PARAMETER ExtensionId
  Extension ID to allow. Defaults to the store ID once published. Required
  with -Dev, where the ID comes from chrome://extensions.

.PARAMETER Dev
  Register a development (unpacked) extension instead of the store build.

.PARAMETER HostPath
  Install this local executable instead of downloading a release.

.PARAMETER Version
  Release tag to download, for example 0.1.0. Defaults to the latest release.

.PARAMETER InstallDir
  Where to install the host and manifest.
  Defaults to %LOCALAPPDATA%\GitHubBulkCloner.

.PARAMETER Repair
  Re-download and re-register over an existing installation.

.PARAMETER Uninstall
  Remove the registration and the installed files, then exit.

.PARAMETER Force
  Replace a registration that points at a different install directory.

.EXAMPLE
  .\setup.ps1

.EXAMPLE
  # 開発版の拡張を登録する
  .\setup.ps1 -Dev -ExtensionId abcdefghijklmnopabcdefghijklmnop

.EXAMPLE
  .\setup.ps1 -Repair

.EXAMPLE
  .\setup.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ExtensionId,
  [switch]$Dev,
  [string]$HostPath,
  [string]$Version = 'latest',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GitHubBulkCloner'),
  [switch]$Repair,
  [switch]$Uninstall,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HostName = 'com.tonbiattack.github_bulk_cloner'
$ExeName = 'github-bulk-cloner-host.exe'
$ManifestName = "$HostName.json"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$RepoSlug = 'tonbiattack/github-bulk-cloner'
$AssetName = 'github-bulk-cloner-host-windows-amd64.exe'
$ChecksumsName = 'SHA256SUMS.txt'

$InstallDir = $InstallDir
$ExePath = Join-Path $InstallDir $ExeName
$ManifestPath = Join-Path $InstallDir $ManifestName

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Yellow
}

function Stop-RunningHost {
  Get-Process -Name 'github-bulk-cloner-host' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $ExePath } |
    ForEach-Object {
      Write-Warn "起動中のホストを終了します (PID $($_.Id))"
      Stop-Process -Id $_.Id -Force
    }
  Start-Sleep -Milliseconds 300
}

# --------------------------------------------------------------- uninstall

if ($Uninstall) {
  Write-Step 'アンインストールしています'

  if (Test-Path -LiteralPath $RegistryPath) {
    Remove-Item -LiteralPath $RegistryPath -Recurse -Force
    Write-Ok "レジストリを削除しました: $RegistryPath"
  } else {
    Write-Ok 'レジストリ登録はありませんでした'
  }

  if (Test-Path -LiteralPath $InstallDir) {
    Stop-RunningHost
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Ok "ファイルを削除しました: $InstallDir"
  } else {
    Write-Ok 'ファイルはありませんでした'
  }

  Write-Host ''
  Write-Host 'アンインストールが完了しました。' -ForegroundColor Green
  Write-Host 'Chrome の拡張機能ページから拡張自体も削除してください。'
  return
}

# ------------------------------------------------------------- extension ID

Write-Step '拡張 ID を確認しています'

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
  $storeIdFile = Join-Path $PSScriptRoot 'store-extension-id.txt'
  if (Test-Path -LiteralPath $storeIdFile) {
    $candidate = Get-Content -LiteralPath $storeIdFile |
      Where-Object { $_ -and -not $_.StartsWith('#') } |
      Select-Object -First 1
    if ($candidate) { $ExtensionId = $candidate.Trim() }
  }
}

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
  throw @'
拡張 ID が分かりません。

・ストア版はまだ公開されていない可能性があります。公開後に
  installer\store-extension-id.txt へ ID を記載してください。

・開発版（パッケージ化されていない拡張）を登録する場合は、
  次のように実行してください。

    .\setup.ps1 -Dev -ExtensionId <chrome://extensions に表示された ID>
'@
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "拡張 ID の形式が不正です: $ExtensionId （32文字の a-p である必要があります）"
}

if (-not $Dev -and $ExtensionId -notmatch '^[a-p]{32}$') {
  throw 'ストア版の ID として不正です。'
}
Write-Ok $ExtensionId

# ------------------------------------------------------------ existing state

Write-Step '既存の登録を確認しています'

$existingManifest = $null
if (Test-Path -LiteralPath $RegistryPath) {
  $existingManifest = (Get-ItemProperty -LiteralPath $RegistryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
}

if ($existingManifest) {
  Write-Ok "登録済み: $existingManifest"
  $existingDir = Split-Path -Parent $existingManifest
  if ($existingDir -ne $InstallDir) {
    if (-not ($Repair -or $Force)) {
      throw @"
別の場所に既に登録されています。

  登録済み: $existingManifest
  今回の対象: $ManifestPath

そのままにしたい場合は何もしないでください。置き換える場合は -Repair、
強制的に上書きする場合は -Force を付けて再実行してください。
"@
    }
    Write-Warn '別のインストール先から置き換えます'
  }
} else {
  Write-Ok '未登録です'
}

# ---------------------------------------------------------------- preflight

Write-Step '前提条件を確認しています'

$gitCommand = Get-Command 'git' -ErrorAction SilentlyContinue
if (-not $gitCommand) {
  throw @'
Git が見つかりません。

Git for Windows をインストールし、PATH に追加してから再実行してください。
https://git-scm.com/download/win
'@
}
Write-Ok "git: $($gitCommand.Source)"

$ghCommand = Get-Command 'gh' -ErrorAction SilentlyContinue
if ($ghCommand) {
  Write-Ok "gh: $($ghCommand.Source)（Private リポジトリに対応）"
} else {
  Write-Warn 'gh がありません。Public リポジトリのみ clone できます。'
}

# --------------------------------------------------------------- obtain host

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

if (-not [string]::IsNullOrWhiteSpace($HostPath)) {
  Write-Step 'ローカルのバイナリを配置しています'
  if (-not (Test-Path -LiteralPath $HostPath)) {
    throw "指定されたバイナリが見つかりません: $HostPath"
  }
  Stop-RunningHost
  Copy-Item -LiteralPath (Resolve-Path -LiteralPath $HostPath).Path -Destination $ExePath -Force
  Write-Ok $ExePath
} else {
  Write-Step 'ビルド済みホストを取得しています'

  if ($Version -eq 'latest') {
    $baseUrl = "https://github.com/$RepoSlug/releases/latest/download"
  } else {
    $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    $baseUrl = "https://github.com/$RepoSlug/releases/download/$tag"
  }
  $assetUrl = "$baseUrl/$AssetName"
  $checksumsUrl = "$baseUrl/$ChecksumsName"

  $tempExe = Join-Path ([System.IO.Path]::GetTempPath()) "$AssetName.download"
  $tempSums = Join-Path ([System.IO.Path]::GetTempPath()) "$ChecksumsName.download"

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  } catch {
    # Older hosts may not need or allow this.
  }

  try {
    Write-Ok "download: $assetUrl"
    Invoke-WebRequest -Uri $assetUrl -OutFile $tempExe -UseBasicParsing
  } catch {
    throw @"
ビルド済みホストをダウンロードできませんでした。

  $assetUrl

ネットワーク接続を確認してください。オフラインの場合は -HostPath で
ローカルに置いた github-bulk-cloner-host-windows-amd64.exe を指定できます。
"@
  }

  # Verify the checksum when the release publishes one.
  try {
    Invoke-WebRequest -Uri $checksumsUrl -OutFile $tempSums -UseBasicParsing
    $expected = (Get-Content -LiteralPath $tempSums |
      Where-Object { $_ -match [regex]::Escape($AssetName) } |
      Select-Object -First 1) -split '\s+' | Select-Object -First 1

    if ($expected) {
      $actual = (Get-FileHash -LiteralPath $tempExe -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $expected.ToLower()) {
        throw @"
チェックサムが一致しません。ダウンロードが壊れているか、改ざんされています。

  期待値: $expected
  実際:   $actual
"@
      }
      Write-Ok "sha256: $actual"
    }
  } catch {
    if ($_.Exception.Message -like '*チェックサム*') { throw }
    Write-Warn 'SHA256SUMS.txt を取得できなかったため、チェックサム検証を省略しました'
  }

  Stop-RunningHost
  Copy-Item -LiteralPath $tempExe -Destination $ExePath -Force
  Remove-Item -LiteralPath $tempExe -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tempSums -Force -ErrorAction SilentlyContinue
  Write-Ok $ExePath
}

# ---------------------------------------------------------------- manifest

Write-Step 'マニフェストを作成しています'

$manifest = [ordered]@{
  name            = $HostName
  description     = 'GitHub Bulk Cloner native messaging host'
  path            = $ExePath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$json = $manifest | ConvertTo-Json -Depth 4
# Chrome requires UTF-8 without a BOM.
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok $ManifestPath

# ------------------------------------------------------------ registration

Write-Step 'レジストリに登録しています'

New-Item -Path $RegistryPath -Force | Out-Null
Set-ItemProperty -LiteralPath $RegistryPath -Name '(default)' -Value $ManifestPath
Write-Ok $RegistryPath

# ------------------------------------------------------------------ verify

Write-Step 'ホストの動作を確認しています'

$probe = Join-Path $PSScriptRoot 'test-host.ps1'
if (Test-Path -LiteralPath $probe) {
  & $probe -ExePath $ExePath
  if ($LASTEXITCODE -ne 0) {
    throw 'ホストが ping に応答しませんでした。ウイルス対策ソフトでブロックされていないか確認してください。'
  }
} else {
  Write-Warn 'test-host.ps1 が見つからないため、応答確認を省略しました'
}

# ----------------------------------------------------------------- summary

Write-Host ''
Write-Host 'セットアップが完了しました。' -ForegroundColor Green
Write-Host ''
Write-Host "  実行ファイル : $ExePath"
Write-Host "  マニフェスト : $ManifestPath"
Write-Host "  拡張 ID      : $ExtensionId"
Write-Host ''
Write-Host '次の手順:'
Write-Host '  1. chrome://extensions で拡張を再読み込みする'
Write-Host '  2. GitHub のリポジトリ一覧ページを開く'
Write-Host '  3. ポップアップのバッジが「接続 OK」になることを確認する'
Write-Host ''
Write-Host 'アンインストール: .\setup.ps1 -Uninstall'
