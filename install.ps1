<#
.SYNOPSIS
  Mandu CLI installer for Windows (PowerShell).

.DESCRIPTION
  Downloads the appropriate standalone binary from a GitHub Release,
  verifies its SHA-256 checksum, installs it under %LOCALAPPDATA%\Mandu\bin,
  and optionally appends that directory to the user's PATH.

.PARAMETER Version
  Release tag to install (default: "latest"). Also honored via the
  MANDU_VERSION environment variable.

.PARAMETER InstallDir
  Install directory (default: $env:LOCALAPPDATA\Mandu\bin). Also honored
  via MANDU_INSTALL_DIR.

.PARAMETER Repo
  GitHub owner/repo (default: "konamgil/mandu"). Also honored via
  MANDU_REPO.

.PARAMETER DryRun
  Print planned actions without downloading or writing.

.PARAMETER Force
  Overwrite an existing binary without prompting.

.PARAMETER NoModifyPath
  Skip editing the User PATH environment variable.

.EXAMPLE
  # One-liner (piped from GitHub)
  iwr https://raw.githubusercontent.com/konamgil/mandu/main/install.ps1 -useb | iex

.EXAMPLE
  # Explicit invocation with flags
  .\install.ps1 -Version v0.23.0 -DryRun

.NOTES
  Exit codes:
    0  success
    1  generic failure
    2  unsupported OS/arch
    3  download / network failure
    4  checksum mismatch

  The downloaded binary is unsigned during Phase 9b rollout; Windows
  SmartScreen will warn on first execution. See docs/install.md for the
  signed-release timeline.
#>
[CmdletBinding()]
param(
  [string] $Version = $env:MANDU_VERSION,
  [string] $InstallDir = $env:MANDU_INSTALL_DIR,
  [string] $Repo = $env:MANDU_REPO,
  [switch] $DryRun,
  [switch] $Force,
  [switch] $NoModifyPath
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Version))    { $Version = "latest" }
if ([string]::IsNullOrWhiteSpace($Repo))       { $Repo = "konamgil/mandu" }
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "Mandu\bin"
}

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
function Write-Note {
  param([string] $Message, [string] $Color = "White")
  Write-Host $Message -ForegroundColor $Color
}

function Write-Plain {
  param([string] $Key, [string] $Value)
  Write-Host ("  {0,-12} {1}" -f $Key, $Value) -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
# Platform detection
#
# We only ship a Windows x64 binary today. arm64 Windows is on the 1.x
# roadmap (Bun already supports `bun-windows-arm64` as a target), but the
# release matrix in .github/workflows/release-binaries.yml does not build
# it yet, so we refuse to guess.
# ---------------------------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
# When running inside a 32-bit PowerShell host on 64-bit Windows, the real
# architecture lives in PROCESSOR_ARCHITEW6432.
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }

switch ($arch) {
  "AMD64" { $runnerTarget = "bun-windows-x64" }
  "x86"   {
    Write-Error "32-bit Windows is not supported. Please use a 64-bit PowerShell host."
    exit 2
  }
  "ARM64" {
    Write-Error "Windows ARM64 binaries are not yet published. Track https://github.com/$Repo for updates."
    exit 2
  }
  default {
    Write-Error "Unsupported architecture: $arch"
    exit 2
  }
}

$binaryName = "mandu-$runnerTarget.exe"

# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------
if ($Version -eq "latest") {
  $baseUrl = "https://github.com/$Repo/releases/latest/download"
} else {
  $baseUrl = "https://github.com/$Repo/releases/download/$Version"
}
$binUrl = "$baseUrl/$binaryName"
$shaUrl = "$binUrl.sha256"

# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
Write-Host ""
Write-Note "Mandu CLI installer" "Cyan"
Write-Plain "repo"        $Repo
Write-Plain "version"     $Version
Write-Plain "platform"    "windows/$($arch.ToLower())"
Write-Plain "target"      $runnerTarget
Write-Plain "install dir" $InstallDir
Write-Plain "binary url"  $binUrl
Write-Host ""

if ($DryRun) {
  Write-Note "[dry-run] stopping before download." "Yellow"
  exit 0
}

# ---------------------------------------------------------------------------
# TLS 1.2 for older PowerShell hosts
# ---------------------------------------------------------------------------
try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  # Tls13 may not be available on Windows Server 2019 / PS5.1 — fall back.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

# ---------------------------------------------------------------------------
# Temp workspace
# ---------------------------------------------------------------------------
$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("mandu-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  $tmpBin = Join-Path $tmpDir $binaryName
  $tmpSha = "$tmpBin.sha256"

  # -----------------------------------------------------------------------
  # Download binary
  # -----------------------------------------------------------------------
  Write-Host "Downloading $binaryName..."
  try {
    Invoke-WebRequest -Uri $binUrl -OutFile $tmpBin -UseBasicParsing
  } catch {
    Write-Error "download failed: $binUrl`n$($_.Exception.Message)"
    exit 3
  }

  # -----------------------------------------------------------------------
  # Download + verify checksum (best-effort — release may predate sidecar)
  # -----------------------------------------------------------------------
  Write-Host "Downloading checksum..."
  $checksumVerified = $false
  try {
    Invoke-WebRequest -Uri $shaUrl -OutFile $tmpSha -UseBasicParsing -ErrorAction Stop
    $expected = (Get-Content $tmpSha -First 1).Split()[0].ToLower()
    $actual = (Get-FileHash -Path $tmpBin -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
      Write-Error "checksum mismatch`n  expected: $expected`n  actual:   $actual"
      exit 4
    }
    Write-Note "  OK $actual" "Green"
    $checksumVerified = $true
  } catch {
    Write-Note "  warning: checksum sidecar not found; skipping verification" "Yellow"
  }

  # -----------------------------------------------------------------------
  # Install
  # -----------------------------------------------------------------------
  if (-not (Test-Path -Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }

  $destPath = Join-Path $InstallDir "mandu.exe"

  if ((Test-Path -Path $destPath) -and (-not $Force)) {
    Write-Note "warning: $destPath already exists -- overwriting." "Yellow"
  }

  Move-Item -Path $tmpBin -Destination $destPath -Force
  Write-Note "Installed: $destPath" "Green"

  # -----------------------------------------------------------------------
  # PATH assistance (User scope — no admin needed)
  # -----------------------------------------------------------------------
  $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
  if ([string]::IsNullOrEmpty($userPath)) { $userPath = "" }
  $pathEntries = $userPath -split ";" | Where-Object { $_ -ne "" }

  if ($pathEntries -notcontains $InstallDir) {
    if ($NoModifyPath) {
      Write-Host ""
      Write-Host "Add this to your User PATH manually:"
      Write-Note "  $InstallDir" "White"
    } else {
      Write-Host ""
      Write-Host "Updating User PATH..."
      $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
      [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
      # Propagate into the *current* session so the post-install --version
      # check works without a shell restart.
      $env:PATH = "$env:PATH;$InstallDir"
      Write-Note "  -> added $InstallDir to User PATH" "Green"
      Write-Host "  (open a new terminal for the change to apply to other shells)"
    }
  } else {
    Write-Host ""
    Write-Host "mandu is already on your User PATH."
  }

  # -----------------------------------------------------------------------
  # Verify install
  # -----------------------------------------------------------------------
  Write-Host ""
  try {
    $ver = & $destPath --version 2>$null | Select-Object -First 1
    Write-Note "mandu $ver is ready." "Green"
    Write-Host "Try: mandu init my-app"
  } catch {
    Write-Error "binary installed but failed to execute`ntry running it directly: `"$destPath`" --help"
    exit 1
  }
}
finally {
  if (Test-Path -Path $tmpDir) {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
