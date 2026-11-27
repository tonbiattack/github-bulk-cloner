#Requires -Version 5.1
<#
.SYNOPSIS
  Builds and registers the GitHub Bulk Cloner native messaging host for the
  current Windows user (HKCU, no administrator rights required).

.DESCRIPTION
  Steps performed:
    1. Verify the toolchain (Go, git) and the extension directory.
    2. Build native-host\cmd\host into the install directory.
    3. Write the native messaging manifest with the extension ID.
    4. Register the manifest under HKCU.
    5. Verify the host answers a ping over the native messaging protocol.

.PARAMETER ExtensionId
  The 32-character Chrome extension ID. Required unless -SkipRegister is used.

.PARAMETER InstallDir
  Where the host executable and manifest are installed.
  Defaults to %LOCALAPPDATA%\GitHubBulkCloner.

.PARAMETER SkipBuild
  Reuse an existing executable instead of rebuilding.

.PARAMETER PrebuiltExe
  Install this prebuilt host executable instead of building from source.
  Use it when Go is not installed: download the .exe from the GitHub
  Releases page and pass its path. Go is then not required.

.PARAMETER SkipRegister
  Build and write the manifest without touching the registry.

.PARAMETER Force
  Overwrite an existing installation without prompting.

.EXAMPLE
  .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

.EXAMPLE
  # Go を入れずに、配布されている exe を使う
  .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop `
    -PrebuiltExe .\github-bulk-cloner-host-windows-amd64.exe
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GitHubBulkCloner'),

  [string]$PrebuiltExe,

  [switch]$SkipBuild,
  [switch]$SkipRegister,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HostName = 'com.tonbiattack.github_bulk_cloner'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$NativeHostDir = Join-Path $RepoRoot 'native-host'
$ExtensionDir = Join-Path $RepoRoot 'extension'
$ExeName = 'github-bulk-cloner-host.exe'
$ManifestName = "$HostName.json"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Yellow
}

function Assert-Command([string]$Name, [string]$Hint) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "$Name が見つかりません。$Hint"
  }
  return $command.Source
}

# ---------------------------------------------------------------- preflight

Write-Step '前提条件を確認しています'

$usePrebuilt = -not [string]::IsNullOrWhiteSpace($PrebuiltExe)

if ($usePrebuilt) {
  # Go is only needed to build, so a prebuilt binary removes the requirement.
  if (-not (Test-Path -LiteralPath $PrebuiltExe)) {
    throw "配布バイナリが見つかりません: $PrebuiltExe"
  }
  $PrebuiltExe = (Resolve-Path -LiteralPath $PrebuiltExe).Path
  Write-Ok "prebuilt: $PrebuiltExe"
} else {
  $goPath = Assert-Command 'go' 'Go 1.24 以降をインストールし、PATH に追加してください。Go を使わない場合は -PrebuiltExe で配布バイナリを指定できます。'
  Write-Ok "go: $goPath"
}

$gitPath = Assert-Command 'git' 'Git for Windows をインストールし、PATH に追加してください。'
Write-Ok "git: $gitPath"

if (-not (Test-Path -LiteralPath $NativeHostDir)) {
  throw "native-host ディレクトリが見つかりません: $NativeHostDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $ExtensionDir 'manifest.json'))) {
  throw "extension\manifest.json が見つかりません: $ExtensionDir"
}

if (-not $SkipRegister -and -not $ExtensionId) {
  throw @'
-ExtensionId を指定してください。

拡張 ID の確認方法:
  1. chrome://extensions を開く
  2. デベロッパーモードを有効にする
  3. 「パッケージ化されていない拡張機能を読み込む」で extension フォルダを選ぶ
  4. 表示された ID（32文字）を -ExtensionId に渡す
'@
}

# ------------------------------------------------------------------- build

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$exePath = Join-Path $InstallDir $ExeName

# A running host locks the executable; stop only our own binary.
function Stop-RunningHost {
  Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($ExeName)) -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exePath } |
    ForEach-Object {
      Write-Warn "起動中のホストを終了します (PID $($_.Id))"
      Stop-Process -Id $_.Id -Force
    }
  Start-Sleep -Milliseconds 300
}

if ($usePrebuilt) {
  Write-Step '配布バイナリを配置しています'
  Stop-RunningHost
  Copy-Item -LiteralPath $PrebuiltExe -Destination $exePath -Force
  Write-Ok $exePath
} elseif ($SkipBuild) {
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "-SkipBuild が指定されましたが、$exePath が存在しません。"
  }
  Write-Step 'ビルドをスキップし、既存の実行ファイルを使用します'
  Write-Ok $exePath
} else {
  Write-Step 'ネイティブホストをビルドしています'

  Stop-RunningHost

  $version = '0.1.1'
  Push-Location $NativeHostDir
  try {
    & go build -trimpath -ldflags "-s -w -X main.version=$version" -o $exePath ./cmd/host
    if ($LASTEXITCODE -ne 0) {
      throw "go build が失敗しました (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }
  Write-Ok $exePath
}

# ---------------------------------------------------------------- manifest

Write-Step 'ネイティブメッセージングマニフェストを作成しています'

$manifestPath = Join-Path $InstallDir $ManifestName

if (-not $SkipRegister) {
  $manifest = [ordered]@{
    name            = $HostName
    description     = 'GitHub Bulk Cloner native messaging host'
    path            = $exePath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
  }
  $json = $manifest | ConvertTo-Json -Depth 4
  # Chrome requires UTF-8 without a BOM.
  [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok $manifestPath
} else {
  Write-Warn '-SkipRegister のためマニフェストは作成していません'
}

# -------------------------------------------------------------- registration

if (-not $SkipRegister) {
  Write-Step 'レジストリに登録しています (HKCU)'

  if (Test-Path -LiteralPath $RegistryPath) {
    $existing = (Get-ItemProperty -LiteralPath $RegistryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if ($existing -and $existing -ne $manifestPath -and -not $Force) {
      throw "既に別のマニフェストが登録されています: $existing`n上書きするには -Force を付けて再実行してください。"
    }
  }

  New-Item -Path $RegistryPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $RegistryPath -Name '(default)' -Value $manifestPath
  Write-Ok "$RegistryPath"
  Write-Ok "-> $manifestPath"
}

# ------------------------------------------------------------------- verify

Write-Step 'ホストの応答を確認しています'

$probe = Join-Path $PSScriptRoot 'test-host.ps1'
if (Test-Path -LiteralPath $probe) {
  & $probe -ExePath $exePath
  if ($LASTEXITCODE -ne 0) {
    throw 'ホストが ping に応答しませんでした。'
  }
} else {
  Write-Warn "test-host.ps1 が見つからないため応答確認を省略しました"
}

# ------------------------------------------------------------------ summary

Write-Host ''
Write-Host 'インストールが完了しました。' -ForegroundColor Green
Write-Host ''
Write-Host "  実行ファイル : $exePath"
if (-not $SkipRegister) {
  Write-Host "  マニフェスト : $manifestPath"
  Write-Host "  レジストリ   : $RegistryPath"
  Write-Host "  拡張 ID      : $ExtensionId"
}
Write-Host ''
Write-Host '次の手順:'
Write-Host '  1. chrome://extensions で拡張を再読み込みする'
Write-Host '  2. GitHub のリポジトリ一覧ページを開く'
Write-Host '  3. ポップアップのバッジが「接続 OK」になることを確認する'
Write-Host ''
Write-Host 'アンインストール: .\uninstall.ps1'
