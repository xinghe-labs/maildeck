param(
  [string]$Repo = "xinghe-labs/maildeck",
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
  $package = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
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
$Target = (git rev-parse HEAD).Trim()
$Portable = Join-Path $Root "release\MailDeck-$Version-portable.exe"
$Installer = Join-Path $Root "release\MailDeck-Setup-$Version.exe"
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
  ('# MailDeck ' + $Version),
  '',
  '本地优先的邮箱桌面工作台。这一版把应用从 Outlook Manager 改名为 MailDeck，并内置了设备代码登录。',
  '',
  '## 本版变化',
  '',
  '- 改名 MailDeck：数据目录 `%APPDATA%\maildeck`，数据库 `maildeck.db`；旧目录会自动改名迁移，账号不用重新导入',
  '- 内置设备代码登录：导入弹窗里点「用 Microsoft 账号登录」，浏览器输入 8 位代码，邮箱与 refresh_token 自动填好',
  ('- 产物名改为无空格：`MailDeck-Setup-' + $Version + '.exe` / `MailDeck-' + $Version + '-portable.exe`'),
  ('- 打包脚本自动生成 `SHA256SUMS-' + $Version + '.txt`'),
  '',
  '## Assets',
  '',
  ('- `MailDeck-Setup-' + $Version + '.exe`：安装版（NSIS）'),
  ('- `MailDeck-' + $Version + '-portable.exe`：免安装绿色版，双击即用'),
  ('- `SHA256SUMS-' + $Version + '.txt`：上面两个文件的 SHA-256'),
  '',
  '## 校验下载完整性',
  '',
  '产物未做 Authenticode 签名，SmartScreen 可能提示「已保护你的电脑」，需点「更多信息 → 仍要运行」。因为没签名，请自己核对哈希（cmd 里执行）：',
  '',
  '```cmd',
  ('certutil -hashfile MailDeck-Setup-' + $Version + '.exe SHA256'),
  ('type SHA256SUMS-' + $Version + '.txt'),
  '```',
  '',
  '两串 64 位十六进制一致才说明文件没被替换或损坏。',
  '',
  '## 环境要求',
  '',
  '- Windows 10/11 x64',
  '- 无需安装 Node.js 或 SQLite',
  '',
  '## 自检',
  '',
  '- `npm run verify` 全绿（typecheck + eslint + 539 个测试）',
  '- 打包后启动冒烟通过：窗口标题、桥接、SQLite、CSP、代理加密逐项校验'
)
[System.IO.File]::WriteAllText(
  $NotesFile,
  (($notes -join [Environment]::NewLine) + [Environment]::NewLine),
  (New-Object System.Text.UTF8Encoding($false))
)

Write-Output "Release assets ready:"
Write-Output "  $Portable"
Write-Output "  $Installer"
Write-Output "  $NotesFile"
Write-Output "Local checksum file:"
Write-Output "  $Checksums"

if ($NoUpload) {
  Write-Output "NoUpload was set. Skipping GitHub Release upload."
  exit 0
}

Invoke-Checked "gh.exe" @("auth", "status")

$releaseJson = & gh.exe release list --repo $Repo --limit 100 --json tagName
if ($LASTEXITCODE -ne 0) {
  throw "Failed to query GitHub releases for $Repo."
}

$releaseRows = @()
if ($releaseJson) {
  $releaseRows = @($releaseJson | ConvertFrom-Json)
}
$releaseExists = @($releaseRows | Where-Object { $_.tagName -eq $Tag }).Count -gt 0

if (-not $releaseExists) {
  # gh 的 `release create --target` 在本仓库会直接失败：
  #   tag_name is not a valid tag / Published releases must have a valid tag
  #   Release.target_commitish is invalid
  # 所以改成先本地打附注标签并推送，再用 `--verify-tag` 建 release（不带 --target）。
  Invoke-Checked "git.exe" @("fetch", "--tags", "--prune", "origin")

  $remoteHasCommit = (& git.exe branch -r --contains $Target 2>$null)
  if (-not $remoteHasCommit) {
    throw "Commit $Target is not on any remote-tracking branch. Push the branch first: git push origin HEAD"
  }

  $localSha = (& git.exe rev-list -n 1 $Tag 2>$null)
  if ($localSha) {
    $localSha = $localSha.Trim()
    if ($localSha -ne $Target) {
      throw "Tag $Tag already exists at $localSha, but HEAD is $Target. Delete or retag it before publishing."
    }
    Write-Output "Local tag $Tag already points at $Target"
  } else {
    Invoke-Checked "git.exe" @("tag", "-a", $Tag, "-m", "MailDeck $Version", $Target)
    Write-Output "Created annotated tag $Tag at $Target"
  }

  $remoteTag = (& git.exe ls-remote --tags origin "refs/tags/$Tag")
  if (-not $remoteTag) {
    Invoke-Checked "git.exe" @("push", "origin", $Tag)
    Write-Output "Pushed tag $Tag to origin"
  } else {
    Write-Output "Remote tag $Tag already exists"
  }

  $createArgs = @(
    "release",
    "create",
    $Tag,
    "--repo",
    $Repo,
    "--title",
    "MailDeck $Version",
    "--notes-file",
    $NotesFile,
    "--verify-tag"
  )

  if ($Draft) {
    $createArgs += "--draft"
  }
  if ($Prerelease) {
    $createArgs += "--prerelease"
  }

  Invoke-Checked "gh.exe" $createArgs
} else {
  Invoke-Checked "gh.exe" @(
    "release",
    "edit",
    $Tag,
    "--repo",
    $Repo,
    "--title",
    "MailDeck $Version",
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
  "--repo",
  $Repo
)

if ($Clobber) {
  $uploadArgs += "--clobber"
}

Invoke-Checked "gh.exe" $uploadArgs
Write-Output "GitHub Release published: $Repo $Tag"
