param(
  [string]$Repo = "xinghe118/outlook-manager",
  [switch]$SkipBuild,
  [switch]$Draft,
  [switch]$Prerelease,
  [switch]$AllowDirty,
  [switch]$NoUpload,
  [switch]$Clobber
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

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

function Get-PackageVersion {
  $package = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
  if (-not $package.version) {
    throw "package.json does not contain a version."
  }
  return [string]$package.version
}

function Get-Sha256Hash {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha256.ComputeHash($stream)
      return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "").ToUpperInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

if (-not $AllowDirty) {
  $status = git status --porcelain
  if ($status) {
    throw "Working tree is not clean. Commit or stash changes, or pass -AllowDirty for a local test release."
  }
}

$Version = Get-PackageVersion
$Tag = "v$Version"
$Portable = Join-Path $Root "release\Outlook Manager $Version.exe"
$Installer = Join-Path $Root "release\Outlook Manager Setup $Version.exe"
$Checksums = Join-Path $Root "release\SHA256SUMS-$Version.txt"
$NotesFile = Join-Path $Root "release\release-notes-$Version.md"

if (-not $SkipBuild) {
  Invoke-Checked "npm.cmd" @("run", "dist:win")
} else {
  Invoke-Checked "npm.cmd" @("run", "verify:release")
}

foreach ($asset in @($Portable, $Installer)) {
  if (-not (Test-Path -LiteralPath $asset)) {
    throw "Expected release asset not found: $asset"
  }
}

$hashLines = foreach ($asset in @($Portable, $Installer)) {
  "$((Get-Sha256Hash $asset))  $([IO.Path]::GetFileName($asset))"
}
$hashLines | Set-Content -LiteralPath $Checksums -Encoding ascii

$notes = @(
  "# Outlook Manager $Version",
  "",
  "## Assets",
  "",
  "- Outlook Manager $Version.exe: portable build",
  "- Outlook Manager Setup $Version.exe: Windows installer",
  "- SHA256SUMS-$Version.txt: SHA256 checksums",
  "",
  "## Verification",
  "",
  "- npm run dist:win completed",
  "- release startup smoke test passed",
  "- executable icon and SQLite startup were verified"
)
$notes | Set-Content -LiteralPath $NotesFile -Encoding utf8

Write-Output "Release assets ready:"
Write-Output "  $Portable"
Write-Output "  $Installer"
Write-Output "  $Checksums"
Write-Output "  $NotesFile"

if ($NoUpload) {
  Write-Output "NoUpload was set. Skipping GitHub Release upload."
  exit 0
}

Invoke-Checked "gh.exe" @("auth", "status")

$releaseExists = $false
& gh.exe release view $Tag --repo $Repo *> $null
if ($LASTEXITCODE -eq 0) {
  $releaseExists = $true
}

if (-not $releaseExists) {
  $args = @(
    "release",
    "create",
    $Tag,
    "--repo",
    $Repo,
    "--title",
    "Outlook Manager $Version",
    "--notes-file",
    $NotesFile
  )

  if ($Draft) {
    $args += "--draft"
  }
  if ($Prerelease) {
    $args += "--prerelease"
  }

  Invoke-Checked "gh.exe" $args
} else {
  Invoke-Checked "gh.exe" @(
    "release",
    "edit",
    $Tag,
    "--repo",
    $Repo,
    "--title",
    "Outlook Manager $Version",
    "--notes-file",
    $NotesFile
  )
}

$uploadArgs = @(
  "release",
  "upload",
  $Tag,
  $Portable,
  $Installer,
  $Checksums,
  "--repo",
  $Repo
)

if ($Clobber) {
  $uploadArgs += "--clobber"
}

Invoke-Checked "gh.exe" $uploadArgs
Write-Output "GitHub Release published: $Repo $Tag"
