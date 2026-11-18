param(
  [string]$SapiExtract = $env:TTS_SAMA_SAPI_EXTRACT,
  [string]$TvExtract   = $env:TTS_SAMA_TV_EXTRACT,
  [string]$SapiExe     = $env:TTS_SAMA_SAPI_EXE,
  [string]$TvExe       = $env:TTS_SAMA_TV_EXE
)

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$buildDir  = Join-Path $root 'installer'
$stage     = Join-Path $buildDir 'engine-stage'
$engineBin = Join-Path $buildDir 'engine.bin'
$iconPath  = Join-Path $buildDir 'setup.ico'
$source    = Join-Path $buildDir 'installer.cs'
$manifest  = Join-Path $buildDir 'installer.manifest'
$outExe    = Join-Path $root 'TTS-Sama-Setup.exe'
$testExe   = Join-Path $buildDir 'TTS-Sama-Setup-Test.exe'
$appExe    = Join-Path $root 'TTS-Sama.exe'
$csc       = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'

foreach ($required in @(
    @{ Name = 'SapiExtract'; Value = $SapiExtract },
    @{ Name = 'TvExtract';   Value = $TvExtract },
    @{ Name = 'SapiExe';     Value = $SapiExe },
    @{ Name = 'TvExe';       Value = $TvExe }
)) {
    if ([string]::IsNullOrWhiteSpace($required.Value) -or -not (Test-Path $required.Value)) {
        throw ("Missing " + $required.Name + ". Pass -" + $required.Name + " <path> or set the matching TTS_SAMA_* environment variable. See BUILD.md.")
    }
}

Write-Host 'Staging engine files...'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item (Join-Path $sapiExtract '*') $stage -Force
Copy-Item (Join-Path $tvExtract '*') $stage -Force
Copy-Item $sapiExe $stage -Force
Copy-Item $tvExe $stage -Force

Write-Host 'Writing engine payload...'
$files = Get-ChildItem -Path $stage -File | Sort-Object Name
$fs = [System.IO.File]::Open($engineBin, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('TSE1'))
  $bw.Write([int]$files.Count)
  foreach ($f in $files) {
    $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($f.Name)
    $data = [System.IO.File]::ReadAllBytes($f.FullName)
    $bw.Write([int]$nameBytes.Length)
    $bw.Write($nameBytes)
    $bw.Write([int]$data.Length)
    $bw.Write($data)
    Write-Host ('  ' + $f.Name + ' (' + $data.Length + ' bytes)')
  }
  $bw.Flush()
} finally {
  $fs.Dispose()
}

Write-Host 'Generating setup icon...'
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 64,64
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(24,24,26))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(138,92,246))
$g.FillRectangle($brush, 0, 0, 64, 7)
$brush.Dispose()
$font = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold)
$g.DrawString('T', $font, [System.Drawing.Brushes]::White, 13, 8)
$font.Dispose()
$g.Dispose()
$hicon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$iconStream = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try { $icon.Save($iconStream) } finally { $iconStream.Dispose() }
$icon.Dispose()
$bmp.Dispose()

Write-Host 'Compiling installer...'
$refs = @(
  '/nologo', '/noconfig', '/optimize+', '/debug-', '/target:winexe', '/platform:x86',
  '/r:mscorlib.dll', '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  ('/win32icon:' + $iconPath)
)
$resources = @(
  ('/resource:' + $appExe + ',AppExe'),
  ('/resource:' + $engineBin + ',EngineBin')
)

$finalArgs = $refs + @(('/win32manifest:' + $manifest)) + $resources + @(('/out:' + $outExe), $source)
& $csc @finalArgs
if ($LASTEXITCODE -ne 0) { throw "Installer compile failed with exit code $LASTEXITCODE" }

Write-Host 'Compiling test build (no UAC manifest)...'
$testArgs = $refs + $resources + @(('/out:' + $testExe), $source)
& $csc @testArgs
if ($LASTEXITCODE -ne 0) { throw "Test build compile failed with exit code $LASTEXITCODE" }

Get-Item $outExe, $testExe | Select-Object Name, Length
