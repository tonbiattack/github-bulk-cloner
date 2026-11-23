#Requires -Version 5.1
<#
.SYNOPSIS
  Checks that installer/store-extension-id.txt holds a usable extension ID.

.DESCRIPTION
  setup.ps1 reads the first line that does not start with '#'. If that line is
  missing or malformed, a store user cannot install without passing
  -ExtensionId by hand, which defeats the point of the file.

  Run this before a release so the file stays in step with the published
  extension.

.EXAMPLE
  .\installer\test-store-id.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$idFile = Join-Path $PSScriptRoot 'store-extension-id.txt'

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

function Write-Fail([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Red
}

if (-not (Test-Path -LiteralPath $idFile)) {
  Write-Fail "ファイルがありません: $idFile"
  exit 1
}

# Mirror how setup.ps1 reads the file.
$candidate = Get-Content -LiteralPath $idFile |
  Where-Object { $_ -and -not $_.StartsWith('#') } |
  Select-Object -First 1

if ([string]::IsNullOrWhiteSpace($candidate)) {
  Write-Fail '拡張 ID が記載されていません（コメント以外の行がありません）'
  exit 1
}

$id = $candidate.Trim()

# Chrome extension IDs are 32 characters in the range a-p.
if ($id -notmatch '^[a-p]{32}$') {
  Write-Fail "拡張 ID の形式が不正です: $id"
  exit 1
}

Write-Ok "store extension id: $id"
Write-Ok "allowed_origins: chrome-extension://$id/"
exit 0
