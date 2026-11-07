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

# 用 .NET 直接算：有的机器 PSModulePath 是坏的，Get-FileHash 会找不到。
function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $Stream = [System.IO.File]::OpenRead($Path)
    try {
      return ([System.BitConverter]::ToString($Sha.ComputeHash($Stream)) -replace '-', '').ToLowerInvariant()
    } finally {
      $Stream.Dispose()
    }
  } finally {
    $Sha.Dispose()
  }
}

Push-Location -LiteralPath $Root
try {
  $PackageJson = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
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

    # 生成校验和文件：README 和发布页都让用户核对它，缺了用户就没法自查完整性。
    $ArtifactNames = @(
      ([string]$PackageJson.build.portable.artifactName -replace '\$\{version\}', [string]$PackageJson.version),
      ([string]$PackageJson.build.nsis.artifactName -replace '\$\{version\}', [string]$PackageJson.version)
    )
    $Artifacts = @($ArtifactNames | ForEach-Object { Join-Path $Root ("release\" + $_) } | Where-Object { Test-Path -LiteralPath $_ })
    if ($Artifacts.Count -eq 0) {
      throw "No packaged artifacts found in release\; cannot write checksums."
    }
    $SumLines = @($Artifacts | ForEach-Object {
      $Hash = (Get-Sha256Hex -Path $_)
      "$Hash  $(Split-Path -Leaf $_)"
    })
    $SumPath = Join-Path $Root ("release\SHA256SUMS-" + $PackageJson.version + ".txt")
    Set-Content -LiteralPath $SumPath -Value $SumLines -Encoding ASCII
    Write-Output ("checksums written: " + $SumPath)
    $SumLines | ForEach-Object { Write-Output ("  " + $_) }
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
