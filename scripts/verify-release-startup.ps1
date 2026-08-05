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
  $StartupDeadline = (Get-Date).AddSeconds(30)
  $page = $null
  do {
    if ($process.HasExited) {
      throw "Outlook Manager exited during startup with code $($process.ExitCode)."
    }

    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
      $page = $targets |
        Where-Object { $_.type -eq "page" -and $_.title -eq "Outlook Manager" } |
        Select-Object -First 1
    } catch {
      $page = $null
    }

    if (-not $page) {
      Start-Sleep -Milliseconds 500
    }
  } while (-not $page -and (Get-Date) -lt $StartupDeadline)

  if (-not $page) {
    throw "No browser page target was exposed by the release executable."
  }

  $RendererDeadline = (Get-Date).AddSeconds(30)
  $rendererReady = $false
  $readyExpression = @'
document.readyState === 'complete' &&
  typeof window.outlookManager?.settings?.get === 'function' &&
  Boolean(document.querySelector('.sidebar-actions .square-button:last-child'))
'@
  do {
    if ($process.HasExited) {
      throw "Outlook Manager exited before the renderer became ready with code $($process.ExitCode)."
    }

    $readyJson = & node (Join-Path $Root "scripts\evaluate-cdp.mjs") $page.webSocketDebuggerUrl $readyExpression
    if ($LASTEXITCODE -eq 0) {
      $rendererReady = $readyJson | ConvertFrom-Json
    }
    if (-not $rendererReady) {
      Start-Sleep -Milliseconds 500
    }
  } while (-not $rendererReady -and (Get-Date) -lt $RendererDeadline)

  if (-not $rendererReady) {
    throw "Renderer bridge and settings controls did not become ready."
  }

  $securityExpression = @'
(async () => {
  const bridge = window.outlookManager;
  const hasBridge = typeof bridge?.settings?.get === 'function';
  await bridge?.settings?.update({
    proxyUrl: 'http://127.0.0.1:7890',
    proxyUsername: 'release-user',
    proxyPassword: 'release-secret'
  });

  let invalidIpcRejected = false;
  try {
    await bridge?.settings?.update({
      batchConcurrency: 99,
      proxyPassword: 'x'.repeat(2049),
      unexpected: true
    });
  } catch (error) {
    invalidIpcRejected = String(error?.message || error).includes('IPC request rejected');
  }

  const settings = await bridge?.settings?.get();
  const forbiddenPasswordFields = Object.keys(settings || {}).filter((key) =>
    ['password', 'proxyPassword', 'encryptedPassword'].includes(key)
  );

  const settingsButton = document.querySelector('.sidebar-actions .square-button:last-child');
  settingsButton?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const modal = document.querySelector('form.modal');
  const modalBounds = modal?.getBoundingClientRect();
  const passwordInput = modal?.querySelector('input[type="password"]');

  return {
    documentReadyState: document.readyState,
    hasBridge,
    settingsReadable: Boolean(settings),
    invalidIpcRejected,
    forbiddenPasswordFields,
    proxyHasPassword: settings?.proxyHasPassword === true,
    settingsButtonFound: Boolean(settingsButton),
    passwordInputBlank: passwordInput?.value === '',
    settingsModalVisible: Boolean(modalBounds && modalBounds.width > 0 && modalBounds.height > 0),
    settingsModalFitsViewport: Boolean(
      modalBounds && modalBounds.top >= 0 && modalBounds.bottom <= window.innerHeight
    ),
    hasNodeProcess: typeof globalThis.process !== 'undefined',
    csp: document.querySelector('meta[http-equiv=Content-Security-Policy]')?.content || ''
  };
})()
'@
  $securityJson = & node (Join-Path $Root "scripts\evaluate-cdp.mjs") $page.webSocketDebuggerUrl $securityExpression
  if ($LASTEXITCODE -ne 0) {
    throw "Renderer security evaluation failed."
  }
  $security = $securityJson | ConvertFrom-Json
  $securitySummary = $security | ConvertTo-Json -Compress
  if (
    -not $security.hasBridge -or
    -not $security.settingsReadable -or
    -not $security.invalidIpcRejected -or
    -not $security.proxyHasPassword -or
    -not $security.settingsButtonFound -or
    -not $security.passwordInputBlank -or
    -not $security.settingsModalVisible -or
    -not $security.settingsModalFitsViewport -or
    $security.forbiddenPasswordFields.Count -ne 0 -or
    $security.hasNodeProcess
  ) {
    throw "Packaged renderer security boundary is not active: $securitySummary"
  }
  if (-not $security.csp.Contains("object-src 'none'")) {
    throw "Packaged renderer CSP is missing object-src 'none'."
  }

  if ($page.title -ne "Outlook Manager") {
    throw "Unexpected page title: $($page.title)"
  }

  $databasePath = Join-Path $UserData "outlook-manager.db"
  if (-not (Test-Path -LiteralPath $databasePath)) {
    throw "SQLite database was not created."
  }

  $settingsPath = Join-Path $UserData "settings.json"
  if (-not (Test-Path -LiteralPath $settingsPath)) {
    throw "Settings file was not created."
  }
  $settingsRaw = Get-Content -LiteralPath $settingsPath -Raw
  if ($settingsRaw.Contains("release-secret")) {
    throw "Proxy password was persisted in plaintext."
  }
  $settingsFile = $settingsRaw | ConvertFrom-Json
  if ($settingsFile.version -ne 2 -or -not $settingsFile.proxy.encryptedPassword.StartsWith("safe:")) {
    throw "Proxy password was not persisted through safeStorage."
  }

  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $ReleaseExe).Path)
  $bitmap = $icon.ToBitmap()
  $center = $bitmap.GetPixel([Math]::Floor($bitmap.Width / 2), [Math]::Floor($bitmap.Height / 2))
  $bitmap.Dispose()
  $icon.Dispose()

  if ($center.R -gt 80 -and $center.G -gt 80 -and $center.B -gt 80) {
    throw "Release executable icon does not look like the custom dark mail icon."
  }

  Write-Output "release startup ok: title=$($page.title) bridge=$($security.hasBridge) settings=$($security.settingsReadable) invalidIpcRejected=$($security.invalidIpcRejected) proxyEncrypted=True passwordExposed=False passwordInputBlank=$($security.passwordInputBlank) settingsModalFits=$($security.settingsModalFitsViewport) nodeProcess=$($security.hasNodeProcess) cspObjectNone=True db=$databasePath iconCenter=$($center.Name)"
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
