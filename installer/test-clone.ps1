#Requires -Version 5.1
<#
.SYNOPSIS
  End-to-end check of the native host clone protocol.

.DESCRIPTION
  Builds the host, sends a real `clone` request over the native messaging
  protocol, and prints every response frame. Used to verify the host outside
  Chrome.

.PARAMETER Root
  Clone root directory. Defaults to a temporary directory.

.PARAMETER Repositories
  owner/repo specs to clone. Defaults to a small public repository.

.PARAMETER Keep
  Keep the temporary clone root instead of deleting it.

.EXAMPLE
  .\test-clone.ps1 -Repositories 'octocat/Hello-World'
#>
[CmdletBinding()]
param(
  [string]$Root,
  [string[]]$Repositories = @('octocat/Hello-World'),
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$NativeHostDir = Join-Path $RepoRoot 'native-host'

$tempRoot = $null
if (-not $Root) {
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gbc-clone-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $Root = $tempRoot
}

if (-not (Test-Path -LiteralPath $Root)) {
  throw "clone ルートが存在しません: $Root"
}
$Root = (Resolve-Path -LiteralPath $Root).Path

$exePath = Join-Path ([System.IO.Path]::GetTempPath()) ("gbc-host-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.exe')

Push-Location $NativeHostDir
try {
  & go build -trimpath -o $exePath ./cmd/host
  if ($LASTEXITCODE -ne 0) { throw "go build が失敗しました" }
} finally {
  Pop-Location
}

function Get-Field($object, [string]$name) {
  $property = $object.PSObject.Properties[$name]
  if ($property) { return $property.Value }
  return $null
}

function Send-Frame($stream, [string]$json) {
  $payload = [System.Text.Encoding]::UTF8.GetBytes($json)
  $frame = New-Object byte[] ($payload.Length + 4)
  [System.BitConverter]::GetBytes([uint32]$payload.Length).CopyTo($frame, 0)
  $payload.CopyTo($frame, 4)
  $stream.Write($frame, 0, $frame.Length)
  $stream.Flush()
}

function Read-Frame($stream) {
  $header = New-Object byte[] 4
  if ($stream.Read($header, 0, 4) -ne 4) { return $null }
  $length = [System.BitConverter]::ToUInt32($header, 0)
  if ($length -eq 0 -or $length -gt 1048576) { return $null }
  $body = New-Object byte[] $length
  $offset = 0
  while ($offset -lt $length) {
    $chunk = $stream.Read($body, $offset, $length - $offset)
    if ($chunk -le 0) { break }
    $offset += $chunk
  }
  return [System.Text.Encoding]::UTF8.GetString($body, 0, $offset)
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exePath
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($psi)
$failed = $false

try {
  $request = [ordered]@{
    type         = 'clone'
    requestId    = 'e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    root         = $Root
    repositories = $Repositories
  } | ConvertTo-Json -Compress

  Write-Host "root: $Root" -ForegroundColor Cyan
  Write-Host "repositories: $($Repositories -join ', ')" -ForegroundColor Cyan
  Write-Host ''

  Send-Frame $process.StandardInput.BaseStream $request

  $finished = $false
  while (-not $finished) {
    $json = Read-Frame $process.StandardOutput.BaseStream
    if (-not $json) { break }

    $message = $json | ConvertFrom-Json
    switch ($message.type) {
      'result' {
        $status = Get-Field $message 'status'
        $color = switch ($status) {
          'success' { 'Green' }
          'skipped' { 'Yellow' }
          default { 'Red' }
        }
        Write-Host ("  [{0}] {1}" -f $status, (Get-Field $message 'repository')) -ForegroundColor $color
        $path = Get-Field $message 'path'
        if ($path) { Write-Host "        $path" -ForegroundColor DarkGray }
        $detail = Get-Field $message 'message'
        if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
        if ($status -eq 'failed') { $failed = $true }
      }
      'done' {
        $summary = Get-Field $message 'summary'
        Write-Host ''
        Write-Host ("完了: 成功 {0} / スキップ {1} / 失敗 {2}" -f `
          (Get-Field $summary 'success'), (Get-Field $summary 'skipped'), (Get-Field $summary 'failed')) -ForegroundColor Cyan
        $finished = $true
      }
      'error' {
        Write-Host ("エラー [{0}] {1}" -f (Get-Field $message 'code'), (Get-Field $message 'message')) -ForegroundColor Red
        $failed = $true
        $finished = $true
      }
      default {
        Write-Host "  $json" -ForegroundColor DarkGray
      }
    }
  }

  # Close stdin so the host's read loop ends and it exits; only then can stderr
  # be drained without blocking.
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(5000)) { $process.Kill() }

  $stderr = $process.StandardError.ReadToEnd()
  if ($stderr) {
    Write-Host ''
    Write-Host '--- host stderr ---' -ForegroundColor DarkGray
    Write-Host $stderr -ForegroundColor DarkGray
  }
} finally {
  try {
    $process.StandardInput.Close()
    if (-not $process.HasExited) {
      if (-not $process.WaitForExit(5000)) { $process.Kill() }
    }
  } catch { }
  $process.Dispose()

  Remove-Item -LiteralPath $exePath -Force -ErrorAction SilentlyContinue
  if ($tempRoot -and -not $Keep) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($failed) { exit 1 }
exit 0
