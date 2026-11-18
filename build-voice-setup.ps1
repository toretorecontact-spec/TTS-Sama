$ErrorActionPreference = 'Stop'

$root        = $PSScriptRoot
$source      = Join-Path $root 'voice-setup.cs'
$manifest    = Join-Path $root 'voice-setup.manifest'
$icon        = Join-Path $root 'installer\setup.ico'
$engineStage = Join-Path $root 'installer\engine-stage'
$portableDir = Join-Path $root 'sapi4'
$engineBin   = Join-Path $root 'engine-slim.bin'
$portableBin = Join-Path $root 'voice-setup-portable.bin'
$outExe      = Join-Path $root 'voice-setup.exe'
$csc         = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'

function Write-Tse1Container {
    param([string[]]$Files, [string]$Output)

    $fs = [System.IO.File]::Open($Output, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
        $bw = New-Object System.IO.BinaryWriter($fs)
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes('TSE1'))
        $bw.Write([int]$Files.Count)
        foreach ($f in $Files) {
            $nameBytes = [System.Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFileName($f))
            $data = [System.IO.File]::ReadAllBytes($f)
            $bw.Write([int]$nameBytes.Length)
            $bw.Write($nameBytes)
            $bw.Write([int]$data.Length)
            $bw.Write($data)
            Write-Host ('  ' + [System.IO.Path]::GetFileName($f) + ' (' + $data.Length + ' bytes)')
        }
        $bw.Flush()
    } finally {
        $fs.Dispose()
    }
}

Write-Host 'Writing system-install payload (DLLs only; no legacy installers)...'
$coreDlls = Get-ChildItem -Path $portableDir -File -Filter '*.dll' | Sort-Object Name
$supportNames = @('SPCHTEL.DLL','XLISTEN.DLL','XTEL.DLL','XVOICE.DLL',
                  'VDICT.DLL','VTEXT.DLL','VCMSHL.DLL','XCOMMAND.DLL',
                  'WRAPSAPI.DLL','MSVCRT.DLL')
$supportDlls = @()
foreach ($n in $supportNames) {
    $p = Join-Path $engineStage $n
    if (-not (Test-Path $p)) { throw "Missing support DLL: $p" }
    $supportDlls += Get-Item $p
}
$engineFiles = @($coreDlls) + @($supportDlls) | Sort-Object Name | ForEach-Object { $_.FullName }
Write-Tse1Container -Files $engineFiles -Output $engineBin

Write-Host 'Writing portable voice payload...'
$portableFiles = Get-ChildItem -Path $portableDir -File | Sort-Object Name | ForEach-Object { $_.FullName }
Write-Tse1Container -Files $portableFiles -Output $portableBin

Write-Host 'Compiling Voice Setup...'
$cscArgs = @(
  '/nologo', '/noconfig', '/optimize+', '/debug-', '/target:winexe', '/platform:x86',
  '/r:mscorlib.dll', '/r:System.dll', '/r:System.Core.dll',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  ('/win32manifest:' + $manifest),
  ('/win32icon:' + $icon),
  ('/out:' + $outExe),
  $source
)
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Voice Setup compile failed with exit code $LASTEXITCODE" }

# The payloads are now plain side files, not .NET resources. Static ML engines
# treat a tiny unsigned EXE carrying multi-megabyte binary resources as a
# dropper, which caused false positives on the distributed RAR.
Copy-Item -LiteralPath $outExe -Destination (Join-Path $root 'VoiceSetup.exe') -Force

Get-Item $outExe | Select-Object Name, Length, LastWriteTime
Get-Item $engineBin, $portableBin | Select-Object Name, Length, LastWriteTime
