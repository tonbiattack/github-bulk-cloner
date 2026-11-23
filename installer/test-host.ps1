#Requires -Version 5.1
<#
.SYNOPSIS
  Sends a ping to the native host over the Chrome native messaging protocol and
  verifies the pong. Used by install.ps1 and for troubleshooting.

.PARAMETER ExePath
  Path to the host executable. Defaults to the installed location.

.EXAMPLE
  .\test-host.ps1
#>
[CmdletBinding()]
param(
  [string]$ExePath = (Join-Path $env:LOCALAPPDATA 'GitHubBulkCloner\github-bulk-cloner-host.exe')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Host "ホストが見つかりません: $ExePath" -ForegroundColor Red
  exit 1
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

# Chrome frames messages as a 4-byte little-endian length followed by UTF-8 JSON.
$payload = [System.Text.Encoding]::UTF8.GetBytes('{"type":"ping"}')
$frame = New-Object byte[] ($payload.Length + 4)
[System.BitConverter]::GetBytes([uint32]$payload.Length).CopyTo($frame, 0)
$payload.CopyTo($frame, 4)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ExePath
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($psi)
try {
  $process.StandardInput.BaseStream.Write($frame, 0, $frame.Length)
  $process.StandardInput.BaseStream.Flush()

  # Read the 4-byte length prefix, then the JSON body.
  $header = New-Object byte[] 4
  $read = $process.StandardOutput.BaseStream.Read($header, 0, 4)
  if ($read -ne 4) {
    $stderr = $process.StandardError.ReadToEnd()
    Write-Host "応答ヘッダを読み取れませんでした (read=$read)" -ForegroundColor Red
    if ($stderr) { Write-Host "stderr: $stderr" -ForegroundColor DarkGray }
    exit 1
  }

  $length = [System.BitConverter]::ToUInt32($header, 0)
  if ($length -eq 0 -or $length -gt 1048576) {
    Write-Host "応答長が不正です: $length" -ForegroundColor Red
    exit 1
  }

  $body = New-Object byte[] $length
  $offset = 0
  while ($offset -lt $length) {
    $chunk = $process.StandardOutput.BaseStream.Read($body, $offset, $length - $offset)
    if ($chunk -le 0) { break }
    $offset += $chunk
  }

  $json = [System.Text.Encoding]::UTF8.GetString($body, 0, $offset)
  $response = $json | ConvertFrom-Json

  if ($response.type -ne 'pong') {
    Write-Host "予期しない応答です: $json" -ForegroundColor Red
    exit 1
  }

  Write-Ok "pong を受信しました (version: $($response.version))"
  exit 0
} finally {
  try {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(3000)) {
      $process.Kill()
    }
  } catch {
    # The process may already have exited.
  }
  $process.Dispose()
}
