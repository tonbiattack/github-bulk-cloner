#Requires -Version 5.1
<#
.SYNOPSIS
  Generates the extension icons from a single vector definition.

.DESCRIPTION
  Draws the icon at 4x the target size and downsamples with high-quality
  interpolation, so the 16px variant stays legible.

  The mark is a downward arrow entering an open tray: "clone into a folder".
  A green rounded square keeps it readable on both light and dark toolbars.

.PARAMETER OutDir
  Destination directory. Defaults to extension\icons.

.PARAMETER Sizes
  Pixel sizes to emit. Defaults to 16, 32, 48, 128.

.EXAMPLE
  .\make-icons.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'extension\icons'),
  [int[]]$Sizes = @(16, 32, 48, 128)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

# The icon is authored in a 512x512 coordinate space and scaled per size.
$Canvas = 512.0
$Supersample = 4

# Palette: GitHub's green, lightened at the top for a little depth.
$TopColor = [System.Drawing.Color]::FromArgb(255, 46, 160, 67)
$BottomColor = [System.Drawing.Color]::FromArgb(255, 26, 127, 55)
$GlyphColor = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

function New-RoundedRectPath {
  param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-PolygonPath {
  param([System.Drawing.PointF[]]$Points)

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddPolygon($Points)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap {
  param([int]$Size)

  $big = $Size * $Supersample
  $scale = $big / $Canvas

  $bitmap = [System.Drawing.Bitmap]::new($big, $big)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    # Rounded square background, inset slightly so the corners are not clipped.
    $inset = 8 * $scale
    $side = $big - ($inset * 2)
    $radius = 112 * $scale
    $backgroundPath = New-RoundedRectPath -X $inset -Y $inset -W $side -H $side -R $radius

    $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      [System.Drawing.PointF]::new(0, 0),
      [System.Drawing.PointF]::new(0, $big),
      $TopColor,
      $BottomColor
    )
    $graphics.FillPath($gradient, $backgroundPath)
    $gradient.Dispose()
    $backgroundPath.Dispose()

    # Glyph: arrow shaft plus head, as one polygon so there is no seam.
    $arrowPoints = @(
      ([System.Drawing.PointF]::new(230 * $scale, 76 * $scale)),
      ([System.Drawing.PointF]::new(282 * $scale, 76 * $scale)),
      ([System.Drawing.PointF]::new(282 * $scale, 216 * $scale)),
      ([System.Drawing.PointF]::new(346 * $scale, 216 * $scale)),
      ([System.Drawing.PointF]::new(256 * $scale, 330 * $scale)),
      ([System.Drawing.PointF]::new(166 * $scale, 216 * $scale)),
      ([System.Drawing.PointF]::new(230 * $scale, 216 * $scale))
    )
    $arrowPath = New-PolygonPath -Points $arrowPoints

    # Tray: an open U shape the arrow points into.
    $trayPoints = @(
      ([System.Drawing.PointF]::new(112 * $scale, 300 * $scale)),
      ([System.Drawing.PointF]::new(156 * $scale, 300 * $scale)),
      ([System.Drawing.PointF]::new(156 * $scale, 380 * $scale)),
      ([System.Drawing.PointF]::new(356 * $scale, 380 * $scale)),
      ([System.Drawing.PointF]::new(356 * $scale, 300 * $scale)),
      ([System.Drawing.PointF]::new(400 * $scale, 300 * $scale)),
      ([System.Drawing.PointF]::new(400 * $scale, 424 * $scale)),
      ([System.Drawing.PointF]::new(112 * $scale, 424 * $scale))
    )
    $trayPath = New-PolygonPath -Points $trayPoints

    $glyphBrush = [System.Drawing.SolidBrush]::new($GlyphColor)
    $graphics.FillPath($glyphBrush, $arrowPath)
    $graphics.FillPath($glyphBrush, $trayPath)
    $glyphBrush.Dispose()
    $arrowPath.Dispose()
    $trayPath.Dispose()
  } finally {
    $graphics.Dispose()
  }

  # Downsample to the requested size for clean edges.
  $result = [System.Drawing.Bitmap]::new($Size, $Size)
  $resultGraphics = [System.Drawing.Graphics]::FromImage($result)
  try {
    $resultGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resultGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $resultGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $resultGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $resultGraphics.Clear([System.Drawing.Color]::Transparent)
    $resultGraphics.DrawImage($bitmap, ([System.Drawing.Rectangle]::new(0, 0, $Size, $Size)))
  } finally {
    $resultGraphics.Dispose()
    $bitmap.Dispose()
  }

  return $result
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

foreach ($size in $Sizes) {
  $icon = New-IconBitmap -Size $size
  try {
    $path = Join-Path $OutDir "icon-$size.png"
    $icon.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "wrote $path" -ForegroundColor Green
  } finally {
    $icon.Dispose()
  }
}
