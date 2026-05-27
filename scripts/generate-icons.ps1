Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$OutDir = Join-Path $Root "build"
$Sizes = @(16, 24, 32, 48, 64, 128, 256)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-RoundRectPath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $Path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $Diameter = $Radius * 2
  $Path.AddArc($X, $Y, $Diameter, $Diameter, 180, 90)
  $Path.AddArc($X + $Width - $Diameter, $Y, $Diameter, $Diameter, 270, 90)
  $Path.AddArc($X + $Width - $Diameter, $Y + $Height - $Diameter, $Diameter, $Diameter, 0, 90)
  $Path.AddArc($X, $Y + $Height - $Diameter, $Diameter, $Diameter, 90, 90)
  $Path.CloseFigure()
  return $Path
}

function Draw-Icon {
  param([int]$Size)

  $Bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $Graphics.Clear([System.Drawing.Color]::Transparent)
  $Graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

  $BgPath = New-RoundRectPath 96 96 832 832 188
  $BgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new(176, 100),
    [System.Drawing.PointF]::new(846, 928),
    [System.Drawing.ColorTranslator]::FromHtml("#0F5750"),
    [System.Drawing.ColorTranslator]::FromHtml("#062D31")
  )
  $Graphics.FillPath($BgBrush, $BgPath)
  $BgBrush.Dispose()

  $BorderPath = New-RoundRectPath 140 132 744 744 156
  $BorderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(62, 91, 174, 165), 18)
  $Graphics.DrawPath($BorderPen, $BorderPath)
  $BorderPen.Dispose()

  $ShadowPath = New-RoundRectPath 278 298 516 460 68
  $ShadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(70, 0, 26, 30))
  $Graphics.FillPath($ShadowBrush, $ShadowPath)
  $ShadowBrush.Dispose()

  $PaperPath = New-RoundRectPath 254 274 516 460 68
  $PaperBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new(268, 286),
    [System.Drawing.PointF]::new(768, 746),
    [System.Drawing.Color]::White,
    [System.Drawing.ColorTranslator]::FromHtml("#DCEBE7")
  )
  $Graphics.FillPath($PaperBrush, $PaperPath)
  $PaperBrush.Dispose()

  $EnvelopePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#0C4B48"), 52)
  $EnvelopePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $EnvelopePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $EnvelopePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $Graphics.DrawLines($EnvelopePen, @(
    [System.Drawing.PointF]::new(300, 348),
    [System.Drawing.PointF]::new(512, 520),
    [System.Drawing.PointF]::new(724, 348)
  ))
  $EnvelopePen.Dispose()

  $FoldPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(168, 12, 75, 72), 40)
  $FoldPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $FoldPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $Graphics.DrawLine($FoldPen, 302, 666, 449, 524)
  $Graphics.DrawLine($FoldPen, 722, 666, 575, 524)
  $FoldPen.Dispose()

  $BadgeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#E7FFF1"))
  $Graphics.FillEllipse($BadgeBrush, 632, 620, 236, 236)
  $BadgeBrush.Dispose()
  $BadgePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#0A3E3A"), 28)
  $Graphics.DrawEllipse($BadgePen, 632, 620, 236, 236)
  $BadgePen.Dispose()

  $CheckPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#159B66"), 42)
  $CheckPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $CheckPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $CheckPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $Graphics.DrawLines($CheckPen, @(
    [System.Drawing.PointF]::new(704, 738),
    [System.Drawing.PointF]::new(735, 769),
    [System.Drawing.PointF]::new(800, 704)
  ))
  $CheckPen.Dispose()

  $Graphics.Dispose()
  return $Bitmap
}

function Get-PngBytes {
  param([System.Drawing.Bitmap]$Bitmap)

  $Stream = [System.IO.MemoryStream]::new()
  $Bitmap.Save($Stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $Bytes = $Stream.ToArray()
  $Stream.Dispose()
  return $Bytes
}

function Get-IcoDibBytes {
  param([System.Drawing.Bitmap]$Bitmap)

  $Width = $Bitmap.Width
  $Height = $Bitmap.Height
  $PixelStride = $Width * 4
  $PixelBytes = New-Object byte[] ($PixelStride * $Height)

  for ($Y = 0; $Y -lt $Height; $Y++) {
    $TargetY = $Height - 1 - $Y
    for ($X = 0; $X -lt $Width; $X++) {
      $Color = $Bitmap.GetPixel($X, $Y)
      $Offset = ($TargetY * $PixelStride) + ($X * 4)
      $PixelBytes[$Offset] = [byte]$Color.B
      $PixelBytes[$Offset + 1] = [byte]$Color.G
      $PixelBytes[$Offset + 2] = [byte]$Color.R
      $PixelBytes[$Offset + 3] = [byte]$Color.A
    }
  }

  $MaskStride = [int]([Math]::Ceiling($Width / 32.0) * 4)
  $MaskBytes = New-Object byte[] ($MaskStride * $Height)
  $Stream = [System.IO.MemoryStream]::new()
  $Writer = [System.IO.BinaryWriter]::new($Stream)
  $Writer.Write([UInt32]40)
  $Writer.Write([Int32]$Width)
  $Writer.Write([Int32]($Height * 2))
  $Writer.Write([UInt16]1)
  $Writer.Write([UInt16]32)
  $Writer.Write([UInt32]0)
  $Writer.Write([UInt32]($PixelBytes.Length + $MaskBytes.Length))
  $Writer.Write([Int32]0)
  $Writer.Write([Int32]0)
  $Writer.Write([UInt32]0)
  $Writer.Write([UInt32]0)
  $Writer.Write($PixelBytes)
  $Writer.Write($MaskBytes)

  $Bytes = $Stream.ToArray()
  $Writer.Dispose()
  $Stream.Dispose()
  return $Bytes
}

$Images = @()
foreach ($Size in $Sizes) {
  $Bitmap = Draw-Icon $Size
  $PngBytes = Get-PngBytes $Bitmap
  $IcoBytes = Get-IcoDibBytes $Bitmap
  [System.IO.File]::WriteAllBytes((Join-Path $OutDir "icon-$Size.png"), $PngBytes)
  if ($Size -eq 256) {
    [System.IO.File]::WriteAllBytes((Join-Path $OutDir "icon.png"), $PngBytes)
  }
  $Images += [PSCustomObject]@{ Size = $Size; Bytes = [byte[]]$IcoBytes }
  $Bitmap.Dispose()
}

$HeaderSize = 6 + ($Images.Count * 16)
$TotalSize = $HeaderSize + (($Images | ForEach-Object { ([byte[]]$_.Bytes).Length } | Measure-Object -Sum).Sum)
$Ico = New-Object byte[] $TotalSize
$Writer = [System.IO.BinaryWriter]::new([System.IO.MemoryStream]::new($Ico))
$Writer.Write([UInt16]0)
$Writer.Write([UInt16]1)
$Writer.Write([UInt16]$Images.Count)

$Offset = $HeaderSize
foreach ($Image in $Images) {
  $Bytes = [byte[]]$Image.Bytes
  $Writer.Write([byte]($(if ($Image.Size -ge 256) { 0 } else { $Image.Size })))
  $Writer.Write([byte]($(if ($Image.Size -ge 256) { 0 } else { $Image.Size })))
  $Writer.Write([byte]0)
  $Writer.Write([byte]0)
  $Writer.Write([UInt16]1)
  $Writer.Write([UInt16]32)
  $Writer.Write([UInt32]$Bytes.Length)
  $Writer.Write([UInt32]$Offset)
  $Offset += $Bytes.Length
}

foreach ($Image in $Images) {
  $Writer.Write([byte[]]$Image.Bytes)
}

$Writer.Dispose()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir "icon.ico"), $Ico)
