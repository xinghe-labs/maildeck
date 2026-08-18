param()

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$Arguments = @()
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
  }
}

Push-Location -LiteralPath $Root
try {
  $PackageJson = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
  $ExpectedElectronVersion = [string]$PackageJson.devDependencies.electron
  if ($ExpectedElectronVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Electron must be pinned to an exact release version before packaging."
  }

  $ElectronCli = Join-Path $Root "node_modules\electron\cli.js"
  $ElectronDist = Join-Path $Root "node_modules\electron\dist"
  $ElectronExe = Join-Path $ElectronDist "electron.exe"
  $Builder = Join-Path $Root "node_modules\.bin\electron-builder.cmd"
  if (-not (Test-Path -LiteralPath $Builder)) {
    throw "electron-builder is not installed. Run npm install first."
  }

  if (-not (Test-Path -LiteralPath $ElectronExe)) {
    Write-Output "Local Electron distribution is missing; running the pinned installer."
    Invoke-Checked "npm.cmd" @("run", "electron:install")
  }
  if (-not (Test-Path -LiteralPath $ElectronExe)) {
    throw "Electron distribution was not installed at $ElectronDist"
  }

  $RuntimeVersionOutput = & node $ElectronCli --version
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read the installed Electron version."
  }
  $RuntimeVersion = ([string]$RuntimeVersionOutput).Trim().TrimStart([char]'v')
  if ($RuntimeVersion -ne $ExpectedElectronVersion) {
    throw "Installed Electron version $RuntimeVersion does not match package.json $ExpectedElectronVersion"
  }

  $PreviousCscDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY
  try {
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    Invoke-Checked "npm.cmd" @("run", "icons")
    Invoke-Checked "npm.cmd" @("run", "build")
    Invoke-Checked $Builder @(
      "--win",
      "--x64",
      "--config.electronDist=$ElectronDist"
    )
    Invoke-Checked "npm.cmd" @("run", "verify:release")
  } finally {
    if ($null -eq $PreviousCscDiscovery) {
      Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
    } else {
      $env:CSC_IDENTITY_AUTO_DISCOVERY = $PreviousCscDiscovery
    }
  }
} finally {
  Pop-Location
}
