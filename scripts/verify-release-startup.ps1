Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ReleaseExe = Join-Path $Root "release\win-unpacked\Outlook Manager.exe"
$UserData = Join-Path $Root "tmp-release-verify-user-data"
$Port = 9340

function Stop-VerifyProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine.Contains($UserData) -or
        $_.CommandLine.Contains("remote-debugging-port=$Port")
      )
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Stop-VerifyProcesses
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath $UserData) {
  Remove-Item -LiteralPath $UserData -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $UserData | Out-Null

$env:OUTLOOK_MANAGER_USER_DATA_DIR = $UserData
$process = Start-Process `
  -FilePath $ReleaseExe `
  -ArgumentList "--remote-debugging-port=$Port" `
  -WorkingDirectory (Split-Path -Parent $ReleaseExe) `
  -PassThru `
  -WindowStyle Hidden

try {
  Start-Sleep -Seconds 6
  if ($process.HasExited) {
    throw "Outlook Manager exited during startup with code $($process.ExitCode)."
  }

  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
  $page = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1
  if (-not $page) {
    throw "No browser page target was exposed by the release executable."
  }

  if ($page.title -ne "Outlook Manager") {
    throw "Unexpected page title: $($page.title)"
  }

  $databasePath = Join-Path $UserData "outlook-manager.db"
  if (-not (Test-Path -LiteralPath $databasePath)) {
    throw "SQLite database was not created."
  }

  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $ReleaseExe).Path)
  $bitmap = $icon.ToBitmap()
  $center = $bitmap.GetPixel([Math]::Floor($bitmap.Width / 2), [Math]::Floor($bitmap.Height / 2))
  $bitmap.Dispose()
  $icon.Dispose()

  if ($center.R -gt 80 -and $center.G -gt 80 -and $center.B -gt 80) {
    throw "Release executable icon does not look like the custom dark mail icon."
  }

  Write-Output "release startup ok: title=$($page.title) db=$databasePath iconCenter=$($center.Name)"
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-VerifyProcesses
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $UserData) {
    Remove-Item -LiteralPath $UserData -Recurse -Force -ErrorAction SilentlyContinue
  }
}
