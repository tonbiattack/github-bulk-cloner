#Requires -Version 5.1
<#
.SYNOPSIS
  Packages the extension into a zip for Chrome Web Store upload.

.DESCRIPTION
  The store expects a zip whose root contains manifest.json. This script
  validates the manifest, checks that every referenced file exists, and writes
  dist/github-bulk-cloner-<version>.zip.

.PARAMETER OutDir
  Output directory. Defaults to dist/.

.EXAMPLE
  .\tools\package-extension.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExtensionDir = Join-Path $RepoRoot 'extension'
$ManifestPath = Join-Path $ExtensionDir 'manifest.json'

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

# ---------------------------------------------------------------- validate

Write-Step 'マニフェストを検証しています'

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "manifest.json が見つかりません: $ManifestPath"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

if ($manifest.manifest_version -ne 3) {
  throw "manifest_version は 3 である必要があります（現在: $($manifest.manifest_version)）"
}

$version = $manifest.version
if ($version -notmatch '^\d+(\.\d+){0,3}$') {
  throw "version の形式が不正です: $version"
}
Write-Ok "version: $version"

$descLength = $manifest.description.Length
if ($descLength -gt 132) {
  throw "description が 132 文字を超えています（現在: $descLength）"
}
Write-Ok "description: $descLength 文字"

# Every file the manifest references must exist.
$referenced = @()
if ($manifest.background.service_worker) { $referenced += $manifest.background.service_worker }
if ($manifest.action.default_popup) { $referenced += $manifest.action.default_popup }
foreach ($prop in $manifest.icons.PSObject.Properties) { $referenced += $prop.Value }
foreach ($prop in $manifest.action.default_icon.PSObject.Properties) { $referenced += $prop.Value }
foreach ($script in $manifest.content_scripts) {
  foreach ($js in $script.js) { $referenced += $js }
  foreach ($css in $script.css) { $referenced += $css }
}

$missing = @()
foreach ($rel in ($referenced | Select-Object -Unique)) {
  $full = Join-Path $ExtensionDir $rel
  if (-not (Test-Path -LiteralPath $full)) { $missing += $rel }
}
if ($missing.Count -gt 0) {
  throw "マニフェストが参照するファイルが見つかりません:`n  $($missing -join "`n  ")"
}
Write-Ok "参照ファイル: $($referenced.Count) 件すべて存在"

# ---------------------------------------------------------------- package

Write-Step 'zip を作成しています'

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$zipPath = Join-Path $OutDir "github-bulk-cloner-$version.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

# The store requires manifest.json at the archive root, so the extension
# directory's contents are zipped rather than the directory itself.
$items = Get-ChildItem -LiteralPath $ExtensionDir -Force |
  Where-Object { $_.Name -ne 'test' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $items) {
    if ($item.PSIsContainer) {
      $files = Get-ChildItem -LiteralPath $item.FullName -Recurse -File
      foreach ($file in $files) {
        $entryName = $file.FullName.Substring($ExtensionDir.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $archive, $file.FullName, $entryName,
          [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
      }
    } else {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $item.FullName, $item.Name,
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  }
} finally {
  $archive.Dispose()
}

$sizeKb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1)
Write-Ok "$zipPath ($sizeKb KB)"

# ---------------------------------------------------------------- verify

Write-Step 'zip の内容を確認しています'

$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = $verify.Entries | ForEach-Object { $_.FullName }
} finally {
  $verify.Dispose()
}

if ($names -notcontains 'manifest.json') {
  throw 'zip のルートに manifest.json がありません'
}
if ($names | Where-Object { $_ -like 'test/*' }) {
  throw 'zip に test/ が含まれています'
}
Write-Ok "エントリ数: $($names.Count)"

Write-Host ''
Write-Host 'パッケージができました。' -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host ''
Write-Host 'Chrome Web Store のデベロッパー ダッシュボードからアップロードしてください。'
Write-Host '掲載文言は store/listing.md にまとまっています。'
